const WINDOW_ORDER = ["hourly", "5h", "daily", "weekly", "monthly"];

function asNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asIso(value) {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const raw = String(value);
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? raw : new Date(parsed).toISOString();
}

export function classifyWindow(label, resetTime) {
  const blob = String(label || "").toLowerCase();
  if (blob.includes("5") && (blob.includes("hour") || blob.includes("hr"))) return "5h";
  if (blob.includes("hour")) return "hourly";
  if (blob.includes("week")) return "weekly";
  if (blob.includes("month")) return "monthly";
  if (blob.includes("day") || blob.includes("daily")) return "daily";
  if (!resetTime) return "unknown";
  const ms = Date.parse(resetTime) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "unknown";
  if (ms <= 90 * 60 * 1000) return "hourly";
  if (ms <= 6 * 60 * 60 * 1000) return "5h";
  if (ms <= 36 * 60 * 60 * 1000) return "daily";
  if (ms <= 10 * 24 * 60 * 60 * 1000) return "weekly";
  return "monthly";
}

function pickRemaining(entry) {
  const remaining =
    asNumber(entry.remainingFraction) ??
    asNumber(entry.remaining_fraction) ??
    asNumber(entry.remaining) ??
    asNumber(entry.remainingPercent);
  if (remaining == null) return null;
  return remaining > 1 ? remaining / 100 : remaining;
}

function pickUsed(entry, remaining) {
  const used =
    asNumber(entry.usedFraction) ??
    asNumber(entry.used_fraction) ??
    asNumber(entry.usagePercent) ??
    asNumber(entry.used);
  if (used != null) return used > 1 ? used / 100 : used;
  if (remaining != null) return Math.max(0, Math.min(1, 1 - remaining));
  return null;
}

export function normalizeQuotaEntry(raw, fallbackLabel = "") {
  const entry = raw && typeof raw === "object" ? raw : {};
  const label = String(entry.displayName || entry.name || entry.quotaId || entry.id || fallbackLabel || "Quota");
  const resetTime = asIso(entry.resetTime || entry.reset_time || entry.resetAt || entry.nextResetTime);
  const remaining = pickRemaining(entry);
  const used = pickUsed(entry, remaining);
  const limit = asNumber(entry.limit) ?? asNumber(entry.quotaLimit) ?? asNumber(entry.max);
  const current = asNumber(entry.current) ?? asNumber(entry.usage) ?? asNumber(entry.usedAbsolute);
  return {
    id: String(entry.quotaId || entry.id || label).toLowerCase().replace(/\s+/g, "-"),
    label,
    window: classifyWindow(label, resetTime),
    remaining,
    used,
    limit,
    current,
    reset_time: resetTime,
    model: entry.model || entry.modelId || null,
  };
}

function walkQuotaNodes(payload, out = []) {
  if (!payload) return out;
  if (Array.isArray(payload)) {
    for (const item of payload) walkQuotaNodes(item, out);
    return out;
  }
  if (typeof payload !== "object") return out;
  const looksLikeQuota =
    payload.remainingFraction != null ||
    payload.remaining_fraction != null ||
    payload.resetTime != null ||
    payload.reset_time != null ||
    payload.quotaId != null ||
    (payload.limit != null && (payload.used != null || payload.current != null));
  if (looksLikeQuota) out.push(payload);
  for (const value of Object.values(payload)) {
    if (value && (typeof value === "object" || Array.isArray(value))) walkQuotaNodes(value, out);
  }
  return out;
}

export function parseQuotaSummary(payload) {
  const nodes = walkQuotaNodes(payload);
  const seen = new Set();
  const quotas = [];
  for (const node of nodes) {
    const item = normalizeQuotaEntry(node);
    if (isInternalModelId(item.id) || isInternalModelId(item.label) || isInternalModelId(item.model || "")) continue;
    const key = `${item.window}:${item.label}:${item.reset_time || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    quotas.push(item);
  }
  quotas.sort((a, b) => {
    const ai = WINDOW_ORDER.indexOf(a.window);
    const bi = WINDOW_ORDER.indexOf(b.window);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.label.localeCompare(b.label);
  });
  return quotas;
}

function isInternalModelId(id) {
  return /^(tab_|chat_)/i.test(id) || /-tiered$/i.test(id) || /^MODEL_/i.test(id);
}

function labelForModelGroup(models, resetTime) {
  const window = classifyWindow("reset", resetTime);
  if (window !== "unknown") {
    const pretty = { hourly: "Hourly", "5h": "5 hour", daily: "Daily", weekly: "Weekly", monthly: "Monthly" }[window];
    return pretty || "Quota";
  }
  if (models.length > 3) return `${models.length} models`;
  return models.join(", ");
}

export function quotasFromLiveModels(payload) {
  const models = payload?.models;
  if (!models || typeof models !== "object") return [];
  const groups = new Map();
  for (const [id, entry] of Object.entries(models)) {
    if (isInternalModelId(id)) continue;
    const quota = entry?.quotaInfo;
    if (!quota || typeof quota !== "object") continue;
    const remaining = pickRemaining(quota);
    const resetTime = asIso(quota.resetTime || quota.reset_time);
    const key = `${remaining ?? "?"}:${resetTime || "?"}`;
    const group = groups.get(key) || {
      remaining,
      reset_time: resetTime,
      used: pickUsed(quota, remaining),
      models: [],
    };
    group.models.push(id);
    groups.set(key, group);
  }
  return [...groups.values()].map((group, index) => ({
    id: `models-${index}`,
    label: labelForModelGroup(group.models, group.reset_time),
    window: classifyWindow(group.reset_time ? "reset" : "models", group.reset_time),
    remaining: group.remaining,
    used: group.used,
    limit: null,
    current: null,
    reset_time: group.reset_time,
    model: group.models[0] || null,
  }));
}

export function mergeQuotaViews(summaryQuotas, modelQuotas) {
  if (summaryQuotas.length) return summaryQuotas;
  return modelQuotas;
}

export { WINDOW_ORDER };
