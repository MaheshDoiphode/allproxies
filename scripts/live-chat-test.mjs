const BASE = process.env.ALLPROXIES_URL || "http://127.0.0.1:8787";
const GAP_MS = Number(process.env.LIVE_TEST_GAP_MS || 2500);

const CASES = [
  { id: "gemini-3.8-flash-high", note: "default recommended / baked high" },
  { id: "gemini-3.8-flash-medium", note: "live effort medium" },
  { id: "gemini-3.8-flash-low", note: "live effort low" },
  { id: "gemini-3.8-flash-high", reasoning_effort: "low", note: "override high id + reasoning_effort low" },
  { id: "gemini-3.7-flash-high", note: "static" },
  { id: "gemini-3.7-flash-medium", note: "live effort" },
  { id: "gemini-3.7-flash-low", note: "live effort" },
  { id: "gemini-3.6-flash-high", note: "static" },
  { id: "gemini-3.6-flash-medium", note: "live effort" },
  { id: "gemini-3.6-flash-low", note: "live effort" },
  { id: "gemini-3-flash", note: "static / command model" },
  { id: "gemini-3.1-flash-lite", note: "static / web" },
  { id: "gemini-3.5-flash-lite", note: "static / mquery" },
  { id: "gemini-pro-agent", note: "3.1 pro high" },
  { id: "gemini-3.1-pro-low", note: "static" },
  { id: "claude-sonnet-4-6", note: "static; live says thinking" },
  { id: "claude-opus-4-6-thinking", note: "static thinking" },
  { id: "claude-opus-4-6-thinking", reasoning_effort: "high", note: "claude reasoning_effort high" },
  { id: "gpt-oss-120b-medium", note: "static", max_tokens: 128 },
  { id: "gemini-3.1-flash-image", note: "image model, one try", max_tokens: 32 },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snippet(value, n = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= n ? text : `${text.slice(0, n)}…`;
}

async function one(testCase) {
  const body = {
    model: testCase.id,
    messages: [{ role: "user", content: "Reply with exactly OK and nothing else." }],
    max_tokens: testCase.max_tokens ?? 256,
    temperature: 0,
  };
  if (testCase.reasoning_effort) body.reasoning_effort = testCase.reasoning_effort;
  const started = Date.now();
  let status = 0;
  let payload = null;
  let raw = "";
  try {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    status = response.status;
    raw = await response.text();
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  } catch (err) {
    return {
      model: testCase.id,
      effort: testCase.reasoning_effort || "",
      note: testCase.note,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: err.message,
    };
  }
  const message = payload?.choices?.[0]?.message || {};
  const error = payload?.error?.message || (status >= 400 ? snippet(raw, 200) : "");
  return {
    model: testCase.id,
    effort: testCase.reasoning_effort || "",
    note: testCase.note,
    ok: status === 200 && !error && (message.content != null || message.reasoning_content),
    status,
    ms: Date.now() - started,
    finish: payload?.choices?.[0]?.finish_reason || "",
    content: snippet(message.content, 80),
    reasoning: snippet(message.reasoning_content, 80),
    usage: payload?.usage || null,
    error: snippet(error, 220),
  };
}

const rows = [];
for (let i = 0; i < CASES.length; i += 1) {
  const row = await one(CASES[i]);
  rows.push(row);
  const label = row.effort ? `${row.model} effort=${row.effort}` : row.model;
  console.log(
    [
      `${i + 1}/${CASES.length}`,
      row.ok ? "OK" : "FAIL",
      `http=${row.status}`,
      `${row.ms}ms`,
      label,
      row.content ? `out=${JSON.stringify(row.content)}` : "",
      row.reasoning ? `think=${JSON.stringify(row.reasoning)}` : "",
      row.usage ? `tok=${row.usage.prompt_tokens}/${row.usage.completion_tokens}/${row.usage.reasoning_tokens || 0}` : "",
      row.error ? `err=${JSON.stringify(row.error)}` : "",
    ]
      .filter(Boolean)
      .join(" | "),
  );
  if (i < CASES.length - 1) await sleep(GAP_MS);
}

const passed = rows.filter((row) => row.ok).length;
console.log(`\nSUMMARY ${passed}/${rows.length} ok`);
for (const row of rows) {
  console.log(
    JSON.stringify({
      model: row.model,
      effort: row.effort || undefined,
      ok: row.ok,
      status: row.status,
      ms: row.ms,
      finish: row.finish || undefined,
      content: row.content || undefined,
      reasoning: row.reasoning || undefined,
      usage: row.usage || undefined,
      error: row.error || undefined,
      note: row.note,
    }),
  );
}
