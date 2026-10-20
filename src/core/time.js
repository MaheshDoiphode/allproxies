export const IST_TIME_ZONE = "Asia/Kolkata";

export function parseTime(value) {
  if (value == null || value === "") return NaN;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? NaN : ms;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 || value < 0 ? value : value * 1000;
  }
  const raw = String(value).trim();
  if (!raw) return NaN;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const num = Number(raw);
    return num > 1e12 || num < 0 ? num : num * 1000;
  }
  return Date.parse(raw);
}

export function formatIst(value) {
  const ms = parseTime(value);
  if (!Number.isFinite(ms)) return value == null ? "" : String(value);
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(new Date(ms));
}
