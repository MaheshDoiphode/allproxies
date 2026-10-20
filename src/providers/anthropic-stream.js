// Shared Anthropic /v1/messages streaming loop for the Gemini-backed providers (Antigravity, Vertex).
//
// Why this exists: VS Code maps any Anthropic `error` SSE event to "Sorry, no response was returned."
// and throws the real message away, and it also shows that text for a message with no usable content.
// So this loop
//   1. retries transparently while nothing has been sent to the client (empty turns such as
//      MALFORMED_FUNCTION_CALL, and transient network failures like ECONNRESET), and
//   2. reports a failure that happens after output started as visible text, never as an `error` event.
// A failure before any output still propagates, so the HTTP layer can answer with a readable error.

export function formatSse(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function* withIdlePings(source, idleMs = 10_000) {
  const iter = source[Symbol.asyncIterator]();
  const pending = [];
  let done = false;
  let fail;
  let notify = null;
  const wake = () => {
    const fn = notify;
    notify = null;
    fn?.();
  };
  const pull = (async () => {
    try {
      while (true) {
        const next = await iter.next();
        if (next.done) break;
        pending.push(next.value);
        wake();
      }
    } catch (err) {
      fail = err;
    } finally {
      done = true;
      wake();
    }
  })();
  try {
    while (!done || pending.length) {
      if (pending.length) {
        yield pending.shift();
        continue;
      }
      if (done) break;
      let timer;
      const pinged = await new Promise((resolve) => {
        if (done || pending.length) {
          resolve(false);
          return;
        }
        notify = () => resolve(false);
        timer = setTimeout(() => {
          notify = null;
          resolve(true);
        }, idleMs);
      });
      clearTimeout(timer);
      if (pinged && !done && !pending.length) {
        yield { __ping: true };
      }
    }
    await pull;
    if (fail) throw fail;
  } finally {
    if (!done) {
      try {
        await iter.return?.();
      } catch {
        // ignore cleanup error
      }
    }
  }
}

const NETWORK_ERROR = /econnreset|econnrefused|etimedout|epipe|socket hang up|network|timed out|terminated|eai_again|und_err|aborted/i;

export function isTransientStreamError(err) {
  if (!err || err.name === "AuthRequiredError" || err.retriedUpstream) return false;
  const status = Number(err.status || 0);
  if (status) return status === 500 || status === 502 || status === 503 || status === 504;
  return NETWORK_ERROR.test(`${err.code || ""} ${err.message || ""} ${err.cause?.code || ""} ${err.cause?.message || ""}`);
}

// Usage: const acc = yield* streamAnthropicMessages({ open, makeAccumulator });
// Returns the accumulator of the attempt that was delivered, so callers can record usage.
//
// Output is held back until the model produces something actionable (visible text or a tool call).
// Thoughts alone don't count: Gemini often streams thoughts and then ends with MALFORMED_FUNCTION_CALL and
// no call, and a turn like that can only be retried if the client hasn't seen the thoughts yet. If the
// model keeps thinking for `holdThoughtsMs`, they are released so long reasoning still streams live.
export async function* streamAnthropicMessages({ open, makeAccumulator, maxAttempts = 3, backoffMs = 400, holdThoughtsMs = 3_000, log }) {
  let acc;
  let held = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    acc = makeAccumulator();
    held = [];
    let opened = false;
    const startedAt = Date.now();
    try {
      for await (const event of withIdlePings(open())) {
        if (event?.__ping) {
          yield formatSse("ping", { type: "ping" });
          continue;
        }
        for (const item of acc.ingest(event)) {
          if (opened) yield formatSse(item.type, item);
          else held.push(item);
        }
        if (
          !opened &&
          (acc.hasVisibleContent ||
            (acc.hasContent &&
              !acc.upstreamFinish &&
              (holdThoughtsMs <= 0 || Date.now() - startedAt >= holdThoughtsMs || acc.seenThoughts.length >= 64)))
        ) {
          opened = true;
          for (const item of held.splice(0)) yield formatSse(item.type, item);
        }
      }
    } catch (err) {
      if (opened) {
        log?.(`stream failed after output started: ${err.message}`);
        for (const item of acc.finish({ error: err })) yield formatSse(item.type, item);
        return acc;
      }
      if (attempt < maxAttempts && isTransientStreamError(err)) {
        log?.(`attempt ${attempt}/${maxAttempts} failed before output (${err.message}); retrying`);
        await sleep(backoffMs * attempt);
        continue;
      }
      throw err;
    }
    if (opened) break;
    if (attempt < maxAttempts) {
      log?.(`attempt ${attempt}/${maxAttempts} produced no output (upstream finishReason: ${acc.upstreamFinish || "none"}); retrying`);
      continue;
    }
  }

  // Either the stream delivered content, or every attempt came back empty. In the latter case the
  // accumulator's finish() turns it into a short visible notice instead of an empty message.
  for (const item of held.splice(0)) yield formatSse(item.type, item);
  if (!acc.started) {
    for (const event of acc.start()) {
      if (event.message) event.message.usage = { ...acc.usage };
      yield formatSse(event.type, event);
    }
  }
  for (const item of acc.finish()) yield formatSse(item.type, item);
  return acc;
}
