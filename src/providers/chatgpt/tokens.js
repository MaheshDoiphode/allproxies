import { TokenStore, createBundle, accountIdOf, isAccountDisabled, isExpired, disableAccount, enableAccount, setAccountEnabled, touchAccountStats, isQuotaError, isRetryableUpstreamError, cooldownUntil, projectOf } from "../antigravity/tokens.js";

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

export function createChatgptBundle(raw = {}) {
  const packed = unpackScope(raw.scope);
  const accountId = raw.account_id || raw.chatgpt_account_id || packed.account_id || raw.project_id || null;
  const extras = {
    scope: packed.scope || (typeof raw.scope === "string" && !raw.scope.startsWith("{") ? raw.scope : null),
    id_token: raw.id_token || packed.id_token || "",
    plan: raw.plan || raw.chatgpt_plan_type || packed.plan || null,
    is_fedramp: Boolean(raw.is_fedramp || packed.is_fedramp),
    account_id: accountId,
  };
  return {
    ...createBundle({
      ...raw,
      project_id: accountId || raw.project_id || null,
      managed_project_id: accountId || raw.managed_project_id || raw.project_id || null,
      scope: JSON.stringify(extras),
    }),
    ...extras,
    scope: JSON.stringify(extras),
    project_id: accountId || raw.project_id || null,
    managed_project_id: accountId || raw.managed_project_id || raw.project_id || null,
  };
}

export function chatgptAccountIdOf(bundle) {
  return bundle?.account_id || bundle?.project_id || accountIdOf(bundle);
}

export function hydrateChatgptBundle(bundle, claims = {}) {
  if (!bundle) return bundle;
  const packed = unpackScope(bundle.scope);
  const accountId = bundle.account_id || packed.account_id || claims.account_id || bundle.project_id || null;
  return createChatgptBundle({
    ...bundle,
    account_id: accountId,
    plan: bundle.plan || packed.plan || claims.plan || null,
    is_fedramp: Boolean(bundle.is_fedramp || packed.is_fedramp || claims.is_fedramp),
    id_token: bundle.id_token || packed.id_token || "",
    email: bundle.email || claims.email || null,
    project_id: accountId || bundle.project_id || null,
    managed_project_id: accountId || bundle.managed_project_id || bundle.project_id || null,
  });
}
