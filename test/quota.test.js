import assert from "node:assert/strict";
import test from "node:test";
import { classifyWindow, mergeQuotaViews, parseQuotaSummary, quotasFromLiveModels } from "../src/providers/antigravity/quota.js";

test("classifies reset windows", () => {
  assert.equal(classifyWindow("Hourly quota"), "hourly");
  assert.equal(classifyWindow("5-hour limit"), "5h");
  assert.equal(classifyWindow("Weekly"), "weekly");
  assert.equal(classifyWindow("Monthly allowance"), "monthly");
});

test("parses nested quota summary", () => {
  const quotas = parseQuotaSummary({
    quotaInfo: [
      { displayName: "Hourly", remainingFraction: 0.4, resetTime: "2026-10-10T12:00:00Z" },
      { name: "Weekly", remainingFraction: 0.8, resetTime: "2026-10-16T00:00:00Z" },
      { id: "chat_23310", remainingFraction: 1 },
      { name: "tab_foo", remainingFraction: 1 },
    ],
  });
  assert.equal(quotas.length, 2);
  assert.equal(quotas[0].window, "hourly");
  assert.equal(quotas[0].remaining, 0.4);
  assert.ok(quotas[0].used > 0.5);
});

test("falls back to live model quota groups", () => {
  const fromModels = quotasFromLiveModels({
    models: {
      "gemini-3.8-flash-high": { quotaInfo: { remainingFraction: 1, resetTime: "2026-10-16T02:00:00Z" } },
      "claude-sonnet-4-6": { quotaInfo: { remainingFraction: 1, resetTime: "2026-10-16T02:00:00Z" } },
      chat_20706: { quotaInfo: { remainingFraction: 1 } },
    },
  });
  assert.equal(fromModels.length, 1);
  assert.equal(fromModels[0].remaining, 1);
  assert.equal(fromModels[0].label, "Weekly");
  assert.deepEqual(mergeQuotaViews([], fromModels), fromModels);
});
