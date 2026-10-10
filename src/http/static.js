import fs from "node:fs";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const cleaned = decoded.replace(/^\/+/, "").replace(/\\/g, "/");
  const resolved = path.resolve(root, cleaned);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

export function sendFile(res, filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": TYPES[ext] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": ext === ".html" || ext === ".js" || ext === ".css" ? "no-store" : "public, max-age=3600",
  });
  res.end(body);
  return true;
}
