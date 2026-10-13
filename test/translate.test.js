import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicStreamAccumulator,
  StreamAccumulator,
  anthropicToGemini,
  anthropicToUpstream,
  geminiToAnthropic,
  geminiToOpenai,
  openaiToResponses,
  openaiToUpstream,
  outputTokenFloor,
  responsesInputToMessages,
  responsesToChatBody,
  thinkingFromRequest,
  unwrapResponse,
} from "../src/providers/antigravity/translate.js";

const SAMPLE = {
  response: {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { text: "plan", thought: true },
            { text: "hello" },
            { functionCall: { name: "lookup", args: { q: "x" }, id: "c1" } },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 1, totalTokenCount: 6 },
    responseId: "r1",
  },
  traceId: "t1",
};

test("openai wraps envelope and system object", () => {
  const payload = openaiToUpstream(
    {
      model: "gemini-3.8-flash-high",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.2,
      max_tokens: 16,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } } }],
    },
    { model: "gemini-3.8-flash-high", project: "proj-123" },
  );
  assert.equal(payload.project, "proj-123");
  assert.equal(payload.model, "gemini-3.8-flash-high");
  assert.equal(payload.userAgent, "antigravity");
  assert.equal(payload.requestType, "agent");
  assert.match(payload.requestId, /^agent-/);
  assert.deepEqual(payload.request.systemInstruction, { parts: [{ text: "be brief" }] });
  assert.equal(payload.request.contents[0].role, "user");
  assert.equal(payload.request.generationConfig.temperature, 0.2);
  assert.equal(payload.request.tools[0].functionDeclarations[0].name, "lookup");
});

test("assistant maps to model and tool result to function response", () => {
  const payload = openaiToUpstream(
    {
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "{\"ok\":true}" },
      ],
    },
    { model: "m", project: "p" },
  );
  assert.deepEqual(
    payload.request.contents.map((item) => item.role),
    ["user", "model", "user"],
  );
  assert.equal(payload.request.contents[1].parts[0].functionCall.name, "lookup");
  assert.equal(payload.request.contents[1].parts[0].thoughtSignature, "skip_thought_signature_validator");
  assert.equal(payload.request.contents[2].parts[0].functionResponse.name, "lookup");
});

test("interrupted assistant reply is followed by a continue user turn", () => {
  const payload = openaiToUpstream(
    {
      messages: [
        { role: "user", content: "write a long poem" },
        { role: "assistant", content: "In the quiet dusk the" },
      ],
    },
    { model: "m", project: "p" },
  );
  assert.deepEqual(
    payload.request.contents.map((item) => item.role),
    ["user", "model", "user"],
  );
  assert.equal(payload.request.contents[1].parts[0].text, "In the quiet dusk the");
  assert.equal(payload.request.contents[2].parts[0].text, "(continue)");
});

test("anthropic interrupted assistant reply is followed by a continue user turn", () => {
  const payload = anthropicToUpstream(
    {
      model: "m",
      max_tokens: 16,
      messages: [
        { role: "user", content: "write a long poem" },
        { role: "assistant", content: "In the quiet dusk the" },
      ],
    },
    { model: "m", project: "p" },
  );
  assert.deepEqual(
    payload.request.contents.map((item) => item.role),
    ["user", "model", "user"],
  );
  assert.equal(payload.request.contents[2].parts[0].text, "(continue)");
});

test("anthropic tool_result becomes a user functionResponse", () => {
  const payload = anthropicToUpstream(
    {
      model: "m",
      max_tokens: 16,
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "lookup", input: { q: "x" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c1", content: "file body" }],
        },
      ],
    },
    { model: "m", project: "p" },
  );
  assert.deepEqual(
    payload.request.contents.map((item) => item.role),
    ["user", "model", "user"],
  );
  assert.equal(payload.request.contents[2].parts[0].functionResponse.name, "lookup");
  assert.equal(payload.request.contents[2].parts[0].functionResponse.response.result, "file body");
  assert.equal(payload.request.contents[1].parts[0].thoughtSignature, "skip_thought_signature_validator");
});

test("openai routes reasoning effort into thinkingConfig", () => {
  const payload = openaiToUpstream(
    { model: "gemini-3.6-flash", messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium" },
    { model: "gemini-3.6-flash-medium", project: "p", effort: "medium" },
  );
  assert.equal(payload.model, "gemini-3.6-flash-medium");
  assert.deepEqual(payload.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: "medium" });
});

test("thinking level from model suffix and reasoning effort", () => {
  assert.deepEqual(thinkingFromRequest("gemini-3.8-flash-high", {}), { includeThoughts: true, thinkingLevel: "high" });
  assert.deepEqual(thinkingFromRequest("claude-opus-4-6-thinking", { reasoning_effort: "low" }), { includeThoughts: true, thinkingBudget: 8192 });
  assert.deepEqual(thinkingFromRequest("m", { extra_body: { google: { thinkingBudget: 9 } } }), { includeThoughts: true, thinkingBudget: 9 });
  assert.deepEqual(thinkingFromRequest("gemini-3.6-flash", { reasoning_effort: "high" }, "high"), { includeThoughts: true, thinkingLevel: "high" });
  assert.deepEqual(thinkingFromRequest("gemini-3.6-flash", { output_config: { effort: "medium" } }), { includeThoughts: true, thinkingLevel: "medium" });
  assert.equal(thinkingFromRequest("gemini-3.6-flash-high", { reasoning_effort: "none" }), null);
  assert.equal(thinkingFromRequest("gemini-3.6-flash", { thinking: { type: "disabled" } }), null);
});

test("response maps thoughts and tools", () => {
  const out = geminiToOpenai(SAMPLE, "gemini-3.8-flash-high");
  assert.equal(out.object, "chat.completion");
  assert.equal(out.choices[0].message.content, "hello");
  assert.equal(out.choices[0].message.reasoning_content, "plan");
  assert.equal(out.choices[0].message.tool_calls[0].function.name, "lookup");
  assert.equal(out.choices[0].finish_reason, "tool_calls");
  assert.equal(out.usage.prompt_tokens, 3);
  assert.equal(out.usage.completion_tokens, 3);
  assert.equal(out.usage.reasoning_tokens, 1);
  assert.equal(out.usage.total_tokens, 6);
});

test("unwrap accepts bare or wrapped", () => {
  assert.deepEqual(unwrapResponse({ response: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrapResponse({ a: 1 }), { a: 1 });
});

test("anthropic response maps text and tools", () => {
  const out = geminiToAnthropic(SAMPLE, "claude-sonnet-4-6");
  assert.equal(out.type, "message");
  assert.equal(out.content[0].type, "thinking");
  assert.equal(out.content[1].text, "hello");
  assert.equal(out.content[2].type, "tool_use");
  assert.equal(out.stop_reason, "tool_use");
  assert.equal(out.usage.input_tokens, 3);
  assert.equal(out.usage.output_tokens, 3);
  assert.equal(out.usage.output_tokens_details.thinking_tokens, 1);
});

test("anthropic stream publishes input and output tokens for Copilot", () => {
  const acc = new AnthropicStreamAccumulator("m");
  const usageOnly = acc.ingest({
    response: { usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 40, thoughtsTokenCount: 80, cachedContentTokenCount: 300, totalTokenCount: 1320 } },
  });
  assert.equal(usageOnly[0].type, "message_start");
  assert.equal(usageOnly[0].message.usage.input_tokens, 1200);
  const events = acc.ingest({
    response: {
      candidates: [{ content: { parts: [{ text: "plan", thought: true }, { text: "hi" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 40, thoughtsTokenCount: 80, cachedContentTokenCount: 300, totalTokenCount: 1320 },
    },
  });
  assert.ok(events.some((item) => item.type === "content_block_delta"));
  const done = acc.finish();
  const delta = done.find((item) => item.type === "message_delta");
  assert.equal(delta.usage.input_tokens, 1200);
  assert.equal(delta.usage.output_tokens, 120);
  assert.equal(delta.usage.cache_read_input_tokens, 300);
  assert.equal(delta.usage.output_tokens_details.thinking_tokens, 80);
});

test("responses input becomes chat messages", () => {
  const { chat } = responsesToChatBody({
    model: "gemini-3.8-flash-high",
    instructions: "be brief",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } }],
  });
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[1].content[0].text, "hi");
  assert.equal(chat.tools[0].function.name, "lookup");
  assert.equal(responsesInputToMessages("plain").length, 1);
});

test("chat completion maps to responses object", () => {
  const chat = geminiToOpenai(SAMPLE, "gemini-3.8-flash-high");
  const out = openaiToResponses(chat, { id: "resp_test", model: "gemini-3.8-flash-high" });
  assert.equal(out.object, "response");
  assert.equal(out.id, "resp_test");
  assert.equal(out.output_text, "hello");
  assert.ok(out.output.some((item) => item.type === "reasoning"));
  assert.ok(out.output.some((item) => item.type === "function_call"));
});

test("anthropic stream keeps tool_use stop even if Gemini says MAX_TOKENS", () => {
  const acc = new AnthropicStreamAccumulator("m");
  acc.start();
  acc.ingest({
    response: {
      candidates: [{
        content: { parts: [{ functionCall: { name: "lookup", args: { q: "x" }, id: "c1" } }] },
        finishReason: "MAX_TOKENS",
      }],
    },
  });
  const done = acc.finish();
  assert.equal(done.find((item) => item.type === "message_delta").delta.stop_reason, "tool_use");
});

test("anthropic stream signs thinking blocks before stop", () => {
  const acc = new AnthropicStreamAccumulator("m");
  acc.start();
  acc.ingest({ response: { candidates: [{ content: { parts: [{ text: "plan", thought: true }, { text: "hi" }] } }] } });
  const done = acc.finish();
  assert.ok(done.some((item) => item.delta?.type === "signature_delta" && item.delta.signature === "skip_thought_signature_validator"));
  assert.ok(done.some((item) => item.type === "content_block_stop" && item.index === 0));
});

test("claude requests send tool schemas as parametersJsonSchema, gemini keeps parameters", () => {
  const body = {
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } } } }],
  };
  const claude = anthropicToUpstream(body, { model: "claude-sonnet-4-6", project: "p" });
  const claudeDecl = claude.request.tools[0].functionDeclarations[0];
  assert.ok(claudeDecl.parametersJsonSchema && !claudeDecl.parameters);
  const gemini = anthropicToUpstream(body, { model: "gemini-3.8-flash", project: "p" });
  const geminiDecl = gemini.request.tools[0].functionDeclarations[0];
  assert.ok(geminiDecl.parameters && !geminiDecl.parametersJsonSchema);
});

test("tool result images stay in the same user turn as the functionResponse", () => {
  const png = "iVBORw0KGgo=";
  const { contents } = anthropicToGemini({
    messages: [
      { role: "user", content: "look" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "shot", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "c1",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
              { type: "text", text: "done" },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(contents.map((turn) => turn.role), ["user", "model", "user"]);
  assert.ok(contents[2].parts[0].functionResponse);
  assert.equal(contents[2].parts[1].inlineData.data, png);
});

test("image envelope sent as text becomes an image part", () => {
  const data = "A".repeat(200);
  const envelope = JSON.stringify({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
  const { contents } = anthropicToGemini({
    messages: [{ role: "user", content: [{ type: "text", text: "<attachments>" }, { type: "text", text: envelope }, { type: "text", text: "hi" }] }],
  });
  assert.equal(contents.length, 1);
  assert.deepEqual(contents[0].parts.map((part) => (part.inlineData ? "image" : part.text)), ["<attachments>", "image", "hi"]);
  assert.equal(contents[0].parts[1].inlineData.mimeType, "image/jpeg");
});

test("anthropic stream finish only closes opened blocks", () => {
  const empty = new AnthropicStreamAccumulator("m");
  assert.equal(empty.start()[0].type, "message_start");
  const emptyDone = empty.finish();
  // An empty turn must still carry one text block, otherwise VS Code says "no response was returned".
  assert.deepEqual(emptyDone.map((item) => item.type), ["content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.match(emptyDone[1].delta.text, /no output/);
  assert.ok(emptyDone.some((item) => item.type === "message_stop"));

  const malformed = new AnthropicStreamAccumulator("m");
  malformed.start();
  malformed.ingest({ response: { candidates: [{ content: { role: "model" }, finishReason: "MALFORMED_FUNCTION_CALL" }] } });
  assert.equal(malformed.hasContent, false);
  assert.match(malformed.finish()[1].delta.text, /MALFORMED_FUNCTION_CALL/);

  const acc = new AnthropicStreamAccumulator("m");
  acc.start();
  acc.ingest({ response: { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] } });
  const done = acc.finish();
  assert.equal(done[0].type, "content_block_stop");
  assert.equal(done[0].index, 0);
  assert.ok(done.some((item) => item.type === "message_stop"));
});

test("thinking requests raise maxOutputTokens above the thinking budget", () => {
  assert.equal(outputTokenFloor(16, { thinkingLevel: "low" }), 4096);
  assert.equal(outputTokenFloor(100, { thinkingBudget: 8192 }), 12288);
  assert.equal(outputTokenFloor(20000, { thinkingBudget: 8192 }), 20000);
  assert.equal(outputTokenFloor(16, null), 16);
  const payload = anthropicToUpstream(
    { model: "gemini-3.8-flash", max_tokens: 32, output_config: { effort: "low" }, messages: [{ role: "user", content: "x" }] },
    { model: "gemini-3.8-flash-low", project: "p", effort: "low" },
  );
  assert.equal(payload.request.generationConfig.maxOutputTokens, 4096);
  assert.deepEqual(payload.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: "low" });
});

test("stream accumulator emits deltas", () => {
  const acc = new StreamAccumulator("m");
  const first = acc.ingest({ response: { candidates: [{ content: { parts: [{ text: "he" }] } }] } });
  const second = acc.ingest({
    response: { candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }] },
  });
  const texts = [...first, ...second].map((event) => event.choices[0].delta.content).filter(Boolean);
  assert.ok(texts.includes("he"));
  assert.ok(texts.includes("llo"));
  assert.equal(second.at(-1).choices[0].finish_reason, "stop");
});
