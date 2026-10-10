import assert from "node:assert/strict";
import test from "node:test";
import { collapseEffortVariants, createModel, loadStaticCatalog, mergeCatalog, parseLiveModels, resolveModelId, resolveRequestRoute } from "../src/providers/antigravity/catalog.js";
import { MODELS_PATH } from "./helpers.js";

test("static catalog loads", () => {
  const models = loadStaticCatalog(MODELS_PATH);
  const ids = new Set(models.map((model) => model.id));
  assert.ok(ids.has("gemini-3.8-flash-high"));
  assert.ok(ids.has("claude-opus-4-6-thinking"));
  assert.ok(ids.has("gpt-oss-120b-medium"));
});

test("merge live quota onto static", () => {
  const staticModels = [createModel({ id: "gemini-3.8-flash-high", name: "Gemini 3.8", aliases: ["gemini-3.8-flash"] })];
  const live = parseLiveModels({
    models: {
      "gemini-3.8-flash": {
        displayName: "Gemini 3.8 Flash",
        model: "gemini-3.8-flash",
        supportsThinking: true,
        quotaInfo: { remainingFraction: 0.4, resetTime: "soon" },
      },
    },
  });
  const merged = mergeCatalog(staticModels, live);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "gemini-3.8-flash-high");
  assert.equal(merged[0].remaining_fraction, 0.4);
  assert.equal(merged[0].source, "live");
  assert.ok(merged[0].aliases.includes("gemini-3.8-flash"));
});

test("live placeholder enum uses object key and skips internals", () => {
  const live = parseLiveModels({
    models: {
      "gemini-3.8-flash-medium": {
        displayName: "Gemini 3.8 Flash (Medium)",
        model: "MODEL_PLACEHOLDER_M319",
        supportsThinking: true,
        quotaInfo: { remainingFraction: 1 },
      },
      chat_20706: { model: "MODEL_CHAT_20706" },
      "gemini-3.8-flash-tiered": { model: "MODEL_PLACEHOLDER_M322", supportsThinking: true },
    },
  });
  assert.deepEqual(
    live.map((model) => model.id),
    ["gemini-3.8-flash-medium"],
  );
  assert.equal(live[0].name, "Gemini 3.8 Flash (Medium)");
});

test("resolve strips provider prefix", () => {
  const catalog = [
    createModel({
      id: "gemini-3.8-flash-high",
      name: "Gemini",
      aliases: ["antigravity-gemini-3.8-flash", "gemini-3.8-flash"],
    }),
  ];
  const resolved = resolveModelId("google/antigravity-gemini-3.8-flash", catalog);
  assert.equal(resolved.id, "gemini-3.8-flash-high");
  assert.ok(resolved.model);
  assert.equal(resolveModelId("Gemini:gemini-3.8-flash-high", catalog).id, "gemini-3.8-flash-high");
  assert.equal(resolveModelId("claude-sonnet-4-6[1m]", [createModel({ id: "claude-sonnet-4-6" })]).id, "claude-sonnet-4-6");
});

test("collapse folds effort clones and routes body effort to the variant", () => {
  const catalog = [
    createModel({ id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash High", aliases: ["gemini-3.6-flash"], supports_thinking: true }),
    createModel({ id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash Medium", supports_thinking: true }),
    createModel({ id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash Low", supports_thinking: true }),
    createModel({ id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" }),
    createModel({ id: "gemini-pro-agent", name: "Gemini 3.1 Pro High", aliases: ["gemini-3.1-pro", "gemini-3.1-pro-high"], supports_thinking: true }),
    createModel({ id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro Low", supports_thinking: true }),
  ];
  const collapsed = collapseEffortVariants(catalog);
  const flash = collapsed.find((model) => model.id === "gemini-3.6-flash");
  const lite = collapsed.find((model) => model.id === "gemini-3.5-flash-lite");
  const pro = collapsed.find((model) => model.id === "gemini-3.1-pro");
  assert.ok(flash);
  assert.ok(lite);
  assert.ok(pro);
  assert.equal(collapsed.filter((model) => model.id.startsWith("gemini-3.6-flash")).length, 1);
  assert.deepEqual(flash.efforts, ["none", "low", "medium", "high"]);
  assert.equal(flash.variants.high, "gemini-3.6-flash-high");
  assert.equal(pro.variants.high, "gemini-pro-agent");
  assert.equal(pro.variants.low, "gemini-3.1-pro-low");
  assert.deepEqual(collapseEffortVariants(collapsed).find((model) => model.id === "gemini-3.6-flash").variants, flash.variants);
  assert.equal(resolveRequestRoute({ model: "gemini-3.6-flash", reasoning_effort: "high" }, catalog).model, "gemini-3.6-flash-high");
  assert.equal(resolveRequestRoute({ model: "gemini-3.6-flash", reasoning: { effort: "low" } }, catalog).model, "gemini-3.6-flash-low");
  assert.equal(resolveRequestRoute({ model: "gemini-3.6-flash", output_config: { effort: "medium" } }, catalog).model, "gemini-3.6-flash-medium");
  assert.equal(resolveRequestRoute({ model: "gemini-3.6-flash", reasoning_effort: "none" }, catalog).model, "gemini-3.6-flash-low");
  assert.equal(resolveRequestRoute({ model: "gemini-3.6-flash" }, catalog).model, "gemini-3.6-flash-high");
  assert.equal(resolveRequestRoute({ model: "gemini-3.1-pro", reasoning_effort: "high" }, catalog).model, "gemini-pro-agent");
});
