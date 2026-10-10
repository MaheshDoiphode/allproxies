import assert from "node:assert/strict";
import test from "node:test";
import { createBundle, TokenStore } from "../src/providers/antigravity/tokens.js";
import { request, startApi, tempDir, testClient, testSettings } from "./helpers.js";
import { AntigravityClient } from "../src/providers/antigravity/client.js";
import path from "node:path";

test("dashboard is served without api key", async () => {
  const dir = tempDir();
  const api = await startApi(dir);
  try {
    const page = await request(api.url, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /allproxies/);
    const boot = await request(api.url, "/admin/api/bootstrap");
    assert.equal(boot.status, 200);
    assert.equal(boot.json.authorized, true);
    const accounts = await request(api.url, "/admin/api/accounts");
    assert.equal(accounts.status, 200);
    assert.equal(accounts.json[0].email, "user@example.com");
    assert.equal(accounts.json[0].enabled, true);
  } finally {
    await api.close();
  }
});

test("enable disable and batch skip disabled accounts", async () => {
  const dir = tempDir();
  const tokenPath = path.join(dir, "tokens.json");
  const store = new TokenStore(tokenPath);
  store.save(createBundle({
    access_token: "a1",
    refresh_token: "r1",
    expires_at: 4_000_000_000,
    email: "one@example.com",
    project_id: "p1",
    managed_project_id: "p1",
  }));
  store.save(createBundle({
    access_token: "a2",
    refresh_token: "r2",
    expires_at: 4_000_000_000,
    email: "two@example.com",
    project_id: "p2",
    managed_project_id: "p2",
  }));
  const client = new AntigravityClient(testSettings(dir, { tokenPath, liveModels: false }));
  const api = await startApi(dir, { client });
  try {
    const disabled = await request(api.url, "/admin/api/accounts/one@example.com", {
      method: "PUT",
      json: { enabled: false },
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.enabled, false);
    const list = await request(api.url, "/admin/api/accounts");
    const one = list.json.find((item) => item.email === "one@example.com");
    const two = list.json.find((item) => item.email === "two@example.com");
    assert.equal(one.enabled, false);
    assert.equal(one.disabled, true);
    assert.equal(two.enabled, true);
    const batch = await request(api.url, "/admin/api/accounts/batch", {
      method: "POST",
      json: { ids: ["one@example.com"], action: "enable" },
    });
    assert.equal(batch.json.success, true);
    const again = await request(api.url, "/admin/api/accounts/one@example.com");
    assert.equal(again.json.enabled, true);
  } finally {
    await api.close();
  }
});

test("dashboard lists chatgpt accounts and starts chatgpt login", async () => {
  const dir = tempDir();
  const tokenPath = path.join(dir, "chatgpt-tokens.db");
  const { TokenStore, createChatgptBundle } = await import("../src/providers/chatgpt/tokens.js");
  const { ChatgptClient } = await import("../src/providers/chatgpt/client.js");
  new TokenStore(tokenPath).save(createChatgptBundle({
    access_token: "gpt-access",
    refresh_token: "gpt-refresh",
    expires_at: 4_000_000_000,
    email: "gpt@example.com",
    account_id: "acct-1",
    project_id: "acct-1",
    managed_project_id: "acct-1",
    plan: "free",
  }));
  const chatgpt = new ChatgptClient(testSettings(dir, { chatgptTokenPath: tokenPath, liveModels: false }));
  const api = await startApi(dir, { chatgpt });
  try {
    const status = await request(api.url, "/admin/api/status");
    assert.equal(status.status, 200);
    const emails = status.json.items.map((item) => item.email);
    assert.ok(emails.includes("user@example.com"));
    assert.ok(emails.includes("gpt@example.com"));
    const gpt = status.json.items.find((item) => item.email === "gpt@example.com");
    assert.equal(gpt.provider, "chatgpt");
    const login = await request(api.url, "/admin/api/accounts/login-chatgpt", { method: "POST" });
    assert.equal(login.status, 200);
    assert.match(login.json.authorize_url, /auth\.openai\.com/);
    assert.equal(login.json.provider, "chatgpt");
    await request(`http://127.0.0.1:1455/auth/callback?state=${encodeURIComponent(login.json.state)}&error=access_denied`);
  } finally {
    await api.close();
  }
});
