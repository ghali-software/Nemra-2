const GEMINI_REST = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

const SUMMARY_PROMPT = `Tu reçois la transcription d'un appel téléphonique reçu par le standard IA de Nemra Cowork. Génère un résumé SMS ultra-court (max 300 caractères) en français pour la personne vers qui l'appel est transféré. Format :

[Nemra AI] Appel transféré
De: <numéro>
Objet: <1 ligne>
Détails: <1 ligne>

Sois concis. Pas de salutation. Si la transcription est en darija, traduis en français pour le SMS.`;

export async function sendCallSummary({ twilioClient, geminiApiKey, transcript, callerNumber, target, fromNumber }) {
  if (!transcript.length) return;

  const convo = transcript.map((t) => `${t.role}: ${t.text}`).join("\n");

  try {
    const res = await fetch(`${GEMINI_REST}?key=${geminiApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${SUMMARY_PROMPT}\n\nNuméro appelant: ${callerNumber}\nTransféré vers: ${target.name} (${target.role})\n\nTranscription:\n${convo}` }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.2 },
      }),
    });

    const data = await res.json();
    const summary = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!summary) { console.error("[sms] no summary generated"); return; }

    await twilioClient.messages.create({
      body: summary.slice(0, 480),
      from: fromNumber,
      to: target.number,
    });
    console.log(`[sms] sent to ${target.name} (${target.number})`);
  } catch (e) {
    console.error(`[sms] error: ${e.message}`);
  }
}
