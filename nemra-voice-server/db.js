import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { existsSync } from "node:fs";

const dataDir = existsSync("/data") ? "/data" : __dirname;
const db = new Database(join(dataDir, "nemra.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'agent' CHECK(role IN ('agent','supervisor','admin')),
    personal_phone TEXT DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid TEXT NOT NULL,
    recording_sid TEXT UNIQUE NOT NULL,
    recording_url TEXT NOT NULL,
    duration_seconds INTEGER DEFAULT 0,
    channels INTEGER DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','ready','failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export default db;
