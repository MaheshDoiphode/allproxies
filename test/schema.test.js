import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSchema, sanitizeToolName, sanitizeTools } from "../src/providers/antigravity/schema.js";

test("schema strips unsupported and promotes const", () => {
  const cleaned = sanitizeSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: "#/$defs/x",
    $comment: "copilot leftover",
    title: "Nope",
    default: 1,
    examples: [1],
    const: "only",
    enumDescriptions: ["only desc"],
    propertyNames: { type: "string" },
    properties: { keep: { type: "string" }, gone: { type: "number" } },
    required: ["keep", "missing"],
  });
  assert.equal(cleaned.$schema, undefined);
  assert.equal(cleaned.$ref, undefined);
  assert.equal(cleaned.$comment, undefined);
  assert.equal(cleaned.title, undefined);
  assert.equal(cleaned.default, undefined);
  assert.equal(cleaned.enumDescriptions, undefined);
  assert.equal(cleaned.propertyNames, undefined);
  assert.deepEqual(cleaned.enum, ["only"]);
  assert.deepEqual(cleaned.required, ["keep"]);
});

test("tool name sanitized", () => {
  assert.equal(sanitizeToolName("pkg/read.file"), "pkg_read_file");
  assert.ok(sanitizeToolName("9bad").startsWith("t_"));
  assert.equal(sanitizeToolName("a".repeat(80)).length, 64);
});

test("google search not mixed with functions", () => {
  const tools = sanitizeTools([
    { googleSearch: {} },
    { type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } },
  ]);
  assert.deepEqual(tools, [
    { functionDeclarations: [{ name: "lookup", description: "", parameters: { type: "object", properties: {} } }] },
  ]);
  assert.deepEqual(sanitizeTools([{ google_search: {} }]), [{ googleSearch: {} }]);
});
