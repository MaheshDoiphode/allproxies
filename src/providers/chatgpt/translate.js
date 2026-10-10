import crypto from "node:crypto";
import {
  AnthropicStreamAccumulator,
  StreamAccumulator,
  openaiChunk,
  openaiToResponses,
  responsesToChatBody,
} from "../antigravity/translate.js";

export function normalizeChatgptResponsesBody(body, { modelInfo = null, forceStream = false } = {}) {
  const normalized = { ...(body && typeof body === "object" ? body : {}) };
  if (typeof normalized.input === "string") {
    normalized.input = [{ role: "user", content: [{ type: "input_text", text: normalized.input }] }];
  }
  if (!Array.isArray(normalized.include)) normalized.include = [];
  if (!normalized.include.includes("reasoning.encrypted_content")) {
    normalized.include.push("reasoning.encrypted_content");
  }
  normalized.store = false;
  if (normalized.instructions == null) normalized.instructions = "";
  const lite = modelInfo?.use_responses_lite ?? modelInfo?.useResponsesLite ?? true;
  if (lite) {
    const input = Array.isArray(normalized.input) ? [...normalized.input] : [];
    const prefix = [];
    const tools = Array.isArray(normalized.tools) ? normalized.tools : [];
    if (tools.length && !input.some((item) => item && item.type === "additional_tools")) {
      prefix.push({ type: "additional_tools", role: "developer", tools });
    }
    if (typeof normalized.instructions === "string" && normalized.instructions) {
      prefix.push({ role: "developer", content: [{ type: "input_text", text: normalized.instructions }] });
    }
    normalized.input = [...prefix, ...input];
    normalized.instructions = "";
    normalized.parallel_tool_calls = false;
    delete normalized.tools;
    const reasoning = normalized.reasoning && typeof normalized.reasoning === "object" ? { ...normalized.reasoning } : {};
    if (reasoning.context == null) reasoning.context = "all_turns";
    const defaultEffort = modelInfo?.default_reasoning_level || modelInfo?.defaultReasoningLevel;
    if (reasoning.effort == null && defaultEffort) reasoning.effort = defaultEffort;
    if (Object.keys(reasoning).length) normalized.reasoning = reasoning;
    if (modelInfo?.support_verbosity || modelInfo?.supportVerbosity) {
      const text = normalized.text && typeof normalized.text === "object" ? { ...normalized.text } : {};
      const defaultVerbosity = modelInfo.default_verbosity || modelInfo.defaultVerbosity;
      if (text.verbosity == null && defaultVerbosity) text.verbosity = defaultVerbosity;
      if (Object.keys(text).length) normalized.text = text;
    }
  } else {
    const defaultEffort = modelInfo?.default_reasoning_level || modelInfo?.defaultReasoningLevel;
    if (defaultEffort) {
      const reasoning = normalized.reasoning && typeof normalized.reasoning === "object" ? { ...normalized.reasoning } : {};
      if (reasoning.effort == null) reasoning.effort = defaultEffort;
      if (Object.keys(reasoning).length) normalized.reasoning = reasoning;
    }
  }
  if (forceStream) normalized.stream = true;
  delete normalized.max_output_tokens;
  return normalized;
}

export function chatgptUsageToOpenai(usage = {}) {
  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const cached = Number(usage.input_tokens_details?.cached_tokens || 0);
  const reasoning = Number(usage.output_tokens_details?.reasoning_tokens || 0);
  const out = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: Number(usage.total_tokens || input + output),
    reasoning_tokens: reasoning,
    cached_tokens: cached,
  };
  if (cached) out.prompt_tokens_details = { cached_tokens: cached };
  if (reasoning) out.completion_tokens_details = { reasoning_tokens: reasoning };
  return out;
}

export function chatgptUsageToAnthropic(usage = {}) {
  const mapped = chatgptUsageToOpenai(usage);
  const out = { input_tokens: mapped.prompt_tokens, output_tokens: mapped.completion_tokens };
  if (mapped.cached_tokens) out.cache_read_input_tokens = mapped.cached_tokens;
  if (mapped.reasoning_tokens) out.output_tokens_details = { thinking_tokens: mapped.reasoning_tokens };
  return out;
}

function partsFromOutput(response) {
  const items = Array.isArray(response?.output) ? response.output : [];
  let text = "";
  let reasoning = "";
  const tools = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning") {
      for (const part of item.content || item.summary || []) {
        if (part?.text) reasoning += part.text;
      }
    }
    if (item.type === "message") {
      for (const part of item.content || []) {
        if ((part?.type === "output_text" || part?.type === "text") && part.text) text += part.text;
      }
    }
    if (item.type === "function_call") {
      tools.push({
        id: item.call_id || item.id,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      });
    }
  }
  return { text, reasoning, tools };
}

export function responsesOutputToOpenai(response, model) {
  const { text, reasoning, tools } = partsFromOutput(response);
  const usage = chatgptUsageToOpenai(response?.usage || {});
  const message = { role: "assistant", content: text || null };
  if (tools.length) message.tool_calls = tools;
  if (reasoning) message.reasoning_content = reasoning;
  let finish = tools.length ? "tool_calls" : "stop";
  if (response?.status === "incomplete") finish = "length";
  return {
    id: String(response?.id || `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`),
    object: "chat.completion",
    created: Number(response?.created_at || Math.floor(Date.now() / 1000)),
    model: response?.model || model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}

export function responsesOutputToAnthropic(response, model) {
  const chat = responsesOutputToOpenai(response, model);
  const message = chat.choices[0].message;
  const content = [];
  if (message.reasoning_content) content.push({ type: "thinking", thinking: message.reasoning_content });
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  return {
    id: String(response?.id || `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`),
    type: "message",
    role: "assistant",
    model: response?.model || model,
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: (message.tool_calls || []).length ? "tool_use" : "end_turn",
    usage: chatgptUsageToAnthropic(response?.usage || {}),
  };
}

function openaiMessagesToResponsesInput(messages = []) {
  const input = [];
  for (const message of messages || []) {
    if (!message) continue;
    if (message.role === "system") {
      const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
      input.push({ role: "developer", content: [{ type: "input_text", text }] });
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: typeof message.content === "string" ? message.content : JSON.stringify(message.content || ""),
      });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      for (const call of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments || "{}",
        });
      }
      if (message.content) {
        input.push({ role: "assistant", content: [{ type: "output_text", text: String(message.content) }] });
      }
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const text = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => part?.text || "").join("\n")
        : "";
    if (text) input.push({ role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
  }
  return input;
}

export function chatToChatgptResponses(body, { model, modelInfo } = {}) {
  const tools = Array.isArray(body.tools)
    ? body.tools.map((tool) => {
        const fn = tool.function || tool;
        return {
          type: "function",
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters || { type: "object", properties: {} },
        };
      })
    : [];
  const effort = body.reasoning_effort || body.reasoning?.effort;
  return normalizeChatgptResponsesBody(
    {
      model,
      input: openaiMessagesToResponsesInput(body.messages || []),
      tools,
      stream: Boolean(body.stream),
      reasoning: effort ? { effort } : undefined,
    },
    { modelInfo, forceStream: Boolean(body.stream) },
  );
}

export function messagesToChatgptResponses(body, { model, modelInfo } = {}) {
  const messages = [];
  if (typeof body.system === "string" && body.system) messages.push({ role: "system", content: body.system });
  for (const message of body.messages || []) {
    if (!message) continue;
    if (Array.isArray(message.content)) {
      const texts = [];
      const tools = [];
      const results = [];
      for (const part of message.content) {
        if (!part) continue;
        if (part.type === "text") texts.push(part.text || "");
        else if (part.type === "tool_use") {
          tools.push({
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.input || {}) },
          });
        } else if (part.type === "tool_result") {
          results.push({
            role: "tool",
            tool_call_id: part.tool_use_id,
            content: typeof part.content === "string" ? part.content : JSON.stringify(part.content || ""),
          });
        }
      }
      if (tools.length) messages.push({ role: "assistant", content: texts.join("\n") || null, tool_calls: tools });
      else if (texts.length) messages.push({ role: message.role, content: texts.join("\n") });
      messages.push(...results);
    } else {
      messages.push({ role: message.role, content: message.content });
    }
  }
  return chatToChatgptResponses(
    {
      model,
      messages,
      tools: (body.tools || []).map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.input_schema || {} },
      })),
      stream: body.stream,
      reasoning_effort: body.thinking?.effort || body.output_config?.effort,
    },
    { model, modelInfo },
  );
}

export class ChatgptResponsesStreamAccumulator {
  constructor(model) {
    this.model = model;
    this.response = {
      id: `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      model,
      output: [],
      usage: {},
      status: "in_progress",
    };
    this.seenText = "";
    this.openai = new StreamAccumulator(model);
    this.anthropic = new AnthropicStreamAccumulator(model);
  }

  ingest(event) {
    if (!event || typeof event !== "object") return { openai: [], anthropic: [] };
    if (event.response && typeof event.response === "object") {
      this.response = { ...this.response, ...event.response };
    }
    if (event.type === "response.output_text.delta" && event.delta) this.seenText += String(event.delta);
    if (event.type === "response.output_text.done" && event.text && !this.seenText) this.seenText = event.text;
    if (event.type === "response.completed" && event.response) this.response = event.response;
    const fake = {
      response: {
        candidates: [
          {
            content: { role: "model", parts: [{ text: this.seenText }] },
            finishReason: event.type === "response.completed" ? "STOP" : undefined,
          },
        ],
        usageMetadata: {
          promptTokenCount: this.response.usage?.input_tokens || 0,
          candidatesTokenCount: this.response.usage?.output_tokens || 0,
          thoughtsTokenCount: this.response.usage?.output_tokens_details?.reasoning_tokens || 0,
          cachedContentTokenCount: this.response.usage?.input_tokens_details?.cached_tokens || 0,
          totalTokenCount: this.response.usage?.total_tokens || 0,
        },
      },
    };
    return {
      openai: this.openai.ingest(fake),
      anthropic: this.anthropic.ingest(fake),
    };
  }

  finishOpenai() {
    const extra = openaiChunk({
      model: this.model,
      completionId: this.openai.completionId,
      delta: {},
      finish: "stop",
      usage: chatgptUsageToOpenai(this.response.usage || {}),
    });
    return [...this.openai.finish(), extra].filter(Boolean);
  }

  finishAnthropic() {
    return this.anthropic.finish();
  }
}

export { openaiToResponses, responsesToChatBody, StreamAccumulator, AnthropicStreamAccumulator };
