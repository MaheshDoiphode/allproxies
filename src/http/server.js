import http from "node:http";

export function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(html);
}

export function flush(res) {
  if (typeof res.flush === "function") res.flush();
}

export function createServer(handler) {
  return http.createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err.status || 500;
      sendJson(res, status, err.payload || { error: { message: err.message || "internal error", type: "api_error" } });
    }
  });
}
