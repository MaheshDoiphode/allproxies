import { execFile } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import {
  OAUTH_AUTH_URL,
  OAUTH_CALLBACK_PORT,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPES,
  OAUTH_TOKEN_URL,
  OAUTH_USERINFO_URL,
} from "../../core/constants.js";
import { OAuthError } from "../../core/errors.js";
import { requestJson as defaultRequestJson } from "../../http/request.js";
import { createBundle } from "./tokens.js";

let requestJson = defaultRequestJson;

export function setOAuthRequest(fn) {
  requestJson = fn || defaultRequestJson;
}

export function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function generatePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthUrl({ state, codeChallenge, redirectUri = OAUTH_REDIRECT_URI, prompt = "select_account" }) {
  const query = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt,
    include_granted_scopes: "true",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${OAUTH_AUTH_URL}?${query.toString()}`;
}

export function tokenFromResponse(payload, existing) {
  const refresh = payload.refresh_token || existing?.refresh_token || "";
  if (!refresh) throw new OAuthError("Token response did not include a refresh_token");
  return createBundle({
    access_token: payload.access_token || "",
    refresh_token: refresh,
    expires_at: Date.now() / 1000 + Number(payload.expires_in || 3600),
    token_type: payload.token_type || "Bearer",
    email: existing?.email || null,
    project_id: existing?.project_id || null,
    managed_project_id: existing?.managed_project_id || null,
    scope: payload.scope || existing?.scope || null,
    enabled: existing?.enabled !== false,
    last_used: existing?.last_used || 0,
    request_count: existing?.request_count || 0,
    error_count: existing?.error_count || 0,
    success_count: existing?.success_count || 0,
    prompt_tokens: existing?.prompt_tokens || 0,
    completion_tokens: existing?.completion_tokens || 0,
    quotas: existing?.quotas || [],
    quotas_at: existing?.quotas_at || 0,
    disabled_until: existing?.disabled_until || 0,
    disabled_reason: existing?.disabled_reason || null,
  });
}

export async function exchangeCode({ code, codeVerifier, redirectUri = OAUTH_REDIRECT_URI, timeoutMs }) {
  const response = await requestJson(OAUTH_TOKEN_URL, {
    method: "POST",
    form: {
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    },
    timeoutMs,
  });
  if (response.status >= 400) {
    throw new OAuthError(`Token exchange failed (${response.status}): ${response.body}`);
  }
  return tokenFromResponse(response.parsed || {});
}

export async function refreshAccessToken(bundle, timeoutMs) {
  const response = await requestJson(OAUTH_TOKEN_URL, {
    method: "POST",
    form: {
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: bundle.refresh_token,
      grant_type: "refresh_token",
    },
    timeoutMs,
  });
  if (response.status >= 400) {
    throw new OAuthError(`Token refresh failed (${response.status}): ${response.body}`);
  }
  return tokenFromResponse(response.parsed || {}, bundle);
}

export async function fetchEmail(accessToken, timeoutMs) {
  const response = await requestJson(OAUTH_USERINFO_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    timeoutMs,
  });
  if (response.status >= 400) return null;
  return response.parsed?.email || null;
}

export function startCallbackServer(expectedState, { port = OAUTH_CALLBACK_PORT, timeoutMs = 180_000, path = "/oauth-callback" } = {}) {
  let settled = false;
  let finish;
  const code = new Promise((resolve, reject) => {
    finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Chrome keeps this keep-alive socket open until the tab is closed.
      // Stop accepting and drop sockets so login does not wait on that.
      server.closeAllConnections?.();
      try {
        server.close();
      } catch {
        // already closed
      }
      if (err) reject(err);
      else resolve(value);
    };
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.replace(/\/$/, "") !== path) {
      res.writeHead(404);
      res.end();
      return;
    }
    const html =
      "<html><body><p>Login received. You can close this tab.</p><script>window.close();</script></body></html>";
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      Connection: "close",
    });
    res.end(html);
    const state = url.searchParams.get("state") || "";
    const error = url.searchParams.get("error");
    const authCode = url.searchParams.get("code");
    if (state !== expectedState) finish(new OAuthError("OAuth state mismatch"));
    else if (error) finish(new OAuthError(error));
    else if (!authCode) finish(new OAuthError("Missing authorization code"));
    else finish(null, authCode);
  });
  const timer = setTimeout(() => finish(new OAuthError("Timed out waiting for the Google OAuth callback")), timeoutMs);
  server.on("error", (err) => finish(err));
  const ready = new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  return { ready, code, close: () => finish(new OAuthError("Callback server closed")) };
}

export async function waitForCallback(expectedState, options = {}) {
  const { ready, code } = startCallbackServer(expectedState, options);
  await ready;
  return code;
}

export function browserLaunch(url) {
  if (process.platform === "win32") {
    // rundll32 takes the URL as one argv. Do not go through `cmd start` —
    // caret-escaping `&` as `^&` is then passed into the browser and Google
    // returns 400. Quoted `start` plus `^&` has the same bug.
    return { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (process.platform === "darwin") {
    return { file: "open", args: [url] };
  }
  return { file: "xdg-open", args: [url] };
}

export function openBrowser(url) {
  const { file, args } = browserLaunch(url);
  execFile(file, args, { windowsHide: true }, () => {});
}
