import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ChatgptClient } from "../src/providers/chatgpt/client.js";
import { TokenStore, createChatgptBundle } from "../src/providers/chatgpt/tokens.js";
import { isChatgptModelId, mergeModelLists, pickClient } from "../src/router.js";
import { mockServer, request, sendJson, startApi, tempDir, testSettings } from "./helpers.js";

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

test("model family routes gpt ids to chatgpt", () => {
  assert.equal(isChatgptModelId("gpt-5.6-terra"), true);
  assert.equal(isChatgptModelId("GPT:gpt-5.6-luna"), true);
  assert.equal(isChatgptModelId("openai/gpt-5.6-terra"), true);
  assert.equal(isChatgptModelId("o3-mini"), true);
  assert.equal(isChatgptModelId("gemini-3.8-flash"), false);
  assert.equal(isChatgptModelId("claude-sonnet-4-6"), false);
  const chatgpt = { name: "chatgpt" };
  const client = { name: "antigravity" };
  assert.equal(pickClient({ model: "gpt-5.6-terra" }, { client, chatgpt }), chatgpt);
  assert.equal(pickClient({ model: "gemini-3.8-flash" }, { client, chatgpt }), client);
});

test("merged catalog prefers unique chatgpt slugs first", () => {
  const merged = mergeModelLists(
    [{ id: "gemini-3.8-flash", family: "gemini" }],
    [{ id: "gpt-5.6-terra", family: "gpt" }, { id: "gemini-3.8-flash", family: "gpt" }],
  );
  assert.equal(merged[0].id, "gpt-5.6-terra");
  assert.equal(merged.filter((item) => item.id === "gemini-3.8-flash").length, 1);
});

test("/v1/messages for gpt hits Codex responses not Antigravity", async () => {
  const dir = tempDir();
  let antigravityHits = 0;
  let chatgptHits = 0;
  const antigravity = await mockServer(({ url, res }) => {
    if (url.pathname.endsWith(":generateContent") || url.pathname.endsWith(":streamGenerateContent")) {
      antigravityHits += 1;
      sendJson(res, 200, { response: { candidates: [{ content: { parts: [{ text: "gemini" }] } }] } });
      return;
    }
    sendJson(res, 404, {});
  });
  const chatgptUp = await mockServer(({ url, res }) => {
    if (url.pathname.endsWith("/models")) {
      sendJson(res, 200, { models: [{ slug: "gpt-5.6-terra", visibility: "list", use_responses_lite: true }] });
      return;
    }
    if (url.pathname.endsWith("/responses")) {
      chatgptHits += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        sse([
          {
            type: "response.completed",
            response: {
              id: "resp_r",
              model: "gpt-5.6-terra",
              usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
              output: [{ type: "message", content: [{ type: "output_text", text: "from-codex" }] }],
            },
          },
        ]),
      );
      return;
    }
    sendJson(res, 404, {});
  });
  const tokenPath = path.join(dir, "chatgpt-tokens.db");
  new TokenStore(tokenPath).save(createChatgptBundle({
    access_token: "gpt-access",
    refresh_token: "gpt-refresh",
    expires_at: 4_000_000_000,
    email: "gpt@example.com",
    account_id: "acct-1",
    project_id: "acct-1",
    managed_project_id: "acct-1",
  }));
  const chatgpt = new ChatgptClient(testSettings(dir, {
    chatgptTokenPath: tokenPath,
    chatgptBaseUrl: chatgptUp.url,
    liveModels: true,
  }));
  const api = await startApi(dir, { antigravityBaseUrl: antigravity.url, chatgpt });
  try {
    const response = await request(api.url, "/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "gpt-5.6-terra", messages: [{ role: "user", content: "ping" }], max_tokens: 16 },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.content[0].text, "from-codex");
    assert.equal(response.json.usage.input_tokens, 2);
    assert.equal(chatgptHits, 1);
    assert.equal(antigravityHits, 0);
  } finally {
    await api.close();
    await antigravity.close();
    await chatgptUp.close();
  }
});
