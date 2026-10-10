import { createAdmin } from "./admin/routes.js";
import { VERSION } from "./core/constants.js";
import { HttpError } from "./core/errors.js";
import { createServer, flush, readBody, sendJson } from "./http/server.js";
import { projectOf } from "./providers/antigravity/tokens.js";

function pathnameOf(req) {
  return new URL(req.url || "/", "http://localhost").pathname;
}

function shouldReadJson(path) {
  return (
    path.startsWith("/admin/api/") ||
    path.startsWith("/v1/") ||
    path.startsWith("/openai/") ||
    path.startsWith("/anthropic/") ||
    path === "/chat/completions" ||
    path === "/messages" ||
    path === "/responses"
  );
}

function writeSseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

async function pipeSse(res, source) {
  const iter = source[Symbol.asyncIterator]();
  let first;
  try {
    first = await iter.next();
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, err.status || 502, err.payload || { error: { message: err.message, type: "api_error" } });
      return;
    }
    throw err;
  }
  writeSseHead(res);
  try {
    if (!first.done && first.value) {
      res.write(first.value);
      flush(res);
    }
    while (true) {
      const next = await iter.next();
      if (next.done) break;
      if (next.value) {
        res.write(next.value);
        flush(res);
      }
    }
    res.end();
  } catch (err) {
    if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: err?.payload?.error?.type || "api_error", message: err.message } })}\n\n`);
      flush(res);
      res.end();
    }
  }
}

function isStreaming(body) {
  return Boolean(body?.stream) || String(body?.stream).toLowerCase() === "true";
}

function bearer(req) {
  const header = req.headers.authorization || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return header.trim();
}

function requireApiKey(req, settings) {
  if (!settings.apiKey) return;
  if (bearer(req) !== settings.apiKey) {
    throw new HttpError(401, "Invalid API key", { type: "api_error" });
  }
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function createApp({ settings, client }) {
  const admin = createAdmin({ settings, client });
  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;
    if (["POST", "PUT", "PATCH"].includes(req.method) && shouldReadJson(path)) {
      req.body = await readJson(req);
    }
    if (await admin.handle(req, res, url)) return;
    if (req.method === "GET" && path === "/health") {
      const accounts = client.accounts();
      const bundle = client.activeAccount() || client.store.load();
      sendJson(res, 200, {
        status: "ok",
        version: VERSION,
        provider: "antigravity",
        logged_in: Boolean(bundle?.refresh_token || accounts.length),
        email: bundle?.email || null,
        project: projectOf(bundle),
        endpoint: client.baseUrl,
        accounts: accounts.map((item) => client.accountSummary(item)),
      });
      return;
    }

    try {
      requireApiKey(req, settings);
    } catch (err) {
      sendJson(res, err.status || 401, err.payload || { error: { message: err.message, type: "api_error" } });
      return;
    }

    if (req.method === "GET" && path === "/v1/models") {
      const models = await client.fetchModels();
      sendJson(res, 200, {
        object: "list",
        data: models.map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: "antigravity",
          name: model.name,
          family: model.family,
          context_window: model.context,
          max_output_tokens: model.output,
          supports_thinking: model.supports_thinking,
          supports_images: model.supports_images,
          supports_web_search: model.supports_web_search,
          aliases: model.aliases,
          quota: { remaining_fraction: model.remaining_fraction, reset_time: model.reset_time },
          source: model.source,
        })),
      });
      return;
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions" || path === "/openai/v1/chat/completions")) {
      const body = req.body || await readJson(req);
      if (settings.debugRequests) console.log(`[req] ${path} model=${body.model} stream=${Boolean(body.stream)} effort=${body.reasoning_effort || body.reasoning?.effort || body.output_config?.effort || ""}`);
      if (isStreaming(body)) {
        await pipeSse(res, client.chatCompletionsStream(body));
        return;
      }
      sendJson(res, 200, await client.chatCompletions(body));
      return;
    }

    if (req.method === "POST" && (path === "/v1/messages" || path === "/messages" || path === "/anthropic/v1/messages")) {
      const body = req.body || await readJson(req);
      if (settings.debugRequests) {
        const thinking = body.thinking && typeof body.thinking === "object" ? `${body.thinking.type || ""}/${body.thinking.effort || body.thinking.budget_tokens || ""}` : "";
        const tools = Array.isArray(body.tools) ? body.tools.length : 0;
        const kinds = (body.messages || []).flatMap((item) => Array.isArray(item.content) ? item.content.map((part) => part?.type) : [item.role]);
        console.log(`[req] ${path} model=${body.model} stream=${Boolean(body.stream)} effort=${body.output_config?.effort || ""} thinking=${thinking} tools=${tools} parts=${kinds.join(",")}`);
      }
      if (isStreaming(body)) {
        await pipeSse(res, client.messagesStream(body));
        return;
      }
      sendJson(res, 200, await client.messages(body));
      return;
    }

    if (req.method === "POST" && (path === "/v1/responses" || path === "/responses" || path === "/openai/v1/responses")) {
      const body = req.body || await readJson(req);
      if (isStreaming(body)) {
        await pipeSse(res, client.responsesStream(body));
        return;
      }
      sendJson(res, 200, await client.responses(body));
      return;
    }

    const responseGet = path.match(/^\/(?:openai\/)?v1\/responses\/([^/]+)$/) || path.match(/^\/responses\/([^/]+)$/);
    if (responseGet && req.method === "GET") {
      sendJson(res, 200, client.getResponse(decodeURIComponent(responseGet[1])));
      return;
    }
    if (responseGet && req.method === "DELETE") {
      sendJson(res, 200, client.deleteResponse(decodeURIComponent(responseGet[1])));
      return;
    }

    if (req.method === "POST" && path === "/v1internal:generateContent") {
      sendJson(res, 200, await client.nativeGenerate(req.body || await readJson(req), { stream: false }));
      return;
    }

    if (req.method === "POST" && path === "/v1internal:streamGenerateContent") {
      const stream = await client.nativeGenerate(req.body || await readJson(req), { stream: true });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for await (const payload of stream) res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    sendJson(res, 404, { error: { message: "Not found", type: "api_error" } });
  });
}

export function startServer({ settings, client }) {
  const server = createApp({ settings, client });
  return new Promise((resolve) => {
    server.listen(settings.port, settings.host, () => {
      console.log(`allproxies listening on http://${settings.host}:${settings.port}`);
      console.log(`dashboard: http://${settings.host}:${settings.port}/`);
      resolve(server);
    });
  });
}
