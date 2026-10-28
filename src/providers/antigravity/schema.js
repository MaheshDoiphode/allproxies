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

function sanitizeNode(node, options) {
  if (Array.isArray(node)) return node.map((item) => (item && typeof item === "object" ? sanitizeSchema(item, options) : item));
  if (!node || typeof node !== "object") return node;
  return sanitizeSchema(node, options);
}

export function sanitizeSchema(node, { jsonSchema = false } = {}) {
  if (Array.isArray(node)) return node.map((item) => (item && typeof item === "object" ? sanitizeSchema(item, { jsonSchema }) : item));
  if (!node || typeof node !== "object") return node;
  let current = node;
  const cleaned = {};
  // Match Google's js-genai processJsonSchema for Gemini `parameters`: collapse 2-element anyOf [T, null]
  // into nullable: true + T, and flatten type: ["string", "null"] into type: "string", nullable: true.
  if (!jsonSchema && Array.isArray(current.anyOf) && current.anyOf.length === 2) {
    const firstNull = current.anyOf[0] && current.anyOf[0].type === "null";
    const secondNull = current.anyOf[1] && current.anyOf[1].type === "null";
    if (firstNull || secondNull) {
      cleaned.nullable = true;
      const other = firstNull ? current.anyOf[1] : current.anyOf[0];
      if (other && typeof other === "object") {
        const { anyOf: _drop, ...rest } = current;
        current = { ...rest, ...other };
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(current, "const") && current.const !== undefined) {
    cleaned.enum = [current.const];
  }
  for (const [key, value] of Object.entries(current)) {
    if (key === "const") continue;
    if (DROP_KEYS.has(key) || key.startsWith("$") || !KEEP_KEYS.has(key)) continue;
    cleaned[key] = value;
  }
  if (!jsonSchema && Array.isArray(cleaned.type)) {
    const types = cleaned.type.filter((t) => typeof t === "string");
    if (types.includes("null")) cleaned.nullable = true;
    const nonNull = types.filter((t) => t !== "null");
    if (nonNull.length === 1) {
      cleaned.type = nonNull[0];
    } else if (nonNull.length > 1) {
      delete cleaned.type;
      cleaned.anyOf = nonNull.map((t) => ({ type: t }));
    } else {
      delete cleaned.type;
    }
  }
  if (!jsonSchema && cleaned.type && cleaned.anyOf) {
    delete cleaned.type;
  }
  if (cleaned.properties && typeof cleaned.properties === "object") {
    const next = {};
    for (const [name, value] of Object.entries(cleaned.properties)) next[name] = sanitizeNode(value, { jsonSchema });
    cleaned.properties = next;
  }
  if (cleaned.items != null) cleaned.items = sanitizeNode(cleaned.items, { jsonSchema });
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (Array.isArray(cleaned[key])) {
      if (jsonSchema) {
        cleaned[key] = cleaned[key].map((item) => sanitizeNode(item, { jsonSchema }));
        continue;
      }
      const items = [];
      for (const item of cleaned[key]) {
        if (item && typeof item === "object" && item.type === "null") {
          cleaned.nullable = true;
          continue;
        }
        items.push(sanitizeNode(item, { jsonSchema }));
      }
      if (items.length === 1 && key === "anyOf" && items[0] && typeof items[0] === "object") {
        delete cleaned.anyOf;
        Object.assign(cleaned, items[0]);
      } else if (items.length) {
        cleaned[key] = items;
      } else {
        delete cleaned[key];
      }
    }
  }
  if (cleaned.properties && typeof cleaned.properties === "object" && Array.isArray(cleaned.required)) {
    cleaned.required = cleaned.required.filter((name) => typeof name === "string" && Object.prototype.hasOwnProperty.call(cleaned.properties, name));
    if (!cleaned.required.length) delete cleaned.required;
  }
  return cleaned;
}

function ensureObjectSchema(schema) {
  const next = schema && typeof schema === "object" && !Array.isArray(schema) ? { ...schema } : {};
  if (!next.type || String(next.type).toLowerCase() !== "object") {
    next.type = "object";
  }
  if (!next.properties || typeof next.properties !== "object" || Array.isArray(next.properties)) {
    next.properties = {};
  }
  return next;
}

// `jsonSchema` selects the wire field. Gemini takes Google's Schema subset in `parameters`. Claude (served
// through the same endpoint) rejects Gemini-style `parameters` containing anyOf with
// "input_schema: JSON schema is invalid ... draft 2020-12", but accepts a plain JSON Schema in
// `parametersJsonSchema`.
function cleanDeclaration(decl, { jsonSchema = false } = {}) {
  const isAnthropicWebSearch = typeof decl.type === "string" && /^web_search/i.test(decl.type);
  const rawParams = decl.parameters || decl.parametersJsonSchema || decl.input_schema || (
    isAnthropicWebSearch
      ? {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query to execute." },
          },
          required: ["query"],
        }
      : {}
  );
  const cleaned = ensureObjectSchema(rawParams && typeof rawParams === "object" ? sanitizeSchema(rawParams, { jsonSchema }) : {});
  const base = {
    name: sanitizeToolName(String(decl.name || (isAnthropicWebSearch ? "web_search" : "tool"))),
    description: String(decl.description || (isAnthropicWebSearch ? "Search the web for current information." : "")),
  };
  if (!jsonSchema) return { ...base, parameters: cleaned };
  return { ...base, parametersJsonSchema: cleaned };
}

export function sanitizeTools(tools, options = {}) {
  const declarations = [];
  let googleSearch = false;
  for (const tool of tools || []) {
    if (!tool || typeof tool !== "object") continue;
    if (
      tool.googleSearch != null ||
      tool.google_search != null ||
      (typeof tool.type === "string" && /^web_search/i.test(tool.type))
    ) {
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
