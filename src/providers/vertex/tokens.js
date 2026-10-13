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

function vertexProjectFrom(raw = {}, packed = {}, location = "global") {
  const candidates = [raw.project_id, packed.project_id, raw.managed_project_id, packed.managed_project_id];
  for (const value of candidates) {
    const next = String(value || "").trim();
    if (next && next !== location) return next;
  }
  return "";
}

export function createVertexBundle(raw = {}) {
  const packed = unpackScope(raw.scope);
  const apiKey = raw.api_key || raw.refresh_token || packed.api_key || "";
  const location = raw.location || packed.location || "global";
  const projectId = vertexProjectFrom(raw, packed, location);
  const extras = {
    api_key: apiKey,
    location,
    project_id: projectId || packed.project_id || "",
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
      project_id: projectId || null,
      managed_project_id: projectId || null,
      scope: JSON.stringify(extras),
    }),
    ...extras,
    access_token: apiKey,
    refresh_token: apiKey,
    email,
    scope: JSON.stringify(extras),
    project_id: projectId || null,
    managed_project_id: projectId || null,
  };
}

export function hydrateVertexBundle(bundle) {
  if (!bundle) return bundle;
  const packed = unpackScope(bundle.scope);
  return createVertexBundle({
    ...bundle,
    api_key: bundle.api_key || packed.api_key || bundle.refresh_token || bundle.access_token,
    location: bundle.location || packed.location || "global",
    project_id: bundle.project_id || packed.project_id,
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

export function vertexProjectOf(bundle) {
  const hydrated = hydrateVertexBundle(bundle);
  const project = String(hydrated?.project_id || hydrated?.managed_project_id || "").trim();
  if (!project || project === vertexLocationOf(hydrated)) return "";
  return project;
}
