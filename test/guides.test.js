import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClientGuides,
  claudeCodeSettings,
  codexConfig,
  displayModelId,
  displayModelName,
  vscodeLanguageModels,
} from "../src/core/guides.js";
import { createModel } from "../src/providers/antigravity/catalog.js";
import { request, startApi, tempDir } from "./helpers.js";

const MODELS = [
  createModel({ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High", family: "gemini", context: 1048576, output: 65536, supports_thinking: true, supports_images: true, aliases: ["gemini-3.8-flash"] }),
  createModel({ id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash Medium", family: "gemini", context: 1048576, output: 65536, supports_thinking: true, supports_images: true }),
  createModel({ id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash Low", family: "gemini", context: 1048576, output: 65536, supports_thinking: true, supports_images: true }),
  createModel({ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", family: "claude", context: 200000, output: 64000, supports_thinking: true }),
  createModel({ id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking", family: "claude", context: 200000, output: 64000, supports_thinking: true }),
];

const SETTINGS = { host: "127.0.0.1", port: 8787, apiKey: "dev-key" };

test("vscode snippet uses live catalog and messages url", () => {
  const snippet = vscodeLanguageModels({ models: MODELS, settings: SETTINGS, apiType: "messages" });
  assert.equal(snippet.vendor, "customendpoint");
  assert.equal(snippet.apiType, "messages");
  assert.equal(snippet.models[0].url, "http://127.0.0.1:8787/v1/messages");
  assert.equal(snippet.models[0].id, "gemini-3.8-flash");
  assert.equal(snippet.models[0].name, "Gemini 3.8 Flash");
  assert.equal(snippet.models[0].thinking, true);
  assert.deepEqual(snippet.models[0].supportsReasoningEffort, ["none", "low", "medium", "high"]);
  assert.equal(snippet.models[0].reasoningEffortFormat, "messages");
  assert.equal(snippet.models.filter((item) => item.id.startsWith("gemini-3.8-flash")).length, 1);
  const openai = vscodeLanguageModels({ models: MODELS, settings: SETTINGS, apiType: "completions" });
  assert.equal(openai.apiType, "openai");
  assert.equal(openai.models[0].url, "http://127.0.0.1:8787/v1/chat/completions");
  assert.equal(openai.models[0].reasoningEffortFormat, "openai");
  const prefixed = vscodeLanguageModels({ models: MODELS, settings: SETTINGS, apiType: "completions", prefixed: true });
  assert.equal(prefixed.apiType, "openai");
  assert.equal(prefixed.models[0].id, "gemini-3.8-flash");
  assert.equal(prefixed.models[0].name, "Antigravity:Gemini 3.8 Flash");
  assert.equal(prefixed.models[1].id, "claude-sonnet-4-6");
  assert.equal(prefixed.models[1].name, "Antigravity:Claude Sonnet 4.6");
  assert.equal(prefixed.models[0].url, "http://127.0.0.1:8787/v1/chat/completions");
});

test("claude code and codex pick family defaults", () => {
  const claude = claudeCodeSettings({ models: MODELS, settings: SETTINGS });
  assert.equal(claude.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787");
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, "dev-key");
  assert.equal(claude.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-sonnet-4-6");
  assert.equal(claude.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-opus-4-6-thinking");
  const toml = codexConfig({ models: MODELS, settings: SETTINGS });
  assert.match(toml, /model = "claude-opus-4-6-thinking"/);
  assert.match(toml, /wire_api = "responses"/);
  assert.match(toml, /base_url = "http:\/\/127.0.0.1:8787\/v1"/);
  assert.equal(displayModelId(MODELS[0]), "gemini-3.8-flash-high");
  assert.equal(displayModelName(MODELS[0], { prefixed: true }), "Antigravity:Gemini 3.8 Flash High");
});

test("admin guides endpoint returns all snippets", async () => {
  const dir = tempDir();
  const api = await startApi(dir);
  try {
    const plain = await request(api.url, "/admin/api/guides");
    assert.equal(plain.status, 200);
    assert.equal(plain.json.vscode.messages.vendor, "customendpoint");
    assert.ok(plain.json.vscode.messages.models.some((item) => item.id === "gemini-3.8-flash"));
    assert.ok(!plain.json.vscode.messages.models.some((item) => /gemini-3\.8-flash-(high|medium|low)$/.test(item.id)));
    assert.match(plain.json.codex, /\[model_providers.allproxies\]/);
    const prefixed = await request(api.url, "/admin/api/guides?prefixed=1");
    const named = prefixed.json.vscode.messages.models.find((item) => item.id === "gemini-3.8-flash");
    assert.ok(named);
    assert.match(named.name, /^Antigravity:/);
    assert.ok(!prefixed.json.vscode.messages.models.some((item) => item.id.startsWith("Gemini:") || item.id.startsWith("Claude:")));
  } finally {
    await api.close();
  }
});

test("buildClientGuides includes endpoints", () => {
  const guides = buildClientGuides({ models: MODELS, settings: SETTINGS });
  assert.equal(guides.endpoints.openai.chat, "http://127.0.0.1:8787/v1/chat/completions");
  assert.equal(guides.endpoints.anthropic.messages, "http://127.0.0.1:8787/v1/messages");
});

test("prefixed names use provider not family", () => {
  const models = [
    createModel({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", family: "gemini", provider: "antigravity", supports_thinking: true }),
    createModel({ id: "vertex/gemini-3.8-flash", name: "Gemini 3.8 Flash", family: "gemini", provider: "vertex", supports_thinking: true }),
    createModel({ id: "gpt-5.4", name: "GPT 5.4", family: "gpt", provider: "chatgpt", supports_thinking: true }),
  ];
  const snippet = vscodeLanguageModels({ models, settings: SETTINGS, apiType: "messages", prefixed: true });
  assert.equal(snippet.models.find((item) => item.id === "gemini-3.8-flash").name, "Antigravity:Gemini 3.8 Flash");
  assert.equal(snippet.models.find((item) => item.id === "vertex/gemini-3.8-flash").name, "Vertex:Gemini 3.8 Flash");
  assert.equal(snippet.models.find((item) => item.id === "gpt-5.4").name, "ChatGPT:GPT 5.4");
});

test("vscode snippet keeps live chatgpt efforts including xhigh and ultra", () => {
  const models = [
    createModel({
      id: "gpt-5.6-terra",
      name: "GPT 5.6 Terra",
      family: "gpt",
      supports_thinking: true,
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    }),
  ];
  const snippet = vscodeLanguageModels({ models, settings: SETTINGS, apiType: "messages" });
  assert.deepEqual(snippet.models[0].supportsReasoningEffort, ["low", "medium", "high", "xhigh", "max", "ultra"]);
});
