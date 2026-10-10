import { dbPathFromTokenPath, openDb } from "../../db.js";

export class ResponseStore {
  constructor(tokenPath) {
    this.db = openDb(dbPathFromTokenPath(tokenPath));
    this.db.exec(`CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY,
      model TEXT,
      messages_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at REAL
    )`);
  }

  save({ id, model, messages, response, createdAt = Date.now() }) {
    if (!id) throw new Error("response id required");
    this.db
      .prepare(
        `INSERT INTO responses (id, model, messages_json, response_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           model = excluded.model,
           messages_json = excluded.messages_json,
           response_json = excluded.response_json,
           created_at = excluded.created_at`,
      )
      .run(id, model || "", JSON.stringify(messages || []), JSON.stringify(response || {}), createdAt);
    return id;
  }

  load(id) {
    const row = this.db.prepare("SELECT * FROM responses WHERE id = ?").get(String(id || ""));
    if (!row) return null;
    return {
      id: row.id,
      model: row.model,
      messages: parseJson(row.messages_json, []),
      response: parseJson(row.response_json, null),
      created_at: row.created_at,
    };
  }

  remove(id) {
    const result = this.db.prepare("DELETE FROM responses WHERE id = ?").run(String(id || ""));
    return Number(result.changes || 0) > 0;
  }
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
