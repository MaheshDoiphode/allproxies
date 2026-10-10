import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ChatgptClient } from "../src/providers/chatgpt/client.js";
import { setChatgptOAuthRequest } from "../src/providers/chatgpt/oauth.js";
import { TokenStore, createChatgptBundle } from "../src/providers/chatgpt/tokens.js";
import { mockServer, sendJson, tempDir, testSettings } from "./helpers.js";

function writeChatgptToken(dir, extra = {}) {
  const tokenPath = path.join(dir, "chatgpt-tokens.db");
  const store = new TokenStore(tokenPath);
  store.save(
    createChatgptBundle({
      access_token: extra.access_token || "gpt-access",
      refresh_token: extra.refresh_token || "gpt-refresh",
      expires_at: extra.expires_at ?? 4_000_000_000,
      email: extra.email || "gpt@example.com",
      account_id: extra.account_id || "acct-1",
      project_id: extra.account_id || extra.project_id || "acct-1",
      managed_project_id: extra.account_id || extra.managed_project_id || "acct-1",
      plan: extra.plan || "free",
    }),
  );
  return tokenPath;
}

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function testChatgpt(dir, extra = {}) {
  const tokenPath = extra.tokenPath || writeChatgptToken(dir, extra.token);
  return new ChatgptClient(
    testSettings(dir, {
      chatgptTokenPath: tokenPath,
      chatgptBaseUrl: extra.chatgptBaseUrl,
      chatgptUsageUrl: extra.chatgptUsageUrl,
      liveModels: extra.liveModels ?? true,
      requestTimeoutMs: extra.requestTimeoutMs ?? 5_000,
    }),
  );
}

test("chatgpt generate uses responses-lite headers and records usage", async () => {
  const dir = tempDir();
  let last;
  const upstream = await mockServer(({ req, url, json, res }) => {
    last = { url: url.toString(), headers: req.headers, json, method: req.method };
    if (url.pathname.endsWith("/models")) {
      sendJson(res, 200, {
        models: [{ slug: "gpt-5.6-terra", visibility: "list", supported_in_api: true, use_responses_lite: true }],
      });
      return;
    }
    if (url.pathname.endsWith("/responses")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        sse([
          { type: "response.created", response: { id: "resp_1", model: "gpt-5.6-terra" } },
          { type: "response.output_text.delta", delta: "pong" },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              model: "gpt-5.6-terra",
              usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 },
              output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }],
            },
          },
        ]),
      );
      return;
    }
    sendJson(res, 404, {});
  });
  const client = testChatgpt(dir, { chatgptBaseUrl: upstream.url });
  try {
    const out = await client.chatCompletions({
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "ping" }],
    });
    assert.equal(out.choices[0].message.content, "pong");
    assert.equal(out.usage.prompt_tokens, 15);
    assert.equal(out.usage.completion_tokens, 5);
    assert.equal(last.headers.authorization, "Bearer gpt-access");
    assert.equal(last.headers["chatgpt-account-id"], "acct-1");
    assert.equal(last.headers["x-openai-internal-codex-responses-lite"], "true");
    assert.match(String(last.headers["user-agent"]), /codex_cli_rs\/0\.144\.1/);
    assert.equal(last.json.store, false);
    assert.equal(client.stats.success, 1);
  } finally {
    await upstream.close();
  }
});

test("quota on one chatgpt account fails over to the next", async () => {
  const dir = tempDir();
  const tokenPath = path.join(dir, "chatgpt-tokens.db");
  const store = new TokenStore(tokenPath);
  store.save(createChatgptBundle({
    access_token: "first",
    refresh_token: "rt-first",
    expires_at: 4_000_000_000,
    email: "one@example.com",
    account_id: "acct-1",
    project_id: "acct-1",
    managed_project_id: "acct-1",
  }));
  store.save(createChatgptBundle({
    access_token: "second",
    refresh_token: "rt-second",
    expires_at: 4_000_000_000,
    email: "two@example.com",
    account_id: "acct-2",
    project_id: "acct-2",
    managed_project_id: "acct-2",
  }));
  store.use("one@example.com");
  const tokens = [];
  const upstream = await mockServer(({ req, url, res }) => {
    if (url.pathname.endsWith("/models")) {
      sendJson(res, 200, { models: [{ slug: "gpt-5.6-terra", visibility: "list", use_responses_lite: true }] });
      return;
    }
    if (url.pathname.endsWith("/responses")) {
      const auth = req.headers.authorization || "";
      tokens.push(auth);
      if (auth.includes("first")) {
        sendJson(res, 429, { error: { message: "rate limit reached" }, rate_limit: { limit_reached: true, allowed: false } });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        sse([
          {
            type: "response.completed",
            response: {
              id: "resp_2",
              model: "gpt-5.6-terra",
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              output: [{ type: "message", content: [{ type: "output_text", text: "from-second" }] }],
            },
          },
        ]),
      );
      return;
    }
    sendJson(res, 404, {});
  });
  const client = new ChatgptClient(testSettings(dir, {
    chatgptTokenPath: tokenPath,
    chatgptBaseUrl: upstream.url,
    liveModels: true,
  }));
  try {
    const out = await client.chatCompletions({
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "ping" }],
    });
    assert.equal(out.choices[0].message.content, "from-second");
    assert.ok(tokens.some((item) => item.includes("first")));
    assert.ok(tokens.some((item) => item.includes("second")));
    assert.equal(client.findAccount("one@example.com").disabled_until > Date.now(), true);
  } finally {
    await upstream.close();
  }
});

test("refresh lock only hits the token endpoint once", async () => {
  const dir = tempDir();
  let hits = 0;
  setChatgptOAuthRequest(async () => {
    hits += 1;
    return {
      status: 200,
      body: "{}",
      parsed: {
        access_token: "fresh",
        refresh_token: "gpt-refresh",
        expires_in: 3600,
      },
    };
  });
  const client = testChatgpt(dir, { token: { expires_at: 1 } });
  try {
    await Promise.all([client.ensureToken(), client.ensureToken()]);
    assert.equal(hits, 1);
    assert.equal(client.store.load().access_token, "fresh");
  } finally {
    setChatgptOAuthRequest(null);
  }
});
