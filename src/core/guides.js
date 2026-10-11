import { collapseEffortVariants } from "../providers/antigravity/catalog.js";

const PROVIDER_LABELS = {
  antigravity: "Antigravity",
  chatgpt: "ChatGPT",
  vertex: "Vertex",
};

const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high"];

export function providerLabel(provider = "antigravity") {
  const key = String(provider || "antigravity").toLowerCase();
  if (PROVIDER_LABELS[key]) return PROVIDER_LABELS[key];
  const cleaned = String(provider || "").replace(/[^A-Za-z0-9]+/g, "");
  return cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : "Antigravity";
}

export function providerPrefix(family, provider = "antigravity") {
  return providerLabel(provider || family);
}

export function displayModelId(model) {
  return String(model?.id || "");
}

export function displayModelName(model, { provider = "antigravity", prefixed = false } = {}) {
  const raw = String(model?.name || model?.id || "").trim();
  if (!prefixed) return raw;
  const label = providerLabel(model?.provider || provider);
  const already = new RegExp(`^${label}\\s*:`, "i");
  if (already.test(raw)) return raw;
  return `${label}:${raw}`;
}

export function publicBaseUrl(settings) {
  const host = settings?.host || "127.0.0.1";
  const port = Number(settings?.port || 8787);
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${shown}:${port}`;
}

export function authToken(settings) {
  return String(settings?.apiKey || "dummy");
}

function vscodeApiType(apiType) {
  if (apiType === "completions" || apiType === "chat" || apiType === "openai") return "openai";
  if (apiType === "responses") return "responses";
  return "messages";
}

function vscodeUrl(baseUrl, apiType) {
  const kind = vscodeApiType(apiType);
  if (kind === "openai") return `${baseUrl}/v1/chat/completions`;
  if (kind === "responses") return `${baseUrl}/v1/responses`;
  return `${baseUrl}/v1/messages`;
}

function vscodeReasoningFormat(apiType) {
  const kind = vscodeApiType(apiType);
  if (kind === "openai") return "openai";
  if (kind === "responses") return "responses";
  return "messages";
}

function vscodeTokenLimits(model) {
  const total = Number(model?.context || 1_048_576);
  const output = Number(model?.output || 65_536);
  const input = total > output ? total - output : total;
  return {
    maxInputTokens: Math.max(1024, input),
    maxOutputTokens: output,
  };
}

export function vscodeLanguageModels({
  models = [],
  settings,
  provider = "antigravity",
  apiType = "messages",
  prefixed = false,
} = {}) {
  const baseUrl = publicBaseUrl(settings);
  const name = "allproxies";
  const listed = collapseEffortVariants(models);
  return {
    name,
    vendor: "customendpoint",
    apiType: vscodeApiType(apiType),
    models: listed.map((model) => {
      const limits = vscodeTokenLimits(model);
      return {
        id: displayModelId(model),
        name: displayModelName(model, { provider: model.provider || provider, prefixed }),
        url: vscodeUrl(baseUrl, apiType),
        headers: settings?.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : undefined,
        toolCalling: true,
        vision: model.supports_images !== false,
        maxInputTokens: limits.maxInputTokens,
        maxOutputTokens: limits.maxOutputTokens,
        thinking: Boolean(model.supports_thinking),
        supportsReasoningEffort: Array.isArray(model.efforts) && model.efforts.length
          ? model.efforts
          : model.supports_thinking
            ? REASONING_LEVELS
            : undefined,
        reasoningEffortFormat: (model.efforts?.length || model.supports_thinking) ? vscodeReasoningFormat(apiType) : undefined,
      };
    }).map((item) => {
      const cleaned = { ...item };
      if (!cleaned.headers) delete cleaned.headers;
      if (!cleaned.supportsReasoningEffort) {
        delete cleaned.supportsReasoningEffort;
        delete cleaned.reasoningEffortFormat;
      }
      return cleaned;
    }),
  };
}

export function supportsMillionContext(model) {
  return Number(model?.context || 0) >= 1_000_000;
}

export function claudeModelId(model, { million = false } = {}) {
  const id = displayModelId(model);
  if (!id) return "";
  if (million && !/\[1m\]$/i.test(id)) return `${id}[1m]`;
  return id;
}

function findModelById(models, id) {
  const wanted = String(id || "").trim();
  if (!wanted) return null;
  return models.find((item) => item.id === wanted || item.preferred === wanted || (item.aliases || []).includes(wanted)) || null;
}

function pickPreferred(models, tests) {
  for (const test of tests) {
    const found = models.find(test);
    if (found) return found;
  }
  return models[0] || null;
}

export const CLAUDE_SLOTS = [
  { key: "model", env: "ANTHROPIC_MODEL", label: "Default" },
  { key: "sonnet", env: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "Sonnet" },
  { key: "opus", env: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "Opus" },
  { key: "haiku", env: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "Haiku" },
  { key: "fast", env: "ANTHROPIC_SMALL_FAST_MODEL", label: "Small / fast" },
  { key: "subagent", env: "CLAUDE_CODE_SUBAGENT_MODEL", label: "Subagent" },
];

export function defaultClaudePicks(models = []) {
  const listed = collapseEffortVariants(models);
  const sonnet = pickPreferred(listed, [
    (m) => /sonnet/i.test(m.id) && /4-?6|4\.6|5/i.test(m.id),
    (m) => /sonnet/i.test(m.id),
    (m) => m.family === "claude",
    (m) => /gemini-3\.8-flash(?!-)/.test(m.id),
    (m) => /gemini-3\.8-flash/.test(m.id),
  ]);
  const opus = pickPreferred(listed, [
    (m) => /opus/i.test(m.id),
    (m) => sonnet && m.id === sonnet.id,
  ]);
  const haiku = pickPreferred(listed, [
    (m) => /haiku|lite/i.test(m.id),
    (m) => sonnet && m.id === sonnet.id,
  ]);
  const id = (model) => model?.id || "";
  return {
    model: id(sonnet),
    sonnet: id(sonnet),
    opus: id(opus || sonnet),
    haiku: id(haiku || sonnet),
    fast: id(haiku || sonnet),
    subagent: id(sonnet),
  };
}

export function defaultCodexPick(models = []) {
  const listed = collapseEffortVariants(models);
  const chosen = pickPreferred(listed, [
    (m) => /opus/i.test(m.id),
    (m) => /sonnet/i.test(m.id),
    (m) => /gemini-3\.8-flash(?!-)/.test(m.id),
    (m) => /gemini-3\.8-flash/.test(m.id),
    (m) => /gemini-pro-agent|gemini-3\.1-pro/.test(m.id),
  ]);
  return chosen?.id || listed[0]?.id || "";
}

export function claudeCodeSettings({
  models = [],
  settings,
  picks = {},
  million = {},
} = {}) {
  const baseUrl = publicBaseUrl(settings);
  models = collapseEffortVariants(models);
  const defaults = defaultClaudePicks(models);
  const chosen = {};
  for (const slot of CLAUDE_SLOTS) {
    chosen[slot.key] = findModelById(models, picks[slot.key]) || findModelById(models, defaults[slot.key]);
  }
  const idOf = (key) => claudeModelId(chosen[key], { million: Boolean(million[key]) });
  const primary = chosen.opus || chosen.model || chosen.sonnet;
  return {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: authToken(settings),
      ANTHROPIC_MODEL: idOf("model"),
      ANTHROPIC_DEFAULT_OPUS_MODEL: idOf("opus"),
      ANTHROPIC_DEFAULT_SONNET_MODEL: idOf("sonnet"),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: idOf("haiku"),
      ANTHROPIC_SMALL_FAST_MODEL: idOf("fast"),
      CLAUDE_CODE_SUBAGENT_MODEL: idOf("subagent"),
      CLAUDE_CODE_USE_VERTEX: "0",
      CLAUDE_CODE_USE_BEDROCK: "0",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "true",
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
      MCP_CONNECT_TIMEOUT_MS: "20000",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "700000",
      DISABLE_INTERLEAVED_THINKING: "0",
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(primary?.output || 128000),
      CLAUDE_CODE_EFFORT_LEVEL: "max",
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "88",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(primary?.context || 500000),
      MAX_MCP_OUTPUT_TOKENS: "50000",
      MCP_TIMEOUT: "200000",
      ENABLE_TOOL_SEARCH: "auto",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      API_TIMEOUT_MS: "6000000",
      CLAUDE_ENABLE_STREAM_WATCHDOG: "0",
      CLAUDE_CODE_USE_POWERSHELL_TOOL: "1",
      ENABLE_PROMPT_CACHING_1H: "1",
    },
    permissions: { defaultMode: "auto" },
  };
}

export function escapeToml(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function codexConfig({
  models = [],
  settings,
  providerKey = "allproxies",
  modelId = "",
} = {}) {
  const baseUrl = `${publicBaseUrl(settings)}/v1`;
  models = collapseEffortVariants(models);
  const chosen = findModelById(models, modelId) || findModelById(models, defaultCodexPick(models));
  const id = chosen ? displayModelId(chosen) : "";
  const context = Number(chosen?.context || 1_048_576);
  return `# ~/.codex/config.toml
model = "${escapeToml(id)}"
model_provider = "${escapeToml(providerKey)}"
model_context_window = ${context}
model_reasoning_effort = "medium"

# Skip the OpenAI key check — auth is handled by the proxy
preferred_auth_method = "apikey"

[model_providers.${providerKey}]
name = "allproxies"
base_url = "${escapeToml(baseUrl)}"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
request_max_retries = 2
stream_max_retries = 5
stream_idle_timeout_ms = 300000
`;
}

export function openaiCompatSnippet({ settings } = {}) {
  const base = publicBaseUrl(settings);
  const key = authToken(settings);
  return {
    openai: {
      base_url: `${base}/v1`,
      api_key: key,
      chat: `${base}/v1/chat/completions`,
      responses: `${base}/v1/responses`,
    },
    anthropic: {
      base_url: base,
      auth_token: key,
      messages: `${base}/v1/messages`,
    },
  };
}

export function buildClientGuides({
  models = [],
  settings,
  provider = "antigravity",
  prefixed = false,
  hidden = [],
  claudePicks = {},
  claudeMillion = {},
  codexModel = "",
} = {}) {
  const hide = new Set((hidden || []).map(String));
  const visible = models.filter((model) => !hide.has(String(model.id)));
  const listed = collapseEffortVariants(visible);
  return {
    base_url: publicBaseUrl(settings),
    auth_token: authToken(settings),
    prefixed,
    hidden: [...hide],
    choices: listed.map((model) => ({
      id: model.id,
      name: displayModelName(model, { provider: model.provider || provider, prefixed: false }),
      provider: model.provider || provider,
      context: Number(model.context || 0),
      million: true,
    })),
    claude_slots: CLAUDE_SLOTS,
    claude_defaults: defaultClaudePicks(listed),
    codex_default: defaultCodexPick(listed),
    vscode: {
      messages: vscodeLanguageModels({ models: listed, settings, provider, apiType: "messages", prefixed }),
      completions: vscodeLanguageModels({ models: listed, settings, provider, apiType: "openai", prefixed }),
      responses: vscodeLanguageModels({ models: listed, settings, provider, apiType: "responses", prefixed }),
    },
    claude_code: claudeCodeSettings({ models: listed, settings, picks: claudePicks, million: claudeMillion }),
    codex: codexConfig({ models: listed, settings, modelId: codexModel }),
    endpoints: openaiCompatSnippet({ settings }),
  };
}
