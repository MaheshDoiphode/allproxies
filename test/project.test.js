import assert from "node:assert/strict";
import test from "node:test";
import { defaultTier, extractProjectId, loadCodeAssistBody, onboardUserBody } from "../src/providers/antigravity/project.js";

test("extract project from string or object", () => {
  assert.equal(extractProjectId({ cloudaicompanionProject: "abc" }), "abc");
  assert.equal(extractProjectId({ cloudaicompanionProject: { id: "xyz" } }), "xyz");
  assert.equal(extractProjectId({ response: { project: "nested" } }), "nested");
});

test("default tier prefers isDefault", () => {
  assert.equal(defaultTier({ allowedTiers: [{ id: "paid" }, { id: "free-tier", isDefault: true }] }), "free-tier");
  assert.equal(defaultTier({}), "free-tier");
});

test("onboard metadata uses antigravity", () => {
  const body = onboardUserBody("free-tier");
  assert.equal(body.tierId, "free-tier");
  assert.equal(body.metadata.ideType, "ANTIGRAVITY");
  assert.equal(loadCodeAssistBody().metadata.pluginType, "GEMINI");
});
