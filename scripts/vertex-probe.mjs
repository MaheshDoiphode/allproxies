#!/usr/bin/env node
/**
 * Live Vertex Express Mode probe. Reads ALLPROXIES_VERTEX_API_KEY or argv[2].
 * Never prints the key.
 */
import { requestJson } from "../src/http/request.js";
import { VERTEX_API_KEY_HEADER, VERTEX_API_VERSION, VERTEX_GLOBAL_BASE, vertexGeneratePath, vertexModelsPath } from "../src/core/vertex-constants.js";

const key = process.env.ALLPROXIES_VERTEX_API_KEY || process.env.GOOGLE_API_KEY || process.argv[2] || "";
if (!key) {
  console.error("usage: node.exe scripts/vertex-probe.mjs <AQ.key>");
  process.exit(2);
}

const headers = {
  [VERTEX_API_KEY_HEADER]: key,
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": "allproxies-vertex-probe/0.1",
};

function join(path) {
  return `${VERTEX_GLOBAL_BASE}/${VERTEX_API_VERSION}/${path}`;
}

async function main() {
  const models = await requestJson(join(vertexModelsPath()), { method: "GET", headers, timeoutMs: 20_000 });
  const ids = (models.parsed?.publisherModels || models.parsed?.models || [])
    .map((item) => String(item.name || item.id || ""))
    .filter(Boolean)
    .slice(0, 20);
  console.log("models", { status: models.status, count: ids.length, sample: ids.slice(0, 8) });

  const chat = await requestJson(join(vertexGeneratePath("gemini-3.8-flash")), {
    method: "POST",
    headers,
    json: {
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri: "gs://generativeai-downloads/images/scones.jpg", mimeType: "image/jpeg" } },
            { text: "Reply with exactly: pong" },
          ],
        },
      ],
      generationConfig: {
        thinkingConfig: { thinkingLevel: "LOW", includeThoughts: true },
        maxOutputTokens: 64,
      },
    },
    timeoutMs: 60_000,
  });
  const text = chat.parsed?.candidates?.[0]?.content?.parts?.find((part) => part.text && !part.thought)?.text || null;
  console.log("chat", {
    status: chat.status,
    text: text ? String(text).slice(0, 80) : null,
    error: chat.status >= 400 ? String(chat.body || "").slice(0, 300) : null,
    finish: chat.parsed?.candidates?.[0]?.finishReason || null,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
