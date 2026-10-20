#!/usr/bin/env node
/**
 * Direct Vertex generateContent with the saved `cpt` key. Bypasses proxy parks.
 * Does not print the API key.
 */
import { loadSettings } from "../src/core/config.js";
import { VertexClient } from "../src/providers/vertex/client.js";
import {
  accountIdOf,
  hydrateVertexBundle,
  vertexApiKeyOf,
  vertexLocationOf,
  vertexProjectOf,
} from "../src/providers/vertex/tokens.js";
import {
  VERTEX_API_KEY_HEADER,
  VERTEX_API_VERSION,
  vertexGeneratePath,
  vertexRegionalBase,
} from "../src/core/vertex-constants.js";
import { requestJson } from "../src/http/request.js";
import { formatIst } from "../src/core/time.js";

function join(base, pathname) {
  return `${String(base).replace(/\/$/, "")}/${VERTEX_API_VERSION}/${String(pathname).replace(/^\//, "")}`;
}

function summarizeError(res) {
  const headers = res.headers || {};
  const retryAfter = headers["retry-after"] ?? headers["retry-after"] ?? headers["Retry-After"] ?? null;
  const msg = res?.parsed?.error?.message || res?.parsed?.message || res?.body || "";
  return {
    status: res.status,
    code: res?.parsed?.error?.status || res?.parsed?.error?.code || null,
    retryAfter,
    error: String(msg).replace(/\s+/g, " ").slice(0, 400),
  };
}

async function main() {
  const settings = loadSettings();
  const vertex = new VertexClient(settings);
  const raw = vertex.accounts().find((item) => {
    const id = accountIdOf(item);
    const email = String(item.email || "").toLowerCase();
    return id === "cpt" || email === "cpt";
  });
  if (!raw) {
    console.log(JSON.stringify({ error: "cpt key not found" }, null, 2));
    process.exit(1);
  }
  const bundle = hydrateVertexBundle(raw);
  const project = vertexProjectOf(bundle) || settings.vertexProject || "";
  const location = vertexLocationOf(bundle) || "global";
  const url = join(vertexRegionalBase(location), vertexGeneratePath("gemini-4-argon", { project, location }));
  const started = Date.now();
  const res = await requestJson(url, {
    method: "POST",
    headers: {
      [VERTEX_API_KEY_HEADER]: vertexApiKeyOf(bundle),
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "allproxies-vertex-probe/0.1",
    },
    json: {
      contents: [{ role: "user", parts: [{ text: "Reply with exactly: pong" }] }],
      generationConfig: { maxOutputTokens: 16, temperature: 0 },
    },
    timeoutMs: 60_000,
  });
  const text = res.parsed?.candidates?.[0]?.content?.parts?.find((part) => part.text && !part.thought)?.text || null;
  const until = Number(bundle.disabled_until || 0);
  console.log(JSON.stringify({
    now: formatIst(Date.now()),
    account: bundle.email,
    project: project || null,
    location,
    path: new URL(url).pathname,
    proxy_park: until ? formatIst(until) : null,
    proxy_park_active: until > Date.now(),
    ms: Date.now() - started,
    status: res.status,
    text: text ? String(text).slice(0, 80) : null,
    finish: res.parsed?.candidates?.[0]?.finishReason || null,
    usage: res.parsed?.usageMetadata || null,
    google: res.status >= 400 ? summarizeError(res) : null,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
