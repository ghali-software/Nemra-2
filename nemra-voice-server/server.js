import express from "express";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import twilio from "twilio";
import { openGeminiSession } from "./gemini-live.js";
import { INTERLOCUTORS } from "./prompt.js";
import { mulaw8kToPcm16k, pcm24kToMulaw8k } from "./audio.js";
import { createDashboardServer } from "./dashboard.js";
import { loadCallers, getCaller, saveCaller } from "./caller-store.js";
import { sendCallSummary } from "./sms.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_HOST = process.env.PUBLIC_HOST;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";

if (!GEMINI_KEY || !TWILIO_SID || !TWILIO_TOKEN || !PUBLIC_HOST) {
  console.error("Missing env : PUBLIC_HOST, GEMINI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN");
  process.exit(1);
}

loadCallers();

const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
const app = express();

app.use(express.static(join(__dirname, "public")));
app.get("/dashboard", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));

app.post("/voice", express.urlencoded({ extended: false }), (req, res) => {
  const callSid = req.body.CallSid || "";
  const from = req.body.From || "";
  const to = req.body.To || "";
  console.log(`[twilio] inbound call ${callSid} : ${from} → ${to}`);
  const wsUrl = `wss://${PUBLIC_HOST}/stream`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callSid" value="${callSid}"/>
      <Parameter name="callerNumber" value="${from}"/>
    </Stream>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

const server = http.createServer(app);
const dashboard = createDashboardServer();
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const path = req.url.split("?")[0];
  if (path === "/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else if (path === "/dashboard-ws") {
    dashboard.wss.handleUpgrade(req, socket, head, (ws) => dashboard.wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let callSid = null;
  let callerNumber = null;
  let gemini = null;
  let closed = false;
  const transcript = [];
  const callStart = Date.now();

  const closeAll = () => {
    if (closed) return;
    closed = true;
    const dur = Math.round((Date.now() - callStart) / 1000);
    dashboard.broadcast({ type: "call_end", duration: dur });
    console.log(`[call] ended after ${dur}s`);
    try { gemini?.close(); } catch {}
    try { twilioWs.close(); } catch {}
  };

  const handleToolCall = async ({ id, name, args }) => {
    console.log(`[tool] ${name}(${JSON.stringify(args)}) callSid=${callSid}`);

    if (name === "end_call") {
      dashboard.broadcast({ type: "status", status: "ended" });
      gemini?.sendToolResponse(id, name, { status: "ended" });
      setTimeout(async () => {
        try { await twilioClient.calls(callSid).update({ status: "completed" }); } catch (e) { console.error("end_call err", e.message); }
        closeAll();
      }, 1500);
      return;
    }

    const key = name.replace("transfer_to_", "");
    const target = INTERLOCUTORS[key];
    if (!target) {
      gemini?.sendToolResponse(id, name, { status: "error", message: "Inconnu" });
      return;
    }

    // Dashboard : intent + transfer
    const subject = args.subject || name.replace("transfer_to_", "");
    dashboard.broadcast({ type: "intent", intent: subject, target: target.name });
    dashboard.broadcast({ type: "transfer", target: target.name, role: target.role, number: target.number });
    dashboard.broadcast({ type: "status", status: "transferring" });

    // Caller store : sauvegarder pour reconnaissance future
    if (callerNumber) {
      saveCaller(callerNumber, { name: args.caller_name, subject });
    }

    // SMS post-appel
    sendCallSummary({
      twilioClient,
      geminiApiKey: GEMINI_KEY,
      transcript,
      callerNumber,
      target,
      fromNumber: TWILIO_NUMBER,
    }).catch((e) => console.error("[sms] error:", e.message));

    gemini?.sendToolResponse(id, name, { status: "transferring", to: target.name });
    setTimeout(async () => {
      try {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${TWILIO_NUMBER}" timeout="25" answerOnBridge="true">
    <Number>${target.number}</Number>
  </Dial>
</Response>`;
        await twilioClient.calls(callSid).update({ twiml });
        console.log(`[transfer] ${callSid} → ${target.name} (${target.number})`);
        dashboard.broadcast({ type: "status", status: "transferred" });
      } catch (e) {
        console.error(`[transfer] err: ${e.message}`);
        dashboard.broadcast({ type: "status", status: "transfer_failed", error: e.message });
      }
      closeAll();
    }, 2000);
  };

  gemini = openGeminiSession({
    apiKey: GEMINI_KEY,
    onAudio: (pcm24k) => {
      if (!streamSid) return;
      const mulaw = pcm24kToMulaw8k(pcm24k);
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: mulaw.toString("base64") },
      }));
    },
    onToolCall: handleToolCall,
    onText: ({ role, text }) => {
      transcript.push({ role, text, ts: Date.now() });
      dashboard.broadcast({ type: "transcript", role, text });
      console.log(`[${role}] ${text}`);
    },
    onClose: () => { console.log("[gemini] closed"); closeAll(); },
    onError: (e) => { console.error("[gemini] error", e.message); closeAll(); },
  });

  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.event) {
      case "start":
        streamSid = msg.start?.streamSid;
        callSid = msg.start?.callSid || msg.start?.customParameters?.callSid;
        callerNumber = msg.start?.customParameters?.callerNumber || null;
        console.log(`[ws] stream started callSid=${callSid} caller=${callerNumber}`);

        dashboard.broadcast({ type: "call_start", from: callerNumber, timestamp: new Date().toISOString() });
        dashboard.broadcast({ type: "status", status: "connected" });

        // Reconnaissance de l'appelant
        const caller = callerNumber ? getCaller(callerNumber) : null;
        let nudge;
        if (caller && caller.name !== "Inconnu") {
          nudge = `(Appel entrant de ${caller.name}, dernière interaction le ${caller.lastDate} au sujet de "${caller.lastSubject}". Salue-le par son prénom, mentionne brièvement son dernier sujet, puis demande comment tu peux l'aider.)`;
          dashboard.broadcast({ type: "returning_caller", name: caller.name, lastSubject: caller.lastSubject, lastDate: caller.lastDate });
        } else {
          nudge = "(Appel qui démarre — salue l'appelant avec ta phrase d'ouverture bilingue courte, puis attends.)";
        }
        setTimeout(() => gemini?.sendText(nudge), 300);
        break;

      case "media": {
        const mulaw = Buffer.from(msg.media.payload, "base64");
        const pcm16k = mulaw8kToPcm16k(mulaw);
        gemini?.sendAudio(pcm16k);
        break;
      }

      case "stop":
        console.log("[ws] stream stopped");
        closeAll();
        break;
    }
  });

  twilioWs.on("close", () => { console.log("[ws] twilio closed"); closeAll(); });
  twilioWs.on("error", (e) => { console.error("[ws] twilio error", e.message); closeAll(); });
});

server.listen(PORT, () => {
  console.log(`listening on :${PORT}  (public host = ${PUBLIC_HOST})`);
});
