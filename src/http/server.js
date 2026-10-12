import http from "node:http";
import { HttpError } from "../core/errors.js";

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024 * 1024;

// Over-limit bodies are drained (not buffered) and rejected with a 413 once fully received.
// Destroying the socket instead makes clients see net::ERR_CONNECTION_RESET with no explanation.
export function readBody(req, limit = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        const mb = (n) => (n / (1024 * 1024)).toFixed(1);
        reject(new HttpError(413, `Request body too large: ${mb(size)} MB exceeds the ${mb(limit)} MB limit (ALLPROXIES_MAX_BODY_MB)`, { type: "request_too_large" }));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
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
