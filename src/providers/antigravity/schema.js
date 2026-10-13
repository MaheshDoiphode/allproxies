const DROP_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "$comment",
  "definitions",
  "default",
  "examples",
  "example",
  "title",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "additionalProperties",
  "unevaluatedProperties",
  "patternProperties",
  "propertyNames",
  "enumDescriptions",
  "markdownDescription",
  "markdownEnumDescriptions",
  "deprecated",
  "readOnly",
  "writeOnly",
  "contentMediaType",
  "contentEncoding",
  "contentSchema",
  "if",
  "then",
  "else",
  "not",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
]);

const KEEP_KEYS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "format",
  "nullable",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minProperties",
  "maxProperties",
  "pattern",
  "anyOf",
  "oneOf",
  "allOf",
  "prefixItems",
]);

export function sanitizeToolName(name) {
  let cleaned = String(name || "tool")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned || !/^[A-Za-z_]/.test(cleaned)) cleaned = cleaned ? `t_${cleaned}` : "tool";
  return cleaned.slice(0, 64);
}

function sanitizeNode(node) {
  if (Array.isArray(node)) return node.map((item) => (item && typeof item === "object" ? sanitizeSchema(item) : item));
  if (!node || typeof node !== "object") return node;
  return sanitizeSchema(node);
}

export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.map((item) => (item && typeof item === "object" ? sanitizeSchema(item) : item));
  if (!node || typeof node !== "object") return node;
  const cleaned = {};
  if (Object.prototype.hasOwnProperty.call(node, "const") && node.const !== undefined) {
    cleaned.enum = [node.const];
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "const") continue;
    if (DROP_KEYS.has(key) || key.startsWith("$") || !KEEP_KEYS.has(key)) continue;
    cleaned[key] = value;
  }
  if (cleaned.properties && typeof cleaned.properties === "object") {
    const next = {};
    for (const [name, value] of Object.entries(cleaned.properties)) next[name] = sanitizeNode(value);
    cleaned.properties = next;
  }
  if (cleaned.items != null) cleaned.items = sanitizeNode(cleaned.items);
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (Array.isArray(cleaned[key])) cleaned[key] = cleaned[key].map((item) => sanitizeNode(item));
  }
  if (cleaned.properties && typeof cleaned.properties === "object" && Array.isArray(cleaned.required)) {
    cleaned.required = cleaned.required.filter((name) => typeof name === "string" && Object.prototype.hasOwnProperty.call(cleaned.properties, name));
    if (!cleaned.required.length) delete cleaned.required;
  }
  return cleaned;
}

// `jsonSchema` selects the wire field. Gemini takes Google's Schema subset in `parameters`. Claude (served
// through the same endpoint) rejects Gemini-style `parameters` containing anyOf with
// "input_schema: JSON schema is invalid ... draft 2020-12", but accepts a plain JSON Schema in
// `parametersJsonSchema`.
function cleanDeclaration(decl, { jsonSchema = false } = {}) {
  const parameters = decl.parameters || decl.parametersJsonSchema || decl.input_schema || {};
  const cleaned = parameters && typeof parameters === "object" ? sanitizeSchema(parameters) : { type: "object", properties: {} };
  const base = {
    name: sanitizeToolName(String(decl.name || "tool")),
    description: String(decl.description || ""),
  };
  if (!jsonSchema) return { ...base, parameters: cleaned };
  return { ...base, parametersJsonSchema: { type: "object", ...(Object.keys(cleaned).length ? cleaned : { properties: {} }) } };
}

export function sanitizeTools(tools, options = {}) {
  const declarations = [];
  let googleSearch = false;
  for (const tool of tools || []) {
    if (tool.googleSearch != null || tool.google_search != null) {
      googleSearch = true;
      continue;
    }
    if (tool.functionDeclarations || tool.function_declarations) {
      for (const decl of tool.functionDeclarations || tool.function_declarations || []) declarations.push(cleanDeclaration(decl, options));
      continue;
    }
    if (tool.type === "function" && tool.function && typeof tool.function === "object") {
      declarations.push(
        cleanDeclaration(
          {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters || tool.function.parametersJsonSchema,
          },
          options,
        ),
      );
      continue;
    }
    if (tool.name) declarations.push(cleanDeclaration(tool, options));
  }
  if (googleSearch && !declarations.length) return [{ googleSearch: {} }];
  if (declarations.length) return [{ functionDeclarations: declarations }];
  return [];
}
