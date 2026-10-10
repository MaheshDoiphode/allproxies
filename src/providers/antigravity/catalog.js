import fs from "node:fs";

const EFFORT_ALIASES = {
  none: "none",
  disabled: "none",
  off: "none",
  minimal: "low",
  extra: "low",
  "extra-low": "low",
  low: "low",
  medium: "medium",
  high: "high",
  max: "high",
  xhigh: "high",
};

export function normalizeEffort(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim().toLowerCase();
  return Object.hasOwn(EFFORT_ALIASES, raw) ? EFFORT_ALIASES[raw] : null;
}

export function splitEffortSuffix(modelId) {
  const raw = String(modelId || "").trim();
  const match = raw.match(/[-_/]((?:extra-)?(?:minimal|low|medium|high|max|none))$/i);
  if (!match) return { baseId: raw, effort: null };
  return { baseId: raw.slice(0, match.index), effort: normalizeEffort(match[1]) };
}

export function prettyModelName(name, id) {
  return String(name || id || "")
    .replace(/\s*\((extra[- ]?low|minimal|low|medium|high|max)\)\s*$/i, "")
    .replace(/\s+(extra[- ]?low|minimal|low|medium|high|max)$/i, "")
    .replace(/\s*\(thinking\)\s*$/i, "")
    .trim();
}

export function createModel(raw) {
  const id = String(raw.id || "");
  const { baseId, effort } = splitEffortSuffix(id);
  return {
    id,
    name: raw.name || id,
    family: raw.family || "gemini",
    context: raw.context ?? 1_048_576,
    output: raw.output ?? 65_536,
    supports_thinking: Boolean(raw.supports_thinking),
    supports_images: raw.supports_images !== false,
    supports_web_search: Boolean(raw.supports_web_search),
    aliases: [...(raw.aliases || [])],
    remaining_fraction: raw.remaining_fraction ?? null,
    reset_time: raw.reset_time ?? null,
    recommended: Boolean(raw.recommended),
    tag_title: raw.tag_title ?? null,
    source: raw.source || "static",
    base_id: raw.base_id || (effort ? baseId : id),
    effort: raw.effort || effort,
    efforts: Array.isArray(raw.efforts) ? raw.efforts : [],
    variants: raw.variants && typeof raw.variants === "object" ? raw.variants : {},
    preferred: raw.preferred || id,
  };
}

export function loadStaticCatalog(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const items = raw?.antigravity ?? raw;
  return (items || [])
    .filter((item) => item && item.id)
    .map((item) =>
      createModel({
        id: String(item.id),
        name: String(item.name || item.id),
        family: String(item.family || "gemini"),
        context: Number(item.context || 1_048_576),
        output: Number(item.output || 65_536),
        supports_thinking: Boolean(item.supports_thinking),
        supports_images: item.supports_images !== false,
        supports_web_search: Boolean(item.supports_web_search),
        aliases: (item.aliases || []).map(String),
        source: "static",
      }),
    );
}

function guessFamily(modelId, display) {
  const blob = `${modelId} ${display}`.toLowerCase();
  if (blob.includes("claude") || blob.includes("opus") || blob.includes("sonnet")) return "claude";
  if (blob.includes("gpt")) return "gpt";
  return "gemini";
}

function liveModelId(key, entry) {
  const fromEntry = String(entry.model || entry.modelName || "");
  if (fromEntry && !/^MODEL_/i.test(fromEntry)) return fromEntry;
  return String(key || fromEntry);
}

function isListedLiveModel(key, entry) {
  if (!key) return false;
  if (/^(tab_|chat_)/i.test(key)) return false;
  if (/-tiered$/i.test(key)) return false;
  return Boolean(entry.displayName || entry.modelName || (entry.model && !/^MODEL_/i.test(String(entry.model))));
}

function liveEntryToModel(key, entry) {
  const modelId = liveModelId(key, entry);
  const quota = entry.quotaInfo && typeof entry.quotaInfo === "object" ? entry.quotaInfo : {};
  const remaining = quota.remainingFraction;
  return createModel({
    id: modelId,
    name: String(entry.displayName || entry.modelName || modelId),
    family: guessFamily(modelId, String(entry.displayName || "")),
    supports_thinking: Boolean(entry.supportsThinking),
    supports_images: entry.supportsImages !== false,
    supports_web_search: modelId.toLowerCase().includes("gemini"),
    remaining_fraction: typeof remaining === "number" ? remaining : null,
    reset_time: quota.resetTime ? String(quota.resetTime) : null,
    recommended: Boolean(entry.recommended),
    tag_title: entry.tagTitle ? String(entry.tagTitle) : null,
    source: "live",
  });
}

export function parseLiveModels(payload) {
  const modelsObj = payload?.models;
  if (modelsObj && typeof modelsObj === "object" && !Array.isArray(modelsObj)) {
    return Object.entries(modelsObj)
      .filter(([key, value]) => value && typeof value === "object" && isListedLiveModel(key, value))
      .map(([key, value]) => liveEntryToModel(key, value));
  }
  if (Array.isArray(modelsObj)) {
    return modelsObj
      .filter((item) => item && typeof item === "object")
      .map((item) => liveEntryToModel(String(item.id || item.modelName || item.model || ""), item))
      .filter((model) => model.id && !/^MODEL_/i.test(model.id));
  }
  return [];
}

export function mergeCatalog(staticModels, liveModels) {
  const byId = new Map(staticModels.map((model) => [model.id, { ...model, aliases: [...model.aliases] }]));
  const aliasToId = new Map();
  for (const model of staticModels) {
    for (const alias of model.aliases) aliasToId.set(alias, model.id);
  }
  for (const live of liveModels) {
    const targetId = aliasToId.get(live.id) || live.id;
    const existing = byId.get(targetId);
    if (!existing) {
      byId.set(targetId, live);
      continue;
    }
    existing.name = live.name || existing.name;
    existing.supports_thinking = existing.supports_thinking || live.supports_thinking;
    existing.supports_images = existing.supports_images || live.supports_images;
    existing.remaining_fraction = live.remaining_fraction;
    existing.reset_time = live.reset_time;
    existing.recommended = live.recommended;
    existing.tag_title = live.tag_title || existing.tag_title;
    existing.source = "live";
    if (live.id !== existing.id && !existing.aliases.includes(live.id)) existing.aliases.push(live.id);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const KNOWN_PREFIXES = ["google", "antigravity", "gemini", "claude", "gpt", "openai", "kiro", "bedrock"];

export function stripModelPrefix(requested) {
  let raw = String(requested || "").trim();
  raw = raw.replace(/\[1m\]$/i, "");
  for (let i = 0; i < 3; i += 1) {
    const slash = raw.match(/^([A-Za-z][A-Za-z0-9_-]*)\/(.+)$/);
    if (slash && KNOWN_PREFIXES.includes(slash[1].toLowerCase())) {
      raw = slash[2];
      continue;
    }
    const colon = raw.match(/^([A-Za-z][A-Za-z0-9_-]*):(.+)$/);
    if (colon && KNOWN_PREFIXES.includes(colon[1].toLowerCase())) {
      raw = colon[2];
      continue;
    }
    break;
  }
  if (raw.startsWith("antigravity-")) raw = raw.slice("antigravity-".length);
  return raw;
}

export function resolveModelId(requested, catalog) {
  const raw = stripModelPrefix(requested);
  const { baseId, effort } = splitEffortSuffix(raw);
  for (const model of catalog) {
    if (model.id === raw || model.aliases.includes(raw)) return { id: model.id, model, effort: model.effort || effort };
  }
  if (effort) {
    for (const model of catalog) {
      if (model.id === baseId || model.base_id === baseId || model.aliases.includes(baseId)) {
        return { id: model.base_id || baseId, model, effort };
      }
    }
    return { id: baseId, model: null, effort };
  }
  return { id: raw, model: null, effort: null };
}

function groupKeyFor(model) {
  const fromId = splitEffortSuffix(model.id);
  if (fromId.effort) return fromId.baseId;
  if (model.base_id && model.variants && Object.keys(model.variants).length) return model.base_id;
  for (const alias of model.aliases || []) {
    const fromAlias = splitEffortSuffix(alias);
    if (fromAlias.effort) return fromAlias.baseId;
  }
  return model.id;
}

export function collapseEffortVariants(models) {
  const groups = new Map();
  const order = [];
  for (const model of models || []) {
    const { effort } = splitEffortSuffix(model.id);
    const groupKey = groupKeyFor(model);
    const existing = groups.get(groupKey);
    if (!existing) order.push(groupKey);
    const group = existing || {
      id: groupKey,
      name: prettyModelName(model.name, groupKey),
      family: model.family,
      context: model.context,
      output: model.output,
      supports_thinking: Boolean(model.supports_thinking),
      supports_images: model.supports_images !== false,
      supports_web_search: Boolean(model.supports_web_search),
      aliases: [],
      remaining_fraction: model.remaining_fraction,
      reset_time: model.reset_time,
      recommended: Boolean(model.recommended),
      source: model.source,
      efforts: new Set(),
      variants: {},
    };
    if (model.variants && Object.keys(model.variants).length) {
      Object.assign(group.variants, model.variants);
      for (const key of Object.keys(model.variants)) group.efforts.add(key);
    } else {
      const aliasEffort = !effort
        ? (model.aliases || []).map((alias) => splitEffortSuffix(alias)).find((item) => item.effort)?.effort
        : null;
      const variantEffort = effort || aliasEffort;
      if (variantEffort) {
        group.efforts.add(variantEffort);
        group.variants[variantEffort] = model.id;
      }
    }
    if (model.supports_thinking) group.supports_thinking = true;
    if (model.id !== groupKey && !group.aliases.includes(model.id)) group.aliases.push(model.id);
    for (const alias of model.aliases || []) {
      if (alias !== groupKey && !group.aliases.includes(alias)) group.aliases.push(alias);
    }
    if (model.recommended) group.recommended = true;
    if (model.remaining_fraction != null) group.remaining_fraction = model.remaining_fraction;
    if (model.reset_time) group.reset_time = model.reset_time;
    if (model.context) group.context = Math.max(group.context || 0, Number(model.context) || 0);
    if (model.output) group.output = Math.max(group.output || 0, Number(model.output) || 0);
    groups.set(groupKey, group);
  }
  return order.map((groupKey) => {
    const group = groups.get(groupKey);
    const preferred = group.variants.high || group.variants.medium || group.variants.low || group.id;
    const efforts = group.supports_thinking || group.efforts.size ? ["none", "low", "medium", "high"] : [];
    return createModel({
      id: group.id,
      name: prettyModelName(group.name, group.id),
      family: group.family,
      context: group.context,
      output: group.output,
      supports_thinking: group.supports_thinking,
      supports_images: group.supports_images,
      supports_web_search: group.supports_web_search,
      aliases: group.aliases,
      remaining_fraction: group.remaining_fraction,
      reset_time: group.reset_time,
      recommended: group.recommended,
      source: group.source,
      base_id: group.id,
      efforts,
      variants: group.variants,
      preferred,
    });
  });
}

export function pickVariantId(model, effort) {
  const wanted = normalizeEffort(effort);
  const variants = model?.variants || {};
  if (wanted === "none") return variants.low || variants.medium || model?.preferred || model?.id;
  if (wanted && variants[wanted]) return variants[wanted];
  if (wanted === "high") return variants.high || variants.medium || variants.low || model?.preferred || model?.id;
  if (wanted === "medium") return variants.medium || variants.high || variants.low || model?.preferred || model?.id;
  if (wanted === "low") return variants.low || variants.medium || model?.preferred || model?.id;
  return model?.preferred || variants.high || variants.medium || variants.low || model?.id;
}

export function extractEffortFromBody(body) {
  if (!body || typeof body !== "object") return null;
  const extras = body.extra_body && typeof body.extra_body === "object" ? body.extra_body : {};
  const thinking = extras.thinking || extras.google || body.thinking;
  const output = body.output_config || extras.output_config || body.outputConfig;
  const reasoning = body.reasoning_effort || body.reasoningEffort || body.reasoning;
  const candidates = [
    typeof output === "string" ? output : null,
    output && typeof output === "object" ? output.effort : null,
    typeof reasoning === "string" ? reasoning : null,
    reasoning && typeof reasoning === "object" ? reasoning.effort : null,
    thinking && typeof thinking === "object" ? thinking.effort || thinking.thinkingLevel || thinking.thinking_level : null,
    thinking && typeof thinking === "object" && (thinking.type === "disabled" || thinking.type === "none") ? "none" : null,
  ];
  for (const value of candidates) {
    const effort = normalizeEffort(value);
    if (effort) return effort;
  }
  return null;
}

export function effortGroupFor(requested, catalog) {
  const groups = collapseEffortVariants(catalog);
  const raw = stripModelPrefix(requested);
  const { baseId } = splitEffortSuffix(raw);
  const parsed = resolveModelId(requested, catalog);
  const ids = new Set([raw, baseId, parsed.id, parsed.model?.id, parsed.model?.base_id].filter(Boolean));
  return (
    groups.find(
      (group) =>
        ids.has(group.id) ||
        group.aliases.some((alias) => ids.has(alias)) ||
        Object.values(group.variants || {}).some((id) => ids.has(id)),
    ) || null
  );
}

export function resolveRequestRoute(body, catalog) {
  const requested = body?.model;
  const group = effortGroupFor(requested, catalog);
  const parsed = resolveModelId(requested, catalog);
  const effort = extractEffortFromBody(body) ?? parsed.effort ?? null;
  const model = group ? pickVariantId(group, effort) : parsed.id;
  return { model, effort, requested: parsed.id, group };
}
