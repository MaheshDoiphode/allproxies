#!/usr/bin/env node
/**
 * Live SuperGrok / Grok-CLI OAuth probe (RFC 8628 device code).
 * Tokens stay in data/ (gitignored). Never prints full access/refresh tokens.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data");
const AUTH_FILE = path.join(OUT_DIR, "grok-probe-auth.json");

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const API = "https://api.x.ai/v1";
const BILLING = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SETTINGS = "https://cli-chat-proxy.grok.com/v1/settings";

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

function openBrowser(url) {
  if (process.platform === "win32") {
    execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true }, () => {});
    return;
  }
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
}

function decodeJwt(token) {
  if (!token || !String(token).includes(".")) return null;
  try {
    const raw = String(token).split(".")[1] || "";
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (raw.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
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

function formHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": "allproxies-grok-probe/0.1",
  };
}

async function requestDevice() {
  const res = await fetch(DEVICE_URL, {
    method: "POST",
    headers: formHeaders(),
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
      referrer: "opencode",
    }),
  });
  return readJson(res);
}

async function pollToken(device) {
  const expiresMs = Number(device.expires_in) > 0 ? Number(device.expires_in) * 1000 : 5 * 60_000;
  const deadline = Date.now() + expiresMs;
  let intervalMs = Math.max((Number(device.interval) || 5) * 1000, 1000);
  while (Date.now() < deadline) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: formHeaders(),
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        client_id: CLIENT_ID,
        device_code: device.device_code,
      }),
    });
    const body = await readJson(res);
    if (res.ok && body.parsed?.access_token) return body;
    const err = body.parsed?.error;
    if (err === "authorization_pending") {
      await new Promise((r) => setTimeout(r, intervalMs + 300));
      continue;
    }
    if (err === "slow_down") {
      intervalMs += 5000;
      await new Promise((r) => setTimeout(r, intervalMs + 300));
      continue;
    }
    if (err === "access_denied" || err === "authorization_denied") {
      throw new Error("xAI device authorization was denied");
    }
    if (err === "expired_token") throw new Error("xAI device code expired");
    throw new Error(`token poll failed ${body.status}: ${body.text.slice(0, 400)}`);
  }
  throw new Error("timed out waiting for SuperGrok approval");
}

async function refresh(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: formHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  return readJson(res);
}

function apiHeaders(access) {
  return {
    Authorization: `Bearer ${access}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "allproxies-grok-probe/0.1",
  };
}

function proxyHeaders(access) {
  return {
    ...apiHeaders(access),
    "x-xai-token-auth": "xai-grok-cli",
  };
}

async function probe(access) {
  const results = {};

  const models = await readJson(await fetch(`${API}/models`, { headers: apiHeaders(access) }));
  writeJson("grok-probe-models.txt", { status: models.status, body: models.parsed || models.text.slice(0, 4000) });
  const ids = Array.isArray(models.parsed?.data) ? models.parsed.data.map((item) => item.id) : [];
  results.models = { status: models.status, count: ids.length, ids: ids.slice(0, 30) };

  const chat = await readJson(
    await fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: apiHeaders(access),
      body: JSON.stringify({
        model: ids.includes("grok-4.7") ? "grok-4.7" : ids[0] || "grok-4.7",
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
        max_tokens: 32,
      }),
    }),
  );
  writeJson("grok-probe-chat.txt", { status: chat.status, body: chat.parsed || chat.text.slice(0, 4000) });
  results.chat = {
    status: chat.status,
    model: chat.parsed?.model || null,
    text: chat.parsed?.choices?.[0]?.message?.content?.slice?.(0, 80) || null,
    usage: chat.parsed?.usage || null,
    error: chat.parsed?.error || (chat.status >= 400 ? chat.text.slice(0, 300) : null),
  };

  const responses = await readJson(
    await fetch(`${API}/responses`, {
      method: "POST",
      headers: apiHeaders(access),
      body: JSON.stringify({
        model: ids.includes("grok-4.7") ? "grok-4.7" : ids[0] || "grok-4.7",
        input: "Reply with exactly: pong",
      }),
    }),
  );
  writeJson("grok-probe-responses.txt", { status: responses.status, body: responses.parsed || responses.text.slice(0, 4000) });
  results.responses = {
    status: responses.status,
    text: responses.parsed?.output_text?.slice?.(0, 80) || null,
    error: responses.parsed?.error || (responses.status >= 400 ? responses.text.slice(0, 300) : null),
  };

  const billing = await readJson(await fetch(BILLING, { headers: proxyHeaders(access) }));
  writeJson("grok-probe-billing.txt", { status: billing.status, body: billing.parsed || billing.text.slice(0, 4000) });
  results.billing = {
    status: billing.status,
    creditUsagePercent: billing.parsed?.config?.creditUsagePercent ?? null,
    periodEnd: billing.parsed?.config?.currentPeriod?.end || billing.parsed?.config?.billingPeriodEnd || null,
    keys: billing.parsed && typeof billing.parsed === "object" ? Object.keys(billing.parsed) : [],
    error: billing.status >= 400 ? billing.text.slice(0, 300) : null,
  };

  const settings = await readJson(await fetch(SETTINGS, { headers: proxyHeaders(access) }));
  writeJson("grok-probe-settings.txt", { status: settings.status, body: settings.parsed || settings.text.slice(0, 2000) });
  results.settings = {
    status: settings.status,
    tier: settings.parsed?.subscription_tier_display || settings.parsed?.subscriptionTierDisplay || null,
    error: settings.status >= 400 ? settings.text.slice(0, 300) : null,
  };

  return results;
}

function saveAuth(tokens, extra = {}) {
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
        ...extra,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const device = await requestDevice();
  if (device.status >= 400 || !device.parsed?.device_code) {
    console.error("device code failed", device.status, device.text.slice(0, 500));
    process.exit(1);
  }
  const info = device.parsed;
  const url = info.verification_uri_complete || info.verification_uri;
  console.log("Approve SuperGrok in the browser.");
  console.log(`URL:  ${info.verification_uri}`);
  console.log(`CODE: ${info.user_code}`);
  if (info.verification_uri_complete) console.log(`AUTO: ${info.verification_uri_complete}`);
  console.log("");
  openBrowser(url);

  const exchanged = await pollToken(info);
  const tokens = exchanged.parsed;
  saveAuth(tokens);
  const claims = decodeJwt(tokens.access_token) || decodeJwt(tokens.id_token) || {};
  console.log("login ok");
  console.log(JSON.stringify({
    token_type: tokens.token_type || null,
    expires_in: tokens.expires_in || null,
    scope: tokens.scope || null,
    email: claims.email || claims.preferred_username || null,
    access: redact(tokens.access_token),
    refresh: redact(tokens.refresh_token),
  }, null, 2));

  let access = tokens.access_token;
  if (tokens.refresh_token) {
    const refreshed = await refresh(tokens.refresh_token);
    console.log("refresh", {
      status: refreshed.status,
      has_access: Boolean(refreshed.parsed?.access_token),
      expires_in: refreshed.parsed?.expires_in || null,
      scope: refreshed.parsed?.scope || null,
    });
    if (refreshed.parsed?.access_token) {
      access = refreshed.parsed.access_token;
      saveAuth({ ...tokens, ...refreshed.parsed }, { refreshed: true });
    }
  }

  const results = await probe(access);
  console.log("probes");
  console.log(JSON.stringify(results, null, 2));
  console.log(`\nSaved probe bodies under ${OUT_DIR}/grok-probe-*.txt`);
  console.log("Auth file (gitignored): data/grok-probe-auth.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
