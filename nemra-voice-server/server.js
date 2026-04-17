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
import { loadCallers, getCaller, saveCaller, getAllCallers } from "./caller-store.js";
import { sendCallSummary } from "./sms.js";
import { loadHistory, saveCall, getHistory, getStats } from "./call-history.js";
import { seedAdmin } from "./auth.js";
import authRoutes from "./routes-auth.js";

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
loadHistory();

// ── Seed admin user ──
const adminPwd = seedAdmin();
if (adminPwd) console.log(`\n  Admin cree : admin@nemra.ma / ${adminPwd}\n`);

const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
const app = express();

app.use(express.static(join(__dirname, "public")));
app.get("/dashboard", (_req, res) => res.sendFile(join(__dirname, "public", "index.html")));
app.get("/login", (_req, res) => res.sendFile(join(__dirname, "public", "login.html")));
app.get("/users", (_req, res) => res.sendFile(join(__dirname, "public", "users.html")));

// ── Auth & User management routes ──
app.use("/api", express.json(), authRoutes);

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

app.get("/api/stats", (_req, res) => res.json(getStats()));
app.get("/api/history", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(getHistory(limit));
});

// ── Export endpoints ──
app.get("/api/export/history", (_req, res) => {
  res.json(getHistory(500));
});

app.get("/api/export/callers", (_req, res) => {
  const callers = getAllCallers();
  const list = Object.entries(callers).map(([phone, data]) => ({
    phone,
    name: data.name,
    lastSubject: data.lastSubject,
    lastDate: data.lastDate,
  }));
  res.json(list);
});

app.get("/api/export/transcriptions", (_req, res) => {
  const all = getHistory(500);
  const transcriptions = all
    .filter((c) => c.transcript && c.transcript.length > 0)
    .map((c) => ({
      date: c.date,
      from: c.from,
      callerName: c.callerName,
      intent: c.intent,
      transferTo: c.transferTo,
      sentiment: c.sentiment,
      duration: c.duration,
      transcript: c.transcript.map((t) => `${t.role}: ${t.text}`).join("\n"),
    }));
  res.json(transcriptions);
});

// ── Send message/alert to interlocutor ──
app.post("/api/send-message", express.json(), async (req, res) => {
  const { target, message } = req.body || {};
  if (!target || !message) {
    return res.status(400).json({ error: "target and message required" });
  }

  const interlocutor = INTERLOCUTORS[target.toLowerCase()];
  if (!interlocutor) {
    return res.status(400).json({ error: `Unknown target: ${target}` });
  }

  try {
    await twilioClient.messages.create({
      body: `[Nemra AI] ${message}`,
      from: TWILIO_NUMBER,
      to: interlocutor.number,
    });
    console.log(`[alert] SMS sent to ${interlocutor.name} (${interlocutor.number})`);
    dashboard.broadcast({
      type: "alert_sent",
      target: interlocutor.name,
      message,
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true, sentTo: interlocutor.name });
  } catch (e) {
    console.error(`[alert] SMS error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Simulation endpoint for demo ──
const SIMULATION_SCENARIOS = [
  {
    name: "Prospect commercial (Darija)",
    from: "+212600000001",
    messages: [
      { role: "agent", text: "Salam 3likoum, bonjour, Nemra à votre écoute, kifach n3awnek ?", delay: 800 },
      { role: "user", text: "Salam, bghit n3rf chhal taman dyal bureau shahri 3ndkom?", delay: 2500 },
      { role: "agent", text: "Mezyan, ghadi n7awlek m3a Oumaima, hya ghadi t3tik l-taman u tsayeb lik visite. Stena chwiya.", delay: 2000 },
    ],
    intent: "Tarifs bureau mensuel",
    target: "oumaima",
    sentiment: "positive",
    callerName: "Youssef",
  },
  {
    name: "Problème WiFi urgent (Darija)",
    from: "+212600000002",
    messages: [
      { role: "agent", text: "Salam 3likoum, bonjour, Nemra à votre écoute, kifach n3awnek ?", delay: 800 },
      { role: "user", text: "Wifi makhdemch 3ndi daba f Nemra, ana membre!", delay: 2000 },
      { role: "agent", text: "Sma7 lia 3la had l-mochkil. Kan7awlek daba m3a Zineb, hya ghadi tssayeb hadi.", delay: 1800 },
    ],
    intent: "Problème WiFi — urgent",
    target: "zineb",
    sentiment: "negative",
    callerName: "Fatima",
  },
  {
    name: "Partenariat (Français)",
    from: "+33600000003",
    messages: [
      { role: "agent", text: "Salam 3likoum, bonjour, Nemra à votre écoute, kifach n3awnek ?", delay: 800 },
      { role: "user", text: "Bonjour, je représente WeWork et j'appelle pour discuter d'un partenariat stratégique.", delay: 2500 },
      { role: "agent", text: "Avec plaisir, je vous mets en relation avec Ghali, le fondateur. Ne quittez pas.", delay: 2000 },
    ],
    intent: "Partenariat stratégique",
    target: "ghali",
    sentiment: "positive",
    callerName: "Marc Dupont",
  },
];

app.post("/api/simulate", express.json(), (req, res) => {
  const idx = Number(req.body?.scenario ?? Math.floor(Math.random() * SIMULATION_SCENARIOS.length));
  const scenario = SIMULATION_SCENARIOS[idx % SIMULATION_SCENARIOS.length];
  res.json({ ok: true, scenario: scenario.name });

  const target = INTERLOCUTORS[scenario.target];
  let totalDelay = 0;

  // call_start
  dashboard.broadcast({ type: "call_start", from: scenario.from, timestamp: new Date().toISOString(), simulated: true });
  dashboard.broadcast({ type: "status", status: "connected" });
  dashboard.broadcast({ type: "sentiment", sentiment: "neutral" });

  // Messages
  for (const msg of scenario.messages) {
    totalDelay += msg.delay;
    setTimeout(() => {
      dashboard.broadcast({ type: "transcript", role: msg.role, text: msg.text });
    }, totalDelay);
  }

  // Sentiment update
  setTimeout(() => {
    dashboard.broadcast({ type: "sentiment", sentiment: scenario.sentiment });
  }, totalDelay + 500);

  // Intent
  setTimeout(() => {
    dashboard.broadcast({ type: "intent", intent: scenario.intent, target: target.name });
  }, totalDelay + 1000);

  // Transfer
  setTimeout(() => {
    dashboard.broadcast({ type: "transfer", target: target.name, role: target.role, number: target.number });
    dashboard.broadcast({ type: "status", status: "transferring" });
  }, totalDelay + 1500);

  // Transferred
  setTimeout(() => {
    dashboard.broadcast({ type: "status", status: "transferred" });
  }, totalDelay + 3500);

  // End
  const endDelay = totalDelay + 5000;
  setTimeout(() => {
    const duration = Math.round(endDelay / 1000);
    dashboard.broadcast({ type: "call_end", duration });

    saveCall({
      date: new Date().toISOString(),
      from: scenario.from,
      callerName: scenario.callerName,
      intent: scenario.intent,
      transferTo: target.name,
      action: `transfer_to_${scenario.target}`,
      duration,
      qualificationTime: Math.round((totalDelay + 1000) / 1000),
      sentiment: scenario.sentiment,
      status: "transferred",
      simulated: true,
      transcript: scenario.messages.map((m) => ({ role: m.role, text: m.text })),
    });
    dashboard.broadcast({ type: "stats_update", stats: getStats() });
    dashboard.broadcast({ type: "history_update", history: getHistory(20) });
  }, endDelay);
});

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
  let callIntent = null;
  let callTransferTo = null;
  let callAction = null;
  let callCallerName = null;
  let callSentiment = "neutral";
  let intentDetectedAt = null;

  const closeAll = () => {
    if (closed) return;
    closed = true;
    const dur = Math.round((Date.now() - callStart) / 1000);
    dashboard.broadcast({ type: "call_end", duration: dur });
    console.log(`[call] ended after ${dur}s`);

    // Save to history
    saveCall({
      date: new Date().toISOString(),
      from: callerNumber,
      callerName: callCallerName || "Inconnu",
      intent: callIntent,
      transferTo: callTransferTo,
      action: callAction,
      duration: dur,
      qualificationTime: intentDetectedAt ? Math.round((intentDetectedAt - callStart) / 1000) : 0,
      sentiment: callSentiment,
      status: callAction === "end_call" ? "ended" : callTransferTo ? "transferred" : "ended",
      transcript: transcript.map((t) => ({ role: t.role, text: t.text })),
    });
    dashboard.broadcast({ type: "stats_update", stats: getStats() });
    dashboard.broadcast({ type: "history_update", history: getHistory(20) });
    try { gemini?.close(); } catch {}
    try { twilioWs.close(); } catch {}
  };

  const handleToolCall = async ({ id, name, args }) => {
    console.log(`[tool] ${name}(${JSON.stringify(args)}) callSid=${callSid}`);

    if (name === "end_call") {
      callAction = "end_call";
      intentDetectedAt = intentDetectedAt || Date.now();
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

    // Metadata for history
    const subject = args.subject || name.replace("transfer_to_", "");
    callIntent = subject;
    callTransferTo = target.name;
    callAction = name;
    callCallerName = args.caller_name || callCallerName;
    intentDetectedAt = intentDetectedAt || Date.now();

    // Dashboard : intent + transfer
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
      if (twilioWs.readyState !== 1) return;
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

      // Simple sentiment detection on user messages
      if (role === "user") {
        const lower = text.toLowerCase();
        const urgentWords = ["urgent", "mochkil", "mushkil", "problème", "probleme", "makhdemch", "khsara", "3ajal", "daba", "maintenant", "grave", "cassé"];
        const negativeWords = ["makanch", "makhdemch", "mafhmtch", "nchki", "réclamation", "plainte", "en colère", "pas content", "nul"];
        const positiveWords = ["chokran", "merci", "parfait", "super", "mezyan", "excellent", "wakha", "bien"];

        if (urgentWords.some((w) => lower.includes(w))) {
          callSentiment = "urgent";
        } else if (negativeWords.some((w) => lower.includes(w))) {
          callSentiment = "negative";
        } else if (positiveWords.some((w) => lower.includes(w))) {
          callSentiment = "positive";
        }
        dashboard.broadcast({ type: "sentiment", sentiment: callSentiment });
      }
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
