import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  TokenStore,
  accountIdOf,
  createBundle,
  disableAccount,
  isAccountDisabled,
  cooldownUntil,
  isQuotaError,
  isRetryableUpstreamError,
  packedRefresh,
  parseResetMs,
  projectOf,
} from "../src/providers/antigravity/tokens.js";
import { tempDir } from "./helpers.js";

test("token store roundtrip", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "nested", "tokens.json");
  const store = new TokenStore(filePath);
  assert.equal(store.load(), null);
  const bundle = createBundle({
    access_token: "a",
    refresh_token: "r",
    expires_at: 99,
    email: "a@b.c",
    project_id: "p",
    managed_project_id: "m",
  });
  store.save(bundle);
  const loaded = store.load();
  assert.equal(loaded.access_token, "a");
  assert.equal(projectOf(loaded), "m");
  assert.equal(packedRefresh(loaded), "r|p|m");
  store.clear();
  assert.equal(store.load(), null);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("legacy single-account file migrates and holds two accounts", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "tokens.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      access_token: "a1",
      refresh_token: "r1",
      expires_at: 99,
      email: "one@example.com",
      project_id: "p1",
    }),
  );
  const store = new TokenStore(filePath);
  const first = store.load();
  assert.equal(first.email, "one@example.com");
  store.save(
    createBundle({
      access_token: "a2",
      refresh_token: "r2",
      expires_at: 100,
      email: "two@example.com",
      project_id: "p2",
    }),
  );
  assert.equal(store.list().length, 2);
  assert.equal(store.load().email, "two@example.com");
  assert.equal(store.use("one@example.com").email, "one@example.com");
  assert.equal(store.load().email, "one@example.com");
  store.save(disableAccount(store.load(), { until: Date.now() + 60_000, reason: "quota" }), { activate: false });
  assert.equal(store.load().email, "one@example.com");
  assert.ok(isAccountDisabled(store.load()));
  assert.equal(store.load().enabled, true);
  store.remove("one@example.com");
  assert.equal(store.list().length, 1);
  assert.equal(store.load().email, "two@example.com");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("removing an account keeps its usage in lifetime stats", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "tokens.db");
  const store = new TokenStore(filePath);
  store.save(createBundle({
    access_token: "a1",
    refresh_token: "r1",
    expires_at: 99,
    email: "gone@example.com",
    request_count: 4,
    success_count: 3,
    error_count: 1,
    prompt_tokens: 1_500_000,
    completion_tokens: 250_000,
  }));
  store.save(createBundle({
    access_token: "a2",
    refresh_token: "r2",
    expires_at: 100,
    email: "kept@example.com",
    request_count: 1,
    success_count: 1,
    prompt_tokens: 10,
    completion_tokens: 5,
  }));
  store.remove("gone@example.com");
  assert.deepEqual(store.lifetimeStats(), {
    requests: 4,
    success: 3,
    failed: 1,
    prompt_tokens: 1_500_000,
    completion_tokens: 250_000,
  });
  store.remove("kept@example.com");
  assert.deepEqual(store.lifetimeStats(), {
    requests: 5,
    success: 4,
    failed: 1,
    prompt_tokens: 1_500_010,
    completion_tokens: 250_005,
  });
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("email arriving later remaps rt- id to one row", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "tokens.db");
  const store = new TokenStore(filePath);
  store.save(createBundle({ access_token: "a", refresh_token: "refresh-long-token", expires_at: 1 }));
  assert.equal(store.list().length, 1);
  assert.match(store.load().email ? "x" : store.list()[0].refresh_token, /refresh/);
  store.save(createBundle({
    access_token: "a2",
    refresh_token: "refresh-long-token",
    expires_at: 2,
    email: "later@example.com",
    project_id: "proj",
  }));
  assert.equal(store.list().length, 1);
  assert.equal(store.load().email, "later@example.com");
  assert.equal(accountIdOf(store.load()), "later@example.com");
  assert.equal(projectOf(store.load()), "proj");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("quota helpers parse reset and match 429", () => {
  const now = Date.parse("2026-10-10T00:00:00Z");
  assert.equal(parseResetMs("2026-10-10T01:00:00Z", now), Date.parse("2026-10-10T01:00:00Z"));
  assert.ok(parseResetMs("30 minutes", now) > now);
  assert.equal(accountIdOf(createBundle({ email: "A@B.C", refresh_token: "r" })), "a@b.c");
  assert.equal(isQuotaError({ status: 429, message: "nope" }), true);
  assert.equal(isQuotaError({ status: 503, message: "RESOURCE_EXHAUSTED" }), true);
  assert.equal(isQuotaError({ status: 404, message: "not found" }), false);
  assert.equal(isRetryableUpstreamError({ status: 429, message: "quota" }), true);
  assert.equal(isRetryableUpstreamError({ status: 503, message: "boom" }), true);
  assert.equal(isRetryableUpstreamError({ status: 401, message: "expired" }), true);
  assert.equal(isRetryableUpstreamError({ status: 400, message: "Invalid JSON schema" }), false);
  assert.equal(isRetryableUpstreamError({ status: 400, message: "project not found" }), true);
  const cooled = cooldownUntil({ status: 503, message: "unavailable" }, now);
  assert.equal(cooled, now + 30_000);
});
