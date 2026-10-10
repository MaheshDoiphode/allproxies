import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT,
  refresh_token TEXT NOT NULL UNIQUE,
  access_token TEXT,
  expires_at REAL DEFAULT 0,
  token_type TEXT,
  project_id TEXT,
  managed_project_id TEXT,
  scope TEXT,
  enabled INTEGER DEFAULT 1,
  disabled_until REAL DEFAULT 0,
  disabled_reason TEXT,
  last_used REAL DEFAULT 0,
  request_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  quotas_json TEXT DEFAULT '[]',
  quotas_at REAL DEFAULT 0,
  created_at REAL,
  updated_at REAL
);
CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  model TEXT,
  messages_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at REAL
);
`;

const POOLS = new Map();

export function dbPathFromTokenPath(tokenPath) {
  if (!tokenPath) return tokenPath;
  if (tokenPath.endsWith(".db")) return tokenPath;
  if (tokenPath.endsWith(".json")) return tokenPath.slice(0, -5) + ".db";
  return `${tokenPath}.db`;
}

export function openDb(filePath) {
  const resolved = path.resolve(filePath);
  const existing = POOLS.get(resolved);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  POOLS.set(resolved, db);
  return db;
}

export function closeDb(filePath) {
  const resolved = path.resolve(filePath);
  const db = POOLS.get(resolved);
  if (!db) return;
  try {
    db.close();
  } catch {
    // already closed
  }
  POOLS.delete(resolved);
}

export function closeAllDbs() {
  for (const filePath of [...POOLS.keys()]) closeDb(filePath);
}
