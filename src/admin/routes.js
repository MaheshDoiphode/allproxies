import path from "node:path";
import { ROOT } from "../core/config.js";
import { VERSION } from "../core/constants.js";
import { HttpError } from "../core/errors.js";
import { sendHtml, sendJson } from "../http/server.js";
import { safeJoin, sendFile } from "../http/static.js";
import { OAUTH_REDIRECT_URI } from "../core/constants.js";
import { CHATGPT_OAUTH_REDIRECT_URI } from "../core/chatgpt-constants.js";
import { buildAuthUrl, startCallbackServer } from "../providers/antigravity/oauth.js";
import { buildChatgptAuthUrl, startChatgptCallbackServer } from "../providers/chatgpt/oauth.js";
import { accountIdOf, projectOf } from "../providers/antigravity/tokens.js";
import { buildClientGuides } from "../core/guides.js";
import { findAccountIn, mergeAccountViews, mergeModelLists } from "../router.js";
import { AdminSessions, adminTokenFrom } from "./sessions.js";
import { PendingLogins } from "./oauth-pending.js";

const WEB_ROOT = path.join(ROOT, "web");

function cookieHeader(token) {
  return `allproxies_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 60 * 60}`;
}

export function createAdmin({ settings, client, chatgpt = null, vertex = null }) {
  const sessions = new AdminSessions();
  const pending = new PendingLogins();
  const chatgptPending = new PendingLogins();
  const password = String(settings.adminPassword || "");
  const pools = () => [
    { name: "antigravity", client },
    ...(chatgpt ? [{ name: "chatgpt", client: chatgpt }] : []),
    ...(vertex ? [{ name: "vertex", client: vertex }] : []),
  ];

  function needsAuth() {
    return Boolean(password);
  }

  function authorized(req) {
    if (!needsAuth()) return true;
    return sessions.valid(adminTokenFrom(req));
  }

  async function handle(req, res, url) {
    const pathname = url.pathname;

    if (req.method === "GET" && (pathname === "/" || pathname === "/admin" || pathname === "/admin/")) {
      const file = path.join(WEB_ROOT, "index.html");
      if (sendFile(res, file)) return true;
      sendHtml(res, 500, "<p>Dashboard files missing.</p>");
      return true;
    }

    if (req.method === "GET" && pathname.startsWith("/admin/") && !pathname.startsWith("/admin/api/")) {
      const rel = pathname === "/admin" || pathname === "/admin/" ? "index.html" : pathname.slice("/admin/".length);
      const file = safeJoin(WEB_ROOT, rel);
      if (file && sendFile(res, file)) return true;
      sendJson(res, 404, { error: { message: "Not found" } });
      return true;
    }

    if (!pathname.startsWith("/admin/api/")) return false;

    const apiPath = pathname.slice("/admin/api".length) || "/";

    if (apiPath === "/session" && req.method === "POST") {
      const body = req.body || {};
      if (needsAuth() && String(body.password || "") !== password) {
        sendJson(res, 401, { error: { message: "Invalid password", type: "auth_required" } });
        return true;
      }
      const token = sessions.create();
      res.setHeader("Set-Cookie", cookieHeader(token));
      sendJson(res, 200, { token, auth_required: needsAuth() });
      return true;
    }

    if (apiPath === "/session" && req.method === "DELETE") {
      sessions.revoke(adminTokenFrom(req));
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (apiPath === "/bootstrap" && req.method === "GET") {
      sendJson(res, 200, {
        version: VERSION,
        auth_required: needsAuth(),
        authorized: authorized(req),
      });
      return true;
    }

    if (!authorized(req)) {
      sendJson(res, 401, { error: { message: "Unauthorized", type: "auth_required" } });
      return true;
    }

    if (apiPath === "/status" && req.method === "GET") {
      const refresh = url.searchParams.get("refresh") === "1";
      const antigravity = await client.listAccountViews({ refresh });
      const gpt = chatgpt ? await chatgpt.listAccountViews({ refresh }) : [];
      const vx = vertex ? await vertex.listAccountViews({ refresh }) : [];
      const accounts = mergeAccountViews(antigravity, gpt, vx);
      const usable = accounts.filter((item) => item && !item.disabled);
      const stats = {
        requests: Number(client.stats?.requests || 0) + Number(chatgpt?.stats?.requests || 0) + Number(vertex?.stats?.requests || 0),
        success: Number(client.stats?.success || 0) + Number(chatgpt?.stats?.success || 0) + Number(vertex?.stats?.success || 0),
        failed: Number(client.stats?.failed || 0) + Number(chatgpt?.stats?.failed || 0) + Number(vertex?.stats?.failed || 0),
        prompt_tokens: Number(client.stats?.prompt_tokens || 0) + Number(chatgpt?.stats?.prompt_tokens || 0) + Number(vertex?.stats?.prompt_tokens || 0),
        completion_tokens: Number(client.stats?.completion_tokens || 0) + Number(chatgpt?.stats?.completion_tokens || 0) + Number(vertex?.stats?.completion_tokens || 0),
      };
      sendJson(res, 200, {
        version: VERSION,
        provider: "antigravity",
        endpoint: client.baseUrl,
        host: settings.host,
        port: settings.port,
        active: client.accountSummary(client.activeAccount()),
        chatgpt_active: chatgpt ? chatgpt.accountSummary(chatgpt.activeAccount()) : null,
        vertex_active: vertex ? vertex.accountSummary(vertex.activeAccount()) : null,
        vertex_catalog: vertex?.catalogStatus?.() || null,
        stats,
        accounts: {
          total: accounts.length,
          available: usable.length,
        },
        items: accounts,
      });
      return true;
    }

    if (apiPath === "/accounts" && req.method === "GET") {
      const refresh = url.searchParams.get("refresh") === "1";
      const antigravity = await client.listAccountViews({ refresh });
      const gpt = chatgpt ? await chatgpt.listAccountViews({ refresh }) : [];
      const vx = vertex ? await vertex.listAccountViews({ refresh }) : [];
      sendJson(res, 200, mergeAccountViews(antigravity, gpt, vx));
      return true;
    }

    if (apiPath === "/accounts/login" && req.method === "POST") {
      if ([...pending.items.values()].some((item) => !item.done)) {
        sendJson(res, 409, { error: { message: "A Google login is already in progress" } });
        return true;
      }
      const rec = pending.create({ redirectUri: OAUTH_REDIRECT_URI });
      try {
        const { ready, code: codePromise, close } = startCallbackServer(rec.state);
        rec.closer = close;
        await ready;
        const authorizeUrl = buildAuthUrl({
          state: rec.state,
          codeChallenge: rec.challenge,
          redirectUri: OAUTH_REDIRECT_URI,
        });
        codePromise.then(
          async (code) => {
            try {
              const bundle = await client.completeLogin({
                code,
                codeVerifier: rec.verifier,
                redirectUri: OAUTH_REDIRECT_URI,
                warm: true,
              });
              pending.finish(rec.state, { account: client.accountSummary(bundle) });
            } catch (err) {
              pending.finish(rec.state, { error: err.message || String(err) });
            }
          },
          (err) => pending.finish(rec.state, { error: err.message || String(err) }),
        );
        sendJson(res, 200, { state: rec.state, authorize_url: authorizeUrl, provider: "antigravity" });
      } catch (err) {
        pending.finish(rec.state, { error: err.message || String(err) });
        sendJson(res, 500, { error: { message: err.message || "Could not start login" } });
      }
      return true;
    }

    if (apiPath === "/accounts/login-chatgpt" && req.method === "POST") {
      if (!chatgpt) {
        sendJson(res, 400, { error: { message: "ChatGPT provider is not configured" } });
        return true;
      }
      if ([...chatgptPending.items.values()].some((item) => !item.done)) {
        sendJson(res, 409, { error: { message: "A ChatGPT login is already in progress" } });
        return true;
      }
      const rec = chatgptPending.create({ redirectUri: CHATGPT_OAUTH_REDIRECT_URI });
      try {
        const { ready, code: codePromise, close } = startChatgptCallbackServer(rec.state);
        rec.closer = close;
        await ready;
        const authorizeUrl = buildChatgptAuthUrl({
          state: rec.state,
          codeChallenge: rec.challenge,
          redirectUri: CHATGPT_OAUTH_REDIRECT_URI,
        });
        codePromise.then(
          async (code) => {
            try {
              const bundle = await chatgpt.completeLogin({
                code,
                codeVerifier: rec.verifier,
                redirectUri: CHATGPT_OAUTH_REDIRECT_URI,
                warm: true,
              });
              chatgptPending.finish(rec.state, { account: chatgpt.accountSummary(bundle) });
            } catch (err) {
              chatgptPending.finish(rec.state, { error: err.message || String(err) });
            }
          },
          (err) => chatgptPending.finish(rec.state, { error: err.message || String(err) }),
        );
        sendJson(res, 200, { state: rec.state, authorize_url: authorizeUrl, provider: "chatgpt" });
      } catch (err) {
        chatgptPending.finish(rec.state, { error: err.message || String(err) });
        sendJson(res, 500, { error: { message: err.message || "Could not start ChatGPT login" } });
      }
      return true;
    }

    if (apiPath === "/accounts/login-vertex" && req.method === "POST") {
      if (!vertex) {
        sendJson(res, 400, { error: { message: "Vertex provider is not configured" } });
        return true;
      }
      const body = req.body || {};
      try {
        const bundle = await vertex.addAccount({
          apiKey: body.api_key || body.apiKey || body.key,
          location: body.location,
          project: body.project || body.project_id || body.projectId,
          label: body.label || body.email,
        });
        sendJson(res, 200, { provider: "vertex", account: vertex.accountSummary(bundle) });
      } catch (err) {
        sendJson(res, err.status || 400, { error: { message: err.message || "Could not add Vertex key" } });
      }
      return true;
    }

    if (apiPath.startsWith("/accounts/login/") && apiPath.endsWith("/poll") && req.method === "GET") {
      const state = decodeURIComponent(apiPath.slice("/accounts/login/".length, -"/poll".length));
      const rec = pending.get(state) || chatgptPending.get(state);
      if (!rec) {
        sendJson(res, 404, { error: { message: "Unknown login" } });
        return true;
      }
      sendJson(res, 200, { done: rec.done, error: rec.error, account: rec.account });
      return true;
    }

    if (apiPath === "/accounts/batch" && req.method === "POST") {
      const body = req.body || {};
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const action = String(body.action || "");
      let count = 0;
      for (const id of ids) {
        const match = findAccountIn(id, pools());
        if (!match) continue;
        const target = accountIdOf(match.account) || id;
        if (action === "enable") {
          match.client.setEnabled(target, true);
          count += 1;
        } else if (action === "disable") {
          match.client.setEnabled(target, false);
          count += 1;
        } else if (action === "delete") {
          await match.client.removeAccount(target);
          count += 1;
        } else if (action === "refresh") {
          await match.client.refreshAccountQuotas(target);
          count += 1;
        }
      }
      sendJson(res, 200, { success: true, count });
      return true;
    }

    const accountMatch = apiPath.match(/^\/accounts\/([^/]+)(?:\/(refresh|enable|disable))?$/);
    if (accountMatch && !["login", "login-chatgpt", "login-vertex", "batch"].includes(accountMatch[1])) {
      const id = decodeURIComponent(accountMatch[1]);
      const extra = accountMatch[2];
      const match = findAccountIn(id, pools());
      if (!match) throw new HttpError(404, "Account not found");
      const target = accountIdOf(match.account) || id;
      if (req.method === "GET" && !extra) {
        sendJson(res, 200, match.client.accountSummary(match.account));
        return true;
      }
      if (req.method === "DELETE") {
        await match.client.removeAccount(target);
        sendJson(res, 200, { success: true });
        return true;
      }
      if (req.method === "PUT") {
        const enabled = req.body?.enabled;
        if (typeof enabled === "boolean") match.client.setEnabled(target, enabled);
        if (req.body?.active) await match.client.switchAccount(target);
        sendJson(res, 200, match.client.accountSummary(match.client.findAccount(target)));
        return true;
      }
      if (req.method === "POST" && extra === "refresh") {
        sendJson(res, 200, { success: true, account: await match.client.refreshAccountQuotas(target) });
        return true;
      }
      if (req.method === "POST" && extra === "enable") {
        sendJson(res, 200, match.client.accountSummary(match.client.setEnabled(target, true)));
        return true;
      }
      if (req.method === "POST" && extra === "disable") {
        sendJson(res, 200, match.client.accountSummary(match.client.setEnabled(target, false)));
        return true;
      }
    }

    if (apiPath === "/models" && req.method === "GET") {
      try {
        const refresh = url.searchParams.get("refresh") === "1";
        const [antigravityModels, chatgptModels, vertexModels] = await Promise.all([
          client.fetchModels({ refresh }).catch(() => []),
          chatgpt ? chatgpt.fetchModels({ refresh }).catch(() => []) : Promise.resolve([]),
          vertex ? vertex.fetchModels({ refresh }).catch(() => []) : Promise.resolve([]),
        ]);
        sendJson(res, 200, {
          models: mergeModelLists(
            antigravityModels.map((model) => ({ ...model, provider: model.provider || "antigravity" })),
            chatgptModels.map((model) => ({ ...model, provider: model.provider || "chatgpt" })),
            vertexModels.map((model) => ({ ...model, provider: "vertex" })),
          ),
          catalogs: {
            antigravity: { provider: "antigravity", listed: antigravityModels.length, reason: client.accounts().length ? "ready" : "none" },
            chatgpt: chatgpt?.catalogStatus?.() || { provider: "chatgpt", listed: 0, reason: "none" },
            vertex: vertex?.catalogStatus?.() || null,
          },
        });
      } catch {
        sendJson(res, 200, {
          models: [],
          catalogs: {
            antigravity: { provider: "antigravity", listed: 0, reason: "none" },
            chatgpt: chatgpt?.catalogStatus?.() || { provider: "chatgpt", listed: 0, reason: "none" },
            vertex: vertex?.catalogStatus?.() || null,
          },
        });
      }
      return true;
    }

    if (apiPath === "/guides" && req.method === "GET") {
      const prefixed = url.searchParams.get("prefixed") === "1";
      const hidden = String(url.searchParams.get("hidden") || "").split(",").map((item) => item.trim()).filter(Boolean);
      const claudePicks = {};
      const claudeMillion = {};
      for (const slot of ["model", "sonnet", "opus", "haiku", "fast", "subagent"]) {
        const value = url.searchParams.get(`claude_${slot}`);
        if (value) claudePicks[slot] = value;
        if (url.searchParams.get(`claude_${slot}_1m`) === "1") claudeMillion[slot] = true;
      }
      const codexModel = url.searchParams.get("codex") || "";
      let antigravityModels = [];
      let chatgptModels = [];
      let vertexModels = [];
      try {
        antigravityModels = Array.isArray(client.modelsCache?.models) && client.modelsCache.models.length
          ? client.modelsCache.models
          : await client.fetchModels();
      } catch {
        antigravityModels = [];
      }
      try {
        chatgptModels = chatgpt
          ? (Array.isArray(chatgpt.modelsCache?.models) && chatgpt.modelsCache.models.length
            ? chatgpt.modelsCache.models
            : await chatgpt.fetchModels())
          : [];
      } catch {
        chatgptModels = [];
      }
      try {
        vertexModels = vertex
          ? (Array.isArray(vertex.modelsCache?.models) && vertex.modelsCache.models.length
            ? vertex.modelsCache.models
            : await vertex.fetchModels())
          : [];
      } catch {
        vertexModels = [];
      }
      sendJson(res, 200, buildClientGuides({
        models: mergeModelLists(
          antigravityModels.map((model) => ({ ...model, provider: model.provider || "antigravity" })),
          chatgptModels.map((model) => ({ ...model, provider: model.provider || "chatgpt" })),
          vertexModels.map((model) => ({ ...model, provider: "vertex" })),
        ),
        settings,
        provider: "antigravity",
        prefixed,
        hidden,
        claudePicks,
        claudeMillion,
        codexModel,
      }));
      return true;
    }

    sendJson(res, 404, { error: { message: "Not found" } });
    return true;
  }

  return {
    handle,
    sessions,
    pending,
    chatgptPending,
    authorized,
    needsAuth,
    accountIdOf,
    projectOf,
  };
}
