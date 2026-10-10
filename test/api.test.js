import assert from "node:assert/strict";
import test from "node:test";
import { TokenStore } from "../src/providers/antigravity/tokens.js";
import { AntigravityClient } from "../src/providers/antigravity/client.js";
import { mockServer, request, sendJson, startApi, tempDir, testClient, testSettings, writeToken } from "./helpers.js";

const UPSTREAM = {
  response: {
    candidates: [{ content: { role: "model", parts: [{ text: "pong" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    responseId: "rid",
  },
};

test("health does not need api key", async () => {
  const dir = tempDir();
  const api = await startApi(dir);
  try {
    const response = await request(api.url, "/health");
    assert.equal(response.status, 200);
    assert.equal(response.json.provider, "antigravity");
    assert.equal(response.json.logged_in, true);
    assert.equal(response.json.email, "user@example.com");
    assert.equal(response.json.accounts.length, 1);
    assert.equal(response.json.accounts[0].email, "user@example.com");
    assert.equal(response.json.accounts[0].active, true);
  } finally {
    await api.close();
  }
});

test("models require api key", async () => {
  const dir = tempDir();
  const api = await startApi(dir);
  try {
    const denied = await request(api.url, "/v1/models");
    assert.equal(denied.status, 401);
    assert.ok(denied.json.error);
    const ok = await request(api.url, "/v1/models", { headers: { Authorization: "Bearer test-key" } });
    assert.equal(ok.status, 200);
    const ids = new Set(ok.json.data.map((item) => item.id));
    assert.ok(ids.has("gemini-3.8-flash-high"));
  } finally {
    await api.close();
  }
});

test("chat completions translates", async () => {
  const dir = tempDir();
  let last;
  const upstream = await mockServer(({ url, json, req, res }) => {
    if (url.pathname.endsWith(":generateContent")) {
      last = { json, headers: req.headers };
      sendJson(res, 200, UPSTREAM);
      return;
    }
    sendJson(res, 404, {});
  });
  const client = testClient(dir, { antigravityBaseUrl: upstream.url });
  const api = await startApi(dir, { client });
  try {
    const response = await request(api.url, "/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "google/antigravity-gemini-3.8-flash", messages: [{ role: "user", content: "ping" }] },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.choices[0].message.content, "pong");
    assert.equal(last.json.project, "proj-123");
    assert.equal(last.json.model, "gemini-3.8-flash-high");
    assert.equal(last.json.userAgent, "antigravity");
    assert.equal(last.json.request.contents[0].parts[0].text, "ping");
    assert.equal(last.headers.authorization, "Bearer access-token");
    assert.ok(String(last.headers["user-agent"]).startsWith("antigravity/hub/"));
    assert.equal(last.headers["x-goog-api-key"], undefined);
  } finally {
    await api.close();
    await upstream.close();
  }
});

test("chat completions maps collapsed model plus effort to the variant", async () => {
  const dir = tempDir();
  let last;
  const upstream = await mockServer(({ url, json, req, res }) => {
    if (url.pathname.endsWith(":generateContent")) {
      last = json;
      sendJson(res, 200, UPSTREAM);
      return;
    }
    sendJson(res, 404, {});
  });
  const client = testClient(dir, { antigravityBaseUrl: upstream.url });
  const api = await startApi(dir, { client });
  try {
    const response = await request(api.url, "/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "gemini-3.8-flash", reasoning_effort: "low", messages: [{ role: "user", content: "ping" }] },
    });
    assert.equal(response.status, 200, response.body);
    assert.equal(last.model, "gemini-3.8-flash-low");
    assert.deepEqual(last.request.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: "low" });
    const again = await request(api.url, "/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "gemini-3.8-flash", max_tokens: 16, output_config: { effort: "medium" }, messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(again.status, 200, again.body);
    assert.equal(last.model, "gemini-3.8-flash-medium");
    const responses = await request(api.url, "/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "gemini-3.8-flash", reasoning: { effort: "high" }, input: "ping" },
    });
    assert.equal(responses.status, 200, responses.body);
    assert.equal(last.model, "gemini-3.8-flash-high");
  } finally {
    await api.close();
    await upstream.close();
  }
});

test("chat completions stream", async () => {
  const dir = tempDir();
  const upstream = await mockServer(({ url, res }) => {
    if (url.pathname.endsWith(":streamGenerateContent")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}}\n\n');
      return;
    }
    sendJson(res, 404, {});
  });
  const client = testClient(dir, { antigravityBaseUrl: upstream.url });
  const api = await startApi(dir, { client });
  try {
    const response = await request(api.url, "/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "gemini-3.8-flash-high", stream: true, messages: [{ role: "user", content: "x" }] },
    });
    assert.match(response.body, /data: /);
    assert.match(response.body, /\[DONE\]/);
    assert.match(response.body, /hi/);
  } finally {
    await api.close();
    await upstream.close();
  }
});

test("anthropic messages", async () => {
  const dir = tempDir();
  const upstream = await mockServer(({ url, res }) => {
    if (url.pathname.endsWith(":generateContent")) {
      sendJson(res, 200, UPSTREAM);
      return;
    }
    sendJson(res, 404, {});
  });
  const client = testClient(dir, { antigravityBaseUrl: upstream.url });
  const api = await startApi(dir, { client });
  try {
    const response = await request(api.url, "/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.type, "message");
    assert.equal(response.json.content[0].text, "pong");
  } finally {
    await api.close();
    await upstream.close();
  }
});

test("openai responses translates and stores previous", async () => {
  const dir = tempDir();
  const upstream = await mockServer(({ url, res }) => {
    if (url.pathname.endsWith(":generateContent")) {
      sendJson(res, 200, UPSTREAM);
      return;
    }
    sendJson(res, 404, {});
  });
  const client = testClient(dir, { antigravityBaseUrl: upstream.url });
  const api = await startApi(dir, { client });
  try {
    const created = await request(api.url, "/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "gemini-3.8-flash-high", input: "ping" },
    });
    assert.equal(created.status, 200, created.body);
    assert.equal(created.json.object, "response");
    assert.equal(created.json.output_text, "pong");
    const fetched = await request(api.url, `/v1/responses/${created.json.id}`, {
      headers: { Authorization: "Bearer test-key" },
    });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.output_text, "pong");
    const again = await request(api.url, "/openai/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "gemini-3.8-flash-high", previous_response_id: created.json.id, input: "again" },
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.previous_response_id, created.json.id);
    const missing = await request(api.url, "/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "gemini-3.8-flash-high", previous_response_id: "resp_missing", input: "x" },
    });
    assert.equal(missing.status, 400);
  } finally {
    await api.close();
    await upstream.close();
  }
});

test("messages stream surfaces exhausted pool as HTTP error before SSE", async () => {
  const dir = tempDir();
  const upstream = await mockServer(({ url, res }) => {
    if (url.pathname.endsWith(":streamGenerateContent")) {
      sendJson(res, 429, { error: { message: "Quota exceeded. Limit resets 2026-10-11T00:00:00Z", status: "RESOURCE_EXHAUSTED" } });
      return;
    }
    sendJson(res, 404, {});
  });
  const client = testClient(dir, { antigravityBaseUrl: upstream.url });
  const api = await startApi(dir, { client });
  try {
    const response = await request(api.url, "/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "gemini-3.8-flash", stream: true, max_tokens: 16, messages: [{ role: "user", content: "x" }] },
    });
    assert.equal(response.status, 429);
    assert.match(response.json?.error?.message || "", /Quota exceeded/);
    assert.doesNotMatch(response.body, /event: message_start/);
  } finally {
    await api.close();
    await upstream.close();
  }
});

test("messages stream parses multi-line SSE and empty finish", async () => {
  const dir = tempDir();
  const upstream = await mockServer(({ url, res }) => {
    if (url.pathname.endsWith(":streamGenerateContent")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('event: message\ndata: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}}\n\n');
      return;
    }
    sendJson(res, 404, {});
  });
  const client = testClient(dir, { antigravityBaseUrl: upstream.url });
  const api = await startApi(dir, { client });
  try {
    const response = await request(api.url, "/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "gemini-3.8-flash", output_config: { effort: "none" }, stream: true, max_tokens: 16, messages: [{ role: "user", content: "x" }] },
    });
    assert.match(response.body, /event: message_start/);
    assert.match(response.body, /event: content_block_delta/);
    assert.match(response.body, /"text":"hi"/);
    assert.match(response.body, /event: message_stop/);
  } finally {
    await api.close();
    await upstream.close();
  }
});

test("anthropic messages stream", async () => {
  const dir = tempDir();
  const upstream = await mockServer(({ url, res }) => {
    if (url.pathname.endsWith(":streamGenerateContent")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}}\n\n');
      return;
    }
    sendJson(res, 404, {});
  });
  const client = testClient(dir, { antigravityBaseUrl: upstream.url });
  const api = await startApi(dir, { client });
  try {
    const response = await request(api.url, "/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "claude-sonnet-4-6", max_tokens: 16, stream: true, messages: [{ role: "user", content: "x" }] },
    });
    assert.match(response.body, /event: message_start/);
    assert.match(response.body, /event: content_block_delta/);
    assert.match(response.body, /event: message_stop/);
    assert.match(response.body, /hi/);
  } finally {
    await api.close();
    await upstream.close();
  }
});

test("native generate passthrough", async () => {
  const dir = tempDir();
  const upstream = await mockServer(({ url, res }) => {
    if (url.pathname.endsWith(":generateContent")) {
      sendJson(res, 200, UPSTREAM);
      return;
    }
    sendJson(res, 404, {});
  });
  const client = testClient(dir, { antigravityBaseUrl: upstream.url });
  const api = await startApi(dir, { client });
  try {
    const response = await request(api.url, "/v1internal:generateContent", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "gemini-3-flash", contents: [{ role: "user", parts: [{ text: "x" }] }] },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.candidates[0].content.parts[0].text, "pong");
  } finally {
    await api.close();
    await upstream.close();
  }
});

test("live models merge", async () => {
  const dir = tempDir();
  const upstream = await mockServer(({ url, res }) => {
    if (url.pathname.endsWith(":fetchAvailableModels")) {
      sendJson(res, 200, {
        models: {
          "gemini-3.8-flash": {
            displayName: "Gemini 3.8 Flash",
            model: "gemini-3.8-flash",
            quotaInfo: { remainingFraction: 0.5 },
          },
        },
      });
      return;
    }
    sendJson(res, 404, {});
  });
  const client = testClient(dir, { antigravityBaseUrl: upstream.url, liveModels: true });
  const api = await startApi(dir, { client });
  try {
    let found;
    for (let i = 0; i < 20; i += 1) {
      const response = await request(api.url, "/v1/models", { headers: { Authorization: "Bearer test-key" } });
      assert.equal(response.status, 200);
      found = response.json.data.find((item) => item.id === "gemini-3.8-flash-high");
      if (found?.source === "live") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(found.quota.remaining_fraction, 0.5);
    assert.equal(found.source, "live");
  } finally {
    await api.close();
    await upstream.close();
  }
});

test("missing login returns 401", async () => {
  const dir = tempDir();
  const tokenPath = writeToken(dir);
  new TokenStore(tokenPath).clear();
  const client = new AntigravityClient(testSettings(dir, { tokenPath, liveModels: false }));
  const api = await startApi(dir, { client });
  try {
    const response = await request(api.url, "/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "m", messages: [{ role: "user", content: "x" }] },
    });
    assert.equal(response.status, 401);
    assert.equal(response.json.error.type, "auth_required");
  } finally {
    await api.close();
  }
});
