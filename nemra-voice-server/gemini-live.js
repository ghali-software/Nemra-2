import WebSocket from "ws";
import { SYSTEM_PROMPT, INTERLOCUTORS } from "./prompt.js";

const MODEL = "models/gemini-3.1-flash-live-preview";
const URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "transfer_to_oumaima",
        description: `Transférer l'appel vers Oumaima (${INTERLOCUTORS.oumaima.role}). À utiliser pour : réservation, abonnement, tarifs, devis, visite, salle de réunion, formules, prospect commercial.`,
        parameters: { type: "OBJECT", properties: { caller_name: { type: "STRING", description: "Nom de l'appelant si mentionné pendant l'appel" }, subject: { type: "STRING", description: "Résumé court (5-10 mots) du besoin de l'appelant" } }, required: [] },
      },
      {
        name: "transfer_to_ghali",
        description: `Transférer l'appel vers Ghali (${INTERLOCUTORS.ghali.role}). À utiliser pour : partenariat, presse, média, événement, investisseur, demande à la direction.`,
        parameters: { type: "OBJECT", properties: { caller_name: { type: "STRING", description: "Nom de l'appelant si mentionné pendant l'appel" }, subject: { type: "STRING", description: "Résumé court (5-10 mots) du besoin de l'appelant" } }, required: [] },
      },
      {
        name: "transfer_to_zineb",
        description: `Transférer l'appel vers Zineb (${INTERLOCUTORS.zineb.role}). À utiliser pour : membres existants, support (wifi, badge, impression), réclamation, facture, incident sur place, urgence.`,
        parameters: { type: "OBJECT", properties: { caller_name: { type: "STRING", description: "Nom de l'appelant si mentionné pendant l'appel" }, subject: { type: "STRING", description: "Résumé court (5-10 mots) du besoin de l'appelant" } }, required: [] },
      },
      {
        name: "end_call",
        description: "Raccrocher poliment, par exemple si c'est un démarcheur, un faux numéro, ou à la fin d'un appel résolu sans transfert.",
        parameters: { type: "OBJECT", properties: {}, required: [] },
      },
    ],
  },
];

export function openGeminiSession({ apiKey, onAudio, onToolCall, onText, onClose, onError, onReady }) {
  const ws = new WebSocket(`${URL}?key=${apiKey}`);
  let ready = false;
  const pendingSends = [];

  const flush = () => {
    while (pendingSends.length && ws.readyState === WebSocket.OPEN) {
      ws.send(pendingSends.shift());
    }
  };

  const send = (obj) => {
    const payload = JSON.stringify(obj);
    if (ready && ws.readyState === WebSocket.OPEN) ws.send(payload);
    else pendingSends.push(payload);
  };

  ws.on("open", () => {
    console.log("[gemini] ws open, sending setup");
    const setup = {
      setup: {
        model: MODEL,
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        tools: TOOLS,
        generationConfig: {
          responseModalities: ["AUDIO"],
          temperature: 0.6,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    };
    ws.send(JSON.stringify(setup));
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.log(`[gemini] non-json msg: ${raw.toString().slice(0, 200)}`);
      return;
    }

    if (msg.setupComplete) {
      console.log("[gemini] setupComplete received");
      ready = true;
      flush();
      onReady?.();
      return;
    }

    // Audio sortant
    const parts = msg?.serverContent?.modelTurn?.parts || [];
    for (const p of parts) {
      if (p.inlineData?.mimeType?.startsWith("audio/") && p.inlineData.data) {
        onAudio(Buffer.from(p.inlineData.data, "base64"));
      }
    }

    // Transcriptions
    const input = msg?.serverContent?.inputTranscription?.text;
    const output = msg?.serverContent?.outputTranscription?.text;
    if (input) onText?.({ role: "user", text: input });
    if (output) onText?.({ role: "agent", text: output });

    // Tool calls — on tente plusieurs variantes de format
    const toolCallVariants = [
      msg?.toolCall?.functionCalls,
      msg?.toolCalls?.functionCalls,
      msg?.tool_call?.function_calls,
      msg?.serverContent?.modelTurn?.parts?.filter((p) => p.functionCall).map((p) => p.functionCall),
    ];
    for (const variant of toolCallVariants) {
      if (!Array.isArray(variant) || variant.length === 0) continue;
      for (const call of variant) {
        console.log(`[gemini] TOOL CALL: ${JSON.stringify(call)}`);
        onToolCall({ id: call.id, name: call.name, args: call.args || {} });
      }
      break;
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[gemini] close code=${code} reason="${reason?.toString()}"`);
    onClose?.();
  });
  ws.on("error", (e) => {
    console.error(`[gemini] error: ${e.message}`);
    onError?.(e);
  });
  ws.on("unexpected-response", (_req, res) => {
    let body = "";
    res.on("data", (c) => body += c);
    res.on("end", () => console.error(`[gemini] unexpected-response ${res.statusCode}: ${body.slice(0,500)}`));
  });

  return {
    sendAudio(pcm16kBuf) {
      send({
        realtimeInput: {
          audio: { mimeType: "audio/pcm;rate=16000", data: pcm16kBuf.toString("base64") },
        },
      });
    },
    sendText(text) {
      send({ realtimeInput: { text } });
    },
    sendToolResponse(id, name, response) {
      send({ toolResponse: { functionResponses: [{ id, name, response }] } });
    },
    close() {
      try { ws.close(); } catch {}
    },
  };
}
