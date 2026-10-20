import http from "node:http";
import https from "node:https";

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 });

function requestOnce(url, { method = "GET", headers = {}, body, timeoutMs = 30_000, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttp = parsed.protocol === "http:";
    const lib = isHttp ? http : https;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttp ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        agent: isHttp ? HTTP_AGENT : HTTPS_AGENT,
      },
      (res) => {
        if (stream) {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: "",
            stream: res,
          });
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: raw,
            json() {
              return raw ? JSON.parse(raw) : {};
            },
          });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    if (body) req.write(body);
    req.end();
  });
}

export async function request(url, options = {}) {
  const maxRedirects = options.maxRedirects ?? 5;
  let current = url;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const response = await requestOnce(current, options);
    const loc = response.headers.location;
    if (response.status >= 300 && response.status < 400 && loc && !options.stream) {
      current = new URL(loc, current).toString();
      continue;
    }
    return response;
  }
  throw new Error(`Too many redirects for ${url}`);
}

export async function requestJson(url, { method = "GET", headers = {}, json, form, timeoutMs } = {}) {
  const nextHeaders = { ...headers };
  let body;
  if (form) {
    body = new URLSearchParams(form).toString();
    nextHeaders["Content-Type"] = nextHeaders["Content-Type"] || "application/x-www-form-urlencoded";
  } else if (json !== undefined) {
    body = JSON.stringify(json);
    nextHeaders["Content-Type"] = nextHeaders["Content-Type"] || "application/json";
  }
  if (body) nextHeaders["Content-Length"] = Buffer.byteLength(body);
  const response = await request(url, { method, headers: nextHeaders, body, timeoutMs });
  let parsed;
  try {
    parsed = response.body ? JSON.parse(response.body) : {};
  } catch {
    parsed = undefined;
  }
  return { ...response, parsed };
}

export async function* iterateSse(readable, { onFirstBytes } = {}) {
  let buffer = "";
  let sawBytes = false;
  const flush = function* (chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (!sawBytes) {
      sawBytes = true;
      onFirstBytes?.(text);
    }
    buffer += text;
    let sep;
    while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buffer.slice(0, sep);
      const match = buffer.slice(sep).match(/^\r?\n\r?\n/);
      buffer = buffer.slice(sep + (match ? match[0].length : 2));
      let eventName = "message";
      const dataLines = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      const data = dataLines.join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === "object" && !parsed.type && eventName && eventName !== "message") {
          parsed.type = eventName;
        }
        yield parsed;
      } catch {
        // ignore malformed SSE frames
      }
    }
  };
  try {
    for await (const chunk of readable) yield* flush(chunk);
    if (buffer.trim()) yield* flush("\n\n");
  } finally {
    if (readable && !readable.complete && !readable.destroyed) {
      readable.destroy();
    }
  }
}
