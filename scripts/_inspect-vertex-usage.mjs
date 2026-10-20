#!/usr/bin/env node
import { loadSettings } from "../src/core/config.js";
import { VertexClient } from "../src/providers/vertex/client.js";
import { accountIdOf, hydrateVertexBundle, vertexProjectOf } from "../src/providers/vertex/tokens.js";
import { formatIst } from "../src/core/time.js";

const settings = loadSettings();
const vertex = new VertexClient(settings);
const now = Date.now();
const accounts = vertex.accounts().map((raw) => {
  const bundle = hydrateVertexBundle(raw);
  const until = Number(bundle.disabled_until || 0);
  return {
    id: accountIdOf(bundle),
    email: bundle.email,
    enabled: bundle.enabled !== false,
    project: vertexProjectOf(bundle) || null,
    last_used: bundle.last_used ? formatIst(bundle.last_used) : null,
    last_used_ago_min: bundle.last_used ? Math.round((now - bundle.last_used) / 60000) : null,
    request_count: bundle.request_count || 0,
    success_count: bundle.success_count || 0,
    error_count: bundle.error_count || 0,
    prompt_tokens: bundle.prompt_tokens || 0,
    completion_tokens: bundle.completion_tokens || 0,
    disabled_until: until ? formatIst(until) : null,
    disabled_in_min: until > now ? Math.round((until - now) / 60000) : 0,
    disabled_reason: bundle.disabled_reason || null,
    limited_now: until > now || bundle.enabled === false,
  };
});
const active = vertex.activeAccount();
console.log(JSON.stringify({
  now: formatIst(now),
  db: vertex.store.path,
  lifetime: vertex.store.lifetimeStats(),
  usage: vertex.usageStats(),
  active: active ? { id: accountIdOf(active), email: active.email, project: vertexProjectOf(active) || null } : null,
  accounts,
}, null, 2));
