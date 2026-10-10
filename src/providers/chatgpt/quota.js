function asNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asIso(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function windowFromSeconds(seconds) {
  const n = Number(seconds || 0);
  if (n >= 20 * 24 * 3600) return "monthly";
  if (n >= 5 * 24 * 3600) return "weekly";
  if (n >= 4 * 3600 && n <= 8 * 3600) return "5h";
  if (n >= 50 * 60) return "hourly";
  return "unknown";
}

function fromWindow(raw, label) {
  if (!raw || typeof raw !== "object") return null;
  const usedPct = asNumber(raw.used_percent ?? raw.usedPercent);
  const used = usedPct == null ? null : usedPct > 1 ? usedPct / 100 : usedPct;
  const remaining = used == null ? null : Math.max(0, Math.min(1, 1 - used));
  const reset = asIso(raw.reset_at ?? raw.resetAt);
  const seconds = asNumber(raw.limit_window_seconds ?? raw.limitWindowSeconds);
  return {
    id: String(label).toLowerCase().replace(/\s+/g, "-"),
    label,
    window: windowFromSeconds(seconds),
    remaining,
    used,
    limit: asNumber(raw.limit),
    current: used,
    reset_time: reset,
    model: raw.model || null,
  };
}

export function quotasFromWhamUsage(payload) {
  const raw = payload && typeof payload === "object" ? payload : {};
  const root = raw.rate_limit ? raw : raw.usage && typeof raw.usage === "object" ? raw.usage : raw;
  const rate = root.rate_limit && typeof root.rate_limit === "object" ? root.rate_limit : {};
  const out = [];
  const primary = fromWindow(rate.primary_window, rate.primary_window?.limit_window_seconds >= 20 * 24 * 3600 ? "Monthly Limit" : "5-hour Limit");
  if (primary) out.push(primary);
  const secondary = fromWindow(rate.secondary_window, "Weekly Limit");
  if (secondary) out.push(secondary);
  for (const extra of root.additional_rate_limits || []) {
    if (!extra || typeof extra !== "object") continue;
    const mapped = fromWindow(extra.primary_window || extra, extra.display_name || extra.model || extra.id || "Extra Limit");
    if (mapped) {
      mapped.model = extra.model || extra.slug || mapped.model;
      out.push(mapped);
    }
  }
  return out;
}

export function isChatgptQuotaPayload(payload) {
  const rate = payload?.rate_limit;
  return Boolean(rate && (rate.limit_reached || rate.allowed === false));
}
