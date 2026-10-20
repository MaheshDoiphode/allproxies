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

test("claude tools use parametersJsonSchema so anyOf survives the upstream conversion", () => {
  const tool = {
    name: "emulate",
    description: "d",
    input_schema: {
      type: "object",
      properties: { media: { anyOf: [{ type: "string", enum: ["screen", "print"] }, { type: "null" }] } },
    },
  };
  const gemini = sanitizeTools([tool])[0].functionDeclarations[0];
  assert.ok(gemini.parameters);
  assert.equal(gemini.parametersJsonSchema, undefined);

  const claude = sanitizeTools([tool], { jsonSchema: true })[0].functionDeclarations[0];
  assert.equal(claude.parameters, undefined);
  assert.equal(claude.parametersJsonSchema.type, "object");
  assert.equal(claude.parametersJsonSchema.properties.media.anyOf.length, 2);

  const empty = sanitizeTools([{ name: "noargs", input_schema: {} }], { jsonSchema: true })[0].functionDeclarations[0];
  assert.deepEqual(empty.parametersJsonSchema, { type: "object", properties: {} });
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

test("anthropic built-in web_search_20250305 maps to googleSearch grounding and schema-less tools get type object", () => {
  assert.deepEqual(sanitizeTools([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]), [
    { googleSearch: {} },
  ]);
  const tools = sanitizeTools([{ name: "custom_no_schema", input_schema: {} }]);
  const decls = tools[0].functionDeclarations;
  assert.equal(decls[0].name, "custom_no_schema");
  assert.deepEqual(decls[0].parameters, { type: "object", properties: {} });
});

