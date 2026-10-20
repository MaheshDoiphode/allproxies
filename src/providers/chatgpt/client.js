import crypto from "node:crypto";
import {
  CHATGPT_CODEX_BASE_URL,
  CHATGPT_CODEX_VERSION,
  CHATGPT_USAGE_URL,
  CHATGPT_USER_AGENT,
} from "../../core/chatgpt-constants.js";
import { AuthRequiredError, HttpError, OAuthError, UpstreamError } from "../../core/errors.js";
import { formatIst } from "../../core/time.js";
import { iterateSse, request, requestJson } from "../../http/request.js";
import { ResponseStore } from "../antigravity/responses-store.js";
import { chatgptModelMeta, parseChatgptModels } from "./catalog.js";
import {
  buildChatgptAuthUrl,
  chatgptAuthFromJwt,
  exchangeChatgptCode,
  generatePkce,
  openBrowser,
  refreshChatgptToken,
  startChatgptCallbackServer,
} from "./oauth.js";
import { quotasFromWhamUsage, isChatgptQuotaPayload } from "./quota.js";
import {
  TokenStore,
  accountIdOf,
  chatgptAccountIdOf,
  cooldownUntil,
  createChatgptBundle,
  disableAccount,
  hydrateChatgptBundle,
  isAccountDisabled,
  isExpired,
  isRetryableUpstreamError,
  projectOf,
  setAccountEnabled,
  touchAccountStats,
  addUsageStats,
} from "./tokens.js";
import {
  ChatgptResponsesStreamAccumulator,
  chatToChatgptResponses,
  chatgptUsageToAnthropic,
  chatgptUsageToOpenai,
  messagesToChatgptResponses,
  normalizeChatgptResponsesBody,
  openaiToResponses,
  responsesOutputToAnthropic,
  responsesOutputToOpenai,
  responsesToChatBody,
} from "./translate.js";

function joinUrl(base, pathname) {
  return `${String(base).replace(/\/$/, "")}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function formatSse(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function anthropicErrorEvent(err) {
  return formatSse("error", {
    type: "error",
    error: {
      type: err?.payload?.error?.type || err?.name || "api_error",
      message: err?.message || "upstream stream failed",
    },
  });
}

async function* withIdlePings(source, idleMs = 10_000) {
  const pending = [];
  let done = false;
  let fail;
  let last = Date.now();
  const pull = (async () => {
    try {
      for await (const event of source) pending.push(event);
    } catch (err) {
      fail = err;
    } finally {
      done = true;
    }
  })();
  while (!done || pending.length) {
    if (pending.length) {
      last = Date.now();
      yield pending.shift();
      continue;
    }
    if (Date.now() - last >= idleMs) {
      last = Date.now();
      yield { __ping: true };
    }
    await sleep(200);
  }
  await pull;
  if (fail) throw fail;
}

export class ChatgptClient {
  constructor(settings, { store } = {}) {
    this.settings = settings;
    this.store = store || new TokenStore(settings.chatgptTokenPath || settings.tokenPath);
    this.responseStore = new ResponseStore(this.store.path);
    this.refreshLock = Promise.resolve();
    this.modelsCache = { at: 0, models: [], raw: null };
    this.modelsTtlMs = 60_000;
    this.catalog = { at: 0, error: null, listed: 0, reason: "none" };
    this.quotaCache = new Map();
    this.quotaTtlMs = 30_000;
    this.stats = { requests: 0, success: 0, failed: 0, prompt_tokens: 0, completion_tokens: 0 };
  }

  usageStats() {
    return this.accounts().reduce((sum, bundle) => addUsageStats(sum, {
      requests: bundle.request_count,
      success: bundle.success_count,
      failed: bundle.error_count,
      prompt_tokens: bundle.prompt_tokens,
      completion_tokens: bundle.completion_tokens,
    }), this.store.lifetimeStats());
  }

  catalogReason() {
    const now = Date.now();
    const accounts = this.accounts();
    if (!accounts.length) return "none";
    if (accounts.some((item) => !isAccountDisabled(item, now))) return "ready";
    return "disabled";
  }

  catalogStatus() {
    return {
      provider: "chatgpt",
      at: this.catalog.at || 0,
      error: this.catalog.error || null,
      listed: this.catalog.listed ?? this.modelsCache?.models?.length ?? 0,
      reason: this.catalog.reason || this.catalogReason(),
    };
  }

  rememberCatalog({ models = null, error = null, reason } = {}) {
    const now = Date.now();
    const list = Array.isArray(models) ? models : this.modelsCache?.models || [];
    this.modelsCache = { at: now, models: list, raw: this.modelsCache?.raw || null };
    this.catalog = {
      at: now,
      error: error ? String(error.message || error).slice(0, 400) : null,
      listed: list.length,
      reason: reason || this.catalogReason(),
    };
    return list;
  }

  get baseUrl() {
    return String(this.settings.chatgptBaseUrl || CHATGPT_CODEX_BASE_URL).replace(/\/$/, "");
  }

  get usageUrl() {
    return this.settings.chatgptUsageUrl || CHATGPT_USAGE_URL;
  }

  modelsUrl() {
    return `${joinUrl(this.baseUrl, "/models")}?client_version=${encodeURIComponent(CHATGPT_CODEX_VERSION)}`;
  }

  responsesUrl() {
    return joinUrl(this.baseUrl, "/responses");
  }

  accounts() {
    return this.store.list().map((item) => this.hydrate(item));
  }

  activeAccount() {
    return this.hydrate(this.store.load());
  }

  hydrate(bundle) {
    if (!bundle) return null;
    const packed = hydrateChatgptBundle(bundle);
    return hydrateChatgptBundle(packed, chatgptAuthFromJwt(packed.id_token || packed.access_token));
  }

  accountSummary(bundle, now = Date.now()) {
    if (!bundle) return null;
    const hydrated = hydrateChatgptBundle(bundle, chatgptAuthFromJwt(bundle.id_token || bundle.access_token));
    const limited = Number(hydrated.disabled_until || 0) > now;
    const disabled = isAccountDisabled(hydrated, now);
    return {
      id: accountIdOf(hydrated),
      email: hydrated.email || null,
      project: chatgptAccountIdOf(hydrated),
      provider: "chatgpt",
      plan: hydrated.plan || null,
      expired: isExpired(hydrated),
      enabled: hydrated.enabled !== false,
      disabled,
      limited,
      disabled_until: limited ? hydrated.disabled_until : null,
      disabled_reason: limited || hydrated.enabled === false ? hydrated.disabled_reason : null,
      active: accountIdOf(this.store.load()) === accountIdOf(hydrated),
      last_used: hydrated.last_used || 0,
      request_count: hydrated.request_count || 0,
      success_count: hydrated.success_count || 0,
      error_count: hydrated.error_count || 0,
      prompt_tokens: hydrated.prompt_tokens || 0,
      completion_tokens: hydrated.completion_tokens || 0,
      quotas: hydrated.quotas || [],
      quotas_at: hydrated.quotas_at || 0,
    };
  }

  findAccount(id) {
    const wanted = String(id || "").trim().toLowerCase();
    return this.accounts().find((item) => accountIdOf(item) === wanted || String(item.email || "").toLowerCase() === wanted) || null;
  }

  setEnabled(id, enabled) {
    const match = this.findAccount(id);
    if (!match) throw new AuthRequiredError(`No saved ChatGPT account matching ${id}`);
    const next = setAccountEnabled(match, enabled);
    this.store.save(createChatgptBundle(next), { activate: enabled });
    if (enabled) this.store.use(accountIdOf(next));
    else if (accountIdOf(this.store.load()) === accountIdOf(next)) {
      const ready = this.accounts().find((item) => !isAccountDisabled(item) && accountIdOf(item) !== accountIdOf(next));
      if (ready) this.store.use(accountIdOf(ready));
    }
    return this.findAccount(id);
  }

  recordUsage(bundle, { ok = true, prompt = 0, completion = 0 } = {}) {
    const current = (bundle && this.findAccount(accountIdOf(bundle))) || bundle || this.store.load();
    if (!current) return;
    this.stats.requests += 1;
    if (ok) this.stats.success += 1;
    else this.stats.failed += 1;
    this.stats.prompt_tokens += Number(prompt || 0);
    this.stats.completion_tokens += Number(completion || 0);
    this.store.save(createChatgptBundle(touchAccountStats(current, { ok, prompt, completion })), { activate: false });
  }

  headers(bundle, { lite = false } = {}) {
    const headers = {
      Authorization: `Bearer ${bundle.access_token}`,
      "User-Agent": CHATGPT_USER_AGENT,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const accountId = chatgptAccountIdOf(bundle);
    if (accountId) headers["chatgpt-account-id"] = accountId;
    if (bundle.is_fedramp) headers["X-OpenAI-Fedramp"] = "true";
    if (lite) headers["x-openai-internal-codex-responses-lite"] = "true";
    return headers;
  }

  async completeLogin({ code, codeVerifier, redirectUri, warm = true } = {}) {
    const bundle = await exchangeChatgptCode({
      code,
      codeVerifier,
      redirectUri,
      timeoutMs: this.settings.requestTimeoutMs,
    });
    bundle.enabled = true;
    this.store.save(createChatgptBundle(bundle));
    this.rememberCatalog({ models: [], reason: "ready" });
    const saved = this.store.load();
    if (warm) this.warmAccount(saved).catch(() => {});
    return hydrateChatgptBundle(saved, chatgptAuthFromJwt(saved?.id_token || saved?.access_token));
  }

  async warmAccount(bundle) {
    if (!bundle?.refresh_token) return bundle;
    let current = hydrateChatgptBundle(bundle, chatgptAuthFromJwt(bundle.id_token || bundle.access_token));
    if (isExpired(current)) {
      try {
        current = await this.refreshStoredToken(current);
      } catch {
        // keep stored tokens
      }
    }
    try {
      await this.fetchQuotasFor(current, { force: true });
    } catch {
      // cached/empty quotas are fine
    }
    try {
      await this.refreshLiveModels();
    } catch {
      // catalog can wait
    }
    return this.findAccount(accountIdOf(current)) || current;
  }

  requireBundle({ exclude = [] } = {}) {
    const now = Date.now();
    const skip = new Set([...exclude].map((id) => String(id || "").toLowerCase()).filter(Boolean));
    const accounts = this.accounts();
    const current = this.activeAccount();
    const usable = (item) => item?.refresh_token && !isAccountDisabled(item, now) && !skip.has(accountIdOf(item));
    if (usable(current) && projectOf(current)) return current;
    const ready = accounts
      .filter((item) => usable(item) && projectOf(item))
      .sort((a, b) => (a.last_used || 0) - (b.last_used || 0));
    if (ready[0]) {
      if (!current || accountIdOf(ready[0]) !== accountIdOf(current)) {
        this.store.use(accountIdOf(ready[0]));
        if (this.settings.debugRequests) {
          console.log(`[chatgpt] using ${ready[0].email || accountIdOf(ready[0])}`);
        }
      }
      return ready[0];
    }
    if (usable(current)) return current;
    const any = accounts.find(usable);
    if (any) {
      this.store.use(accountIdOf(any));
      return any;
    }
    if (!current?.refresh_token && !accounts.length) {
      throw new AuthRequiredError("ChatGPT login required. Run: node src/cli.js login-chatgpt");
    }
    const soonest = accounts
      .filter((item) => item?.refresh_token && Number(item.disabled_until || 0) > now)
      .sort((a, b) => Number(a.disabled_until || 0) - Number(b.disabled_until || 0))[0];
    const until = soonest?.disabled_until ? formatIst(soonest.disabled_until) : "later";
    throw new AuthRequiredError(`All ChatGPT accounts are rate-limited until ${until}. Add another from the dashboard or: node src/cli.js login-chatgpt`);
  }

  async ensureToken({ exclude = [] } = {}) {
    let bundle = this.requireBundle({ exclude });
    if (!isExpired(bundle)) return bundle;
    let release;
    const wait = this.refreshLock;
    this.refreshLock = new Promise((resolve) => {
      release = resolve;
    });
    await wait;
    try {
      const skip = [...exclude];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        bundle = this.requireBundle({ exclude: skip });
        if (!isExpired(bundle)) return bundle;
        try {
          const refreshed = await refreshChatgptToken(bundle, this.settings.requestTimeoutMs);
          this.store.save(createChatgptBundle(refreshed));
          return this.findAccount(accountIdOf(refreshed)) || this.store.load();
        } catch (err) {
          if (!(err instanceof OAuthError)) throw err;
          this.markFailed(bundle, err);
          skip.push(accountIdOf(bundle));
        }
      }
      throw new AuthRequiredError("ChatGPT login required. Run: node src/cli.js login-chatgpt");
    } finally {
      release();
    }
  }

  async login({ openUrl = true } = {}) {
    const { verifier, challenge } = generatePkce();
    const state = generatePkce().verifier;
    const { ready, code: codePromise } = startChatgptCallbackServer(state);
    await ready;
    const url = buildChatgptAuthUrl({ state, codeChallenge: challenge });
    if (openUrl) openBrowser(url);
    console.log(`Open this URL if the browser did not launch:\n${url}\n`);
    const code = await codePromise;
    const saved = await this.completeLogin({
      code,
      codeVerifier: verifier,
      redirectUri: undefined,
      warm: false,
    });
    return this.warmAccount(saved);
  }

  async switchAccount(id) {
    const match = this.store.use(id);
    if (!match) throw new AuthRequiredError(`No saved ChatGPT account matching ${id}`);
    this.modelsCache = { at: 0, models: [], raw: null };
    return match;
  }

  async removeAccount(id) {
    const ok = this.store.remove(id);
    if (!ok) throw new AuthRequiredError(`No saved ChatGPT account matching ${id}`);
    this.modelsCache = { at: 0, models: [], raw: null };
    return this.accounts();
  }

  markFailed(bundle, err) {
    const reason = String(err?.code || err?.message || "upstream").slice(0, 180);
    const disabled = disableAccount(bundle, { until: cooldownUntil(err), reason });
    this.store.save(createChatgptBundle(disabled), { activate: false });
    const next = this.accounts()
      .filter((item) => item.refresh_token && !isAccountDisabled(item) && accountIdOf(item) !== accountIdOf(disabled))
      .sort((a, b) => (a.last_used || 0) - (b.last_used || 0))[0];
    if (next) {
      this.store.use(accountIdOf(next));
      this.modelsCache = { at: 0, models: [], raw: null };
      if (this.settings.debugRequests) {
        console.log(`[chatgpt] rotate ${bundle.email || accountIdOf(bundle)} -> ${next.email || accountIdOf(next)} (${reason})`);
      }
    }
    return next || null;
  }

  enableAccount(id) {
    return this.setEnabled(id, true);
  }

  async readyBundle({ exclude = [] } = {}) {
    return this.ensureToken({ exclude });
  }

  raiseUpstream(response) {
    let message = response.body || "";
    let code;
    const payload = response.parsed;
    if (payload && typeof payload === "object") {
      if (payload.error && typeof payload.error === "object") {
        message = String(payload.error.message || message);
        code = payload.error.status || payload.error.code;
      } else if (payload.message) {
        message = String(payload.message);
      }
    }
    if (isChatgptQuotaPayload(payload) && !message) message = "ChatGPT rate limit reached";
    throw new UpstreamError(response.status, message, code ? String(code) : undefined);
  }

  async post(url, payload, { stream = false, lite = false } = {}) {
    const tried = new Set();
    let lastError;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let bundle;
      try {
        bundle = await this.ensureToken({ exclude: tried });
      } catch (err) {
        lastError = err;
        break;
      }
      const id = accountIdOf(bundle);
      if (tried.has(id)) break;
      tried.add(id);
      let response;
      try {
        response = await this.send(url, payload, bundle, { stream, lite });
      } catch (err) {
        lastError = err;
        this.recordUsage(bundle, { ok: false });
        if (isRetryableUpstreamError(err) && this.markFailed(bundle, err)) continue;
        throw err;
      }
      if (response.status === 401) {
        if (stream && response.stream) response.stream.resume();
        const current = this.findAccount(id);
        if (current) {
          current.expires_at = 0;
          this.store.save(createChatgptBundle(current), { activate: false });
        }
        try {
          bundle = await this.ensureToken({ exclude: [...tried].filter((item) => item !== id) });
          if (accountIdOf(bundle) === id) {
            response = await this.send(url, payload, bundle, { stream, lite });
          } else {
            tried.delete(id);
            continue;
          }
        } catch (err) {
          lastError = err;
          this.recordUsage(this.findAccount(id) || bundle, { ok: false });
          if (isRetryableUpstreamError(err) && this.markFailed(this.findAccount(id) || bundle, err)) continue;
          throw err;
        }
      }
      if (response.status < 400) return response;
      if (stream && response.stream) {
        const chunks = [];
        for await (const chunk of response.stream) chunks.push(chunk);
        response.body = Buffer.concat(chunks).toString("utf8");
        try {
          response.parsed = JSON.parse(response.body);
        } catch {
          response.parsed = undefined;
        }
      }
      try {
        this.raiseUpstream(response);
      } catch (err) {
        lastError = err;
        this.recordUsage(bundle, { ok: false });
        if (isRetryableUpstreamError(err) && this.markFailed(bundle, err)) continue;
        throw err;
      }
    }
    throw lastError || new AuthRequiredError("ChatGPT login required. Run: node src/cli.js login-chatgpt");
  }

  send(url, payload, bundle, { stream = false, lite = false } = {}) {
    const body = JSON.stringify(payload);
    const headers = this.headers(bundle, { lite });
    headers["Content-Length"] = Buffer.byteLength(body);
    return request(url, {
      method: "POST",
      headers,
      body,
      timeoutMs: this.settings.requestTimeoutMs,
      stream,
    });
  }

  async fetchModels({ refresh = false } = {}) {
    const now = Date.now();
    const reason = this.catalogReason();
    if (reason !== "ready") {
      return this.rememberCatalog({ models: [], reason });
    }
    if (!refresh && this.modelsCache?.models?.length && now - this.modelsCache.at < this.modelsTtlMs) {
      return this.modelsCache.models;
    }
    if (!this.settings.liveModels) return this.modelsCache.models || [];
    if (!refresh && this.modelsCache?.models?.length) {
      this.refreshLiveModels().catch(() => {});
      return this.modelsCache.models;
    }
    return this.refreshLiveModels();
  }

  async refreshLiveModels() {
    const reason = this.catalogReason();
    if (reason !== "ready") {
      return this.rememberCatalog({ models: [], reason });
    }
    const now = Date.now();
    try {
      const bundle = await this.ensureToken();
      const response = await requestJson(this.modelsUrl(), {
        method: "GET",
        headers: this.headers(bundle),
        timeoutMs: Math.min(this.settings.requestTimeoutMs, 15_000),
      });
      if (response.status >= 400) {
        return this.rememberCatalog({ models: this.modelsCache.models || [], reason: "ready", error: new Error(response.body || `ChatGPT models ${response.status}`) });
      }
      const models = parseChatgptModels(response.parsed || {});
      this.modelsCache = { at: now, models, raw: response.parsed || {} };
      return this.rememberCatalog({ models, reason: "ready" });
    } catch (err) {
      return this.rememberCatalog({ models: this.modelsCache.models || [], reason: this.catalogReason(), error: err });
    }
  }

  modelInfoFor(slug) {
    return chatgptModelMeta(this.modelsCache.raw, slug) || this.modelsCache.models.find((item) => item.id === slug) || null;
  }

  resolveRequestModelSync(body) {
    const requested = String(body?.model || "").trim();
    const models = this.modelsCache.models || [];
    const match = models.find((item) => item.id === requested || item.aliases?.includes(requested));
    const modelInfo = this.modelInfoFor(match?.id || requested);
    return { model: match?.id || requested, effort: body?.reasoning_effort || body?.reasoning?.effort || null, modelInfo };
  }

  async resolveRequestModel(body) {
    await this.fetchModels();
    return this.resolveRequestModelSync(body);
  }

  async fetchQuotasFor(bundle, { force = false } = {}) {
    const id = accountIdOf(bundle);
    const now = Date.now();
    const cached = this.quotaCache.get(id);
    if (!force && cached && now - cached.at < this.quotaTtlMs) return cached.quotas;
    if (!force && bundle.quotas_at && now - bundle.quotas_at < this.quotaTtlMs) {
      this.quotaCache.set(id, { at: bundle.quotas_at, quotas: bundle.quotas || [] });
      return bundle.quotas || [];
    }
    let ready = bundle;
    if (isExpired(bundle)) {
      try {
        ready = await this.refreshStoredToken(bundle);
      } catch {
        ready = bundle;
      }
    }
    let quotas = [];
    try {
      const response = await requestJson(this.usageUrl, {
        method: "GET",
        headers: this.headers(ready),
        timeoutMs: Math.min(this.settings.requestTimeoutMs, 15_000),
      });
      if (response.status < 400) quotas = quotasFromWhamUsage(response.parsed || {});
    } catch {
      quotas = [];
    }
    this.quotaCache.set(id, { at: now, quotas });
    this.store.save(createChatgptBundle({ ...ready, quotas, quotas_at: now }), { activate: false });
    return quotas;
  }

  async refreshAccountQuotas(id) {
    const match = this.findAccount(id);
    if (!match) throw new AuthRequiredError(`No saved ChatGPT account matching ${id}`);
    const quotas = await this.fetchQuotasFor(match, { force: true });
    return this.accountSummary({ ...this.findAccount(id), quotas });
  }

  async listAccountViews({ refresh = false } = {}) {
    const accounts = this.accounts();
    const expired = accounts.filter((bundle) => bundle?.refresh_token && isExpired(bundle) && !isAccountDisabled(bundle));
    if (expired.length) {
      Promise.all(expired.map((bundle) => this.refreshStoredToken(bundle).catch(() => {}))).catch(() => {});
    }
    if (refresh) {
      Promise.all(accounts.map((bundle) => this.warmAccount(bundle).catch(() => {}))).catch(() => {});
    }
    return this.accounts().map((bundle) => this.accountSummary(bundle));
  }

  async refreshStoredToken(bundle) {
    if (!bundle?.refresh_token) return bundle;
    if (!isExpired(bundle)) return bundle;
    const refreshed = await refreshChatgptToken(bundle, Math.min(this.settings.requestTimeoutMs, 15_000));
    this.store.save(createChatgptBundle(refreshed), { activate: false });
    return this.findAccount(accountIdOf(refreshed)) || refreshed;
  }

  async collectCompleted(stream) {
    let completed = null;
    let text = "";
    for await (const event of iterateSse(stream)) {
      if (event?.type === "response.output_text.delta" && event.delta) text += String(event.delta);
      if (event?.type === "response.completed" && event.response) completed = event.response;
      if (event?.response?.status === "completed") completed = event.response;
    }
    if (completed) return completed;
    return { id: `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`, output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: {} };
  }

  async generateResponses(body, { stream = false } = {}) {
    const resolved = await this.resolveRequestModel(body);
    const modelInfo = resolved.modelInfo;
    const lite = modelInfo?.use_responses_lite ?? modelInfo?.useResponsesLite ?? true;
    const payload = normalizeChatgptResponsesBody({ ...body, model: resolved.model }, { modelInfo, forceStream: true });
    const response = await this.post(this.responsesUrl(), payload, { stream: true, lite });
    if (stream) return response;
    try {
      return await this.collectCompleted(response.stream);
    } finally {
      response.stream?.resume();
    }
  }

  async chatCompletions(body) {
    const resolved = await this.resolveRequestModel(body);
    const payload = chatToChatgptResponses(body, { model: resolved.model, modelInfo: resolved.modelInfo });
    const completed = await this.generateResponses(payload);
    const out = responsesOutputToOpenai(completed, resolved.model);
    this.recordUsage(this.store.load(), { ok: true, prompt: out.usage?.prompt_tokens, completion: out.usage?.completion_tokens });
    return out;
  }

  async *chatCompletionsStream(body) {
    const resolved = await this.resolveRequestModel(body);
    const acc = new ChatgptResponsesStreamAccumulator(resolved.model);
    const payload = chatToChatgptResponses(body, { model: resolved.model, modelInfo: resolved.modelInfo });
    const response = await this.generateResponses(payload, { stream: true });
    const bundle = this.store.load();
    try {
      for await (const event of iterateSse(response.stream)) {
        for (const chunk of acc.ingest(event).openai) yield `data: ${JSON.stringify(chunk)}\n\n`;
      }
    } finally {
      response.stream?.resume();
    }
    for (const chunk of acc.finishOpenai()) yield `data: ${JSON.stringify(chunk)}\n\n`;
    this.recordUsage(bundle, { ok: true, prompt: acc.openai.usage?.prompt_tokens, completion: acc.openai.usage?.completion_tokens });
    yield "data: [DONE]\n\n";
  }

  async messages(body) {
    const resolved = await this.resolveRequestModel(body);
    const payload = messagesToChatgptResponses(body, { model: resolved.model, modelInfo: resolved.modelInfo });
    const completed = await this.generateResponses(payload);
    const out = responsesOutputToAnthropic(completed, resolved.model);
    this.recordUsage(this.store.load(), { ok: true, prompt: out.usage?.input_tokens, completion: out.usage?.output_tokens });
    return out;
  }

  async *messagesStream(body) {
    const resolved = await this.resolveRequestModel(body);
    const acc = new ChatgptResponsesStreamAccumulator(resolved.model);
    const payload = messagesToChatgptResponses(body, { model: resolved.model, modelInfo: resolved.modelInfo });
    const bundle = await this.readyBundle();
    const response = await this.generateResponses(payload, { stream: true });
    let opened = false;
    try {
      for await (const event of withIdlePings(iterateSse(response.stream))) {
        if (event?.__ping) {
          if (opened) yield formatSse("ping", { type: "ping" });
          continue;
        }
        for (const item of acc.ingest(event).anthropic) {
          opened = true;
          yield formatSse(item.type, item);
        }
      }
    } catch (err) {
      if (!opened) throw err;
      yield anthropicErrorEvent(err);
      for (const item of acc.finishAnthropic()) yield formatSse(item.type, item);
      return;
    } finally {
      response.stream?.resume();
    }
    if (!opened) {
      for (const event of acc.anthropic.start()) {
        if (event.message) event.message.usage = chatgptUsageToAnthropic(acc.response.usage || {});
        yield formatSse(event.type, event);
      }
    }
    for (const item of acc.finishAnthropic()) yield formatSse(item.type, item);
    this.recordUsage(this.store.load() || bundle, { ok: true, prompt: acc.anthropic.usage?.input_tokens, completion: acc.anthropic.usage?.output_tokens });
  }

  async responses(body) {
    const prepared = this.prepareResponses(body);
    const chat = await this.chatCompletions(prepared.chat);
    return this.persistResponses(prepared, chat);
  }

  async *responsesStream(body) {
    const prepared = this.prepareResponses(body);
    const resolved = await this.resolveRequestModel(prepared.chat);
    const payload = chatToChatgptResponses(prepared.chat, { model: resolved.model, modelInfo: resolved.modelInfo });
    const response = await this.generateResponses(payload, { stream: true });
    try {
      for await (const event of iterateSse(response.stream)) {
        if (!event || typeof event !== "object") continue;
        const type = event.type || "message";
        yield formatSse(type, event);
      }
    } finally {
      response.stream?.resume();
    }
  }

  prepareResponses(body) {
    if (!body?.model) throw new HttpError(400, "model is required", { type: "invalid_request_error" });
    let previous = [];
    if (body.previous_response_id) {
      const prior = this.responseStore.load(body.previous_response_id);
      if (!prior) throw new HttpError(400, "previous_response_id not found", { type: "invalid_request_error" });
      previous = prior.messages || [];
    }
    const { chat, current } = responsesToChatBody(body, previous);
    if (!chat.messages.length) throw new HttpError(400, "input is required", { type: "invalid_request_error" });
    return {
      id: `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      chat,
      current,
      stored: [...previous, ...current],
      previousId: body.previous_response_id || null,
      metadata: body.metadata || null,
      store: body.store !== false,
    };
  }

  persistResponses(prepared, chat) {
    const model = chat.model || prepared.chat.model;
    const response = openaiToResponses(chat, {
      id: prepared.id,
      model,
      previousId: prepared.previousId,
      metadata: prepared.metadata,
    });
    if (prepared.store) {
      this.responseStore.save({
        id: response.id,
        model,
        messages: [...prepared.stored, { role: "assistant", content: chat.choices?.[0]?.message?.content || "" }],
        response,
        createdAt: response.created_at * 1000,
      });
    }
    return response;
  }

  getResponse(id) {
    const row = this.responseStore.load(id);
    if (!row?.response) throw new HttpError(404, "response not found", { type: "not_found_error" });
    return row.response;
  }

  deleteResponse(id) {
    if (!this.responseStore.remove(id)) throw new HttpError(404, "response not found", { type: "not_found_error" });
    return { id, object: "response.deleted", deleted: true };
  }
}
