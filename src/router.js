import { stripModelPrefix } from "./providers/antigravity/catalog.js";

const GPT_PREFIXES = ["gpt-", "o1", "o3", "o4", "chatgpt", "codex"];

export function isChatgptModelId(model) {
  const raw = stripModelPrefix(model).toLowerCase();
  if (!raw) return false;
  if (raw.startsWith("gpt-") || raw.startsWith("chatgpt") || raw.startsWith("codex")) return true;
  if (/^o[134]([.-]|$)/.test(raw)) return true;
  return GPT_PREFIXES.some((prefix) => raw.startsWith(prefix));
}

export function pickClient(body, { client, chatgpt } = {}) {
  if (chatgpt && isChatgptModelId(body?.model)) return chatgpt;
  return client;
}

export function mergeModelLists(antigravity = [], chatgpt = []) {
  const seen = new Set();
  const out = [];
  for (const model of [...chatgpt, ...antigravity]) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

export function mergeAccountViews(antigravity = [], chatgpt = []) {
  return [
    ...antigravity.map((item) => ({ ...item, provider: item.provider || "antigravity" })),
    ...chatgpt.map((item) => ({ ...item, provider: item.provider || "chatgpt" })),
  ];
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
