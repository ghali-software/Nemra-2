import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, "callers.json");

const store = new Map();

export function loadCallers() {
  try {
    const data = JSON.parse(readFileSync(FILE, "utf-8"));
    for (const [k, v] of Object.entries(data)) store.set(k, v);
    console.log(`[callers] loaded ${store.size} callers`);
  } catch {
    console.log("[callers] no existing file, starting fresh");
  }
}

export function getCaller(phone) {
  return store.get(phone) || null;
}

export function getAllCallers() {
  return Object.fromEntries(store);
}

export function saveCaller(phone, { name, subject }) {
  store.set(phone, {
    name: name || "Inconnu",
    lastSubject: subject || "Non précisé",
    lastDate: new Date().toISOString().slice(0, 10),
  });
  try {
    writeFileSync(FILE, JSON.stringify(Object.fromEntries(store), null, 2));
  } catch (e) {
    console.error("[callers] write error:", e.message);
  }
}
