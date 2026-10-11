import crypto from "node:crypto";
import { extractEffortFromBody, normalizeEffort } from "./catalog.js";
import { sanitizeSchema, sanitizeTools } from "./schema.js";

const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

export function newRequestId(model) {
  if (String(model).toLowerCase().includes("image")) {
    return `image_gen/${Date.now()}/${crypto.randomUUID()}/12`;
  }
  return `agent-${crypto.randomUUID()}`;
}

function thinkingConfigFor(model, level) {
  const resolved = normalizeEffort(level);
  if (!resolved || resolved === "none") return null;
  if (String(model).toLowerCase().includes("claude")) {
    const budgets = { low: 8192, medium: 16384, high: 24576 };
    return { includeThoughts: true, thinkingBudget: budgets[resolved] || 16384 };
  }
  return { includeThoughts: true, thinkingLevel: resolved };
}

export function thinkingFromRequest(model, body = {}, effort) {
  const extras = body.extra_body && typeof body.extra_body === "object" ? body.extra_body : {};
  const thinking = extras.google || extras.thinking || body.thinking;
  const resolved = normalizeEffort(effort) ?? extractEffortFromBody(body);
  if (resolved === "none") return null;
  if (thinking && typeof thinking === "object") {
    if (thinking.type === "disabled" || thinking.type === "none") return thinkingConfigFor(model, resolved);
    const config = {};
    if (thinking.thinkingLevel || thinking.thinking_level) config.thinkingLevel = thinking.thinkingLevel || thinking.thinking_level;
    if (thinking.thinkingBudget || thinking.budget_tokens) config.thinkingBudget = thinking.thinkingBudget || thinking.budget_tokens;
    if (thinking.includeThoughts != null || thinking.include_thoughts != null) {
      config.includeThoughts = Boolean(thinking.includeThoughts ?? thinking.include_thoughts);
    } else if (Object.keys(config).length) {
      config.includeThoughts = true;
    }
    if (Object.keys(config).length) return config;
  }
  if (resolved) return thinkingConfigFor(model, resolved);
  const lowered = String(model).toLowerCase();
  for (const level of ["minimal", "low", "medium", "high", "max"]) {
    if (lowered.endsWith(`-${level}`)) return thinkingConfigFor(model, level);
  }
  return null;
}

function textPart(text, thought = false) {
  const part = { text };
  if (thought) part.thought = true;
  return part;
}

function imagePart(url) {
  if (url.startsWith("data:") && url.includes(",")) {
    const [header, data] = url.split(",", 2);
    const mime = header.slice(5).split(";")[0] || "image/png";
    return { inlineData: { mimeType: mime, data } };
  }
  return { fileData: { fileUri: url, mimeType: "image/png" } };
}

export function openaiContentToParts(content) {
  if (content == null) return [];
  if (typeof content === "string") return content ? [textPart(content)] : [];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(textPart(item));
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const kind = item.type;
    if (["text", "input_text", "output_text"].includes(kind) && item.text) parts.push(textPart(String(item.text)));
    else if (kind === "image_url" || kind === "image" || kind === "input_image" || kind === "base64") {
      let url = item.image_url ?? item.url;
      if (url && typeof url === "object") url = url.url;
      const source = item.source && typeof item.source === "object" ? item.source : null;
      if (source?.type === "base64" && source.data) {
        parts.push({ inlineData: { mimeType: source.media_type || source.mime_type || "image/png", data: String(source.data) } });
      } else if (item.type === "base64" && item.data) {
        parts.push({ inlineData: { mimeType: item.media_type || item.mime_type || "image/png", data: String(item.data) } });
      } else if (typeof url === "string") {
        parts.push(imagePart(url));
      } else if (source?.url) {
        parts.push(imagePart(source.url));
      }
    }
  }
  return parts;
}

export function normalizeContents(contents) {
  if (!contents.length) return [{ role: "user", parts: [{ text: "" }] }];
  if (contents[0].role === "model") contents.unshift({ role: "user", parts: [{ text: "" }] });

  for (let i = 0; i < contents.length; i += 1) {
    const turn = contents[i];
    if (turn?.role !== "model" || !Array.isArray(turn.parts)) continue;
    const calls = turn.parts.filter((p) => p && p.functionCall).map((p) => p.functionCall);
    if (!calls.length) continue;

    let next = contents[i + 1];
    if (!next || next.role !== "user" || !Array.isArray(next.parts) || !next.parts.some((p) => p && p.functionResponse)) {
      next = { role: "user", parts: [] };
      contents.splice(i + 1, 0, next);
    }

    const respondedIds = new Set(next.parts.map((p) => p.functionResponse?.id).filter(Boolean));
    const respondedNames = new Set(next.parts.map((p) => p.functionResponse?.name).filter(Boolean));
    for (const call of calls) {
      const match = (call.id && respondedIds.has(call.id)) || respondedNames.has(call.name);
      if (!match) {
        next.parts.push({
          functionResponse: {
            name: call.name,
            response: { output: "" },
            ...(call.id ? { id: call.id } : {}),
          },
        });
      }
    }
    const currentResponses = next.parts.filter((p) => p && p.functionResponse);
    while (currentResponses.length < calls.length) {
      const missingCall = calls[currentResponses.length];
      const placeholder = {
        functionResponse: {
          name: missingCall?.name || "tool",
          response: { output: "" },
          ...(missingCall?.id ? { id: missingCall.id } : {}),
        },
      };
      next.parts.push(placeholder);
      currentResponses.push(placeholder);
    }
  }

  return contents;
}

export function openaiMessagesToGemini(messages) {
  const systemBits = [];
  const contents = [];
  const pendingCalls = {};

  for (const message of messages || []) {
    const role = String(message.role || "user").toLowerCase();
    if (role === "system" || role === "developer") {
      const text = message.content;
      if (typeof text === "string" && text.trim()) systemBits.push(text);
      else if (Array.isArray(text)) {
        for (const part of text) if (part && part.text) systemBits.push(String(part.text));
      }
      continue;
    }
    if (role === "tool") {
      const toolId = String(message.tool_call_id || "");
      const name = pendingCalls[toolId] || message.name || "tool";
      let raw = message.content;
      if (typeof raw !== "string") raw = JSON.stringify(raw);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { result: raw };
      }
      const wrapped = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed.result != null || parsed.content != null || parsed.output != null ? parsed : { result: parsed })
        : { result: parsed };
      const response = { name, response: wrapped };
      if (toolId) response.id = toolId;
      const respPart = { functionResponse: response };

      const last = contents[contents.length - 1];
      if (last && last.role === "user" && Array.isArray(last.parts) && last.parts.some((p) => p.functionResponse)) {
        last.parts.push(respPart);
      } else {
        contents.push({ role: "user", parts: [respPart] });
      }
      continue;
    }

    const parts = openaiContentToParts(message.content);
    for (const call of message.tool_calls || []) {
      const fn = call && typeof call === "object" ? call.function : null;
      if (!fn || typeof fn !== "object") continue;
      let args = fn.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args || "{}");
        } catch {
          args = { raw: args };
        }
      }
      const callId = String(call.id || "");
      const name = String(fn.name || "tool");
      if (callId) pendingCalls[callId] = name;
      const payload = { name, args: args || {} };
      if (callId) payload.id = callId;
      parts.push({
        functionCall: payload,
        thoughtSignature: SKIP_THOUGHT_SIGNATURE,
      });
    }
    contents.push({ role: role === "assistant" ? "model" : "user", parts: parts.length ? parts : [textPart("")] });
  }

  return {
    system: systemBits.length ? { parts: [{ text: systemBits.join("\n\n") }] } : null,
    contents: normalizeContents(contents),
  };
}

export function anthropicToGemini(body) {
  const messages = [...(body.messages || [])];
  if (typeof body.system === "string" && body.system.trim()) messages.unshift({ role: "system", content: body.system });
  else if (Array.isArray(body.system)) {
    const text = body.system.filter((part) => part && part.text).map((part) => String(part.text)).join("\n");
    if (text) messages.unshift({ role: "system", content: text });
  }
  const normalized = [];
  for (const message of messages) {
    const role = message.role;
    const content = message.content;
    if (role === "assistant" && Array.isArray(content)) {
      const toolCalls = [];
      const texts = [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text") texts.push(part.text || "");
        else if (part.type === "tool_use") {
          toolCalls.push({
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.input || {}) },
          });
        }
      }
      normalized.push({ role: "assistant", content: texts.join("\n"), tool_calls: toolCalls });
    } else if (role === "user" && Array.isArray(content)) {
      const leftovers = [];
      const media = [];
      for (const part of content) {
        if (part && part.type === "tool_result") {
          const raw = typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
          normalized.push({
            role: "tool",
            tool_call_id: part.tool_use_id,
            name: part.name,
            content: raw,
          });
        } else if (part && part.type === "text") leftovers.push(part.text || "");
        else if (part && (part.type === "image" || part.type === "image_url" || part.type === "input_image" || part.type === "base64" || part.source)) {
          media.push(part);
        } else if (part) leftovers.push(part);
      }
      if (leftovers.length || media.length) {
        const bits = leftovers.map((item) => typeof item === "string" ? { type: "text", text: item } : item);
        normalized.push({ role: "user", content: bits.concat(media) });
      }
    } else {
      normalized.push(message);
    }
  }
  return openaiMessagesToGemini(normalized);
}

export function wrapGenerate({ model, project, contents, system, generation, tools, sessionId, requestType }) {
  const request = { contents };
  if (system) request.systemInstruction = system;
  if (generation) request.generationConfig = generation;
  if (tools) request.tools = sanitizeTools(tools);
  if (sessionId) request.sessionId = sessionId;
  return {
    project,
    model,
    userAgent: "antigravity",
    requestType: requestType || (String(model).toLowerCase().includes("image") ? "image_gen" : "agent"),
    requestId: newRequestId(model),
    request,
  };
}

export function openaiToUpstream(body, { model, project, effort } = {}) {
  const { system, contents } = openaiMessagesToGemini(body.messages || []);
  const generation = {};
  if (body.temperature != null) generation.temperature = body.temperature;
  if (body.top_p != null) generation.topP = body.top_p;
  if (body.max_tokens != null) generation.maxOutputTokens = body.max_tokens;
  if (body.stop) generation.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  const responseFormat = body.response_format || {};
  if (responseFormat.type === "json_object") generation.responseMimeType = "application/json";
  if (responseFormat.json_schema && typeof responseFormat.json_schema === "object") {
    generation.responseSchema = sanitizeSchema(responseFormat.json_schema.schema || responseFormat.json_schema);
    generation.responseMimeType = "application/json";
  }
  const thinking = thinkingFromRequest(model, body, effort);
  if (thinking) generation.thinkingConfig = thinking;
  return wrapGenerate({
    model,
    project,
    contents,
    system,
    generation: Object.keys(generation).length ? generation : null,
    tools: Array.isArray(body.tools) ? body.tools : null,
    sessionId: body.user ? String(body.user) : null,
  });
}

const THINKING_OUTPUT_FLOOR = 4096;

export function outputTokenFloor(requested, thinking) {
  const wanted = Number(requested);
  const hasWanted = Number.isFinite(wanted) && wanted > 0;
  if (!thinking || typeof thinking !== "object") return hasWanted ? wanted : undefined;
  const budget = Number(thinking.thinkingBudget);
  const floor = Number.isFinite(budget) && budget > 0 ? budget + THINKING_OUTPUT_FLOOR : THINKING_OUTPUT_FLOOR;
  if (!hasWanted) return floor;
  return Math.max(wanted, floor);
}

export function anthropicToUpstream(body, { model, project, effort } = {}) {
  const { system, contents } = anthropicToGemini(body);
  const generation = {};
  if (body.temperature != null) generation.temperature = body.temperature;
  if (body.top_p != null) generation.topP = body.top_p;
  const thinkingOff = body.thinking && typeof body.thinking === "object" && (body.thinking.type === "disabled" || body.thinking.type === "none");
  if (thinkingOff && normalizeEffort(effort ?? extractEffortFromBody(body)) == null) {
    // Claude Code can disable thinking independently of effort.
  } else if (body.thinking && typeof body.thinking === "object" && body.thinking.budget_tokens && !thinkingOff) {
    generation.thinkingConfig = { includeThoughts: true, thinkingBudget: body.thinking.budget_tokens };
  } else {
    const thinking = thinkingFromRequest(model, body, effort);
    if (thinking) generation.thinkingConfig = thinking;
  }
  const maxOut = outputTokenFloor(body.max_tokens, generation.thinkingConfig);
  if (maxOut != null) generation.maxOutputTokens = maxOut;
  const tools = [];
  for (const tool of body.tools || []) {
    if (tool && typeof tool === "object") {
      tools.push({ name: tool.name, description: tool.description, parameters: tool.input_schema || {} });
    }
  }
  return wrapGenerate({
    model,
    project,
    contents,
    system,
    generation: Object.keys(generation).length ? generation : null,
    tools: tools.length ? tools : null,
  });
}

export function unwrapResponse(payload) {
  return payload?.response && typeof payload.response === "object" ? payload.response : payload;
}

export function partsToText(parts, thoughts = false) {
  const chunks = [];
  for (const part of parts || []) {
    if (!part || typeof part !== "object") continue;
    if (Boolean(part.thought) !== thoughts) continue;
    if (typeof part.text === "string") chunks.push(part.text);
  }
  return chunks.join("");
}

export function partsToToolCalls(parts) {
  const calls = [];
  (parts || []).forEach((part, index) => {
    if (!part || typeof part !== "object" || !part.functionCall) return;
    const call = part.functionCall || {};
    const args = call.args && typeof call.args === "object" ? call.args : {};
    calls.push({
      id: String(call.id || `call_${index}`),
      type: "function",
      function: { name: String(call.name || "tool"), arguments: JSON.stringify(args) },
    });
  });
  return calls;
}

export function finishReason(raw, tools) {
  if (tools) return "tool_calls";
  const mapping = {
    STOP: "stop",
    END_TURN: "stop",
    MAX_TOKENS: "length",
    SAFETY: "content_filter",
    RECITATION: "content_filter",
    OTHER: "stop",
  };
  return mapping[String(raw || "STOP").toUpperCase()] || "stop";
}

export function usageFromGemini(payload) {
  const meta = payload?.usageMetadata || payload?.usage_metadata || {};
  const prompt = Number(meta.promptTokenCount ?? meta.prompt_token_count ?? 0);
  const cached = Number(meta.cachedContentTokenCount ?? meta.cached_content_token_count ?? 0);
  const candidates = Number(meta.candidatesTokenCount ?? meta.candidates_token_count ?? 0);
  const thoughts = Number(meta.thoughtsTokenCount ?? meta.thoughts_token_count ?? 0);
  const toolUse = Number(meta.toolUsePromptTokenCount ?? meta.tool_use_prompt_token_count ?? 0);
  const output = candidates + thoughts;
  const input = prompt || (cached + toolUse);
  const total = Number(meta.totalTokenCount ?? meta.total_token_count ?? 0) || (input + output);
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
    reasoning_tokens: thoughts,
    cached_tokens: cached,
  };
}

export function anthropicUsageFromGemini(payload, { includeOutputDetails = true } = {}) {
  const usage = usageFromGemini(payload);
  const out = {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
  };
  if (usage.cached_tokens) out.cache_read_input_tokens = usage.cached_tokens;
  if (includeOutputDetails && usage.reasoning_tokens) {
    out.output_tokens_details = { thinking_tokens: usage.reasoning_tokens };
  }
  return out;
}

export function geminiToOpenai(payload, model) {
  const inner = unwrapResponse(payload);
  const first = (inner.candidates || [])[0] || {};
  const parts = first.content?.parts || [];
  const text = partsToText(parts, false);
  const reasoning = partsToText(parts, true);
  const tools = partsToToolCalls(parts);
  const message = { role: "assistant", content: text || null };
  if (tools.length) message.tool_calls = tools;
  if (reasoning) message.reasoning_content = reasoning;
  return {
    id: String(inner.responseId || payload.traceId || `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason(first.finishReason, tools.length > 0) }],
    usage: usageFromGemini(inner),
  };
}

export function geminiToAnthropic(payload, model) {
  const inner = unwrapResponse(payload);
  const first = (inner.candidates || [])[0] || {};
  const parts = first.content?.parts || [];
  const content = [];
  const reasoning = partsToText(parts, true);
  if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  const text = partsToText(parts, false);
  if (text) content.push({ type: "text", text });
  for (const call of partsToToolCalls(parts)) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: JSON.parse(call.function.arguments || "{}"),
    });
  }
  const usage = anthropicUsageFromGemini(inner);
  let stop = content.some((part) => part.type === "tool_use") ? "tool_use" : "end_turn";
  if (String(first.finishReason || "").toUpperCase() === "MAX_TOKENS") stop = "max_tokens";
  return {
    id: String(inner.responseId || `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`),
    type: "message",
    role: "assistant",
    model,
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: stop,
    usage,
  };
}

export function openaiChunk({ model, completionId, delta, finish = null, usage = null }) {
  const chunk = {
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

export class AnthropicStreamAccumulator {
  constructor(model) {
    this.model = model;
    this.messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.seenText = "";
    this.seenThoughts = "";
    this.textIndex = null;
    this.thinkIndex = null;
    this.block = 0;
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.stop = "end_turn";
    this.started = false;
    this.seenCallIds = new Set();
    this.thinkingSignatureSent = false;
  }

  start() {
    this.started = true;
    return [{
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }];
  }

  ingest(payload) {
    const inner = unwrapResponse(payload);
    const candidates = inner.candidates || [];
    const nextUsage = anthropicUsageFromGemini(inner);
    if (nextUsage.input_tokens || nextUsage.output_tokens || nextUsage.cache_read_input_tokens) {
      this.usage = { ...this.usage, ...nextUsage };
    }
    if (!candidates.length) {
      if (!this.started && (this.usage.input_tokens || this.usage.output_tokens)) {
        const events = this.start();
        events[0].message.usage = { ...this.usage };
        return events;
      }
      return [];
    }
    const parts = candidates[0].content?.parts || [];
    const events = [];
    if (!this.started) {
      events.push(...this.start());
      events[0].message.usage = { ...this.usage };
    }
    const thoughts = partsToText(parts, true);
    const extraThoughts = thoughts.startsWith(this.seenThoughts) ? thoughts.slice(this.seenThoughts.length) : thoughts;
    if (extraThoughts) {
      if (this.thinkIndex == null) {
        this.thinkIndex = this.block;
        events.push({ type: "content_block_start", index: this.thinkIndex, content_block: { type: "thinking", thinking: "" } });
        this.block += 1;
      }
      events.push({ type: "content_block_delta", index: this.thinkIndex, delta: { type: "thinking_delta", thinking: extraThoughts } });
      this.seenThoughts = thoughts;
    }
    const text = partsToText(parts, false);
    const extraText = text.startsWith(this.seenText) ? text.slice(this.seenText.length) : text;
    if (extraText) {
      if (this.textIndex == null) {
        this.textIndex = this.block;
        events.push({ type: "content_block_start", index: this.textIndex, content_block: { type: "text", text: "" } });
        this.block += 1;
      }
      events.push({ type: "content_block_delta", index: this.textIndex, delta: { type: "text_delta", text: extraText } });
      this.seenText = text;
    }
    const seenCallIds = this.seenCallIds;
    for (const call of partsToToolCalls(parts)) {
      if (seenCallIds.has(call.id)) continue;
      seenCallIds.add(call.id);
      const index = this.block;
      this.block += 1;
      this.stop = "tool_use";
      let parsed = {};
      try {
        parsed = JSON.parse(call.function.arguments || "{}");
      } catch {
        parsed = {};
      }
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: call.id, name: call.function.name, input: {} },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(parsed) },
      });
      events.push({ type: "content_block_stop", index });
    }
    if (candidates[0].finishReason) {
      if (this.stop !== "tool_use" && String(candidates[0].finishReason).toUpperCase() === "MAX_TOKENS") this.stop = "max_tokens";
    }
    return events;
  }

  finish() {
    const events = [];
    if (this.thinkIndex != null) {
      if (!this.thinkingSignatureSent) {
        events.push({
          type: "content_block_delta",
          index: this.thinkIndex,
          delta: { type: "signature_delta", signature: SKIP_THOUGHT_SIGNATURE },
        });
        this.thinkingSignatureSent = true;
      }
      events.push({ type: "content_block_stop", index: this.thinkIndex });
    }
    if (this.textIndex != null) events.push({ type: "content_block_stop", index: this.textIndex });
    events.push({
      type: "message_delta",
      delta: { stop_reason: this.stop, stop_sequence: null },
      usage: this.usage,
    });
    events.push({ type: "message_stop" });
    return events;
  }
}

export class StreamAccumulator {
  constructor(model) {
    this.model = model;
    this.completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.seenText = "";
    this.seenThoughts = "";
    this.emittedRole = false;
    this.toolIndex = 0;
    this.usage = usageFromGemini({});
  }

  ingest(payload) {
    const inner = unwrapResponse(payload);
    const candidates = inner.candidates || [];
    const nextUsage = usageFromGemini(inner);
    if (nextUsage.prompt_tokens || nextUsage.completion_tokens || nextUsage.reasoning_tokens) this.usage = nextUsage;
    if (!candidates.length) return [];
    const parts = candidates[0].content?.parts || [];
    const events = [];
    if (!this.emittedRole) {
      events.push(openaiChunk({ model: this.model, completionId: this.completionId, delta: { role: "assistant" } }));
      this.emittedRole = true;
    }
    const thoughts = partsToText(parts, true);
    const extraThoughts = thoughts.startsWith(this.seenThoughts) ? thoughts.slice(this.seenThoughts.length) : thoughts;
    if (extraThoughts) {
      events.push(openaiChunk({ model: this.model, completionId: this.completionId, delta: { reasoning_content: extraThoughts } }));
      this.seenThoughts = thoughts;
    }
    const text = partsToText(parts, false);
    const extraText = text.startsWith(this.seenText) ? text.slice(this.seenText.length) : text;
    if (extraText) {
      events.push(openaiChunk({ model: this.model, completionId: this.completionId, delta: { content: extraText } }));
      this.seenText = text;
    }
    for (const call of partsToToolCalls(parts)) {
      events.push(
        openaiChunk({
          model: this.model,
          completionId: this.completionId,
          delta: { tool_calls: [{ ...call, index: this.toolIndex }] },
        }),
      );
      this.toolIndex += 1;
    }
    const finish = candidates[0].finishReason;
    if (finish) {
      events.push(
        openaiChunk({
          model: this.model,
          completionId: this.completionId,
          delta: {},
          finish: finishReason(finish, this.toolIndex > 0),
          usage: this.usage,
        }),
      );
    }
    return events;
  }

  finish() {
    if (this.emittedRole) return [];
    return this.ingest({
      response: {
        candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
      },
    });
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n");
  if (typeof value === "object") return firstString(value.text, value.content, value.output);
  return String(value);
}

function responsesContentToOpenai(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object") return { type: "text", text: String(part) };
      const kind = part.type;
      if (kind === "input_text" || kind === "output_text" || kind === "text" || kind === "refusal") {
        return { type: "text", text: firstString(part.text, part.content, part.output) };
      }
      return part;
    });
  }
  if (typeof content === "object") {
    return [{ type: "text", text: firstString(content.text, content.content, content.output) }];
  }
  return String(content);
}

function normalizeResponsesRole(role) {
  const value = String(role || "").toLowerCase();
  if (value === "developer" || value === "system") return "system";
  if (value === "assistant" || value === "tool" || value === "user") return value;
  return value || "user";
}

function responseInputItemToMessages(item) {
  if (item == null) return [];
  if (typeof item === "string") return item.trim() ? [{ role: "user", content: item }] : [];
  if (typeof item !== "object") return [];
  const itemType = String(item.type || "");
  const role = normalizeResponsesRole(item.role);
  if (itemType === "additional_tools") return [];
  if (itemType === "agent_message") {
    const bits = [];
    for (const part of item.content || []) {
      if (part && typeof part === "object") {
        const text = firstString(part.text, part.encrypted_content);
        if (text) bits.push(text);
      }
    }
    return bits.length ? [{ role: "user", content: bits.join("\n") }] : [];
  }
  if (itemType === "input_text") return [{ role: "user", content: firstString(item.text, item.content) }];
  if (itemType === "output_text") return [{ role: "assistant", content: firstString(item.text, item.content) }];
  if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
    return [{
      role: "tool",
      tool_call_id: firstString(item.call_id, item.tool_call_id, item.id),
      content: typeof item.output === "string" || typeof item.content === "string"
        ? firstString(item.output, item.content)
        : JSON.stringify(item.output ?? item.content ?? {}),
    }];
  }
  if (itemType === "function_call" || itemType === "custom_tool_call") {
    let argumentsText = typeof item.arguments === "string" ? item.arguments : "";
    if (itemType === "custom_tool_call") argumentsText = JSON.stringify({ input: item.input || "" });
    else if (!argumentsText && item.arguments && typeof item.arguments === "object") argumentsText = JSON.stringify(item.arguments);
    return [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: firstString(item.call_id, item.id),
        type: "function",
        function: { name: firstString(item.name), arguments: argumentsText || "{}" },
      }],
    }];
  }
  if (!itemType || itemType === "message") {
    return [{ role: role || "user", content: responsesContentToOpenai(item.content) }];
  }
  if (role) return [{ role, content: responsesContentToOpenai(item.content) }];
  return [];
}

export function responsesInputToMessages(input) {
  if (input == null || input === "") return [];
  if (typeof input === "string") return input.trim() ? [{ role: "user", content: input }] : [];
  if (Array.isArray(input)) return input.flatMap(responseInputItemToMessages);
  if (typeof input === "object") return responseInputItemToMessages(input);
  return [];
}

export function responsesToolsToOpenai(tools) {
  const out = [];
  for (const tool of tools || []) {
    if (!tool || typeof tool !== "object") continue;
    const kind = String(tool.type || (tool.function?.name ? "function" : "")).toLowerCase();
    if (kind === "namespace") {
      out.push(...responsesToolsToOpenai(tool.tools || []));
      continue;
    }
    if (kind === "web_search" || kind === "web_search_preview") {
      out.push({ type: "function", function: { name: "web_search", description: "Search the web", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } });
      continue;
    }
    if (kind === "function" || kind === "custom") {
      const fn = tool.function && typeof tool.function === "object" ? tool.function : {};
      const name = firstString(fn.name, tool.name);
      if (!name) continue;
      out.push({
        type: "function",
        function: {
          name,
          description: firstString(fn.description, tool.description),
          parameters: fn.parameters || tool.parameters || { type: "object", properties: {} },
        },
      });
    }
  }
  return out;
}

export function responsesToChatBody(body, previousMessages = []) {
  const current = responsesInputToMessages(body.input);
  const extras = [];
  const instructions = asText(body.instructions);
  if (instructions.trim()) extras.push({ role: "system", content: instructions });
  const formatType = String(body.text?.format?.type || "").toLowerCase();
  if (formatType === "json_object") extras.push({ role: "system", content: "Respond only with a valid JSON object. Do not include markdown fences or extra text." });
  if (formatType === "json_schema") extras.push({ role: "system", content: `Respond only with valid JSON matching this JSON schema. Do not include markdown fences or extra text.\n${JSON.stringify(body.text.format)}` });
  const messages = [...previousMessages, ...extras, ...current];
  const chat = {
    model: body.model,
    messages,
    stream: Boolean(body.stream),
    tools: responsesToolsToOpenai(body.tools),
    tool_choice: body.tool_choice,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_output_tokens,
    reasoning_effort: body.reasoning?.effort || body.reasoning_effort,
  };
  if (formatType === "json_object") chat.response_format = { type: "json_object" };
  if (formatType === "json_schema") chat.response_format = { type: "json_schema", json_schema: body.text.format };
  return { chat, current, extras };
}

export function openaiToResponses(chat, { id, model, previousId = null, metadata = null, createdAt = Math.floor(Date.now() / 1000) } = {}) {
  const message = chat?.choices?.[0]?.message || {};
  const text = typeof message.content === "string" ? message.content : "";
  const reasoning = message.reasoning_content || "";
  const tools = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const finish = chat?.choices?.[0]?.finish_reason;
  const incomplete = finish === "length" || finish === "content_filter";
  const output = [];
  if (reasoning) {
    output.push({
      id: `rs_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoning }],
      content: [{ type: "reasoning_text", text: reasoning }],
    });
  }
  if (text || !tools.length) {
    output.push({
      id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: text || "", annotations: [] }],
    });
  }
  for (const call of tools) {
    output.push({
      id: call.id,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments || "{}",
    });
  }
  const usage = chat?.usage || {};
  return {
    id: id || `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "response",
    created_at: createdAt,
    status: incomplete ? "incomplete" : "completed",
    incomplete_details: incomplete ? { reason: finish === "length" ? "max_output_tokens" : "content_filter" } : null,
    model,
    previous_response_id: previousId || null,
    output,
    output_text: text,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
    ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
  };
}

export function responsesAssistantMessage(chat) {
  const message = chat?.choices?.[0]?.message || {};
  const out = { role: "assistant", content: message.content ?? null };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) out.tool_calls = message.tool_calls;
  return out;
}

export class ResponsesStreamAccumulator {
  constructor({ id, model, previousId = null }) {
    this.id = id;
    this.model = model;
    this.previousId = previousId || null;
    this.createdAt = Math.floor(Date.now() / 1000);
    this.seenText = "";
    this.seenThoughts = "";
    this.textItemId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.reasonItemId = `rs_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.started = false;
    this.reasonStarted = false;
    this.textStarted = false;
    this.usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    this.finish = null;
    this.toolCalls = [];
  }

  startEvents() {
    this.started = true;
    return [
      this.event("response.created", { response: this.snapshot("in_progress") }),
      this.event("response.in_progress", { response: this.snapshot("in_progress") }),
    ];
  }

  ingest(payload) {
    const inner = unwrapResponse(payload);
    const candidates = inner.candidates || [];
    const usage = usageFromGemini(inner);
    if (usage.prompt_tokens || usage.completion_tokens || usage.total_tokens) {
      this.usage = { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens };
    }
    if (!candidates.length) return [];
    const parts = candidates[0].content?.parts || [];
    const events = [];
    if (!this.started) events.push(...this.startEvents());
    const thoughts = partsToText(parts, true);
    const extraThoughts = thoughts.startsWith(this.seenThoughts) ? thoughts.slice(this.seenThoughts.length) : thoughts;
    if (extraThoughts) {
      if (!this.reasonStarted) {
        events.push(this.event("response.output_item.added", { output_index: 0, item: { id: this.reasonItemId, type: "reasoning", status: "in_progress" } }));
        this.reasonStarted = true;
      }
      events.push(this.event("response.reasoning_text.delta", { item_id: this.reasonItemId, delta: extraThoughts }));
      this.seenThoughts = thoughts;
    }
    const text = partsToText(parts, false);
    const extraText = text.startsWith(this.seenText) ? text.slice(this.seenText.length) : text;
    if (extraText) {
      if (!this.textStarted) {
        events.push(this.event("response.output_item.added", {
          output_index: this.reasonStarted ? 1 : 0,
          item: { id: this.textItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
        }));
        events.push(this.event("response.content_part.added", {
          item_id: this.textItemId,
          output_index: this.reasonStarted ? 1 : 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }));
        this.textStarted = true;
      }
      events.push(this.event("response.output_text.delta", {
        item_id: this.textItemId,
        output_index: this.reasonStarted ? 1 : 0,
        content_index: 0,
        delta: extraText,
      }));
      this.seenText = text;
    }
    for (const call of partsToToolCalls(parts)) {
      this.toolCalls.push(call);
      events.push(this.event("response.output_item.added", {
        output_index: this.outputCount() - 1,
        item: { id: call.id, type: "function_call", status: "in_progress", call_id: call.id, name: call.function.name, arguments: "" },
      }));
      events.push(this.event("response.function_call_arguments.delta", { item_id: call.id, delta: call.function.arguments || "{}" }));
      events.push(this.event("response.function_call_arguments.done", { item_id: call.id, arguments: call.function.arguments || "{}" }));
    }
    if (candidates[0].finishReason) {
      this.finish = finishReason(candidates[0].finishReason, this.toolCalls.length > 0);
    }
    return events;
  }

  finishEvents() {
    const events = [];
    if (this.textStarted) {
      events.push(this.event("response.output_text.done", {
        item_id: this.textItemId,
        output_index: this.reasonStarted ? 1 : 0,
        content_index: 0,
        text: this.seenText,
      }));
      events.push(this.event("response.content_part.done", {
        item_id: this.textItemId,
        output_index: this.reasonStarted ? 1 : 0,
        content_index: 0,
        part: { type: "output_text", text: this.seenText, annotations: [] },
      }));
    }
    const completed = this.snapshot(this.finish === "length" || this.finish === "content_filter" ? "incomplete" : "completed");
    events.push(this.event(completed.status === "incomplete" ? "response.incomplete" : "response.completed", { response: completed }));
    return events;
  }

  outputCount() {
    return (this.reasonStarted ? 1 : 0) + (this.textStarted || !this.toolCalls.length ? 1 : 0) + this.toolCalls.length;
  }

  snapshot(status) {
    const fake = {
      choices: [{
        message: {
          content: this.seenText,
          reasoning_content: this.seenThoughts || undefined,
          tool_calls: this.toolCalls.length ? this.toolCalls : undefined,
        },
        finish_reason: this.finish,
      }],
      usage: { prompt_tokens: this.usage.input_tokens, completion_tokens: this.usage.output_tokens, total_tokens: this.usage.total_tokens },
    };
    return openaiToResponses(fake, { id: this.id, model: this.model, previousId: this.previousId, createdAt: this.createdAt });
  }

  event(type, extra) {
    return { type, ...extra };
  }
}
