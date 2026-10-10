import crypto from "node:crypto";

export class AdminSessions {
  constructor({ ttlMs = 12 * 60 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.byToken = new Map();
  }

  create() {
    const token = crypto.randomBytes(24).toString("base64url");
    this.byToken.set(token, Date.now() + this.ttlMs);
    return token;
  }

  valid(token) {
    if (!token) return false;
    const exp = this.byToken.get(token);
    if (!exp) return false;
    if (exp <= Date.now()) {
      this.byToken.delete(token);
      return false;
    }
    return true;
  }

  revoke(token) {
    this.byToken.delete(token);
  }
}

export function adminTokenFrom(req) {
  const header = req.headers["x-admin-token"] || req.headers.authorization || "";
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  if (typeof header === "string" && header && !header.toLowerCase().startsWith("bearer ")) {
    if (req.headers["x-admin-token"]) return String(req.headers["x-admin-token"]).trim();
  }
  const cookie = String(req.headers.cookie || "");
  const match = cookie.match(/(?:^|;\s*)allproxies_admin=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}
