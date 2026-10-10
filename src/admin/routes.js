import path from "node:path";
import { ROOT } from "../core/config.js";
import { VERSION } from "../core/constants.js";
import { HttpError } from "../core/errors.js";
import { sendHtml, sendJson } from "../http/server.js";
import { safeJoin, sendFile } from "../http/static.js";
import { OAUTH_REDIRECT_URI } from "../core/constants.js";
import { buildAuthUrl, startCallbackServer } from "../providers/antigravity/oauth.js";
import { accountIdOf, projectOf } from "../providers/antigravity/tokens.js";
import { buildClientGuides } from "../core/guides.js";
import { AdminSessions, adminTokenFrom } from "./sessions.js";
import { PendingLogins } from "./oauth-pending.js";

const WEB_ROOT = path.join(ROOT, "web");

function cookieHeader(token) {
  return `allproxies_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 60 * 60}`;
}

export function createAdmin({ settings, client }) {
  const sessions = new AdminSessions();
  const pending = new PendingLogins();
  const password = String(settings.adminPassword || "");

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
      const accounts = await client.listAccountViews({ refresh: url.searchParams.get("refresh") === "1" });
      const usable = accounts.filter((item) => item && !item.disabled);
      sendJson(res, 200, {
        version: VERSION,
        provider: "antigravity",
        endpoint: client.baseUrl,
        host: settings.host,
        port: settings.port,
        active: client.accountSummary(client.activeAccount()),
        stats: client.stats,
        accounts: {
          total: accounts.length,
          available: usable.length,
        },
        items: accounts,
      });
      return true;
    }

    if (apiPath === "/accounts" && req.method === "GET") {
      sendJson(res, 200, await client.listAccountViews({ refresh: url.searchParams.get("refresh") === "1" }));
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
        sendJson(res, 200, { state: rec.state, authorize_url: authorizeUrl });
      } catch (err) {
        pending.finish(rec.state, { error: err.message || String(err) });
        sendJson(res, 500, { error: { message: err.message || "Could not start login" } });
      }
      return true;
    }

    if (apiPath.startsWith("/accounts/login/") && apiPath.endsWith("/poll") && req.method === "GET") {
      const state = decodeURIComponent(apiPath.slice("/accounts/login/".length, -"/poll".length));
      const rec = pending.get(state);
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
        if (action === "enable") {
          client.setEnabled(id, true);
          count += 1;
        } else if (action === "disable") {
          client.setEnabled(id, false);
          count += 1;
        } else if (action === "delete") {
          await client.removeAccount(id);
          count += 1;
        } else if (action === "refresh") {
          await client.refreshAccountQuotas(id);
          count += 1;
        }
      }
      sendJson(res, 200, { success: true, count });
      return true;
    }

    const accountMatch = apiPath.match(/^\/accounts\/([^/]+)(?:\/(refresh|enable|disable))?$/);
    if (accountMatch && accountMatch[1] !== "login" && accountMatch[1] !== "batch") {
      const id = decodeURIComponent(accountMatch[1]);
      const extra = accountMatch[2];
      if (req.method === "GET" && !extra) {
        const found = client.findAccount(id);
        if (!found) throw new HttpError(404, "Account not found");
        sendJson(res, 200, client.accountSummary(found));
        return true;
      }
      if (req.method === "DELETE") {
        await client.removeAccount(id);
        sendJson(res, 200, { success: true });
        return true;
      }
      if (req.method === "PUT") {
        const enabled = req.body?.enabled;
        if (typeof enabled === "boolean") client.setEnabled(id, enabled);
        if (req.body?.active) await client.switchAccount(id);
        sendJson(res, 200, client.accountSummary(client.findAccount(id)));
        return true;
      }
      if (req.method === "POST" && extra === "refresh") {
        sendJson(res, 200, { success: true, account: await client.refreshAccountQuotas(id) });
        return true;
      }
      if (req.method === "POST" && extra === "enable") {
        sendJson(res, 200, client.accountSummary(client.setEnabled(id, true)));
        return true;
      }
      if (req.method === "POST" && extra === "disable") {
        sendJson(res, 200, client.accountSummary(client.setEnabled(id, false)));
        return true;
      }
    }

    if (apiPath === "/models" && req.method === "GET") {
      try {
        sendJson(res, 200, await client.fetchModels());
      } catch (err) {
        sendJson(res, 200, []);
      }
      return true;
    }

    if (apiPath === "/guides" && req.method === "GET") {
      const prefixed = url.searchParams.get("prefixed") === "1";
      let models = [];
      try {
        models = Array.isArray(client.modelsCache?.models) && client.modelsCache.models.length
          ? client.modelsCache.models
          : await client.fetchModels();
      } catch {
        models = [];
      }
      sendJson(res, 200, buildClientGuides({ models, settings, provider: "antigravity", prefixed }));
      return true;
    }

    sendJson(res, 404, { error: { message: "Not found" } });
    return true;
  }

  return {
    handle,
    sessions,
    pending,
    authorized,
    needsAuth,
    accountIdOf,
    projectOf,
  };
}
