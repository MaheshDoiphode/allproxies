import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings } from "../src/core/config.js";
import { AntigravityClient } from "../src/providers/antigravity/client.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = new AntigravityClient(loadSettings());
const bundle = await client.ensureProject(await client.ensureToken());
const { requestJson } = await import("../src/http/request.js");
const response = await requestJson(client.modelsUrl(), {
  method: "POST",
  headers: client.headers(bundle.access_token),
  json: { project: bundle.managed_project_id || bundle.project_id },
  timeoutMs: 30_000,
});
const out = path.join(ROOT, "data", "live-models.dump.json");
fs.writeFileSync(out, JSON.stringify({ status: response.status, body: response.parsed }, null, 2));
console.log("status", response.status);
console.log("keys", Object.keys(response.parsed || {}));
const models = response.parsed?.models || {};
const keys = Object.keys(models);
console.log("count", keys.length);
for (const key of keys) {
  const m = models[key] || {};
  console.log(
    [
      key,
      "model=" + (m.model || ""),
      "modelName=" + (m.modelName || ""),
      "display=" + (m.displayName || ""),
      "think=" + Boolean(m.supportsThinking),
      "img=" + Boolean(m.supportsImages),
      "quota=" + (m.quotaInfo?.remainingFraction ?? ""),
    ].join(" | "),
  );
}
