export const VERTEX_API_VERSION = "v1beta1";
export const VERTEX_GLOBAL_BASE = "https://aiplatform.googleapis.com";
export const VERTEX_API_KEY_HEADER = "x-goog-api-key";
export const VERTEX_USER_AGENT = "allproxies-vertex/0.1";
export const VERTEX_PUBLISHER = "google";

export const VERTEX_THINKING_LEVELS = ["MINIMAL", "LOW", "MEDIUM", "HIGH"];

export const VERTEX_IMAGE_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"];
export const VERTEX_IMAGE_SIZES = ["1K", "2K", "4K"];

export function vertexRegionalBase(location) {
  const loc = String(location || "").trim().toLowerCase();
  if (!loc || loc === "global") return VERTEX_GLOBAL_BASE;
  if (loc === "us" || loc === "eu") return `https://aiplatform.${loc}.rep.googleapis.com`;
  return `https://${loc}-aiplatform.googleapis.com`;
}

export function vertexModelResource(model, { publisher = VERTEX_PUBLISHER } = {}) {
  const raw = String(model || "").trim();
  if (!raw) return "";
  if (raw.startsWith("projects/") || raw.startsWith("publishers/") || raw.startsWith("models/")) return raw;
  if (raw.includes("/")) {
    const [pub, id] = raw.split("/", 2);
    return `publishers/${pub}/models/${id}`;
  }
  return `publishers/${publisher}/models/${raw}`;
}

export function vertexGeneratePath(model) {
  return `${vertexModelResource(model)}:generateContent`;
}

export function vertexStreamPath(model) {
  return `${vertexModelResource(model)}:streamGenerateContent?alt=sse`;
}

export function vertexModelsPath() {
  return "publishers/google/models";
}

export function vertexPredictPath(model) {
  return `${vertexModelResource(model)}:predict`;
}
