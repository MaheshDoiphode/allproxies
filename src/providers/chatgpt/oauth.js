import crypto from "node:crypto";
import {
  CHATGPT_OAUTH_AUTH_URL,
  CHATGPT_OAUTH_CALLBACK_PATH,
  CHATGPT_OAUTH_CALLBACK_PORT,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
  CHATGPT_OAUTH_SCOPE,
  CHATGPT_OAUTH_TOKEN_URL,
} from "../../core/chatgpt-constants.js";
import { OAuthError } from "../../core/errors.js";
import { requestJson as defaultRequestJson } from "../../http/request.js";
import { generatePkce, openBrowser, startCallbackServer } from "../antigravity/oauth.js";
import { createChatgptBundle } from "./tokens.js";

let requestJson = defaultRequestJson;

export function setChatgptOAuthRequest(fn) {
  requestJson = fn || defaultRequestJson;
}

export function decodeJwt(token) {
  if (!token || !String(token).includes(".")) return null;
  try {
    const raw = String(token).split(".")[1] || "";
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (raw.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function chatgptAuthFromJwt(token) {
  const claims = decodeJwt(token) || {};
  const auth = claims["https://api.openai.com/auth"] && typeof claims["https://api.openai.com/auth"] === "object"
    ? claims["https://api.openai.com/auth"]
    : {};
  return {
    email: claims.email || claims.preferred_username || auth.email || null,
    account_id: auth.chatgpt_account_id || claims.chatgpt_account_id || null,
    plan: auth.chatgpt_plan_type || claims.chatgpt_plan_type || null,
    user_id: auth.chatgpt_user_id || claims.sub || null,
    exp: Number(claims.exp || 0),
    is_fedramp: Boolean(auth.chatgpt_account_is_fedramp),
  };
}

export function buildChatgptAuthUrl({
  state,
  codeChallenge,
  redirectUri = CHATGPT_OAUTH_REDIRECT_URI,
  clientId = CHATGPT_OAUTH_CLIENT_ID,
} = {}) {
  const url = new URL(CHATGPT_OAUTH_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", CHATGPT_OAUTH_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  return url.toString();
}

export function chatgptBundleFromTokens(payload, existing = {}) {
  const access = payload.access_token || existing.access_token || "";
  const refresh = payload.refresh_token || existing.refresh_token || "";
  if (!refresh) throw new OAuthError("ChatGPT token response did not include a refresh_token");
  const fromAccess = chatgptAuthFromJwt(access);
  const fromId = chatgptAuthFromJwt(payload.id_token || existing.id_token);
  const exp = fromAccess.exp
    || fromId.exp
    || (payload.expires_in ? Math.floor(Date.now() / 1000 + Number(payload.expires_in)) : 0)
    || Number(existing.expires_at || 0)
    || Math.floor(Date.now() / 1000 + 3600);
  return createChatgptBundle({
    ...existing,
    access_token: access,
    refresh_token: refresh,
    id_token: payload.id_token || existing.id_token || "",
    expires_at: exp,
    token_type: payload.token_type || existing.token_type || "Bearer",
    email: fromId.email || fromAccess.email || existing.email || null,
    account_id: fromId.account_id || fromAccess.account_id || existing.account_id || null,
    plan: fromId.plan || fromAccess.plan || existing.plan || null,
    is_fedramp: fromId.is_fedramp || fromAccess.is_fedramp || existing.is_fedramp || false,
    scope: payload.scope || existing.scope || CHATGPT_OAUTH_SCOPE,
  });
}

export async function exchangeChatgptCode({
  code,
  codeVerifier,
  redirectUri = CHATGPT_OAUTH_REDIRECT_URI,
  timeoutMs,
} = {}) {
  const response = await requestJson(CHATGPT_OAUTH_TOKEN_URL, {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
    },
    timeoutMs,
  });
  if (response.status >= 400 || !response.parsed?.access_token) {
    throw new OAuthError(`ChatGPT token exchange failed (${response.status}): ${response.body}`);
  }
  return chatgptBundleFromTokens(response.parsed);
}

export async function refreshChatgptToken(bundle, timeoutMs) {
  const response = await requestJson(CHATGPT_OAUTH_TOKEN_URL, {
    method: "POST",
    json: {
      grant_type: "refresh_token",
      refresh_token: bundle.refresh_token,
      client_id: CHATGPT_OAUTH_CLIENT_ID,
    },
    timeoutMs,
  });
  if (response.status >= 400 || !response.parsed?.access_token) {
    throw new OAuthError(`ChatGPT token refresh failed (${response.status}): ${response.body}`);
  }
  return chatgptBundleFromTokens(response.parsed, bundle);
}

export function startChatgptCallbackServer(expectedState, { port = CHATGPT_OAUTH_CALLBACK_PORT, timeoutMs = 180_000 } = {}) {
  return startCallbackServer(expectedState, { port, timeoutMs, path: CHATGPT_OAUTH_CALLBACK_PATH });
}

export async function loginChatgpt({ openUrl = true, timeoutMs } = {}) {
  const { verifier, challenge } = generatePkce();
  const state = generatePkce().verifier;
  const { ready, code: codePromise } = startChatgptCallbackServer(state, {
    timeoutMs: timeoutMs || 180_000,
  });
  await ready;
  const url = buildChatgptAuthUrl({ state, codeChallenge: challenge });
  if (openUrl) openBrowser(url);
  console.log(`Open this URL if the browser did not launch:\n${url}\n`);
  const code = await codePromise;
  return exchangeChatgptCode({
    code,
    codeVerifier: verifier,
    redirectUri: CHATGPT_OAUTH_REDIRECT_URI,
    timeoutMs,
  });
}

export { generatePkce, openBrowser, CHATGPT_OAUTH_CALLBACK_PATH, crypto };
