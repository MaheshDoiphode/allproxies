import {
  TokenStore,
  createBundle,
  accountIdOf,
  isAccountDisabled,
  isExpired,
  disableAccount,
  enableAccount,
  setAccountEnabled,
  touchAccountStats,
  isQuotaError,
  isRetryableUpstreamError,
  cooldownUntil,
  projectOf,
} from "../antigravity/tokens.js";

export {
  TokenStore,
  accountIdOf,
  isAccountDisabled,
  isExpired,
  disableAccount,
  enableAccount,
  setAccountEnabled,
  touchAccountStats,
  isQuotaError,
  isRetryableUpstreamError,
  cooldownUntil,
  projectOf,
};

function unpackScope(scope) {
  if (!scope || !String(scope).startsWith("{")) return { scope: scope || null };
  try {
    const parsed = JSON.parse(scope);
    return parsed && typeof parsed === "object" ? parsed : { scope };
  } catch {
    return { scope };
  }
}

function keyTail(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.slice(-8);
}

export function vertexAccountLabel(raw = {}) {
  if (raw.email) return String(raw.email);
  const tail = keyTail(raw.api_key || raw.refresh_token);
  return tail ? `vertex-…${tail}` : "vertex-key";
}

export function createVertexBundle(raw = {}) {
  const packed = unpackScope(raw.scope);
  const apiKey = raw.api_key || raw.refresh_token || packed.api_key || "";
  const location = raw.location || packed.location || "global";
  const extras = {
    api_key: apiKey,
    location,
    label: raw.label || packed.label || vertexAccountLabel({ ...raw, api_key: apiKey }),
  };
  const email = extras.label;
  return {
    ...createBundle({
      ...raw,
      access_token: apiKey,
      refresh_token: apiKey,
      expires_at: Number(raw.expires_at || 4_000_000_000),
      email,
      project_id: raw.project_id || packed.project_id || location,
      managed_project_id: raw.managed_project_id || packed.managed_project_id || raw.project_id || location,
      scope: JSON.stringify(extras),
    }),
    ...extras,
    access_token: apiKey,
    refresh_token: apiKey,
    email,
    scope: JSON.stringify(extras),
    project_id: raw.project_id || packed.project_id || location,
    managed_project_id: raw.managed_project_id || packed.managed_project_id || raw.project_id || location,
  };
}

export function hydrateVertexBundle(bundle) {
  if (!bundle) return bundle;
  const packed = unpackScope(bundle.scope);
  return createVertexBundle({
    ...bundle,
    api_key: bundle.api_key || packed.api_key || bundle.refresh_token || bundle.access_token,
    location: bundle.location || packed.location || "global",
    label: bundle.label || packed.label || bundle.email,
  });
}

export function vertexApiKeyOf(bundle) {
  const hydrated = hydrateVertexBundle(bundle);
  return hydrated?.api_key || hydrated?.refresh_token || hydrated?.access_token || "";
}

export function vertexLocationOf(bundle) {
  return hydrateVertexBundle(bundle)?.location || "global";
}
