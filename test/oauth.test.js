import assert from "node:assert/strict";
import test from "node:test";
import { OAUTH_CLIENT_ID, OAUTH_REDIRECT_URI } from "../src/core/constants.js";
import http from "node:http";
import { browserLaunch, buildAuthUrl, generatePkce, startCallbackServer, tokenFromResponse } from "../src/providers/antigravity/oauth.js";
import { createBundle, parsePackedRefresh } from "../src/providers/antigravity/tokens.js";

test("pkce is s256 urlsafe", () => {
  const { verifier, challenge } = generatePkce();
  assert.ok(verifier.length >= 32);
  assert.notEqual(verifier, challenge);
  assert.ok(!verifier.includes("="));
  assert.ok(!challenge.includes("="));
});

test("auth url has offline consent and pkce", () => {
  const url = new URL(buildAuthUrl({ state: "abc", codeChallenge: "challenge" }));
  assert.equal(url.protocol, "https:");
  assert.equal(url.searchParams.get("client_id"), OAUTH_CLIENT_ID);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "challenge");
  assert.equal(url.searchParams.get("state"), "abc");
  assert.equal(url.searchParams.get("redirect_uri"), OAUTH_REDIRECT_URI);
  const scopes = url.searchParams.get("scope");
  assert.match(scopes, /cloud-platform/);
  assert.match(scopes, /cclog/);
});

test("token from response keeps existing refresh", () => {
  const existing = createBundle({ access_token: "old", refresh_token: "keep-me", expires_at: 1, project_id: "p" });
  const bundle = tokenFromResponse({ access_token: "new", expires_in: 60, token_type: "Bearer" }, existing);
  assert.equal(bundle.access_token, "new");
  assert.equal(bundle.refresh_token, "keep-me");
  assert.equal(bundle.project_id, "p");
  assert.ok(bundle.expires_at > 1);
});

test("packed refresh roundtrip", () => {
  const parsed = parsePackedRefresh("rt|proj|managed");
  assert.deepEqual(parsed, { refresh: "rt", project: "proj", managed: "managed" });
});

test("browser launch does not caret-escape query ampersands", () => {
  const url = buildAuthUrl({ state: "abc", codeChallenge: "challenge" });
  const launch = browserLaunch(url);
  const blob = [launch.file, ...launch.args].join(" ");
  assert.equal(blob.includes("^&"), false);
  assert.equal(launch.args.at(-1), url);
  assert.ok(url.includes("&redirect_uri="));
  if (process.platform === "win32") {
    assert.equal(launch.file, "rundll32.exe");
    assert.equal(launch.args[0], "url.dll,FileProtocolHandler");
  }
});

test("callback server is listening before the auth code arrives", async () => {
  const { ready, code } = startCallbackServer("st", { port: 51131, timeoutMs: 5_000 });
  await ready;
  const started = Date.now();
  const agent = new http.Agent({ keepAlive: true });
  await new Promise((resolve, reject) => {
    http.get("http://127.0.0.1:51131/oauth-callback?state=st&code=abc", { agent }, (res) => {
      res.resume();
      res.on("end", resolve);
    }).on("error", reject);
  });
  assert.equal(await code, "abc");
  assert.ok(Date.now() - started < 1000);
  agent.destroy();
});
