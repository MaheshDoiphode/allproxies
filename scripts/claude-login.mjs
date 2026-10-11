#!/usr/bin/env node
/**
 * Live Claude.ai subscription OAuth probe.
 * Opens the official Claude Code public client. Tokens stay in data/ (gitignored).
 * Never prints access/refresh tokens.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data");
const AUTH_FILE = path.join(OUT_DIR, "claude-probe-auth.json");

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const API = "https://api.anthropic.com";
const SCOPE = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
].join(" ");
const BETA = "oauth-2025-04-20";
const PORT = Number(process.env.CLAUDE_PROBE_PORT || 54545);
const REDIRECT = `http://localhost:${PORT}/callback`;

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function generatePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url) {
  if (process.platform === "win32") {
    execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true }, () => {});
    return;
  }
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
}

function redact(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 10) return `${s.slice(0, 2)}…`;
  return `${s.slice(0, 6)}…${s.slice(-4)} (len=${s.length})`;
}

function writeJson(name, value) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(value, null, 2));
}

async function readJson(res) {
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, text, parsed };
}

async function exchange(code, verifier, state) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state,
    }),
  });
  return readJson(res);
}

async function refresh(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPE,
    }),
  });
  return readJson(res);
}

function authHeaders(access) {
  return {
    Authorization: `Bearer ${access}`,
    "anthropic-beta": BETA,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
}

async function probe(access) {
  const results = {};

  const profile = await readJson(await fetch(`${API}/api/oauth/profile`, { headers: authHeaders(access) }));
  writeJson("claude-probe-profile.txt", { status: profile.status, body: profile.parsed || profile.text.slice(0, 2000) });
  const account = profile.parsed?.account || {};
  const org = profile.parsed?.organization || {};
  results.profile = {
    status: profile.status,
    email: account.email || null,
    display_name: account.display_name || null,
    account_uuid: account.uuid || null,
    org_uuid: org.uuid || null,
    billing_type: org.billing_type || null,
    extra_usage: org.has_extra_usage_enabled ?? null,
  };

  const usage = await readJson(await fetch(`${API}/api/oauth/usage?cedar_ember=1`, { headers: authHeaders(access) }));
  writeJson("claude-probe-usage.txt", { status: usage.status, body: usage.parsed || usage.text.slice(0, 4000) });
  results.usage = { status: usage.status, keys: usage.parsed && typeof usage.parsed === "object" ? Object.keys(usage.parsed) : [], snippet: usage.parsed || usage.text.slice(0, 400) };

  const usagePlain = await readJson(await fetch(`${API}/api/oauth/usage`, { headers: authHeaders(access) }));
  results.usage_plain = { status: usagePlain.status };

  const models = await readJson(await fetch(`${API}/v1/models`, { headers: authHeaders(access) }));
  writeJson("claude-probe-models.txt", { status: models.status, body: models.parsed || models.text.slice(0, 4000) });
  const modelIds = Array.isArray(models.parsed?.data) ? models.parsed.data.map((item) => item.id).slice(0, 20) : [];
  results.models = { status: models.status, count: modelIds.length, ids: modelIds };

  const ping = await readJson(
    await fetch(`${API}/v1/messages`, {
      method: "POST",
      headers: authHeaders(access),
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 32,
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
      }),
    }),
  );
  writeJson("claude-probe-messages.txt", { status: ping.status, body: ping.parsed || ping.text.slice(0, 4000) });
  const text = Array.isArray(ping.parsed?.content)
    ? ping.parsed.content.filter((part) => part.type === "text").map((part) => part.text).join("")
    : "";
  results.messages = {
    status: ping.status,
    model: ping.parsed?.model || null,
    text: text.slice(0, 80),
    stop_reason: ping.parsed?.stop_reason || null,
    usage: ping.parsed?.usage || null,
    error: ping.parsed?.error || (ping.status >= 400 ? ping.text.slice(0, 300) : null),
  };

  return results;
}

function waitForCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const incoming = new URL(req.url || "/", `http://localhost:${PORT}`);
      if (incoming.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (incoming.pathname !== "/callback") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const html = "<html><body><p>Claude login received. You can close this tab.</p><script>window.close();</script></body></html>";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(html);
      const error = incoming.searchParams.get("error");
      const gotState = incoming.searchParams.get("state");
      const code = incoming.searchParams.get("code");
      server.closeAllConnections?.();
      server.close();
      if (error) reject(new Error(error));
      else if (gotState !== expectedState) reject(new Error("state mismatch"));
      else if (!code) reject(new Error("missing code"));
      else resolve(code);
    });
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`Callback listening on ${REDIRECT}`);
    });
    setTimeout(() => {
      try {
        server.close();
      } catch {}
      reject(new Error("timed out waiting for Claude OAuth callback"));
    }, 15 * 60_000);
  });
}

async function main() {
  const { verifier, challenge } = generatePkce();
  const state = b64url(crypto.randomBytes(24));
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  console.log("Open this URL if the browser did not launch:\n");
  console.log(url.toString());
  console.log("\nSign in with the Claude.ai Pro/Max account. Waiting for callback…\n");
  openBrowser(url.toString());

  const code = await waitForCode(state);
  const exchanged = await exchange(code, verifier, state);
  if (exchanged.status >= 400 || !exchanged.parsed?.access_token) {
    console.error("token exchange failed", exchanged.status, exchanged.text.slice(0, 500));
    process.exit(1);
  }
  const tokens = exchanged.parsed;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    AUTH_FILE,
    JSON.stringify(
      {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        scope: tokens.scope,
        token_type: tokens.token_type,
        saved_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  console.log("login ok");
  console.log(JSON.stringify({
    token_status: exchanged.status,
    token_type: tokens.token_type || null,
    expires_in: tokens.expires_in || null,
    scope: tokens.scope || null,
    access: redact(tokens.access_token),
    refresh: redact(tokens.refresh_token),
    extra_keys: Object.keys(tokens).filter((key) => !["access_token", "refresh_token", "expires_in", "scope", "token_type"].includes(key)),
  }, null, 2));

  const refreshed = tokens.refresh_token ? await refresh(tokens.refresh_token) : { status: 0, parsed: null, text: "" };
  if (refreshed.parsed?.access_token) {
    tokens.access_token = refreshed.parsed.access_token;
    tokens.refresh_token = refreshed.parsed.refresh_token || tokens.refresh_token;
    tokens.scope = refreshed.parsed.scope || tokens.scope;
    fs.writeFileSync(
      AUTH_FILE,
      JSON.stringify(
        {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: refreshed.parsed.expires_in || tokens.expires_in,
          scope: tokens.scope,
          token_type: tokens.token_type,
          saved_at: new Date().toISOString(),
          refreshed: true,
        },
        null,
        2,
      ),
    );
  }
  console.log("refresh", {
    status: refreshed.status,
    has_access: Boolean(refreshed.parsed?.access_token),
    scope: refreshed.parsed?.scope || null,
    expires_in: refreshed.parsed?.expires_in || null,
  });

  const results = await probe(tokens.access_token);
  console.log("probes");
  console.log(JSON.stringify(results, null, 2));
  console.log(`\nSaved redacted probe bodies under ${OUT_DIR}/claude-probe-*.txt`);
  console.log("Auth file (gitignored): data/claude-probe-auth.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
