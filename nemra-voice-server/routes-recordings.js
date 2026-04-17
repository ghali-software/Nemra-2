import { Router } from "express";
import db from "./db.js";
import { requireAuth, hasRole } from "./auth.js";

const router = Router();

// ── Twilio recording callback (public, no auth — Twilio calls this) ──
router.post("/twilio/recording-callback", (req, res) => {
  const {
    CallSid,
    RecordingSid,
    RecordingUrl,
    RecordingDuration,
    RecordingChannels,
    RecordingStatus,
  } = req.body || {};

  console.log(`[recording] callback: CallSid=${CallSid} RecordingSid=${RecordingSid} status=${RecordingStatus} duration=${RecordingDuration}s channels=${RecordingChannels}`);

  if (!CallSid || !RecordingSid || !RecordingUrl) {
    return res.status(400).send("Missing params");
  }

  const status = RecordingStatus === "completed" ? "ready" : "failed";

  try {
    db.prepare(`
      INSERT OR REPLACE INTO recordings (call_sid, recording_sid, recording_url, duration_seconds, channels, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      CallSid,
      RecordingSid,
      RecordingUrl,
      Number(RecordingDuration) || 0,
      Number(RecordingChannels) || 1,
      status
    );
    console.log(`[recording] saved: ${RecordingSid} (${status})`);
  } catch (e) {
    console.error(`[recording] db error: ${e.message}`);
  }

  res.status(204).end();
});

// ── List recordings (auth required) ──
router.get("/recordings", requireAuth, hasRole("admin", "supervisor"), (req, res) => {
  const { days } = req.query;
  let sql = "SELECT * FROM recordings WHERE status = 'ready'";
  const params = [];

  if (days && ["1", "7", "30"].includes(days)) {
    sql += " AND created_at >= datetime('now', ?)";
    params.push(`-${days} days`);
  }

  sql += " ORDER BY created_at DESC LIMIT 200";

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// ── Get single recording (auth required) ──
router.get("/recordings/:id", requireAuth, hasRole("admin", "supervisor"), (req, res) => {
  const row = db.prepare("SELECT * FROM recordings WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Enregistrement introuvable" });
  res.json(row);
});

// ── Stream recording audio (proxy to Twilio with auth, supports range requests) ──
// Auth via query param ?token=... because <audio> tag cannot send Authorization headers
router.get("/recordings/:id/stream", (req, res, next) => {
  // Allow token in query string for <audio> tag compatibility
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, requireAuth, hasRole("admin", "supervisor", "agent"), async (req, res) => {
  const row = db.prepare("SELECT * FROM recordings WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Enregistrement introuvable" });

  const mp3Url = row.recording_url + ".mp3";
  const twilioAuth = "Basic " + Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString("base64");

  const headers = { Authorization: twilioAuth };

  // Forward Range header for scrubbing support
  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  try {
    const twilioRes = await fetch(mp3Url, { headers });

    if (!twilioRes.ok && twilioRes.status !== 206) {
      console.error(`[recording] twilio stream error: ${twilioRes.status}`);
      return res.status(twilioRes.status).send("Twilio error");
    }

    res.status(twilioRes.status); // 200 or 206
    res.set("Content-Type", "audio/mpeg");

    // Forward relevant headers from Twilio
    const fwd = ["content-length", "content-range", "accept-ranges"];
    for (const h of fwd) {
      const val = twilioRes.headers.get(h);
      if (val) res.set(h, val);
    }

    twilioRes.body.pipe(res);
  } catch (e) {
    console.error(`[recording] stream error: ${e.message}`);
    res.status(500).json({ error: "Erreur streaming" });
  }
});

export default router;
