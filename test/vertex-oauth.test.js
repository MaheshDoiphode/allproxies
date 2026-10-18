import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { parseVertexPublisherError, vertexGeneratePath, vertexModelResource, vertexRegionalBase, vertexStreamPath, withVertexProjectPath } from "../src/core/vertex-constants.js";
import { TokenStore, createVertexBundle, hydrateVertexBundle, vertexApiKeyOf, vertexLocationOf, vertexProjectOf } from "../src/providers/vertex/tokens.js";
import { loadStaticVertexCatalog, parseVertexModels, resolveVertexRoute } from "../src/providers/vertex/catalog.js";
import { tempDir } from "./helpers.js";

test("vertex express paths stay on the global host", () => {
  assert.equal(vertexRegionalBase("global"), "https://aiplatform.googleapis.com");
  assert.equal(vertexRegionalBase("us-central1"), "https://us-central1-aiplatform.googleapis.com");
  assert.equal(vertexRegionalBase("us"), "https://aiplatform.us.rep.googleapis.com");
  assert.equal(vertexModelResource("gemini-3.8-flash"), "publishers/google/models/gemini-3.8-flash");
  assert.equal(vertexGeneratePath("gemini-3.8-flash"), "publishers/google/models/gemini-3.8-flash:generateContent");
  assert.match(vertexStreamPath("gemini-3.8-flash"), /streamGenerateContent\?alt=sse$/);
  assert.equal(
    vertexModelResource("gemini-4-argon", { project: "790050303616", location: "global" }),
    "projects/790050303616/locations/global/publishers/google/models/gemini-4-argon",
  );
  assert.equal(
    vertexGeneratePath("gemini-4-argon", { project: "790050303616", location: "global" }),
    "projects/790050303616/locations/global/publishers/google/models/gemini-4-argon:generateContent",
  );
  assert.equal(
    withVertexProjectPath(
      "https://aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-4-argon:generateContent",
      { project: "790050303616", location: "global" },
    ),
    "https://aiplatform.googleapis.com/v1beta1/projects/790050303616/locations/global/publishers/google/models/gemini-4-argon:generateContent",
  );
  assert.equal(vertexModelResource("gemini-4-argon", { project: "global" }), "publishers/google/models/gemini-4-argon");
  assert.deepEqual(
    parseVertexPublisherError({
      parsed: {
        error: {
          message: "Publisher model `projects/790050303616/locations/asia-southeast1/publishers/google/models/gemini-4-argon` was not found",
        },
      },
    }),
    { project: "790050303616", location: "asia-southeast1", message: "Publisher model `projects/790050303616/locations/asia-southeast1/publishers/google/models/gemini-4-argon` was not found" },
  );
});

test("vertex key store never prints the raw key as email", () => {
  const dir = tempDir();
  const store = new TokenStore(path.join(dir, "vertex-tokens.db"));
  const saved = createVertexBundle({ api_key: "AQ.Ab8RN6L1Q7uvsLfzPZRPUqOCl", location: "global", label: "work" });
  store.save(saved);
  const loaded = hydrateVertexBundle(store.load());
  assert.equal(loaded.email, "work");
  assert.equal(vertexApiKeyOf(loaded), "AQ.Ab8RN6L1Q7uvsLfzPZRPUqOCl");
  assert.equal(vertexLocationOf(loaded), "global");
  assert.equal(vertexProjectOf(loaded), "");
  assert.ok(!String(loaded.email).includes("AQ."));
});

test("vertex project is stored separately from location", () => {
  const saved = createVertexBundle({
    api_key: "AQ.Ab8RN6L1Q7uvsLfzPZRPUqOCl",
    location: "global",
    project_id: "790050303616",
    label: "work",
  });
  assert.equal(vertexLocationOf(saved), "global");
  assert.equal(vertexProjectOf(saved), "790050303616");
  const rehydrated = hydrateVertexBundle({
    ...saved,
    location: undefined,
    project_id: undefined,
  });
  assert.equal(vertexProjectOf(rehydrated), "790050303616");
});

test("live vertex catalog keeps every publisher family", () => {
  const parsed = parseVertexModels({
    publisherModels: [
      { name: "publishers/google/models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", inputTokenLimit: 1048576 },
      { name: "publishers/google/models/imagen-4.0-generate-001", displayName: "Imagen 4" },
      { name: "publishers/google/models/text-embedding-004", displayName: "Embedding" },
      { name: "publishers/google/models/veo-3.0-generate-001", displayName: "Veo 3" },
      { name: "publishers/anthropic/models/claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
    ],
  });
  assert.ok(parsed.find((item) => item.id === "vertex/gemini-3.8-flash")?.supports_thinking);
  assert.equal(parsed.find((item) => item.id === "vertex/imagen-4.0-generate-001")?.family, "imagen");
  assert.equal(parsed.find((item) => item.id === "vertex/text-embedding-004")?.family, "embedding");
  assert.equal(parsed.find((item) => item.id === "vertex/veo-3.0-generate-001")?.family, "veo");
  assert.equal(parsed.find((item) => item.id === "vertex/claude-sonnet-4-6")?.family, "claude");
  const fallback = loadStaticVertexCatalog();
  assert.ok(fallback.some((item) => item.id === "vertex/gemini-3.8-flash"));
  assert.ok(fallback.some((item) => item.id === "vertex/gemini-2.5-flash"));
  const deepseek = fallback.find((item) => item.id === "vertex/deepseek-ai/deepseek-v4.1-flash-maas");
  assert.equal(deepseek?.family, "deepseek");
  assert.equal(deepseek?.preferred, "deepseek-ai/deepseek-v4.1-flash-maas");
  assert.equal(deepseek?.supports_thinking, true);
  assert.equal(deepseek?.supports_images, true);
  assert.equal(deepseek?.supports_image_output, false);
  assert.deepEqual(deepseek?.efforts, ["none", "low", "medium", "high"]);
  assert.equal(deepseek?.context, 1_048_576);
  assert.equal(deepseek?.output, 1_048_576);
  assert.equal(resolveVertexRoute({ model: "vertex/deepseek-v4.1-flash-maas" }, fallback).model, "deepseek-ai/deepseek-v4.1-flash-maas");
  assert.equal(resolveVertexRoute({ model: "vertex/deepseek-ai/deepseek-v4.1-flash-maas" }, fallback).model, "deepseek-ai/deepseek-v4.1-flash-maas");
  const route = resolveVertexRoute({ model: "vertex/gemini-3.8-flash", reasoning_effort: "low" }, parsed);
  assert.equal(route.model, "gemini-3.8-flash");
  assert.equal(route.effort, "low");
});
