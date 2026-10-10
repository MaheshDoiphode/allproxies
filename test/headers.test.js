import assert from "node:assert/strict";
import test from "node:test";
import { parseHubVersion, requestHeaders, resolveHubVersion, stripApiKeyHeaders } from "../src/providers/antigravity/headers.js";

test("hub version floor and fetch win", () => {
  assert.equal(resolveHubVersion("1.0.0"), "2.9.1");
  assert.equal(resolveHubVersion("2.9.1", "2.10.0"), "2.10.0");
  assert.equal(parseHubVersion("version: 2.11.3\nfiles:\n  - url: x"), "2.11.3");
});

test("headers look like antigravity and strip keys", () => {
  const headers = requestHeaders("2.9.1");
  assert.ok(headers["User-Agent"].startsWith("antigravity/hub/2.9.1 "));
  assert.match(headers["Client-Metadata"], /ideType/);
  const cleaned = stripApiKeyHeaders({ ...headers, "x-goog-api-key": "nope", "x-api-key": "nope" });
  assert.equal(cleaned["x-goog-api-key"], undefined);
  assert.equal(cleaned["x-api-key"], undefined);
  assert.equal(cleaned.Authorization, undefined);
});
