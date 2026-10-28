export const VERTEX_API_VERSION = "v1beta1";
export const VERTEX_GLOBAL_BASE = "https://aiplatform.googleapis.com";
export const VERTEX_API_KEY_HEADER = "x-goog-api-key";
export const VERTEX_API_CLIENT_HEADER = "x-goog-api-client";
export const VERTEX_SDK_VERSION = "2.31.0";
export const VERTEX_USER_AGENT = `google-genai-sdk/${VERTEX_SDK_VERSION} gl-node/${process.version}`;
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

export function isVertexLocation(value) {
  const loc = String(value || "").trim().toLowerCase();
  if (!loc) return false;
  if (loc === "global" || loc === "us" || loc === "eu") return true;
  return /^[a-z]+(?:-[a-z]+)+\d+$/.test(loc);
}

export function isVertexProjectId(value) {
  const raw = String(value || "").trim();
  if (!raw || isVertexLocation(raw)) return false;
  return true;
}

export function vertexPublisherPath(model, { publisher = VERTEX_PUBLISHER } = {}) {
  const raw = String(model || "").trim();
  if (!raw) return "";
  if (raw.startsWith("projects/") || raw.startsWith("publishers/") || raw.startsWith("models/")) return raw;
  if (raw.includes("/")) {
    const [pub, id] = raw.split("/", 2);
    return `publishers/${pub}/models/${id}`;
  }
  return `publishers/${publisher}/models/${raw}`;
}

export function vertexModelResource(model, { publisher = VERTEX_PUBLISHER, project, location } = {}) {
  const publisherPath = vertexPublisherPath(model, { publisher });
  if (!publisherPath) return "";
  if (publisherPath.startsWith("projects/") || publisherPath.startsWith("models/")) return publisherPath;
  const proj = isVertexProjectId(project) ? String(project).trim() : "";
  if (!proj) return publisherPath;
  const loc = String(location || "global").trim() || "global";
  return `projects/${proj}/locations/${loc}/${publisherPath}`;
}

export function withVertexProjectPath(url, { project, location = "global" } = {}) {
  try {
    const parsed = new URL(url);
    const stripped = parsed.pathname.replace(
      /(\/v1(?:beta\d+)?)\/projects\/[^/]+\/locations\/[^/]+\/(publishers\/)/,
      "$1/$2",
    );
    if (!isVertexProjectId(project)) {
      parsed.pathname = stripped;
      return parsed.toString();
    }
    const loc = String(location || "global").trim() || "global";
    parsed.pathname = stripped.replace(
      /(\/v1(?:beta\d+)?)\/(publishers\/)/,
      `$1/projects/${String(project).trim()}/locations/${loc}/$2`,
    );
    return parsed.toString();
  } catch {
    return url;
  }
}

export function parseVertexPublisherError(response) {
  const payload = response?.parsed;
  const message = String(
    (payload && typeof payload === "object" && (payload.error?.message || payload.message)) ||
      response?.body ||
      response?.message ||
      "",
  );
  const match = message.match(/projects\/([^/`\s]+)\/locations\/([^/`\s]+)\//);
  if (!match) return null;
  return { project: match[1], location: match[2], message };
}

export function vertexGeneratePath(model, opts) {
  return `${vertexModelResource(model, opts)}:generateContent`;
}

export function vertexStreamPath(model, opts) {
  return `${vertexModelResource(model, opts)}:streamGenerateContent?alt=sse`;
}

export function vertexModelsPath({ publisher = VERTEX_PUBLISHER, project, location } = {}) {
  const publisherPath = `publishers/${publisher}/models`;
  const proj = isVertexProjectId(project) ? String(project).trim() : "";
  if (!proj) return publisherPath;
  const loc = String(location || "global").trim() || "global";
  return `projects/${proj}/locations/${loc}/${publisherPath}`;
}

export function vertexPredictPath(model, opts) {
  return `${vertexModelResource(model, opts)}:predict`;
}
