import fs from "node:fs";
import path from "node:path";
import { closeDb, dbPathFromTokenPath, openDb } from "../../db.js";

export function createBundle(raw = {}) {
  return {
    access_token: raw.access_token || "",
    refresh_token: raw.refresh_token || "",
    expires_at: Number(raw.expires_at || 0),
    token_type: raw.token_type || "Bearer",
    email: raw.email || null,
    project_id: raw.project_id || null,
    managed_project_id: raw.managed_project_id || null,
    scope: raw.scope || null,
    disabled_until: Number(raw.disabled_until || 0),
    disabled_reason: raw.disabled_reason || null,
    enabled: raw.enabled !== false,
    last_used: Number(raw.last_used || 0),
    request_count: Number(raw.request_count || 0),
    error_count: Number(raw.error_count || 0),
    success_count: Number(raw.success_count || 0),
    prompt_tokens: Number(raw.prompt_tokens || 0),
    completion_tokens: Number(raw.completion_tokens || 0),
    quotas: Array.isArray(raw.quotas) ? raw.quotas : [],
    quotas_at: Number(raw.quotas_at || 0),
  };
}

export function accountIdOf(bundle) {
  const email = String(bundle?.email || "").trim().toLowerCase();
  if (email) return email;
  const refresh = String(bundle?.refresh_token || "").trim();
  return refresh ? `rt-${refresh.slice(-12)}` : "";
}

export function parseResetMs(value, now = Date.now()) {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  const raw = String(value).trim();
  if (!raw) return 0;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const num = Number(raw);
    return num > 1e12 ? num : num * 1000;
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;
  const relative = raw.match(/(\d+)\s*(second|minute|hour|day)s?/i);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = unit.startsWith("day")
      ? n * 86_400_000
      : unit.startsWith("hour")
        ? n * 3_600_000
        : unit.startsWith("minute")
          ? n * 60_000
          : n * 1_000;
    return now + ms;
  }
  return 0;
}

export function isManuallyDisabled(bundle) {
  return bundle?.enabled === false;
}

export function isAccountDisabled(bundle, now = Date.now()) {
  if (!bundle) return true;
  if (bundle.enabled === false) return true;
  return Number(bundle.disabled_until || 0) > now;
}

export function setAccountEnabled(bundle, enabled) {
  return createBundle({
    ...bundle,
    enabled: Boolean(enabled),
    disabled_until: enabled ? 0 : bundle.disabled_until,
    disabled_reason: enabled ? null : bundle.disabled_reason || "manual",
  });
}

export function touchAccountStats(bundle, { ok = true, prompt = 0, completion = 0, now = Date.now() } = {}) {
  return createBundle({
    ...bundle,
    last_used: now,
    request_count: Number(bundle.request_count || 0) + 1,
    success_count: Number(bundle.success_count || 0) + (ok ? 1 : 0),
    error_count: Number(bundle.error_count || 0) + (ok ? 0 : 1),
    prompt_tokens: Number(bundle.prompt_tokens || 0) + Number(prompt || 0),
    completion_tokens: Number(bundle.completion_tokens || 0) + Number(completion || 0),
  });
}

const EMPTY_USAGE = { requests: 0, success: 0, failed: 0, prompt_tokens: 0, completion_tokens: 0 };

export function emptyUsageStats() {
  return { ...EMPTY_USAGE };
}

export function parseUsageStats(raw) {
  if (!raw) return emptyUsageStats();
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return emptyUsageStats();
    }
  }
  if (!parsed || typeof parsed !== "object") return emptyUsageStats();
  return {
    requests: Number(parsed.requests || 0),
    success: Number(parsed.success || 0),
    failed: Number(parsed.failed || parsed.error_count || 0),
    prompt_tokens: Number(parsed.prompt_tokens || 0),
    completion_tokens: Number(parsed.completion_tokens || 0),
  };
}

export function addUsageStats(base, extra = {}) {
  const current = parseUsageStats(base);
  return {
    requests: current.requests + Number(extra.requests || extra.request_count || 0),
    success: current.success + Number(extra.success || extra.success_count || 0),
    failed: current.failed + Number(extra.failed || extra.error_count || 0),
    prompt_tokens: current.prompt_tokens + Number(extra.prompt_tokens || extra.prompt || 0),
    completion_tokens: current.completion_tokens + Number(extra.completion_tokens || extra.completion || 0),
  };
}

export function usageFromBundle(bundle) {
  if (!bundle) return emptyUsageStats();
  return {
    requests: Number(bundle.request_count || 0),
    success: Number(bundle.success_count || 0),
    failed: Number(bundle.error_count || 0),
    prompt_tokens: Number(bundle.prompt_tokens || 0),
    completion_tokens: Number(bundle.completion_tokens || 0),
  };
}

export function disableAccount(bundle, { until, reason, now = Date.now() } = {}) {
  const untilMs = parseResetMs(until, now) || now + 3_600_000;
  return createBundle({
    ...bundle,
    disabled_until: untilMs,
    disabled_reason: reason || "quota",
  });
}

export function enableAccount(bundle) {
  return createBundle({ ...bundle, disabled_until: 0, disabled_reason: null });
}

export function isQuotaError(err) {
  if (!err) return false;
  const blob = `${err.status || ""} ${err.code || ""} ${err.message || ""}`.toLowerCase();
  return (
    err.status === 429 ||
    blob.includes("resource_exhausted") ||
    blob.includes("quota") ||
    blob.includes("rate limit") ||
    blob.includes("too many requests") ||
    blob.includes("limit reached") ||
    blob.includes("limit resets")
  );
}

export function isRetryableUpstreamError(err) {
  if (!err) return false;
  if (err.name === "AbortError" || err.name === "AuthRequiredError") return false;
  if (isQuotaError(err)) return true;
  if (err.name === "ProjectError" || err.name === "OAuthError") return true;
  const status = Number(err.status || 0);
  const blob = `${err.code || ""} ${err.message || ""} ${err.cause || ""}`.toLowerCase();
  if (status === 401 || status === 403) return true;
  if (status >= 500) return true;
  if (status === 400 && (blob.includes("project") || blob.includes("permission") || blob.includes("precondition"))) return true;
  if (status === 400 || status === 404) return false;
  return (
    blob.includes("unavailable") ||
    blob.includes("internal") ||
    blob.includes("deadline") ||
    blob.includes("aborted") ||
    blob.includes("econnreset") ||
    blob.includes("econnrefused") ||
    blob.includes("etimedout") ||
    blob.includes("socket hang up") ||
    blob.includes("network") ||
    blob.includes("timed out")
  );
}

export function cooldownUntil(err, now = Date.now()) {
  if (isQuotaError(err)) return parseResetMs(resetHintFromError(err), now) || now + 3_600_000;
  const status = Number(err?.status || 0);
  if (status === 401 || err?.name === "OAuthError") return now + 300_000;
  if (status === 403 || err?.name === "ProjectError") return now + 120_000;
  return now + 30_000;
}

export function resetHintFromError(err) {
  const text = String(err?.message || "");
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (iso) return iso[0];
  const resets = text.match(/resets?\s+([^.,;]+)/i);
  if (resets) return resets[1].trim();
  return null;
}

export function projectOf(bundle) {
  return bundle?.managed_project_id || bundle?.project_id || null;
}

export function isExpired(bundle, skewS = 120) {
  return !bundle?.access_token || bundle.expires_at - skewS <= Date.now() / 1000;
}

export function packedRefresh(bundle) {
  const parts = [bundle.refresh_token];
  if (bundle.project_id) parts.push(bundle.project_id);
  if (bundle.managed_project_id) parts.push(bundle.managed_project_id);
  return parts.join("|");
}

export function parsePackedRefresh(value) {
  const bits = String(value || "").split("|");
  return {
    refresh: bits[0] || "",
    project: bits[1] || null,
    managed: bits[2] || null,
  };
}

function normalizeAccounts(raw) {
  if (Array.isArray(raw)) return raw.map((item) => createBundle(item)).filter((item) => item.refresh_token);
  if (raw && typeof raw === "object" && Array.isArray(raw.accounts)) {
    return raw.accounts.map((item) => createBundle(item)).filter((item) => item.refresh_token);
  }
  if (raw && typeof raw === "object" && raw.refresh_token) return [createBundle(raw)];
  return [];
}

function parseQuotas(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToBundle(row) {
  if (!row) return null;
  return createBundle({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expires_at: row.expires_at,
    token_type: row.token_type,
    email: row.email,
    project_id: row.project_id,
    managed_project_id: row.managed_project_id,
    scope: row.scope,
    disabled_until: row.disabled_until,
    disabled_reason: row.disabled_reason,
    enabled: Number(row.enabled) !== 0,
    last_used: row.last_used,
    request_count: row.request_count,
    error_count: row.error_count,
    success_count: row.success_count,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    quotas: parseQuotas(row.quotas_json),
    quotas_at: row.quotas_at,
  });
}

function jsonLegacyPath(filePath) {
  if (filePath.endsWith(".db")) return filePath.slice(0, -3) + ".json";
  return filePath.endsWith(".json") ? filePath : `${filePath}.json`;
}

export class TokenStore {
  constructor(filePath) {
    this.path = dbPathFromTokenPath(filePath);
    this.jsonPath = jsonLegacyPath(filePath);
    this.db = openDb(this.path);
    this.migrateFromJson();
  }

  migrateFromJson() {
    if (!fs.existsSync(this.jsonPath)) return;
    const already = this.db.prepare("SELECT COUNT(*) AS n FROM accounts").get();
    if (Number(already?.n || 0) > 0) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.jsonPath, "utf8"));
      const accounts = normalizeAccounts(parsed);
      const active =
        parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.active || null : null;
      for (const account of accounts) this.save(account, { activate: false });
      if (active) this.use(active);
      else if (accounts[0]) this.use(accountIdOf(accounts[0]));
    } catch {
      // leave empty db if the json is unreadable
    }
  }

  getMeta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? String(row.value) : null;
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value == null ? "" : String(value));
  }

  lifetimeStats() {
    return parseUsageStats(this.getMeta("lifetime_stats"));
  }

  addLifetimeStats(extra = {}) {
    const next = addUsageStats(this.lifetimeStats(), extra);
    this.setMeta("lifetime_stats", JSON.stringify(next));
    return next;
  }

  rememberRemovedUsage(bundle) {
    return this.addLifetimeStats(usageFromBundle(bundle));
  }

  list() {
    return this.db.prepare("SELECT * FROM accounts ORDER BY email COLLATE NOCASE, id").all().map(rowToBundle);
  }

  load() {
    const active = this.getMeta("active");
    if (active) {
      const row = this.db.prepare("SELECT * FROM accounts WHERE id = ? OR lower(email) = ?").get(active, active);
      if (row) return rowToBundle(row);
    }
    const first = this.db.prepare("SELECT * FROM accounts ORDER BY email COLLATE NOCASE, id LIMIT 1").get();
    return rowToBundle(first);
  }

  save(bundle, options = {}) {
    const next = createBundle(bundle);
    if (!next.refresh_token) throw new Error("Cannot save a token bundle without a refresh_token");
    const existing =
      this.db.prepare("SELECT * FROM accounts WHERE refresh_token = ? OR id = ? OR (email IS NOT NULL AND lower(email) = ?)").get(
        next.refresh_token,
        accountIdOf(next),
        String(next.email || "").toLowerCase(),
      );
    const prev = rowToBundle(existing);
    const merged = createBundle({
      ...(prev || {}),
      ...next,
      email: next.email || prev?.email || null,
      project_id: next.project_id || prev?.project_id || null,
      managed_project_id: next.managed_project_id || prev?.managed_project_id || null,
      disabled_until: Object.hasOwn(bundle, "disabled_until") ? next.disabled_until : prev?.disabled_until || 0,
      disabled_reason: Object.hasOwn(bundle, "disabled_reason") ? next.disabled_reason : prev?.disabled_reason || null,
      enabled: Object.hasOwn(bundle, "enabled") ? next.enabled : prev ? prev.enabled : true,
      last_used: Math.max(next.last_used || 0, prev?.last_used || 0),
      request_count: Object.hasOwn(bundle, "request_count") ? next.request_count : prev?.request_count || 0,
      error_count: Object.hasOwn(bundle, "error_count") ? next.error_count : prev?.error_count || 0,
      success_count: Object.hasOwn(bundle, "success_count") ? next.success_count : prev?.success_count || 0,
      prompt_tokens: Object.hasOwn(bundle, "prompt_tokens") ? next.prompt_tokens : prev?.prompt_tokens || 0,
      completion_tokens: Object.hasOwn(bundle, "completion_tokens") ? next.completion_tokens : prev?.completion_tokens || 0,
      quotas: Object.hasOwn(bundle, "quotas") ? next.quotas : prev?.quotas || [],
      quotas_at: Object.hasOwn(bundle, "quotas_at") ? next.quotas_at : prev?.quotas_at || 0,
    });
    const id = accountIdOf(merged);
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
    if (existing && existing.id !== id) {
      this.db.prepare("UPDATE accounts SET id = ? WHERE id = ?").run(id, existing.id);
      if (this.getMeta("active") === existing.id) this.setMeta("active", id);
    }
    this.db
      .prepare(
        `INSERT INTO accounts (
          id, email, refresh_token, access_token, expires_at, token_type, project_id, managed_project_id, scope,
          enabled, disabled_until, disabled_reason, last_used, request_count, error_count, success_count,
          prompt_tokens, completion_tokens, quotas_json, quotas_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          refresh_token = excluded.refresh_token,
          access_token = excluded.access_token,
          expires_at = excluded.expires_at,
          token_type = excluded.token_type,
          project_id = excluded.project_id,
          managed_project_id = excluded.managed_project_id,
          scope = excluded.scope,
          enabled = excluded.enabled,
          disabled_until = excluded.disabled_until,
          disabled_reason = excluded.disabled_reason,
          last_used = excluded.last_used,
          request_count = excluded.request_count,
          error_count = excluded.error_count,
          success_count = excluded.success_count,
          prompt_tokens = excluded.prompt_tokens,
          completion_tokens = excluded.completion_tokens,
          quotas_json = excluded.quotas_json,
          quotas_at = excluded.quotas_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        merged.email,
        merged.refresh_token,
        merged.access_token,
        merged.expires_at,
        merged.token_type,
        merged.project_id,
        merged.managed_project_id,
        merged.scope,
        merged.enabled ? 1 : 0,
        merged.disabled_until,
        merged.disabled_reason,
        merged.last_used,
        merged.request_count,
        merged.error_count,
        merged.success_count,
        merged.prompt_tokens,
        merged.completion_tokens,
        JSON.stringify(merged.quotas || []),
        merged.quotas_at,
        existing?.created_at || now,
        now,
      );
    if (options.activate !== false) this.setMeta("active", id);
    this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already closed or no transaction
      }
      throw err;
    }
    return merged;
  }

  use(id) {
    const wanted = String(id || "").trim().toLowerCase();
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ? OR lower(email) = ?").get(wanted, wanted);
    if (!row) return null;
    this.setMeta("active", row.id);
    return rowToBundle(row);
  }

  remove(id) {
    const wanted = String(id || "").trim().toLowerCase();
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ? OR lower(email) = ?").get(wanted, wanted);
    if (!row) return false;
    this.rememberRemovedUsage(rowToBundle(row));
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(row.id);
    if (this.getMeta("active") === row.id) {
      const next = this.db.prepare("SELECT id FROM accounts ORDER BY email COLLATE NOCASE, id LIMIT 1").get();
      this.setMeta("active", next ? next.id : "");
    }
    return true;
  }

  clear() {
    for (const bundle of this.list()) this.rememberRemovedUsage(bundle);
    this.db.exec("DELETE FROM accounts");
    this.setMeta("active", "");
  }

  close() {
    closeDb(this.path);
    this.db = null;
  }
}
