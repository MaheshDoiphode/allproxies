import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
  CHATGPT_OAUTH_SCOPE,
} from "../src/core/chatgpt-constants.js";
import { parseChatgptModels } from "../src/providers/chatgpt/catalog.js";
import {
  buildChatgptAuthUrl,
  chatgptAuthFromJwt,
  chatgptBundleFromTokens,
  decodeJwt,
  setChatgptOAuthRequest,
  refreshChatgptToken,
} from "../src/providers/chatgpt/oauth.js";
import { quotasFromWhamUsage } from "../src/providers/chatgpt/quota.js";
import {
  chatToChatgptResponses,
  chatgptUsageToAnthropic,
  chatgptUsageToOpenai,
  messagesToChatgptResponses,
  normalizeChatgptResponsesBody,
  responsesOutputToAnthropic,
  responsesOutputToOpenai,
} from "../src/providers/chatgpt/translate.js";

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "chatgpt-live.json"), "utf8"),
);

function fakeJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

test("chatgpt auth url uses public Codex client and localhost:1455", () => {
  const url = new URL(buildChatgptAuthUrl({ state: "st", codeChallenge: "ch" }));
  assert.equal(url.origin, "https://auth.openai.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), CHATGPT_OAUTH_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), CHATGPT_OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get("scope"), CHATGPT_OAUTH_SCOPE);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("id_token_add_organizations"), "true");
  assert.equal(url.searchParams.get("codex_cli_simplified_flow"), "true");
  assert.match(CHATGPT_OAUTH_REDIRECT_URI, /localhost:1455\/auth\/callback/);
});

test("jwt decode reads chatgpt account claims", () => {
  const token = fakeJwt({
    email: "user@example.com",
    exp: 4_000_000_000,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct-1",
      chatgpt_plan_type: "plus",
      chatgpt_account_is_fedramp: false,
    },
  });
  assert.equal(decodeJwt(token).email, "user@example.com");
  const auth = chatgptAuthFromJwt(token);
  assert.equal(auth.email, "user@example.com");
  assert.equal(auth.account_id, "acct-1");
  assert.equal(auth.plan, "plus");
  const bundle = chatgptBundleFromTokens({
    access_token: token,
    refresh_token: "rt",
    id_token: token,
    expires_in: 3600,
  });
  assert.equal(bundle.account_id, "acct-1");
  assert.equal(bundle.project_id, "acct-1");
  assert.equal(bundle.plan, "plus");
});

test("refresh posts JSON grant_type refresh_token", async () => {
  let seen;
  setChatgptOAuthRequest(async (url, options) => {
    seen = { url, options };
    return {
      status: 200,
      body: "{}",
      parsed: {
        access_token: fakeJwt({ email: "user@example.com", exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "free" } }),
        refresh_token: "rt2",
        expires_in: 3600,
      },
    };
  });
  try {
    const next = await refreshChatgptToken({ refresh_token: "rt1", email: "user@example.com" });
    assert.equal(seen.options.json.grant_type, "refresh_token");
    assert.equal(seen.options.json.client_id, CHATGPT_OAUTH_CLIENT_ID);
    assert.equal(seen.options.form, undefined);
    assert.equal(next.refresh_token, "rt2");
    assert.equal(next.account_id, "acct-1");
  } finally {
    setChatgptOAuthRequest(null);
  }
});

test("wham usage fixture maps monthly window", () => {
  const quotas = quotasFromWhamUsage(FIXTURE);
  assert.ok(quotas.length >= 1);
  assert.equal(quotas[0].window, "monthly");
  assert.equal(quotas[0].used, 0);
  assert.equal(quotas[0].remaining, 1);
});

test("public catalog hides visibility=hide models", () => {
  const models = parseChatgptModels(FIXTURE);
  const ids = models.map((item) => item.id);
  assert.ok(ids.includes("gpt-5.6-terra"));
  assert.ok(ids.includes("gpt-5.6-luna"));
  assert.ok(!ids.includes("gpt-reserve"));
  assert.ok(!ids.includes("gpt-5.5"));
  assert.ok(!ids.includes("codex-auto-review"));
  assert.equal(models.find((item) => item.id === "gpt-5.6-terra").use_responses_lite, true);
});

test("lite normalize moves tools and drops max_output_tokens", () => {
  const body = normalizeChatgptResponsesBody(
    {
      model: "gpt-5.6-terra",
      input: "ping",
      tools: [{ type: "function", name: "echo", parameters: { type: "object" } }],
      instructions: "be brief",
      max_output_tokens: 64,
    },
    { modelInfo: { use_responses_lite: true, default_reasoning_level: "medium", support_verbosity: true, default_verbosity: "low" }, forceStream: true },
  );
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "");
  assert.equal(body.max_output_tokens, undefined);
  assert.equal(body.tools, undefined);
  assert.equal(body.input[0].type, "additional_tools");
  assert.equal(body.reasoning.context, "all_turns");
  assert.equal(body.reasoning.effort, "medium");
  assert.equal(body.include.includes("reasoning.encrypted_content"), true);
});

test("chat and messages convert into responses input", () => {
  const chat = chatToChatgptResponses(
    { messages: [{ role: "user", content: "ping" }], stream: true },
    { model: "gpt-5.6-terra", modelInfo: { use_responses_lite: true } },
  );
  assert.equal(chat.model, "gpt-5.6-terra");
  assert.equal(chat.input.at(-1).content[0].text, "ping");
  const messages = messagesToChatgptResponses(
    { model: "gpt-5.6-terra", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { model: "gpt-5.6-terra", modelInfo: { use_responses_lite: true } },
  );
  assert.equal(messages.input.at(-1).content[0].text, "hi");
});

test("usage maps cached and reasoning tokens", () => {
  const usage = {
    input_tokens: 15,
    output_tokens: 5,
    total_tokens: 20,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 2 },
  };
  const openai = chatgptUsageToOpenai(usage);
  assert.equal(openai.prompt_tokens, 15);
  assert.equal(openai.cached_tokens, 3);
  assert.equal(openai.reasoning_tokens, 2);
  const anthropic = chatgptUsageToAnthropic(usage);
  assert.equal(anthropic.cache_read_input_tokens, 3);
  assert.equal(anthropic.output_tokens_details.thinking_tokens, 2);
  const completed = {
    id: "resp_1",
    model: "gpt-5.6-terra",
    created_at: 1,
    usage,
    output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }],
  };
  assert.equal(responsesOutputToOpenai(completed, "gpt-5.6-terra").choices[0].message.content, "pong");
  assert.equal(responsesOutputToAnthropic(completed, "gpt-5.6-terra").content[0].text, "pong");
});
