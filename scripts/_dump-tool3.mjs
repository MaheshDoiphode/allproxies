import fs from "node:fs";
import { sanitizeTools } from "../src/providers/antigravity/schema.js";
import { anthropicToUpstream } from "../src/providers/antigravity/translate.js";

const p =
  "C:/Users/Mahes/AppData/Roaming/Code - Insiders/User/workspaceStorage/7400e33f91b452290c102e9204c06e82/GitHub.copilot-chat/debug-logs/81d564e0-3fe3-4940-8166-85e06c8e0fa3/tools_15.json";
const tools = JSON.parse(JSON.parse(fs.readFileSync(p, "utf8")).content);
const asAnthropic = tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters || { type: "object", properties: {} },
}));
console.log("raw tool 3 name", tools[3].name);
console.log("raw tool 3 schema keys", Object.keys(tools[3].parameters || {}));
console.log(JSON.stringify(tools[3].parameters, null, 2));
console.log("\n--- sanitizeTools jsonSchema=true decl 3 ---");
const claude = sanitizeTools(asAnthropic, { jsonSchema: true })[0].functionDeclarations[3];
console.log(JSON.stringify(claude, null, 2));
console.log("\n--- anthropicToUpstream claude-opus-4-6-thinking decl 3 ---");
const up = anthropicToUpstream(
  { max_tokens: 32, messages: [{ role: "user", content: "hi" }], tools: asAnthropic },
  { model: "claude-opus-4-6-thinking", project: "p" },
);
console.log("upstream model", up.model);
const decls = up.request.tools[0].functionDeclarations;
console.log("decl count", decls.length);
console.log("decl 3 name", decls[3].name);
console.log("has parameters", Boolean(decls[3].parameters));
console.log("has parametersJsonSchema", Boolean(decls[3].parametersJsonSchema));
console.log(JSON.stringify(decls[3], null, 2));
