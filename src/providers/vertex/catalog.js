import { createModel, normalizeEffort, extractEffortFromBody, stripModelPrefix, splitEffortSuffix } from "../antigravity/catalog.js";

export { normalizeEffort, extractEffortFromBody, stripModelPrefix, splitEffortSuffix };

const FALLBACK_EFFORTS = ["none", "minimal", "low", "medium", "high"];

export function extractPublisherModels(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.publisherModels)) return payload.publisherModels;
  if (Array.isArray(payload.models)) return payload.models;
  if (Array.isArray(payload)) return payload;
  return [];
}

export function nextPageTokenOf(payload) {
  return payload?.nextPageToken || payload?.next_page_token || "";
}

function displayNameOf(item) {
  const name = item.displayName || item.display_name;
  if (name && !String(name).includes("/")) return String(name);
  return String(item.name || item.id || "").split("/").pop() || "";
}

export function shortModelId(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const models = raw.match(/models\/([^/?]+)$/);
  if (models) return models[1];
  return raw.replace(/^publishers\/[^/]+\/models\//, "").replace(/^models\//, "");
}

export function publisherOf(name) {
  const match = String(name || "").match(/^publishers\/([^/]+)\//);
  return match ? match[1] : "google";
}

function methodsOf(item) {
  const raw = item.supportedGenerationMethods || item.supported_generation_methods || item.supportedActions || [];
  return new Set((Array.isArray(raw) ? raw : []).map((value) => String(value).toLowerCase()));
}

export function familyOf(id, display, item) {
  const blob = `${id} ${display} ${item?.versionId || ""}`.toLowerCase();
  if (blob.includes("claude") || blob.includes("anthropic") || blob.includes("sonnet") || blob.includes("opus") || blob.includes("haiku")) return "claude";
  if (blob.includes("imagen") || /^image/.test(id)) return "imagen";
  if (blob.includes("veo") || blob.includes("lyria")) return "veo";
  if (blob.includes("gemma")) return "gemma";
  if (blob.includes("embed") || blob.includes("embedding")) return "embedding";
  if (blob.includes("bison") || blob.includes("text-unicorn") || blob.includes("chat-bison")) return "palm";
  if (blob.includes("codey") || blob.includes("code-gecko") || blob.includes("codechat")) return "codey";
  if (blob.includes("gemini")) return "gemini";
  if (publisherOf(item?.name || "") !== "google") return publisherOf(item.name);
  return "other";
}

function inferThinking(id, display, family) {
  const blob = `${id} ${display}`.toLowerCase();
  if (["imagen", "veo", "embedding", "palm", "codey"].includes(family)) return false;
  if (family === "claude") return true;
  if (/gemini-2\.0/.test(blob) && !blob.includes("thinking")) return false;
  return family === "gemini" && /gemini-2\.5|gemini-3|thinking/.test(blob);
}

function inferImages(family, id, display) {
  const blob = `${id} ${display}`.toLowerCase();
  if (family === "embedding" || family === "palm" || family === "codey") return false;
  if (family === "imagen" || family === "veo") return true;
  if (blob.includes("image") || blob.includes("vision") || blob.includes("multimodal")) return true;
  return family === "gemini" || family === "claude" || family === "gemma";
}

function inferImageOutput(family, id, display) {
  const blob = `${id} ${display}`.toLowerCase();
  return family === "imagen" || blob.includes("image") || /gemini-3\./.test(blob);
}

function inferEfforts(id, display, thinking, family) {
  if (!thinking) return [];
  const blob = `${id} ${display}`.toLowerCase();
  if (family === "claude") return ["none", "low", "medium", "high"];
  if (/gemini-3/.test(blob)) return ["none", "minimal", "low", "medium", "high"];
  return ["none", "low", "medium", "high"];
}

function contextOf(item) {
  return Number(
    item.inputTokenLimit ||
      item.input_token_limit ||
      item.tokenLimits?.input ||
      item.token_limits?.input ||
      0,
  ) || 0;
}

function outputOf(item) {
  return Number(
    item.outputTokenLimit ||
      item.output_token_limit ||
      item.tokenLimits?.output ||
      item.token_limits?.output ||
      0,
  ) || 0;
}

export function tagVertexModel(model, { source } = {}) {
  const rawId = String(model.id || "").replace(/^vertex[:/]/i, "");
  return createModel({
    ...model,
    id: rawId.startsWith("vertex/") ? rawId : `vertex/${rawId}`,
    name: model.name || rawId,
    family: model.family || "other",
    source: source || model.source || "live",
    provider: "vertex",
    aliases: [...new Set([rawId, `vertex-${rawId}`, `vertex/${rawId}`, ...(model.aliases || [])])],
    preferred: model.preferred || rawId,
    supports_image_output: Boolean(model.supports_image_output),
    context: model.context ?? 0,
    output: model.output ?? 0,
  });
}

export function parseVertexModels(payload) {
  return extractPublisherModels(payload)
    .map((item) => {
      const full = item.name || item.id || "";
      const id = shortModelId(full);
      if (!id) return null;
      const display = displayNameOf(item) || id;
      const family = familyOf(id, display, item);
      const thinking = inferThinking(id, display, family);
      const methods = methodsOf(item);
      return tagVertexModel({
        id,
        name: display,
        family,
        context: contextOf(item),
        output: outputOf(item),
        supports_thinking: thinking,
        supports_images: inferImages(family, id, display),
        supports_image_output: inferImageOutput(family, id, display),
        efforts: inferEfforts(id, display, thinking, family),
        source: "live",
        preferred: id,
        publisher: publisherOf(full),
        methods: [...methods],
      });
    })
    .filter(Boolean);
}

export function mergeVertexCatalog(staticModels = [], live = []) {
  const byId = new Map();
  for (const model of staticModels) {
    const tagged = tagVertexModel(model, { source: model.source || "express" });
    byId.set(String(tagged.preferred || tagged.id), tagged);
  }
  for (const liveModel of live) {
    const tagged = tagVertexModel(liveModel, { source: "live" });
    byId.set(String(tagged.preferred || tagged.id), { ...tagged, source: "live" });
  }
  return [...byId.values()].sort((a, b) => {
    if (a.family !== b.family) return String(a.family).localeCompare(String(b.family));
    return a.id.localeCompare(b.id);
  });
}

// Official Express Mode table (docs last updated 2026-10-10). Used only when
// GET publishers/google/models rejects API keys. Generate still accepts any
// vertex/<id> even if it is not in this list.
export const EXPRESS_MODE_MODELS = [
  { id: "gemini-3-pro-image", name: "Gemini 3 Pro Image", family: "gemini", thinking: true, images: true, imageOut: true, context: 1_048_576, output: 65_536 },
  { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image", family: "gemini", thinking: true, images: true, imageOut: true, context: 1_048_576, output: 65_536 },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", family: "gemini", thinking: true, images: true, imageOut: true, context: 1_048_576, output: 65_536 },
  { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview", family: "gemini", thinking: true, images: true, imageOut: true, context: 1_048_576, output: 65_536 },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", family: "gemini", thinking: true, images: true, imageOut: true, context: 1_048_576, output: 65_536 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", family: "gemini", thinking: true, images: true, imageOut: false, context: 1_048_576, output: 65_536 },
  { id: "gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image", family: "gemini", thinking: true, images: true, imageOut: true, context: 1_048_576, output: 65_536 },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", family: "gemini", thinking: true, images: true, imageOut: false, context: 1_048_576, output: 65_536 },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", family: "gemini", thinking: false, images: true, imageOut: false, context: 1_048_576, output: 65_536 },
];

export function loadStaticVertexCatalog() {
  return EXPRESS_MODE_MODELS.map((item) => {
    const thinking = item.thinking !== false;
    return tagVertexModel({
      id: item.id,
      name: item.name,
      family: item.family || familyOf(item.id, item.name, item),
      context: item.context || 1_048_576,
      output: item.output || 65_536,
      supports_thinking: thinking,
      supports_images: item.images !== false,
      supports_image_output: Boolean(item.imageOut),
      efforts: inferEfforts(item.id, item.name, thinking, item.family || familyOf(item.id, item.name, item)),
      source: "express",
      preferred: item.id,
    }, { source: "express" });
  });
}

export function resolveVertexRoute(body, catalog) {
  const requested = stripModelPrefix(body?.model);
  const { baseId, effort: suffixEffort } = splitEffortSuffix(requested);
  const models = catalog || [];
  const match =
    models.find((item) => item.id === requested || item.aliases?.includes(requested) || item.id === `vertex/${requested}`) ||
    models.find((item) => item.id === baseId || item.id === `vertex/${baseId}` || item.aliases?.includes(baseId) || item.preferred === baseId);
  const effort = extractEffortFromBody(body) ?? suffixEffort ?? null;
  return {
    model: match?.preferred || match?.id?.replace?.(/^vertex[:/]/i, "") || baseId || requested,
    effort,
    requested,
    group: match
      ? {
          ...match,
          efforts: Array.isArray(match.efforts) && match.efforts.length ? match.efforts : match.supports_thinking ? FALLBACK_EFFORTS : [],
        }
      : null,
  };
}

export function isVertexImageModel(model) {
  const blob = String(model || "").toLowerCase();
  return blob.includes("imagen") || /\bimage/.test(blob);
}
