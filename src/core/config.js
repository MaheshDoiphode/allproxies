import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

function resolvePath(value, fallback) {
  const raw = value || fallback;
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

export function loadSettings(overrides = {}) {
  loadDotEnv(path.join(ROOT, ".env"));
  const env = process.env;
  return {
    host: overrides.host ?? env.ALLPROXIES_HOST ?? "127.0.0.1",
    port: Number(overrides.port ?? env.ALLPROXIES_PORT ?? 8787),
    apiKey: overrides.apiKey ?? env.ALLPROXIES_API_KEY ?? "",
    tokenPath: resolvePath(overrides.tokenPath ?? env.ALLPROXIES_TOKEN_PATH, path.join("data", "antigravity-tokens.db")),
    chatgptTokenPath: resolvePath(overrides.chatgptTokenPath ?? env.ALLPROXIES_CHATGPT_TOKEN_PATH, path.join("data", "chatgpt-tokens.db")),
    chatgptBaseUrl: (overrides.chatgptBaseUrl ?? env.ALLPROXIES_CHATGPT_BASE_URL ?? "").replace(/\/$/, ""),
    chatgptUsageUrl: overrides.chatgptUsageUrl ?? env.ALLPROXIES_CHATGPT_USAGE_URL ?? "",
    vertexTokenPath: resolvePath(overrides.vertexTokenPath ?? env.ALLPROXIES_VERTEX_TOKEN_PATH, path.join("data", "vertex-tokens.db")),
    vertexBaseUrl: (overrides.vertexBaseUrl ?? env.ALLPROXIES_VERTEX_BASE_URL ?? "").replace(/\/$/, ""),
    vertexLocation: overrides.vertexLocation ?? env.ALLPROXIES_VERTEX_LOCATION ?? "global",
    vertexProject: overrides.vertexProject ?? env.ALLPROXIES_VERTEX_PROJECT ?? env.GOOGLE_CLOUD_PROJECT ?? "",
    vertexApiKey: overrides.vertexApiKey ?? env.ALLPROXIES_VERTEX_API_KEY ?? env.GOOGLE_API_KEY ?? "",
    modelsPath: resolvePath(overrides.modelsPath ?? env.ALLPROXIES_MODELS_PATH, path.join("data", "models.json")),
    antigravityEndpoint: (overrides.antigravityEndpoint ?? env.ALLPROXIES_ANTIGRAVITY_ENDPOINT ?? "daily").toLowerCase(),
    antigravityBaseUrl: (overrides.antigravityBaseUrl ?? env.ALLPROXIES_ANTIGRAVITY_BASE_URL ?? "").replace(/\/$/, ""),
    antigravityHubVersion: overrides.antigravityHubVersion ?? env.ALLPROXIES_ANTIGRAVITY_HUB_VERSION ?? "2.9.1",
    requestTimeoutMs: Number(overrides.requestTimeoutMs ?? env.ALLPROXIES_REQUEST_TIMEOUT_MS ?? 180_000),
    maxBodyBytes: Math.round(Number(overrides.maxBodyMb ?? env.ALLPROXIES_MAX_BODY_MB ?? 256) * 1024 * 1024),
    liveModels: parseBool(overrides.liveModels ?? env.ALLPROXIES_LIVE_MODELS, true),
    debugRequests: parseBool(overrides.debugRequests ?? env.ALLPROXIES_DEBUG_REQUESTS, false),
    adminPassword: overrides.adminPassword ?? env.ALLPROXIES_ADMIN_PASSWORD ?? "",
  };
}
