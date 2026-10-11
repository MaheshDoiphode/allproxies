import { createModel } from "../antigravity/catalog.js";

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function isPublicChatgptModel(model) {
  if (!model) return false;
  if (model.supported_in_api === false || model.supportedInApi === false) return false;
  const visibility = model.visibility ?? model.raw?.visibility;
  return visibility == null || visibility === "list";
}

export function sortChatgptEfforts(names) {
  return [...new Set((names || []).map((item) => String(item || "").trim()).filter(Boolean))].sort((a, b) => {
    const ia = EFFORT_ORDER.indexOf(a.toLowerCase());
    const ib = EFFORT_ORDER.indexOf(b.toLowerCase());
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

export function effortsFromChatgptModel(item) {
  const levels = item?.supported_reasoning_levels || item?.supportedReasoningLevels || item?.efforts;
  if (!Array.isArray(levels) || !levels.length) return [];
  return sortChatgptEfforts(levels.map((level) => (typeof level === "string" ? level : level?.effort)));
}

export function parseChatgptModels(payload) {
  const items = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : [];
  return items
    .map((item) => {
      const slug = item.slug || item.id;
      if (!slug) return null;
      const efforts = effortsFromChatgptModel(item);
      const model = createModel({
        id: slug,
        name: item.name || item.display_name || slug,
        family: "gpt",
        context: Number(item.context || item.context_window || 1_048_576),
        output: Number(item.output || item.max_output_tokens || 65_536),
        supports_thinking: true,
        supports_images: Array.isArray(item.input_modalities) ? item.input_modalities.includes("image") : true,
        source: "live",
        efforts,
        preferred: slug,
      });
      model.use_responses_lite = item.use_responses_lite ?? item.useResponsesLite ?? true;
      model.default_reasoning_level = item.default_reasoning_level || item.defaultReasoningLevel || "medium";
      model.default_verbosity = item.default_verbosity || item.defaultVerbosity || "low";
      model.support_verbosity = Boolean(item.support_verbosity ?? item.supportVerbosity);
      return model;
    })
    .filter(Boolean)
    .filter((model, _, all) => {
      const raw = items.find((item) => (item.slug || item.id) === model.id);
      return isPublicChatgptModel(raw || model);
    });
}

export function chatgptModelMeta(payload, slug) {
  const items = Array.isArray(payload?.models) ? payload.models : [];
  return items.find((item) => item.slug === slug || item.id === slug) || null;
}
