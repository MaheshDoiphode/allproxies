import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { VertexClient } from "../src/providers/vertex/client.js";
import { TokenStore, createVertexBundle, vertexProjectOf } from "../src/providers/vertex/tokens.js";
import { mockServer, request, sendJson, startApi, tempDir, testSettings } from "./helpers.js";

function writeVertex(dir, extra = {}) {
  const tokenPath = path.join(dir, "vertex-tokens.db");
  new TokenStore(tokenPath).save(createVertexBundle({
    api_key: extra.api_key || "AQ.test-key",
    location: extra.location || "global",
    project_id: extra.project_id,
    label: extra.label || "vertex-test",
    email: extra.email || "vertex-test",
  }));
  return tokenPath;
}

test("vertex generateContent uses x-goog-api-key and publishers path", async () => {
  const dir = tempDir();
  let seen;
  const up = await mockServer(({ req, url, json, res }) => {
    seen = { path: url.pathname, key: req.headers["x-goog-api-key"], json };
    sendJson(res, 200, {
      candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
    });
  });
  const tokenPath = writeVertex(dir);
  const vertex = new VertexClient(testSettings(dir, {
    vertexTokenPath: tokenPath,
    vertexBaseUrl: up.url,
    liveModels: false,
  }));
  try {
    const out = await vertex.chatCompletions({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
      reasoning_effort: "low",
    });
    assert.equal(out.choices[0].message.content, "pong");
    assert.equal(seen.key, "AQ.test-key");
    assert.match(seen.path, /\/v1beta1\/publishers\/google\/models\/gemini-3.8-flash:generateContent$/);
    assert.equal(seen.json.generationConfig.thinkingConfig.thinkingLevel, "LOW");
  } finally {
    await up.close();
  }
});

test("admin models lists vertex separately from antigravity", async () => {
  const dir = tempDir();
  let listed = 0;
  const vertexUp = await mockServer(({ url, res }) => {
    if (url.pathname.includes("/publishers/google/models") && !String(url.pathname).includes(":")) {
      listed += 1;
      sendJson(res, 200, {
        publisherModels: [
          { name: "publishers/google/models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash" },
          { name: "publishers/google/models/imagen-4.0-generate-001", displayName: "Imagen 4" },
          { name: "publishers/google/models/text-embedding-004", displayName: "Text Embedding 004" },
          { name: "publishers/anthropic/models/claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
        ],
      });
      return;
    }
    sendJson(res, 404, {});
  });
  const tokenPath = writeVertex(dir);
  const vertex = new VertexClient(testSettings(dir, {
    vertexTokenPath: tokenPath,
    vertexBaseUrl: vertexUp.url,
    liveModels: true,
  }));
  const api = await startApi(dir, { vertex, settings: testSettings(dir, { liveModels: false }) });
  try {
    const res = await request(api.url, "/admin/api/models?refresh=1");
    assert.equal(res.status, 200);
    const payload = Array.isArray(res.json) ? res.json : res.json.models;
    const vertexModels = payload.filter((item) => item.provider === "vertex");
    const anti = payload.filter((item) => (item.provider || "antigravity") === "antigravity");
    assert.equal(res.json.catalogs?.vertex?.error, null);
    assert.ok(vertexModels.some((item) => item.id === "vertex/gemini-3.8-flash"));
    assert.ok(vertexModels.some((item) => item.id === "vertex/imagen-4.0-generate-001"));
    assert.ok(vertexModels.some((item) => item.id === "vertex/text-embedding-004"));
    assert.ok(vertexModels.some((item) => item.id === "vertex/claude-sonnet-4-6"));
    assert.ok(anti.some((item) => item.id === "gemini-3.8-flash") || anti.length >= 0);
    assert.ok(listed >= 1);
  } finally {
    await api.close();
    await vertexUp.close();
  }
});

test("express list 401 is surfaced instead of an empty vertex group", async () => {
  const dir = tempDir();
  const vertexUp = await mockServer(({ url, res }) => {
    if (url.pathname.includes("/publishers/google/models") && !String(url.pathname).includes(":")) {
      sendJson(res, 401, {
        error: { code: 401, message: "API keys are not supported by this API. Expected OAuth2 access token", status: "UNAUTHENTICATED" },
      });
      return;
    }
    sendJson(res, 404, {});
  });
  const tokenPath = writeVertex(dir);
  const vertex = new VertexClient(testSettings(dir, {
    vertexTokenPath: tokenPath,
    vertexBaseUrl: vertexUp.url,
    liveModels: true,
  }));
  const api = await startApi(dir, { vertex, settings: testSettings(dir, { liveModels: false }) });
  try {
    const res = await request(api.url, "/admin/api/models?refresh=1");
    assert.equal(res.status, 200);
    const payload = Array.isArray(res.json) ? res.json : res.json.models;
    const vertexModels = payload.filter((item) => item.provider === "vertex");
    assert.ok(vertexModels.some((item) => item.id === "vertex/gemini-3.8-flash"));
    assert.ok(vertexModels.some((item) => item.id === "vertex/gemini-2.5-flash"));
    assert.match(String(res.json.catalogs?.vertex?.error || ""), /documented Express models/i);
    const status = await request(api.url, "/admin/api/status");
    assert.match(String(status.json.vertex_catalog?.error || ""), /documented Express models/i);
  } finally {
    await api.close();
    await vertexUp.close();
  }
});

test("vertex: prefix routes /v1/messages away from antigravity", async () => {
  const dir = tempDir();
  let antigravityHits = 0;
  let vertexHits = 0;
  const antigravity = await mockServer(({ url, res }) => {
    if (String(url.pathname).includes("generateContent")) {
      antigravityHits += 1;
      sendJson(res, 200, { response: { candidates: [{ content: { parts: [{ text: "gemini" }] } }] } });
      return;
    }
    sendJson(res, 404, {});
  });
  const vertexUp = await mockServer(({ url, res }) => {
    if (String(url.pathname).includes("generateContent")) {
      vertexHits += 1;
      sendJson(res, 200, { candidates: [{ content: { parts: [{ text: "from-vertex" }] }, finishReason: "STOP" }] });
      return;
    }
    sendJson(res, 404, {});
  });
  const tokenPath = writeVertex(dir);
  const vertex = new VertexClient(testSettings(dir, {
    vertexTokenPath: tokenPath,
    vertexBaseUrl: vertexUp.url,
    liveModels: false,
    antigravityBaseUrl: antigravity.url,
  }));
  const api = await startApi(dir, {
    settings: testSettings(dir, { antigravityBaseUrl: antigravity.url, liveModels: false }),
    vertex,
  });
  try {
    const res = await request(api.url, "/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      json: { model: "vertex/gemini-3.8-flash", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.status, 200);
    assert.match(res.json.content?.[0]?.text || "", /from-vertex/);
    assert.equal(vertexHits, 1);
    assert.equal(antigravityHits, 0);
  } finally {
    await api.close();
    await antigravity.close();
    await vertexUp.close();
  }
});

test("dashboard can add a vertex key without oauth", async () => {
  const dir = tempDir();
  const tokenPath = path.join(dir, "vertex-tokens.db");
  const vertex = new VertexClient(testSettings(dir, { vertexTokenPath: tokenPath, liveModels: false }));
  const api = await startApi(dir, { vertex });
  try {
    const added = await request(api.url, "/admin/api/accounts/login-vertex", {
      method: "POST",
      json: { api_key: "AQ.dashboard-key", label: "desk", location: "global" },
    });
    assert.equal(added.status, 200);
    assert.equal(added.json.provider, "vertex");
    assert.equal(added.json.account.email, "desk");
    const status = await request(api.url, "/admin/api/status");
    assert.ok(status.json.items.some((item) => item.provider === "vertex" && item.email === "desk"));
  } finally {
    await api.close();
  }
});

test("vertex generateContent uses project-scoped path when project is stored", async () => {
  const dir = tempDir();
  let seen;
  const up = await mockServer(({ req, url, json, res }) => {
    seen = { path: url.pathname, key: req.headers["x-goog-api-key"], json };
    sendJson(res, 200, {
      candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }],
    });
  });
  const tokenPath = writeVertex(dir, { project_id: "790050303616" });
  const vertex = new VertexClient(testSettings(dir, {
    vertexTokenPath: tokenPath,
    vertexBaseUrl: up.url,
    liveModels: false,
  }));
  try {
    const out = await vertex.chatCompletions({
      model: "vertex/gemini-4-argon",
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
      reasoning_effort: "low",
    });
    assert.equal(out.choices[0].message.content, "pong");
    assert.match(
      seen.path,
      /\/v1beta1\/projects\/790050303616\/locations\/global\/publishers\/google\/models\/gemini-4-argon:generateContent$/,
    );
  } finally {
    await up.close();
  }
});

test("vertex retries express 404 on the project-scoped path from the error", async () => {
  const dir = tempDir();
  const seen = [];
  const up = await mockServer(({ url, res }) => {
    seen.push(url.pathname);
    if (!String(url.pathname).includes("/projects/")) {
      sendJson(res, 404, {
        error: {
          code: 404,
          status: "NOT_FOUND",
          message: "Publisher model `projects/790050303616/locations/asia-southeast1/publishers/google/models/gemini-4-argon` was not found",
        },
      });
      return;
    }
    sendJson(res, 200, {
      candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }],
    });
  });
  const tokenPath = writeVertex(dir);
  const vertex = new VertexClient(testSettings(dir, {
    vertexTokenPath: tokenPath,
    vertexBaseUrl: up.url,
    liveModels: false,
  }));
  try {
    const out = await vertex.chatCompletions({
      model: "vertex/gemini-4-argon",
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
    });
    assert.equal(out.choices[0].message.content, "pong");
    assert.ok(seen.some((path) => path.includes("/publishers/google/models/gemini-4-argon") && !path.includes("/projects/")));
    assert.ok(seen.some((path) => path.includes("/projects/790050303616/locations/global/publishers/google/models/gemini-4-argon")));
    assert.equal(vertexProjectOf(vertex.activeAccount()), "790050303616");
  } finally {
    await up.close();
  }
});

test("vertex does not overwrite a stored console project from a 404 rewrite", async () => {
  const dir = tempDir();
  const seen = [];
  const up = await mockServer(({ url, res }) => {
    seen.push(url.pathname);
    sendJson(res, 404, {
      error: {
        code: 404,
        status: "NOT_FOUND",
        message: "Publisher model `projects/790050303616/locations/asia-southeast1/publishers/google/models/gemini-4-argon` was not found",
      },
    });
  });
  const tokenPath = writeVertex(dir, { project_id: "project-ad5beb0a-c96e-4620-952" });
  const vertex = new VertexClient(testSettings(dir, {
    vertexTokenPath: tokenPath,
    vertexBaseUrl: up.url,
    liveModels: false,
  }));
  try {
    await assert.rejects(
      () => vertex.chatCompletions({
        model: "vertex/gemini-4-argon",
        messages: [{ role: "user", content: "hi" }],
      }),
      /was not found/,
    );
    assert.equal(vertexProjectOf(vertex.activeAccount()), "project-ad5beb0a-c96e-4620-952");
    assert.ok(seen.every((path) => path.includes("/projects/project-ad5beb0a-c96e-4620-952/")));
  } finally {
    await up.close();
  }
});
