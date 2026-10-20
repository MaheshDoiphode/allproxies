import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicStreamAccumulator,
  anthropicToVertex,
  geminiToAnthropic,
  mediaPartFromUrl,
  openaiContentToVertexParts,
  openaiToVertex,
  recoverMalformedVertexRequest,
  vertexHttpBody,
  vertexThinkingFromRequest,
} from "../src/providers/vertex/translate.js";

test("thinking levels map to Vertex MINIMAL/LOW/MEDIUM/HIGH", () => {
  assert.deepEqual(vertexThinkingFromRequest("gemini-3.8-flash", { reasoning_effort: "low" }, "low"), {
    includeThoughts: true,
    thinkingLevel: "LOW",
  });
  assert.deepEqual(vertexThinkingFromRequest("gemini-3.8-flash", {}, "minimal"), {
    includeThoughts: false,
    thinkingLevel: "LOW",
  });
  assert.equal(vertexThinkingFromRequest("gemini-3.8-flash", { thinking: { type: "disabled" } }), null);
});

test("image input accepts data urls, https, and gs://", () => {
  const data = openaiContentToVertexParts([
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
    { type: "input_image", image_url: "gs://bucket/pic.jpg" },
    { type: "input_file", file_url: "https://example.com/doc.pdf", mime_type: "application/pdf" },
  ]);
  assert.equal(data[0].text, "look");
  assert.deepEqual(data[1].inlineData, { mimeType: "image/jpeg", data: "abc" });
  assert.deepEqual(data[2].fileData, { fileUri: "gs://bucket/pic.jpg", mimeType: "image/jpeg" });
  assert.deepEqual(data[3].fileData, { fileUri: "https://example.com/doc.pdf", mimeType: "application/pdf" });
  assert.deepEqual(mediaPartFromUrl("gs://generativeai-downloads/images/scones.jpg"), {
    fileData: { fileUri: "gs://generativeai-downloads/images/scones.jpg", mimeType: "image/jpeg" },
  });
});

test("openai chat becomes Vertex generateContent with thinking + image config", () => {
  const wrapped = openaiToVertex(
    {
      model: "gemini-3.8-flash",
      reasoning_effort: "low",
      messages: [
        { role: "user", content: [
          { type: "text", text: "Describe this picture." },
          { type: "image_url", image_url: { url: "gs://generativeai-downloads/images/scones.jpg" } },
        ] },
      ],
      extra_body: { imageConfig: { aspectRatio: "16:9", imageSize: "2K" }, response_modalities: ["TEXT", "IMAGE"] },
    },
    { model: "gemini-3.8-flash", effort: "low" },
  );
  const body = vertexHttpBody(wrapped);
  assert.equal(body.contents[0].parts[0].text, "Describe this picture.");
  assert.equal(body.contents[0].parts[1].fileData.fileUri, "gs://generativeai-downloads/images/scones.jpg");
  assert.deepEqual(body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: "LOW" });
  assert.deepEqual(body.generationConfig.imageConfig, { aspectRatio: "16:9", imageSize: "2K" });
  assert.deepEqual(body.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
});

test("interrupted openai assistant reply is followed by a continue user turn", () => {
  const wrapped = openaiToVertex(
    {
      model: "gemini-4-argon",
      messages: [
        { role: "user", content: "write a long poem" },
        { role: "assistant", content: "In the quiet dusk the" },
      ],
    },
    { model: "gemini-4-argon" },
  );
  const body = vertexHttpBody(wrapped);
  assert.deepEqual(body.contents.map((item) => item.role), ["user", "model", "user"]);
  assert.equal(body.contents[2].parts[0].text, "(continue)");
});

test("anthropic image blocks become Vertex inlineData", () => {
  const wrapped = anthropicToVertex(
    {
      model: "vertex/gemini-3.8-flash",
      max_tokens: 32,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "whats in the image ?" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "abc123" } },
        ],
      }],
    },
    { model: "gemini-3.8-flash" },
  );
  const body = vertexHttpBody(wrapped);
  const parts = body.contents[0].parts;
  assert.equal(parts.filter((p) => p.inlineData).length, 1);
  assert.equal(parts[0].text, "whats in the image ?");
  assert.deepEqual(parts[1].inlineData, { mimeType: "image/jpeg", data: "abc123" });
});

test("parallel anthropic tool calls and results are grouped into matching turns", () => {
  const wrapped = anthropicToVertex(
    {
      model: "vertex/gemini-3.8-flash",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", id: "t2", name: "ReadFile", input: { path: "a.txt" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "file1" },
            { type: "tool_result", tool_use_id: "t2", content: "file2" },
          ],
        },
      ],
    },
    { model: "gemini-3.8-flash" },
  );
  const body = vertexHttpBody(wrapped);
  // Verify model turn has 2 calls, both with thoughtSignature
  const modelTurn = body.contents.find((c) => c.role === "model");
  assert.equal(modelTurn.parts.length, 2);
  assert.equal(modelTurn.parts[0].thoughtSignature, "skip_thought_signature_validator");
  assert.equal(modelTurn.parts[1].thoughtSignature, "skip_thought_signature_validator");

  // Verify there is ONE user turn with exactly 2 function responses
  const userTurns = body.contents.filter((c) => c.role === "user" && c.parts?.some((p) => p.functionResponse));
  assert.equal(userTurns.length, 1);
  assert.equal(userTurns[0].parts.length, 2);
  assert.equal(userTurns[0].parts[0].functionResponse.name, "Bash");
  assert.equal(userTurns[0].parts[1].functionResponse.name, "ReadFile");
});

test("anthropic messages keep thinking budget on 2.5 and map budget to thinkingLevel on Gemini 3/4", () => {
  const flash25 = anthropicToVertex(
    {
      model: "gemini-2.5-flash",
      max_tokens: 128,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [{ role: "user", content: "hi" }],
    },
    { model: "gemini-2.5-flash" },
  );
  assert.equal(flash25.request.generationConfig.thinkingConfig.thinkingBudget, 2048);
  assert.ok(flash25.request.generationConfig.maxOutputTokens >= 2048 + 4096);

  const argon = anthropicToVertex(
    {
      model: "gemini-4-argon",
      max_tokens: 128,
      thinking: { type: "enabled", budget_tokens: 32000 },
      messages: [{ role: "user", content: "hi" }],
    },
    { model: "gemini-4-argon" },
  );
  assert.deepEqual(argon.request.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: "HIGH",
  });
  assert.equal(argon.request.generationConfig.maxOutputTokens, 128);
});

test("gemini-4-argon maps thinking and routing properly", () => {
  assert.deepEqual(vertexThinkingFromRequest("gemini-4-argon", { reasoning_effort: "high" }, "high"), {
    includeThoughts: true,
    thinkingLevel: "HIGH",
  });
  const wrapped = anthropicToVertex(
    {
      model: "vertex/gemini-4-argon",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    },
    { model: "gemini-4-argon", effort: "low" },
  );
  assert.equal(wrapped.model, "gemini-4-argon");
  assert.deepEqual(wrapped.request.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: "LOW",
  });
});

test("long multimodal chats preserve all inline images and produce a stable sessionKey for cache hits", () => {
  const messages = [];
  for (let i = 0; i < 10; i += 1) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: `turn ${i}` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(1000) } },
      ],
    });
    if (i < 9) {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `reply ${i}` }],
      });
    }
  }
  const wrapped = anthropicToVertex({ model: "gemini-4-argon", system: "sys", messages }, { model: "gemini-4-argon" });
  const contents = wrapped.request.contents;
  assert.equal(contents.length, 19);
  assert.ok(wrapped.sessionKey);
  // Both early and recent turns retain their inlineData so visual context is never lost
  // and the prefix never mutates (keeping Google's implicit prefix KV-cache valid)
  assert.ok(contents[0].parts.some((p) => p.inlineData));
  assert.ok(contents[contents.length - 1].parts.some((p) => p.inlineData));
});

test("vertex tool requests set VALIDATED functionCallingConfig and recover on MALFORMED_RESPONSE retry", () => {
  const wrapped = anthropicToVertex(
    {
      model: "vertex/gemini-4-argon",
      max_tokens: 1024,
      tools: [{ name: "edit_file", description: "edit", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      messages: [{ role: "user", content: "update the compare table" }],
    },
    { model: "gemini-4-argon", effort: "high" },
  );
  assert.deepEqual(wrapped.request.toolConfig, {
    functionCallingConfig: { mode: "VALIDATED" },
  });
  const retry2 = recoverMalformedVertexRequest(wrapped, { attempt: 2, lastFinish: "MALFORMED_RESPONSE" });
  assert.equal(retry2.request.generationConfig.temperature, undefined);
  assert.equal(retry2.request.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
  const retry3 = recoverMalformedVertexRequest(wrapped, { attempt: 3, lastFinish: "MALFORMED_RESPONSE" });
  assert.equal(retry3.request.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
  assert.deepEqual(retry2.request.toolConfig, {
    functionCallingConfig: { mode: "AUTO" },
  });
  const lastParts = retry2.request.contents.at(-1).parts;
  assert.ok(lastParts.some((p) => typeof p.text === "string" && p.text.includes("emit valid JSON arguments")));
});

test("anthropic web_search_20250305 uses Vertex googleSearch grounding and emits server_tool_use + web_search_tool_result", () => {
  const wrapped = anthropicToVertex(
    {
      model: "vertex/gemini-4-argon",
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: "Search the web for todoTask openTypeExtension" }],
    },
    { model: "gemini-4-argon" },
  );
  assert.deepEqual(wrapped.request.tools, [{ googleSearch: {} }]);
  // Grounding requests must not send functionCallingConfig: VALIDATED
  assert.equal(wrapped.request.toolConfig, undefined);

  const geminiPayload = {
    candidates: [
      {
        content: { role: "model", parts: [{ text: "Open extensions are supported on todoTask." }] },
        groundingMetadata: {
          webSearchQueries: ["todoTask openTypeExtension Graph API"],
          groundingChunks: [
            { web: { uri: "https://learn.microsoft.com/en-us/graph/api/resources/todotask", title: "todoTask resource type" } },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 25 },
  };

  const nonStream = geminiToAnthropic(geminiPayload, "gemini-4-argon");
  assert.equal(nonStream.content[0].type, "server_tool_use");
  assert.equal(nonStream.content[0].name, "web_search");
  assert.deepEqual(nonStream.content[0].input, { query: "todoTask openTypeExtension Graph API" });
  assert.equal(nonStream.content[1].type, "web_search_tool_result");
  assert.equal(nonStream.content[1].content[0].url, "https://learn.microsoft.com/en-us/graph/api/resources/todotask");
  assert.deepEqual(nonStream.usage.server_tool_use, { web_search_requests: 1 });

  const acc = new AnthropicStreamAccumulator("gemini-4-argon");
  const events = [...acc.ingest(geminiPayload), ...acc.finish()];
  assert.ok(events.some((e) => e.type === "content_block_start" && e.content_block?.type === "server_tool_use"));
  assert.ok(events.some((e) => e.type === "content_block_start" && e.content_block?.type === "web_search_tool_result"));
  const delta = events.find((e) => e.type === "message_delta");
  assert.deepEqual(delta.usage.server_tool_use, { web_search_requests: 1 });
});




