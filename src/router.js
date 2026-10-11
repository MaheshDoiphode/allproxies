import { stripModelPrefix } from "./providers/antigravity/catalog.js";

const GPT_PREFIXES = ["gpt-", "o1", "o3", "o4", "chatgpt", "codex"];

export function isChatgptModelId(model) {
  const raw = stripModelPrefix(model).toLowerCase();
  if (!raw) return false;
  if (raw.startsWith("gpt-") || raw.startsWith("chatgpt") || raw.startsWith("codex")) return true;
  if (/^o[134]([.-]|$)/.test(raw)) return true;
  return GPT_PREFIXES.some((prefix) => raw.startsWith(prefix));
}

export function isVertexModelId(model) {
  const raw = String(model || "").trim();
  if (!raw) return false;
  if (/^(vertex|google-vertex|gemini-enterprise)[:/]/i.test(raw)) return true;
  if (/^vertex-/i.test(stripModelPrefix(raw))) return true;
  return false;
}

export function pickClient(body, { client, chatgpt, vertex } = {}) {
  if (chatgpt && isChatgptModelId(body?.model)) return chatgpt;
  if (vertex && isVertexModelId(body?.model)) return vertex;
  return client;
}

export function modelProviderOf(model, fallback = "antigravity") {
  if (model?.provider) return model.provider;
  if (model?.family === "gpt") return "chatgpt";
  if (String(model?.id || "").startsWith("vertex/") || (model?.aliases || []).some((alias) => String(alias).startsWith("vertex/"))) {
    return "vertex";
  }
  return fallback;
}

export function mergeModelLists(first = [], second = [], ...rest) {
  const seen = new Set();
  const out = [];
  for (const model of [...second, ...first, ...rest.flat()]) {
    if (!model?.id) continue;
    const provider = modelProviderOf(model);
    const key = `${provider}:${model.id}`;
    if (seen.has(key)) continue;
    if (provider !== "vertex" && seen.has(`id:${model.id}`)) continue;
    seen.add(key);
    seen.add(`id:${model.id}`);
    out.push({ ...model, provider });
  }
  return out;
}

export function mergeAccountViews(...lists) {
  const names = ["antigravity", "chatgpt", "vertex"];
  return lists.flatMap((list, index) =>
    (list || []).map((item) => ({ ...item, provider: item.provider || names[index] || "antigravity" })),
  );
}

export function findAccountIn(id, clients = []) {
  const wanted = String(id || "").trim().toLowerCase();
  const explicit = wanted.includes(":") ? wanted.split(":")[0] : null;
  const email = explicit ? wanted.slice(explicit.length + 1) : wanted;
  for (const entry of clients) {
    if (explicit && entry.name !== explicit) continue;
    const found = entry.client.findAccount(email) || entry.client.findAccount(wanted);
    if (found) return { ...entry, account: found };
  }
  return null;
}
