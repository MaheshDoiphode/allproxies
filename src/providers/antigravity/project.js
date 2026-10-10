import { DEFAULT_TIER, IDE_TYPE, PLUGIN_TYPE } from "../../core/constants.js";
import { ProjectError } from "../../core/errors.js";
import { requestJson } from "../../http/request.js";

function asProjectId(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    for (const key of ["id", "projectId", "project_id"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }
  }
  return null;
}

export function extractProjectId(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["cloudaicompanionProject", "cloudAiCompanionProject", "project", "projectId"]) {
    const found = asProjectId(payload[key]);
    if (found) return found;
  }
  if (payload.response && typeof payload.response === "object") return extractProjectId(payload.response);
  return null;
}

export function defaultTier(payload) {
  const tiers = payload?.allowedTiers || payload?.allowed_tiers || [];
  if (Array.isArray(tiers)) {
    const marked = tiers.find((tier) => tier && (tier.isDefault || tier.is_default));
    if (marked) return String(marked.id || marked.tierId || DEFAULT_TIER);
    if (tiers[0] && typeof tiers[0] === "object") return String(tiers[0].id || tiers[0].tierId || DEFAULT_TIER);
  }
  return DEFAULT_TIER;
}

export function loadCodeAssistBody() {
  return {
    metadata: {
      ideType: IDE_TYPE,
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: PLUGIN_TYPE,
    },
  };
}

export function onboardUserBody(tierId) {
  return {
    tierId,
    metadata: {
      ideType: IDE_TYPE,
      ide_type: IDE_TYPE,
      ide_name: "antigravity",
      pluginType: PLUGIN_TYPE,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveProject({ loadUrl, onboardUrl, headers, existing, polls = 8, delayMs = 500, timeoutMs }) {
  if (existing) return existing;
  const load = await requestJson(loadUrl, { method: "POST", headers, json: loadCodeAssistBody(), timeoutMs });
  if (load.status >= 400) throw new ProjectError(`loadCodeAssist failed (${load.status}): ${load.body}`);
  const loaded = load.parsed || {};
  const fromLoad = extractProjectId(loaded);
  if (fromLoad) return fromLoad;

  const onboard = await requestJson(onboardUrl, {
    method: "POST",
    headers,
    json: onboardUserBody(defaultTier(loaded)),
    timeoutMs,
  });
  if (onboard.status >= 400) throw new ProjectError(`onboardUser failed (${onboard.status}): ${onboard.body}`);
  const fromOnboard = extractProjectId(onboard.parsed || {});
  if (fromOnboard) return fromOnboard;

  for (let i = 0; i < polls; i += 1) {
    await sleep(delayMs);
    const again = await requestJson(loadUrl, { method: "POST", headers, json: loadCodeAssistBody(), timeoutMs });
    if (again.status >= 400) continue;
    const found = extractProjectId(again.parsed || {});
    if (found) return found;
  }
  throw new ProjectError(
    "Could not resolve a Cloud Code project. Re-run login after accepting the Google onboarding prompt.",
  );
}
