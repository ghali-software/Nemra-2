import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, "call-history.json");

let history = [];

export function loadHistory() {
  try {
    history = JSON.parse(readFileSync(FILE, "utf-8"));
    console.log(`[history] loaded ${history.length} calls`);
  } catch {
    console.log("[history] no existing file, starting fresh");
  }
}

export function saveCall(call) {
  history.unshift(call); // newest first
  if (history.length > 500) history = history.slice(0, 500);
  try {
    writeFileSync(FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error("[history] write error:", e.message);
  }
}

export function getHistory(limit = 50) {
  return history.slice(0, limit);
}

export function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const todayCalls = history.filter((c) => c.date?.startsWith(today));
  const weekCalls = history.filter((c) => c.date >= weekAgo);

  const byAgent = { oumaima: 0, ghali: 0, zineb: 0, end_call: 0 };
  for (const c of history) {
    const key = c.transferTo?.toLowerCase() || (c.action === "end_call" ? "end_call" : null);
    if (key && key in byAgent) byAgent[key]++;
  }

  const durations = history.filter((c) => c.duration > 0).map((c) => c.duration);
  const avgDuration = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  const qualifTimes = history.filter((c) => c.qualificationTime > 0).map((c) => c.qualificationTime);
  const avgQualif = qualifTimes.length ? Math.round(qualifTimes.reduce((a, b) => a + b, 0) / qualifTimes.length) : 0;

  const sentiments = { positive: 0, neutral: 0, negative: 0, urgent: 0 };
  for (const c of history) {
    if (c.sentiment && sentiments[c.sentiment] !== undefined) sentiments[c.sentiment]++;
  }

  return {
    total: history.length,
    today: todayCalls.length,
    thisWeek: weekCalls.length,
    byAgent,
    avgDuration,
    avgQualificationTime: avgQualif,
    sentiments,
    successRate: history.length
      ? Math.round((history.filter((c) => c.status === "transferred").length / history.length) * 100)
      : 0,
  };
}
