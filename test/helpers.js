import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { closeAllDbs } from "../src/db.js";
import { loadSettings, ROOT } from "../src/core/config.js";
import { AntigravityClient } from "../src/providers/antigravity/client.js";
import { TokenStore, createBundle } from "../src/providers/antigravity/tokens.js";
import { createApp } from "../src/server.js";

export { closeAllDbs };

export const MODELS_PATH = path.join(ROOT, "data", "models.json");

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "allproxies-"));
}

export function writeToken(dir, extra = {}) {
  const tokenPath = path.join(dir, "tokens.db");
  const store = new TokenStore(tokenPath);
  store.save(
    createBundle({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_at: 4_000_000_000,
      email: "user@example.com",
      project_id: "proj-123",
      managed_project_id: "proj-123",
      ...extra,
    }),
  );
  return tokenPath;
}

export function testSettings(dir, extra = {}) {
  return loadSettings({
    apiKey: extra.apiKey ?? "test-key",
    tokenPath: extra.tokenPath ?? path.join(dir, "tokens.db"),
    chatgptTokenPath: extra.chatgptTokenPath ?? path.join(dir, "chatgpt-tokens.db"),
    chatgptBaseUrl: extra.chatgptBaseUrl ?? extra.settings?.chatgptBaseUrl,
    chatgptUsageUrl: extra.chatgptUsageUrl ?? extra.settings?.chatgptUsageUrl,
    vertexTokenPath: extra.vertexTokenPath ?? path.join(dir, "vertex-tokens.db"),
    vertexBaseUrl: extra.vertexBaseUrl ?? extra.settings?.vertexBaseUrl,
    modelsPath: MODELS_PATH,
    antigravityBaseUrl: extra.antigravityBaseUrl ?? "https://daily-cloudcode-pa.googleapis.com",
    antigravityHubVersion: extra.antigravityHubVersion ?? "2.9.1",
    liveModels: extra.liveModels ?? false,
    requestTimeoutMs: extra.requestTimeoutMs ?? 5_000,
    ...extra.settings,
  });
}

export function testClient(dir, extra = {}) {
  writeToken(dir, extra.token);
  return new AntigravityClient(testSettings(dir, extra));
}

export function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

export async function startApi(dir, extra = {}) {
  const client = extra.client || testClient(dir, extra);
  const settings = extra.settings || client.settings;
  const app = createApp({ settings, client, chatgpt: extra.chatgpt || null, vertex: extra.vertex || null });
  const httpServer = await listen(app);
  return { ...httpServer, client, settings };
}

export function request(baseUrl, pathname, { method = "GET", headers = {}, json } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const body = json === undefined ? null : JSON.stringify(json);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...headers,
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : undefined;
          } catch {
            parsed = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: raw, json: parsed });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export function mockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = body ? JSON.parse(body) : undefined;
        } catch {
          json = undefined;
        }
        const url = new URL(req.url || "/", "http://127.0.0.1");
        Promise.resolve(handler({ req, res, url, body, json })).catch((err) => {
          res.writeHead(500);
          res.end(String(err));
        });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}
