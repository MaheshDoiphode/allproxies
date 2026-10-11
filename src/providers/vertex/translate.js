import { VERTEX_IMAGE_ASPECT_RATIOS, VERTEX_IMAGE_SIZES, VERTEX_THINKING_LEVELS } from "../../core/vertex-constants.js";
import { extractEffortFromBody, normalizeEffort } from "../antigravity/catalog.js";
import {
  anthropicToGemini,
  geminiToAnthropic,
  geminiToOpenai,
  openaiMessagesToGemini,
  openaiToResponses,
  responsesToChatBody,
  responsesAssistantMessage,
  StreamAccumulator,
  ResponsesStreamAccumulator,
  AnthropicStreamAccumulator,
  unwrapResponse,
} from "../antigravity/translate.js";
import { sanitizeSchema, sanitizeTools } from "../antigravity/schema.js";

export {
  geminiToAnthropic,
  geminiToOpenai,
  openaiToResponses,
  responsesToChatBody,
  responsesAssistantMessage,
  StreamAccumulator,
  ResponsesStreamAccumulator,
  AnthropicStreamAccumulator,
  unwrapResponse,
};

const THINKING_WIRE = {
  none: null,
  minimal: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
};

function thinkingLevelWire(level) {
  const raw = String(level || "").trim();
  const upper = raw.toUpperCase();
  if (VERTEX_THINKING_LEVELS.includes(upper)) return upper;
  const lower = raw.toLowerCase();
  if (lower === "minimal" || lower === "min") return "MINIMAL";
  const resolved = normalizeEffort(level);
  if (!resolved || resolved === "none") return null;
  return THINKING_WIRE[resolved] || null;
}

function requestEffort(body = {}, effort) {
  const extras = body.extra_body && typeof body.extra_body === "object" ? body.extra_body : {};
  return (
    effort ??
    body.reasoning_effort ??
    body.reasoningEffort ??
    extras.reasoning_effort ??
    extras.thinking_level ??
    extras.thinkingLevel ??
    extractEffortFromBody(body)
  );
}

export function vertexThinkingFromRequest(model, body = {}, effort) {
  const extras = body.extra_body && typeof body.extra_body === "object" ? body.extra_body : {};
  const thinking = extras.google || extras.thinking || extras.vertex || body.thinking;
  const rawEffort = requestEffort(body, effort);
  const rawLower = String(rawEffort || "").trim().toLowerCase();
  if (rawLower === "minimal" || rawLower === "min") {
    return { includeThoughts: false, thinkingLevel: "LOW" };
  }
  const resolved = normalizeEffort(rawEffort);
  if (resolved === "none") return null;
  if (thinking && typeof thinking === "object") {
    if (thinking.type === "disabled" || thinking.type === "none") return null;
    const config = {};
    const level = thinking.thinkingLevel || thinking.thinking_level || thinking.level;
    const budget = thinking.thinkingBudget ?? thinking.budget_tokens ?? thinking.thinking_budget;
    if (level) {
      const wire = thinkingLevelWire(level);
      if (wire === "MINIMAL") {
        config.thinkingLevel = "LOW";
        config.includeThoughts = false;
      } else if (wire) {
        config.thinkingLevel = wire;
      }
    }
    if (budget != null && Number.isFinite(Number(budget))) config.thinkingBudget = Number(budget);
    if (thinking.includeThoughts != null || thinking.include_thoughts != null) {
      config.includeThoughts = Boolean(thinking.includeThoughts ?? thinking.include_thoughts);
    } else if (Object.keys(config).length && config.includeThoughts == null) {
      config.includeThoughts = true;
    }
    if (Object.keys(config).length) return config;
  }
  const wire = thinkingLevelWire(resolved);
  if (wire === "MINIMAL") return { includeThoughts: false, thinkingLevel: "LOW" };
  if (wire) return { includeThoughts: true, thinkingLevel: wire };
  const lowered = String(model || "").toLowerCase();
  for (const level of ["minimal", "low", "medium", "high"]) {
    if (lowered.endsWith(`-${level}`)) {
      if (level === "minimal") return { includeThoughts: false, thinkingLevel: "LOW" };
      const mapped = thinkingLevelWire(level);
      return mapped ? { includeThoughts: true, thinkingLevel: mapped } : null;
    }
  }
  return null;
}

function guessMime(url, fallback = "image/png") {
  const raw = String(url || "").toLowerCase();
  if (raw.startsWith("data:") && raw.includes(";")) {
    return raw.slice(5, raw.indexOf(";")) || fallback;
  }
  if (raw.endsWith(".jpg") || raw.endsWith(".jpeg")) return "image/jpeg";
  if (raw.endsWith(".webp")) return "image/webp";
  if (raw.endsWith(".gif")) return "image/gif";
  if (raw.endsWith(".png")) return "image/png";
  if (raw.endsWith(".mp4")) return "video/mp4";
  if (raw.endsWith(".webm")) return "video/webm";
  if (raw.endsWith(".mp3")) return "audio/mpeg";
  if (raw.endsWith(".wav")) return "audio/wav";
  if (raw.endsWith(".pdf")) return "application/pdf";
  return fallback;
}

export function mediaPartFromUrl(url, mimeHint) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  if (raw.startsWith("data:") && raw.includes(",")) {
    const [header, data] = raw.split(",", 2);
    const mime = header.slice(5).split(";")[0] || mimeHint || "image/png";
    return { inlineData: { mimeType: mime, data } };
  }
  return { fileData: { fileUri: raw, mimeType: mimeHint || guessMime(raw) } };
}

function imagePartFromAnthropic(item) {
  if (!item || typeof item !== "object") return null;
  const source = item.source && typeof item.source === "object" ? item.source : item;
  const mime = item.media_type || item.mime_type || item.mimeType || source.media_type || source.mime_type || source.mimeType;
  if (source.type === "base64" && source.data) {
    return { inlineData: { mimeType: mime || "image/png", data: String(source.data) } };
  }
  if (item.type === "base64" && (item.data || source.data)) {
    return { inlineData: { mimeType: mime || "image/png", data: String(item.data || source.data) } };
  }
  const url = item.url || source.url || item.file_url || source.file_url;
  if (url) return mediaPartFromUrl(url, mime);
  if (item.data && typeof item.data === "string" && !item.data.startsWith("http") && !item.data.startsWith("gs://") && !item.data.startsWith("data:")) {
    return { inlineData: { mimeType: mime || "image/png", data: item.data } };
  }
  return null;
}

export function openaiContentToVertexParts(content) {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item) parts.push({ text: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const kind = item.type;
    if (["text", "input_text", "output_text"].includes(kind) && item.text) {
      parts.push({ text: String(item.text) });
      continue;
    }
    if (kind === "image" || kind === "base64" || item.source) {
      const part = imagePartFromAnthropic(item);
      if (part) {
        parts.push(part);
        continue;
      }
    }
    if (kind === "image_url" || kind === "image" || kind === "input_image") {
      let url = item.image_url ?? item.image ?? item.url ?? item.source?.url;
      if (url && typeof url === "object") url = url.url;
      const mime = item.mime_type || item.mimeType || item.media_type || (item.image_url && item.image_url.mime_type);
      const part = mediaPartFromUrl(url, mime) || imagePartFromAnthropic(item);
      if (part) parts.push(part);
      continue;
    }
    if (kind === "input_file" || kind === "file" || kind === "file_url") {
      const url = item.file_url || item.fileUri || item.file_uri || item.url || item.file?.url;
      const mime = item.mime_type || item.mimeType || item.file?.mime_type;
      const part = mediaPartFromUrl(url, mime);
      if (part) parts.push(part);
      continue;
    }
    if (item.inlineData || item.inline_data) {
      const blob = item.inlineData || item.inline_data;
      parts.push({ inlineData: { mimeType: blob.mimeType || blob.mime_type || "image/png", data: blob.data } });
      continue;
    }
    if (item.fileData || item.file_data) {
      const blob = item.fileData || item.file_data;
      parts.push({
        fileData: {
          fileUri: blob.fileUri || blob.file_uri,
          mimeType: blob.mimeType || blob.mime_type || guessMime(blob.fileUri || blob.file_uri),
        },
      });
    }
  }
  return parts;
}

function rewriteGeminiMedia(contents) {
  return (contents || []).map((content) => {
    if (!content || !Array.isArray(content.parts)) return content;
    return {
      ...content,
      parts: content.parts.map((part) => {
        if (!part || typeof part !== "object") return part;
        if (part.fileData?.fileUri && !part.fileData.mimeType) {
          return { fileData: { ...part.fileData, mimeType: guessMime(part.fileData.fileUri) } };
        }
        return part;
      }),
    };
  });
}

export function imageConfigFromBody(body = {}) {
  const extras = body.extra_body && typeof body.extra_body === "object" ? body.extra_body : {};
  const raw = extras.imageConfig || extras.image_config || extras.vertex?.imageConfig || body.image_config || body.imageConfig;
  if (!raw || typeof raw !== "object") return null;
  const config = {};
  if (raw.aspectRatio || raw.aspect_ratio) {
    const ratio = String(raw.aspectRatio || raw.aspect_ratio);
    if (VERTEX_IMAGE_ASPECT_RATIOS.includes(ratio)) config.aspectRatio = ratio;
  }
  if (raw.imageSize || raw.image_size) {
    const size = String(raw.imageSize || raw.image_size).toUpperCase();
    if (VERTEX_IMAGE_SIZES.includes(size)) config.imageSize = size;
  }
  if (raw.personGeneration || raw.person_generation) config.personGeneration = raw.personGeneration || raw.person_generation;
  if (raw.outputMimeType || raw.output_mime_type) config.outputMimeType = raw.outputMimeType || raw.output_mime_type;
  if (raw.outputCompressionQuality != null || raw.output_compression_quality != null) {
    config.outputCompressionQuality = Number(raw.outputCompressionQuality ?? raw.output_compression_quality);
  }
  return Object.keys(config).length ? config : null;
}

export function responseModalitiesFromBody(body = {}, model) {
  const extras = body.extra_body && typeof body.extra_body === "object" ? body.extra_body : {};
  const raw = extras.responseModalities || extras.response_modalities || body.response_modalities || body.modalities;
  if (Array.isArray(raw) && raw.length) {
    return raw.map((item) => String(item).toUpperCase());
  }
  const blob = String(model || "").toLowerCase();
  if (blob.includes("image") || blob.includes("imagen")) return ["IMAGE", "TEXT"];
  return null;
}

function generationFromChat(body, { model, effort } = {}) {
  const generation = {};
  if (body.temperature != null) generation.temperature = body.temperature;
  if (body.top_p != null) generation.topP = body.top_p;
  if (body.top_k != null) generation.topK = body.top_k;
  if (body.max_tokens != null) generation.maxOutputTokens = body.max_tokens;
  if (body.max_completion_tokens != null) generation.maxOutputTokens = body.max_completion_tokens;
  if (body.stop) generation.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.seed != null) generation.seed = body.seed;
  if (body.presence_penalty != null) generation.presencePenalty = body.presence_penalty;
  if (body.frequency_penalty != null) generation.frequencyPenalty = body.frequency_penalty;
  if (body.n != null) generation.candidateCount = body.n;
  const responseFormat = body.response_format || {};
  if (responseFormat.type === "json_object") generation.responseMimeType = "application/json";
  if (responseFormat.json_schema && typeof responseFormat.json_schema === "object") {
    generation.responseSchema = sanitizeSchema(responseFormat.json_schema.schema || responseFormat.json_schema);
    generation.responseMimeType = "application/json";
  }
  const thinking = vertexThinkingFromRequest(model, body, effort);
  if (thinking) generation.thinkingConfig = thinking;
  const modalities = responseModalitiesFromBody(body, model);
  if (modalities) generation.responseModalities = modalities;
  const imageConfig = imageConfigFromBody(body);
  if (imageConfig) generation.imageConfig = imageConfig;
  return generation;
}

function toolsFromOpenai(body) {
  if (!Array.isArray(body.tools) || !body.tools.length) return null;
  return sanitizeTools(body.tools);
}

function toolsFromAnthropic(body) {
  const tools = [];
  for (const tool of body.tools || []) {
    if (tool && typeof tool === "object") {
      tools.push({ name: tool.name, description: tool.description, parameters: tool.input_schema || {} });
    }
  }
  return tools.length ? sanitizeTools(tools) : null;
}

export function wrapVertexGenerate({ model, contents, system, generation, tools }) {
  const request = { contents: rewriteGeminiMedia(contents) };
  if (system) request.systemInstruction = system;
  if (generation && Object.keys(generation).length) request.generationConfig = generation;
  if (tools) request.tools = tools;
  return { model, request };
}

function applyVertexParts(contents, messages) {
  const sources = (messages || []).filter((message) => {
    const role = String(message?.role || "").toLowerCase();
    return role !== "system" && role !== "developer" && role !== "tool";
  });
  let index = 0;
  return (contents || []).map((content) => {
    if (String(content?.role || "") === "model") return content;
    if (Array.isArray(content?.parts) && content.parts.some((p) => p && p.functionResponse)) return content;
    const source = sources[index];
    index += 1;
    if (!source || typeof source.content === "string" || source.content == null) return content;
    const extra = openaiContentToVertexParts(source.content);
    if (!extra.length) return content;
    const existing = content.parts || [];
    const merged = [];
    const seen = new Set();
    for (const part of [...extra, ...existing]) {
      const key = part.text
        ? `t:${part.text}`
        : part.inlineData
          ? `i:${part.inlineData.data?.slice?.(0, 24)}`
          : part.fileData
            ? `f:${part.fileData.fileUri}`
            : JSON.stringify(part);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(part);
    }
    return { ...content, parts: merged.length ? merged : existing };
  });
}

export function openaiToVertex(body, { model, effort } = {}) {
  const { system, contents } = openaiMessagesToGemini(body.messages || []);
  return wrapVertexGenerate({
    model,
    contents: applyVertexParts(contents, body.messages || []),
    system,
    generation: generationFromChat(body, { model, effort }),
    tools: toolsFromOpenai(body),
  });
}

export function anthropicToVertex(body, { model, effort } = {}) {
  const { system, contents } = anthropicToGemini(body);
  const generation = generationFromChat(
    {
      ...body,
      max_tokens: body.max_tokens,
      extra_body: body.extra_body,
      thinking: body.thinking,
    },
    { model, effort },
  );
  return wrapVertexGenerate({
    model,
    contents: applyVertexParts(contents, body.messages || []),
    system,
    generation,
    tools: toolsFromAnthropic(body),
  });
}

export function vertexHttpBody(wrapped) {
  const request = wrapped?.request || {};
  const body = { contents: request.contents || [] };
  if (request.systemInstruction) body.systemInstruction = request.systemInstruction;
  if (request.generationConfig) body.generationConfig = request.generationConfig;
  if (request.tools) body.tools = request.tools;
  if (request.toolConfig) body.toolConfig = request.toolConfig;
  if (request.safetySettings) body.safetySettings = request.safetySettings;
  if (request.labels) body.labels = request.labels;
  if (request.cachedContent) body.cachedContent = request.cachedContent;
  return body;
}

export function partsHaveInlineImage(parts) {
  return (parts || []).some((part) => part && (part.inlineData || part.inline_data));
}
