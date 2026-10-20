export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.payload = {
      error: {
        message,
        type: extra.type || "api_error",
        ...(extra.code ? { code: extra.code } : {}),
      },
    };
  }
}

export class AuthRequiredError extends HttpError {
  constructor(message = "Google Antigravity login required. Run: node src/cli.js login") {
    super(401, message, { type: "auth_required" });
    this.name = "AuthRequiredError";
  }
}

export class UpstreamError extends HttpError {
  constructor(status, message, code, extra = {}) {
    super(status, message, { type: "upstream_error", code });
    this.name = "UpstreamError";
    this.code = code ? String(code) : undefined;
    this.retryAfterMs = Number(extra.retryAfterMs || 0) || 0;
    this.headers = extra.headers || null;
  }
}

export class OAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "OAuthError";
  }
}

export class ProjectError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectError";
  }
}
