import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicToVertex,
  mediaPartFromUrl,
  openaiContentToVertexParts,
  openaiToVertex,
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
  assert.equal(body.contents[0].parts[0].text, "whats in the image ?");
  assert.deepEqual(body.contents[0].parts[1].inlineData, { mimeType: "image/jpeg", data: "abc123" });
});

test("anthropic messages keep thinking budget when given", () => {
  const wrapped = anthropicToVertex(
    {
      model: "gemini-3.8-flash",
      max_tokens: 128,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [{ role: "user", content: "hi" }],
    },
    { model: "gemini-3.8-flash" },
  );
  assert.equal(wrapped.request.generationConfig.thinkingConfig.thinkingBudget, 2048);
  assert.equal(wrapped.request.generationConfig.maxOutputTokens, 128);
});
