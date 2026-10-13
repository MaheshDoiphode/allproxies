// Debug: send "hi" + tools to Claude via the proxy; bisect single tools that Anthropic rejects.
import fs from "node:fs";

const [file, model = "claude-opus-4-6-thinking"] = process.argv.slice(2);
const tools = JSON.parse(JSON.parse(fs.readFileSync(file, "utf8")).content).map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters || { type: "object", properties: {} },
}));
globalThis.__tools = tools;

async function ask(subset) {
  const res = await fetch(`http://127.0.0.1:${process.env.PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 32, stream: false, messages: [{ role: "user", content: "say hi" }], tools: subset }),
  });
  return { status: res.status, text: await res.text() };
}

const all = await ask(tools);
console.log(`ALL ${tools.length} tools:`, all.status, all.text.slice(0, 260).replace(/\s+/g, " "));
if (all.status === 200) process.exit(0);
const bad = [];
for (let i = 0; i < tools.length; i += 1) {
  const r = await ask([tools[i]]);
  if (r.status !== 200) bad.push([i, tools[i].name, (r.text.match(/input_schema: [^"\\]+|message\\?":\\?"[^"\\]{0,120}/) || [r.text.slice(0, 120)])[0]]);
}
console.log(`failing single tools: ${bad.length}/${tools.length}`);
for (const b of bad) console.log(b.join(" | "));
