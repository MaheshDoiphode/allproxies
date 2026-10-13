import fs from "node:fs";

const p =
  process.argv[2] ||
  "C:/Users/Mahes/AppData/Roaming/Code - Insiders/User/workspaceStorage/7400e33f91b452290c102e9204c06e82/GitHub.copilot-chat/debug-logs/81d564e0-3fe3-4940-8166-85e06c8e0fa3/tools_15.json";
const raw = JSON.parse(fs.readFileSync(p, "utf8"));
const tools = typeof raw.content === "string" ? JSON.parse(raw.content) : Array.isArray(raw) ? raw : raw.tools || raw.content;
console.log("keys", Object.keys(raw).slice(0, 20));
console.log("count", tools.length);
for (let i = 0; i < tools.length; i += 1) {
  const t = tools[i];
  const schema = t.parameters || t.input_schema || {};
  const s = JSON.stringify(schema);
  const flags = [];
  if (s.includes("anyOf")) flags.push("anyOf");
  if (s.includes("oneOf")) flags.push("oneOf");
  if (s.includes("allOf")) flags.push("allOf");
  if (s.includes("prefixItems")) flags.push("prefixItems");
  if (s.includes("nullable")) flags.push("nullable");
  if (s.includes("$schema")) flags.push("$schema");
  if (i < 10 || flags.length) console.log(String(i).padStart(2), t.name, flags.join(",") || "-", s.length);
}
