import assert from "node:assert/strict";
import test from "node:test";
import { isTransientStreamError, streamAnthropicMessages, streamOpenaiChatCompletions } from "../src/providers/anthropic-stream.js";
import { AnthropicStreamAccumulator, StreamAccumulator } from "../src/providers/antigravity/translate.js";

const chunk = (parts, finishReason) => ({ response: { candidates: [{ content: { role: "model", parts }, finishReason }] } });

async function run(opens, options = {}) {
  let call = 0;
  const out = [];
  const gen = streamAnthropicMessages({
    open: () => opens[Math.min(call++, opens.length - 1)](),
    makeAccumulator: () => new AnthropicStreamAccumulator("m"),
    backoffMs: 1,
    ...options,
  });
  for await (const item of gen) out.push(item);
  return { text: out.join(""), calls: call };
}

async function* events(...items) {
  for (const item of items) yield item;
}

async function* failing(message, ...before) {
  for (const item of before) yield item;
  throw new Error(message);
}

test("transient network failure before any output is retried transparently", async () => {
  const { text, calls } = await run([
    () => failing("read ECONNRESET"),
    () => events(chunk([{ text: "hello" }], "STOP")),
  ]);
  assert.equal(calls, 2);
  assert.match(text, /"text":"hello"/);
  assert.doesNotMatch(text, /event: error/);
});

test("empty turns (MALFORMED_FUNCTION_CALL) are retried before the client sees anything", async () => {
  const { text, calls } = await run([
    () => events(chunk([], "MALFORMED_FUNCTION_CALL")),
    () => events(chunk([{ functionCall: { name: "shot", args: {}, id: "c1" } }])),
  ]);
  assert.equal(calls, 2);
  assert.match(text, /"type":"tool_use"/);
  assert.equal(text.match(/event: message_start/g).length, 1);
});

test("a turn that stays empty ends with a visible notice, never an empty message", async () => {
  const { text, calls } = await run([() => events(chunk([], "MALFORMED_FUNCTION_CALL"))]);
  assert.equal(calls, 3);
  assert.match(text, /MALFORMED_FUNCTION_CALL/);
  assert.match(text, /content_block_start/);
});

test("whitespace-only text is treated as no output", async () => {
  const { text } = await run([() => events(chunk([{ text: "\n" }], "STOP"))], { maxAttempts: 1 });
  assert.match(text, /no output/);
});

test("thoughts followed by MALFORMED_FUNCTION_CALL are retried without the client seeing the dead thoughts", async () => {
  const { text, calls } = await run([
    () => events(chunk([{ text: "plan the call", thought: true }]), chunk([{ text: "" }], "MALFORMED_FUNCTION_CALL")),
    () => events(chunk([{ functionCall: { name: "shot", args: {}, id: "c1" } }])),
  ]);
  assert.equal(calls, 2);
  assert.match(text, /"type":"tool_use"/);
  assert.doesNotMatch(text, /plan the call/);
});

test("thoughts that never lead to an action end with the real finish reason, not an echo of the thoughts", async () => {
  const { text } = await run([
    () => events(chunk([{ text: "plan the call", thought: true }]), chunk([{ text: "" }], "MALFORMED_FUNCTION_CALL")),
  ]);
  assert.match(text, /MALFORMED_FUNCTION_CALL/);
});

test("long thinking is released to the client after the hold window", async () => {
  const { text } = await run(
    [() => events(chunk([{ text: "deep thought", thought: true }]), chunk([{ text: "answer" }], "STOP"))],
    { holdThoughtsMs: 0 },
  );
  assert.match(text, /deep thought/);
  assert.match(text, /answer/);
});

test("failure after output started is visible text, not an error event", async () => {
  const { text, calls } = await run([() => failing("read ECONNRESET", chunk([{ text: "partial answer" }]))]);
  assert.equal(calls, 1);
  assert.doesNotMatch(text, /event: error/);
  assert.match(text, /read ECONNRESET/);
  assert.match(text, /event: message_stop/);
});

test("non-transient failures before output still propagate so the HTTP layer can report them", async () => {
  const err = Object.assign(new Error("bad request"), { status: 400 });
  await assert.rejects(
    run([
      () => {
        throw err;
      },
    ]),
    /bad request/,
  );
});

test("slow upstream failure before output does not emit premature ping SSE events that swallow the HTTP error", async () => {
  const err = Object.assign(new Error("Resource exhausted"), { status: 429 });
  await assert.rejects(
    run([
      async function* () {
        await new Promise((r) => setTimeout(r, 20));
        throw err;
      },
    ]),
    /Resource exhausted/,
  );
});

test("transient error classification", () => {
  assert.equal(isTransientStreamError(new Error("read ECONNRESET")), true);
  assert.equal(isTransientStreamError(new Error("Request timed out after 180000ms")), true);
  assert.equal(isTransientStreamError(Object.assign(new Error("x"), { status: 503 })), true);
  assert.equal(isTransientStreamError(Object.assign(new Error("x"), { status: 400 })), false);
  assert.equal(isTransientStreamError(Object.assign(new Error("x"), { status: 429 })), false);
  assert.equal(isTransientStreamError(new TypeError("cannot read properties of undefined")), false);
});

test("openai chatCompletionsStream retries empty turns and never emits empty choices", async () => {
  let call = 0;
  const opens = [
    () => events(chunk([], "MALFORMED_RESPONSE")),
    () => events(chunk([{ text: "recovered choice" }], "STOP")),
  ];
  const out = [];
  for await (const item of streamOpenaiChatCompletions({
    open: () => opens[Math.min(call++, opens.length - 1)](),
    makeAccumulator: () => new StreamAccumulator("m"),
    backoffMs: 1,
  })) {
    out.push(item);
  }
  const text = out.join("");
  assert.equal(call, 2);
  assert.match(text, /"content":"recovered choice"/);
  assert.match(text, /data: \[DONE\]/);
});

