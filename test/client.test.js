import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { AntigravityClient } from "../src/providers/antigravity/client.js";
import { setOAuthRequest } from "../src/providers/antigravity/oauth.js";
import { createBundle, TokenStore } from "../src/providers/antigravity/tokens.js";
import { mockServer, sendJson, tempDir, testClient, testSettings } from "./helpers.js";

const UPSTREAM = {
  response: {
    candidates: [{ content: { role: "model", parts: [{ text: "pong" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    responseId: "rid",
  },
};

test("colon rpc paths keep the host", () => {
  const dir = tempDir();
  const client = testClient(dir);
  assert.equal(client.generateUrl(), "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
  assert.equal(client.streamUrl(), "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  assert.equal(client.modelsUrl(), "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
  assert.equal(client.loadUrl(), "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
});

test("concurrent refresh hits token endpoint once", async () => {
  const dir = tempDir();
  let hits = 0;
  setOAuthRequest(async () => {
    hits += 1;
    return { status: 200, body: "{}", parsed: { access_token: "fresh", expires_in: 3600, token_type: "Bearer" } };
  });
  const client = testClient(dir, { token: { expires_at: 1 } });
  try {
    await Promise.all([client.ensureToken(), client.ensureToken()]);
    assert.equal(hits, 1);
    assert.equal(client.store.load().access_token, "fresh");
  } finally {
    setOAuthRequest(null);
  }
});

test("generate retries once after 401", async () => {
  const dir = tempDir();
  let generateHits = 0;
  const upstream = await mockServer(({ url, res }) => {
    if (url.pathname.endsWith(":generateContent")) {
      generateHits += 1;
      if (generateHits === 1) {
        sendJson(res, 401, { error: { message: "expired", status: "UNAUTHENTICATED" } });
        return;
      }
      sendJson(res, 200, { response: { candidates: [] } });
      return;
    }
    sendJson(res, 404, {});
  });
  setOAuthRequest(async () => ({ status: 200, body: "{}", parsed: { access_token: "rotated", expires_in: 3600 } }));
  const client = testClient(dir, { antigravityBaseUrl: upstream.url });
  try {
    const payload = await client.generate({ model: "m", request: { contents: [] } });
    assert.deepEqual(payload.response.candidates, []);
    assert.equal(client.store.load().access_token, "rotated");
    assert.equal(generateHits, 2);
  } finally {
    setOAuthRequest(null);
    await upstream.close();
  }
});

test("completeLogin saves the account before project onboarding", async () => {
  const dir = tempDir();
  let tokenHits = 0;
  let userinfoHits = 0;
  setOAuthRequest(async (url) => {
    if (String(url).includes("userinfo")) {
      userinfoHits += 1;
      return { status: 200, body: "{}", parsed: { email: "new@example.com" } };
    }
    tokenHits += 1;
    return {
      status: 200,
      body: "{}",
      parsed: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, token_type: "Bearer" },
    };
  });
  const client = new AntigravityClient(testSettings(dir, { liveModels: false }));
  try {
    const started = Date.now();
    const saved = await client.completeLogin({ code: "abc", codeVerifier: "v", redirectUri: "http://localhost/cb", warm: false });
    assert.ok(Date.now() - started < 500);
    assert.equal(saved.email, "new@example.com");
    assert.equal(saved.refresh_token, "new-refresh");
    assert.equal(client.store.list().length, 1);
    assert.equal(tokenHits, 1);
    assert.equal(userinfoHits, 1);
    const views = await client.listAccountViews({ refresh: true });
    assert.equal(views.length, 1);
    assert.equal(views[0].email, "new@example.com");
  } finally {
    setOAuthRequest(null);
  }
});

test("quota on one account fails over to the next", async () => {
  const dir = tempDir();
  const tokens = [];
  const upstream = await mockServer(({ req, url, res }) => {
    if (url.pathname.endsWith(":generateContent")) {
      const auth = req.headers.authorization || "";
      tokens.push(auth);
      if (auth.includes("access-token")) {
        sendJson(res, 429, { error: { message: "Quota exceeded. Limit resets 2028-10-11T00:00:00Z", status: "RESOURCE_EXHAUSTED" } });
        return;
      }
      sendJson(res, 200, { response: { candidates: [{ content: { parts: [{ text: "from-second" }] } }] } });
      return;
    }
    sendJson(res, 404, {});
  });
  const tokenPath = path.join(dir, "tokens.json");
  const store = new TokenStore(tokenPath);
  store.save(createBundle({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: 4_000_000_000,
    email: "one@example.com",
    project_id: "p1",
    managed_project_id: "p1",
  }));
  store.save(createBundle({
    access_token: "second-token",
    refresh_token: "refresh-two",
    expires_at: 4_000_000_000,
    email: "two@example.com",
    project_id: "p2",
    managed_project_id: "p2",
  }));
  store.use("one@example.com");
  const client = new AntigravityClient(testSettings(dir, { tokenPath, antigravityBaseUrl: upstream.url, liveModels: false }));
  try {
    const payload = await client.generate({ model: "m", request: { contents: [] } });
    assert.equal(payload.response.candidates[0].content.parts[0].text, "from-second");
    assert.equal(client.store.load().email, "two@example.com");
    assert.ok(client.store.list().find((item) => item.email === "one@example.com").disabled_until > Date.now());
    assert.ok(tokens[0].includes("access-token"));
    assert.ok(tokens.some((item) => item.includes("second-token")));
  } finally {
    await upstream.close();
  }
});

test("stream quota on one account fails over before any SSE", async () => {
  const dir = tempDir();
  const tokens = [];
  const upstream = await mockServer(({ req, url, res }) => {
    if (url.pathname.endsWith(":streamGenerateContent")) {
      const auth = req.headers.authorization || "";
      tokens.push(auth);
      if (auth.includes("access-token")) {
        sendJson(res, 429, { error: { message: "Quota exceeded. Limit resets 2028-10-11T00:00:00Z", status: "RESOURCE_EXHAUSTED" } });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"from-second"}]},"finishReason":"STOP"}]}}\n\n');
      return;
    }
    sendJson(res, 404, {});
  });
  const tokenPath = path.join(dir, "tokens.json");
  const store = new TokenStore(tokenPath);
  store.save(createBundle({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: 4_000_000_000,
    email: "one@example.com",
    project_id: "p1",
    managed_project_id: "p1",
  }));
  store.save(createBundle({
    access_token: "second-token",
    refresh_token: "refresh-two",
    expires_at: 4_000_000_000,
    email: "two@example.com",
    project_id: "p2",
    managed_project_id: "p2",
  }));
  store.use("one@example.com");
  const client = new AntigravityClient(testSettings(dir, { tokenPath, antigravityBaseUrl: upstream.url, liveModels: false }));
  try {
    const chunks = [];
    for await (const chunk of client.messagesStream({
      model: "gemini-3.8-flash",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "x" }],
    })) {
      chunks.push(chunk);
    }
    const body = chunks.join("");
    assert.match(body, /from-second/);
    assert.doesNotMatch(body, /Quota exceeded/);
    assert.equal(client.store.load().email, "two@example.com");
    assert.ok(client.store.list().find((item) => item.email === "one@example.com").disabled_until > Date.now());
    assert.ok(tokens[0].includes("access-token"));
    assert.ok(tokens.some((item) => item.includes("second-token")));
  } finally {
    await upstream.close();
  }
});

test("5xx on one account fails over to the next", async () => {
  const dir = tempDir();
  const tokens = [];
  const upstream = await mockServer(({ req, url, res }) => {
    if (url.pathname.endsWith(":generateContent")) {
      const auth = req.headers.authorization || "";
      tokens.push(auth);
      if (auth.includes("access-token")) {
        sendJson(res, 503, { error: { message: "UNAVAILABLE", status: "UNAVAILABLE" } });
        return;
      }
      sendJson(res, 200, { response: { candidates: [{ content: { parts: [{ text: "from-second" }] } }] } });
      return;
    }
    sendJson(res, 404, {});
  });
  const tokenPath = path.join(dir, "tokens.json");
  const store = new TokenStore(tokenPath);
  store.save(createBundle({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: 4_000_000_000,
    email: "one@example.com",
    project_id: "p1",
    managed_project_id: "p1",
  }));
  store.save(createBundle({
    access_token: "second-token",
    refresh_token: "refresh-two",
    expires_at: 4_000_000_000,
    email: "two@example.com",
    project_id: "p2",
    managed_project_id: "p2",
  }));
  store.use("one@example.com");
  const client = new AntigravityClient(testSettings(dir, { tokenPath, antigravityBaseUrl: upstream.url, liveModels: false }));
  try {
    const payload = await client.generate({ model: "m", request: { contents: [] } });
    assert.equal(payload.response.candidates[0].content.parts[0].text, "from-second");
    assert.equal(client.store.load().email, "two@example.com");
    const limited = client.store.list().find((item) => item.email === "one@example.com");
    assert.ok(limited.disabled_until > Date.now());
    assert.match(limited.disabled_reason, /UNAVAILABLE/);
    assert.ok(tokens[0].includes("access-token"));
    assert.ok(tokens.some((item) => item.includes("second-token")));
  } finally {
    await upstream.close();
  }
});

test("readyBundle skips an active account with no project", async () => {
  const dir = tempDir();
  const tokenPath = path.join(dir, "tokens.json");
  const store = new TokenStore(tokenPath);
  store.save(createBundle({
    access_token: "no-project-token",
    refresh_token: "refresh-none",
    expires_at: 4_000_000_000,
    email: "none@example.com",
  }));
  store.save(createBundle({
    access_token: "ready-token",
    refresh_token: "refresh-ready",
    expires_at: 4_000_000_000,
    email: "ready@example.com",
    project_id: "p-ready",
    managed_project_id: "p-ready",
  }));
  store.use("none@example.com");
  const client = new AntigravityClient(testSettings(dir, { tokenPath, liveModels: false }));
  const bundle = await client.readyBundle();
  assert.equal(bundle.email, "ready@example.com");
  assert.equal(bundle.project_id, "p-ready");
  assert.equal(client.store.load().email, "ready@example.com");
});
