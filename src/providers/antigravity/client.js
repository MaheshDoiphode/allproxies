import {
  DAILY_URL,
  ENDPOINT_ALIASES,
  GENERATE_PATH,
  LOAD_CODE_ASSIST_PATH,
  MODELS_PATH,
  ONBOARD_USER_PATH,
  PROD_URL,
  QUOTA_PATH,
  STREAM_PATH,
} from "../../core/constants.js";
import crypto from "node:crypto";
import { AuthRequiredError, HttpError, OAuthError, ProjectError, UpstreamError } from "../../core/errors.js";
import { iterateSse, request, requestJson } from "../../http/request.js";
import { loadStaticCatalog, mergeCatalog, parseLiveModels, resolveRequestRoute } from "./catalog.js";
import { fetchHubVersion, requestHeaders, resolveHubVersion, stripApiKeyHeaders } from "./headers.js";
import {
  buildAuthUrl,
  exchangeCode,
  fetchEmail,
  generatePkce,
  openBrowser,
  refreshAccessToken,
  startCallbackServer,
} from "./oauth.js";
import { resolveProject } from "./project.js";
import {
  TokenStore,
  accountIdOf,
  cooldownUntil,
  disableAccount,
  isAccountDisabled,
  isExpired,
  isRetryableUpstreamError,
  projectOf,
  setAccountEnabled,
  touchAccountStats,
} from "./tokens.js";
import { mergeQuotaViews, parseQuotaSummary, quotasFromLiveModels } from "./quota.js";
import { ResponseStore } from "./responses-store.js";
import {
  StreamAccumulator,
  ResponsesStreamAccumulator,
  AnthropicStreamAccumulator,
  anthropicToUpstream,
  geminiToAnthropic,
  geminiToOpenai,
  openaiToResponses,
  openaiToUpstream,
  responsesAssistantMessage,
  responsesToChatBody,
  unwrapResponse,
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

export class AntigravityClient {
  constructor(settings, { store } = {}) {
    this.settings = settings;
    this.store = store || new TokenStore(settings.tokenPath);
    this.responseStore = new ResponseStore(this.store.path);
    this.hubVersion = resolveHubVersion(settings.antigravityHubVersion);
    this.refreshLock = Promise.resolve();
    this.switchLock = Promise.resolve();
    this.modelsCache = { at: 0, models: loadStaticCatalog(settings.modelsPath) };
    this.modelsTtlMs = 60_000;
    this.quotaCache = new Map();
    this.quotaTtlMs = 30_000;
    this.stats = { requests: 0, success: 0, failed: 0, prompt_tokens: 0, completion_tokens: 0 };
  }

  accounts() {
    return this.store.list();
  }

  activeAccount() {
    return this.store.load();
  }

  accountSummary(bundle, now = Date.now()) {
    if (!bundle) return null;
    const limited = Number(bundle.disabled_until || 0) > now;
    const disabled = isAccountDisabled(bundle, now);
    return {
      id: accountIdOf(bundle),
      email: bundle.email || null,
      project: projectOf(bundle),
      provider: "antigravity",
      expired: isExpired(bundle),
      enabled: bundle.enabled !== false,
      disabled,
      limited,
      disabled_until: limited ? bundle.disabled_until : null,
      disabled_reason: limited || bundle.enabled === false ? bundle.disabled_reason : null,
      active: accountIdOf(this.store.load()) === accountIdOf(bundle),
      last_used: bundle.last_used || 0,
      request_count: bundle.request_count || 0,
      success_count: bundle.success_count || 0,
      error_count: bundle.error_count || 0,
      prompt_tokens: bundle.prompt_tokens || 0,
      completion_tokens: bundle.completion_tokens || 0,
      quotas: bundle.quotas || [],
      quotas_at: bundle.quotas_at || 0,
    };
  }

  findAccount(id) {
    const wanted = String(id || "").trim().toLowerCase();
    return this.store.list().find((item) => accountIdOf(item) === wanted || String(item.email || "").toLowerCase() === wanted) || null;
  }

  setEnabled(id, enabled) {
    const match = this.findAccount(id);
    if (!match) throw new AuthRequiredError(`No saved account matching ${id}`);
    const next = setAccountEnabled(match, enabled);
    this.store.save(next, { activate: enabled });
    if (enabled) this.store.use(accountIdOf(next));
    else if (accountIdOf(this.store.load()) === accountIdOf(next)) {
      const ready = this.store.list().find((item) => !isAccountDisabled(item) && accountIdOf(item) !== accountIdOf(next));
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
    this.store.save(touchAccountStats(current, { ok, prompt, completion }), { activate: false });
  }

  async completeLogin({ code, codeVerifier, redirectUri, warm = true } = {}) {
    const bundle = await exchangeCode({
      code,
      codeVerifier,
      redirectUri,
      timeoutMs: this.settings.requestTimeoutMs,
    });
    bundle.email = await fetchEmail(bundle.access_token, this.settings.requestTimeoutMs);
    bundle.enabled = true;
    this.store.save(bundle);
    this.modelsCache = null;
    const saved = this.store.load();
    if (warm) this.warmAccount(saved).catch(() => {});
    return saved;
  }

  async warmAccount(bundle) {
    if (!bundle?.refresh_token) return bundle;
    let current = bundle;
    if (isExpired(current)) {
      try {
        current = await this.refreshStoredToken(current);
      } catch {
        // keep the stored tokens; project/quota calls may still fail
      }
    }
    if (!current.email && current.access_token) {
      try {
        const email = await fetchEmail(current.access_token, this.settings.requestTimeoutMs);
        if (email) {
          current.email = email;
          this.store.save(current, { activate: false });
        }
      } catch {
        // id stays rt-… until userinfo works
      }
    }
    try {
      current = await this.ensureProject(current);
    } catch {
      // dashboard still shows the account; project can be filled later
    }
    try {
      await this.fetchQuotasFor(current, { force: true });
    } catch {
      // cached/empty quotas are fine
    }
    return this.findAccount(accountIdOf(current)) || current;
  }

  get baseUrl() {
    if (this.settings.antigravityBaseUrl) return this.settings.antigravityBaseUrl.replace(/\/$/, "");
    return ENDPOINT_ALIASES[this.settings.antigravityEndpoint] || DAILY_URL;
  }

  generateUrl() {
    return joinUrl(this.baseUrl, GENERATE_PATH);
  }

  streamUrl() {
    return `${joinUrl(this.baseUrl, STREAM_PATH)}?alt=sse`;
  }

  modelsUrl() {
    return joinUrl(this.baseUrl, MODELS_PATH);
  }

  loadUrl() {
    return joinUrl(PROD_URL, LOAD_CODE_ASSIST_PATH);
  }

  onboardUrl() {
    return joinUrl(PROD_URL, ONBOARD_USER_PATH);
  }

  quotaUrl() {
    return joinUrl(this.baseUrl, QUOTA_PATH);
  }

  headers(token, { onboard = false } = {}) {
    return stripApiKeyHeaders({
      ...requestHeaders(this.hubVersion, { onboard }),
      Authorization: `Bearer ${token}`,
    });
  }

  requireBundle({ exclude = [] } = {}) {
    const now = Date.now();
    const skip = new Set([...exclude].map((id) => String(id || "").toLowerCase()).filter(Boolean));
    const accounts = this.store.list();
    const current = this.store.load();
    const usable = (item) => item?.refresh_token && !isAccountDisabled(item, now) && !skip.has(accountIdOf(item));
    if (usable(current) && projectOf(current)) return current;
    const ready = accounts
      .filter((item) => usable(item) && projectOf(item))
      .sort((a, b) => (a.last_used || 0) - (b.last_used || 0));
    if (ready[0]) {
      if (!current || accountIdOf(ready[0]) !== accountIdOf(current)) {
        this.store.use(accountIdOf(ready[0]));
        if (this.settings.debugRequests) {
          console.log(`[auth] using ${ready[0].email || accountIdOf(ready[0])} (has project; skipped ${current?.email || "none"})`);
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
    if (!current?.refresh_token && !accounts.length) throw new AuthRequiredError();
    const soonest = accounts
      .filter((item) => item?.refresh_token && Number(item.disabled_until || 0) > now)
      .sort((a, b) => Number(a.disabled_until || 0) - Number(b.disabled_until || 0))[0];
    const until = soonest?.disabled_until ? new Date(soonest.disabled_until).toISOString() : "later";
    throw new AuthRequiredError(`All Antigravity accounts are rate-limited until ${until}. Add another from the dashboard or: node src/cli.js login`);
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
          const refreshed = await refreshAccessToken(bundle, this.settings.requestTimeoutMs);
          this.store.save(refreshed);
          return this.findAccount(accountIdOf(refreshed)) || this.store.load();
        } catch (err) {
          if (!(err instanceof OAuthError)) throw err;
          this.markFailed(bundle, err);
          skip.push(accountIdOf(bundle));
        }
      }
      throw new AuthRequiredError();
    } finally {
      release();
    }
  }

  async login({ openUrl = true } = {}) {
    const { verifier, challenge } = generatePkce();
    const state = generatePkce().verifier;
    const { ready, code: codePromise } = startCallbackServer(state);
    await ready;
    const url = buildAuthUrl({ state, codeChallenge: challenge });
    if (openUrl) openBrowser(url);
    console.log(`Open this URL if the browser did not launch:\n${url}\n`);
    const hubPromise = fetchHubVersion(1500).then(
      (fetched) => {
        this.hubVersion = resolveHubVersion(this.settings.antigravityHubVersion, fetched);
      },
      () => {},
    );
    const code = await codePromise;
    await hubPromise;
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
    if (!match) throw new AuthRequiredError(`No saved account matching ${id}`);
    this.modelsCache = null;
    return match;
  }

  async removeAccount(id) {
    const ok = this.store.remove(id);
    if (!ok) throw new AuthRequiredError(`No saved account matching ${id}`);
    this.modelsCache = null;
    return this.store.list();
  }

  markFailed(bundle, err) {
    const reason = String(err?.code || err?.message || "upstream").slice(0, 180);
    const disabled = disableAccount(bundle, {
      until: cooldownUntil(err),
      reason,
    });
    this.store.save(disabled, { activate: false });
    const next = this.store
      .list()
      .filter((item) => item.refresh_token && !isAccountDisabled(item) && accountIdOf(item) !== accountIdOf(disabled))
      .sort((a, b) => {
        const projectDelta = Number(Boolean(projectOf(b))) - Number(Boolean(projectOf(a)));
        if (projectDelta) return projectDelta;
        return (a.last_used || 0) - (b.last_used || 0);
      })[0];
    if (next) {
      this.store.use(accountIdOf(next));
      this.modelsCache = null;
      if (this.settings.debugRequests) {
        console.log(`[auth] rotate ${bundle.email || accountIdOf(bundle)} -> ${next.email || accountIdOf(next)} (${reason})`);
      }
    }
    return next || null;
  }

  markQuota(bundle, err) {
    return this.markFailed(bundle, err);
  }

  enableAccount(id) {
    return this.setEnabled(id, true);
  }

  async readyBundle({ exclude = [] } = {}) {
    const skip = [...exclude];
    let lastError;
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const first = await this.ensureToken({ exclude: skip });
        try {
          const ready = await this.ensureProject(first);
          if (projectOf(ready)) return ready;
          lastError = new ProjectError(`Could not resolve a Cloud Code project for ${first.email || accountIdOf(first)}`);
        } catch (err) {
          lastError = err;
          if (!(err instanceof ProjectError)) throw err;
          if (this.settings.debugRequests) console.log(`[auth] onboard failed for ${first.email || accountIdOf(first)}: ${err.message}`);
        }
        this.markFailed(first, lastError);
        skip.push(accountIdOf(first));
      }
      const failed = lastError?.message || "Could not resolve a Cloud Code project";
      throw new HttpError(400, `${failed}. Switch to an account that already has a project, or re-run login and accept the Google onboarding prompt.`, { type: "api_error" });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof ProjectError) throw new HttpError(400, err.message, { type: "api_error" });
      throw err;
    }
  }

  async ensureProject(bundle) {
    if (projectOf(bundle)) return bundle;
    const project = await resolveProject({
      loadUrl: this.loadUrl(),
      onboardUrl: this.onboardUrl(),
      headers: this.headers(bundle.access_token, { onboard: true }),
      timeoutMs: this.settings.requestTimeoutMs,
    });
    bundle.project_id = project;
    bundle.managed_project_id = project;
    this.store.save(bundle, { activate: false });
    return this.findAccount(accountIdOf(bundle)) || bundle;
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
    if ((response.status === 401 || response.status === 403) && String(message).includes("API_KEY_INVALID")) {
      message = "Upstream rejected an API key header. This proxy uses OAuth only.";
    }
    throw new UpstreamError(response.status, message, code ? String(code) : undefined);
  }

  async post(url, payload, { stream = false } = {}) {
    const tried = new Set();
    let lastError;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let bundle;
      try {
        bundle = await this.ensureProject(await this.ensureToken({ exclude: tried }));
      } catch (err) {
        lastError = err;
        break;
      }
      const id = accountIdOf(bundle);
      if (tried.has(id)) break;
      tried.add(id);
      const requestPayload = { ...payload, project: projectOf(bundle) || payload.project };
      let response;
      try {
        response = await this.send(url, requestPayload, bundle.access_token, stream);
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
          this.store.save(current, { activate: false });
        }
        try {
          bundle = await this.ensureToken({ exclude: [...tried].filter((item) => item !== id) });
          if (accountIdOf(bundle) === id) {
            requestPayload.project = projectOf(bundle) || requestPayload.project;
            response = await this.send(url, requestPayload, bundle.access_token, stream);
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
      if (response.status < 400) {
        return response;
      }
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
    throw lastError || new AuthRequiredError();
  }

  send(url, payload, accessToken, stream) {
    const body = JSON.stringify(payload);
    const headers = this.headers(accessToken);
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
    if (!refresh && this.modelsCache && now - this.modelsCache.at < this.modelsTtlMs) return this.modelsCache.models;
    const staticModels = loadStaticCatalog(this.settings.modelsPath);
    if (!this.modelsCache) this.modelsCache = { at: 0, models: staticModels };
    if (!this.settings.liveModels) {
      this.modelsCache = { at: now, models: staticModels };
      return staticModels;
    }
    if (!refresh) {
      this.refreshLiveModels().catch(() => {});
      return this.modelsCache.models.length ? this.modelsCache.models : staticModels;
    }
    return this.refreshLiveModels();
  }

  async refreshLiveModels() {
    const now = Date.now();
    const staticModels = loadStaticCatalog(this.settings.modelsPath);
    try {
      const bundle = await this.ensureToken();
      const response = await requestJson(this.modelsUrl(), {
        method: "POST",
        headers: this.headers(bundle.access_token),
        json: projectOf(bundle) ? { project: projectOf(bundle) } : {},
        timeoutMs: Math.min(this.settings.requestTimeoutMs, 15_000),
      });
      if (response.status >= 400) {
        this.modelsCache = { at: now, models: this.modelsCache?.models?.length ? this.modelsCache.models : staticModels };
        return this.modelsCache.models;
      }
      const merged = mergeCatalog(staticModels, parseLiveModels(response.parsed || {}));
      this.modelsCache = { at: now, models: merged };
      return merged;
    } catch {
      this.modelsCache = { at: now, models: this.modelsCache?.models?.length ? this.modelsCache.models : staticModels };
      return this.modelsCache.models;
    }
  }

  resolveModel(requested, catalog) {
    return this.resolveRequestModelSync({ model: requested }, catalog).model;
  }

  resolveRequestModelSync(body, catalog) {
    const models = catalog || this.modelsCache?.models || loadStaticCatalog(this.settings.modelsPath);
    return resolveRequestRoute(body, models);
  }

  async resolveRequestModel(body) {
    const catalog = await this.fetchModels();
    const route = this.resolveRequestModelSync(body, catalog);
    return { model: route.model, effort: route.effort, project: null };
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
    let summary = [];
    try {
      const response = await requestJson(this.quotaUrl(), {
        method: "POST",
        headers: this.headers(ready.access_token),
        json: projectOf(ready) ? { project: projectOf(ready) } : {},
        timeoutMs: Math.min(this.settings.requestTimeoutMs, 15_000),
      });
      if (response.status < 400) summary = parseQuotaSummary(response.parsed || {});
    } catch {
      summary = [];
    }
    let fromModels = [];
    if (!summary.length) {
      try {
        const response = await requestJson(this.modelsUrl(), {
          method: "POST",
          headers: this.headers(ready.access_token),
          json: projectOf(ready) ? { project: projectOf(ready) } : {},
          timeoutMs: Math.min(this.settings.requestTimeoutMs, 15_000),
        });
        if (response.status < 400) fromModels = quotasFromLiveModels(response.parsed || {});
      } catch {
        fromModels = [];
      }
    }
    const quotas = mergeQuotaViews(summary, fromModels);
    this.quotaCache.set(id, { at: now, quotas });
    this.store.save({ ...ready, quotas, quotas_at: now }, { activate: false });
    return quotas;
  }

  async refreshAccountQuotas(id) {
    const match = this.findAccount(id);
    if (!match) throw new AuthRequiredError(`No saved account matching ${id}`);
    let current = match;
    if (!projectOf(current)) {
      try {
        current = await this.ensureProject(current);
      } catch {
        current = match;
      }
    }
    const quotas = await this.fetchQuotasFor(current, { force: true });
    return this.accountSummary({ ...this.findAccount(id), quotas });
  }

  async listAccountViews({ refresh = false } = {}) {
    const accounts = this.store.list();
    const expired = accounts.filter((bundle) => bundle?.refresh_token && isExpired(bundle) && !isAccountDisabled(bundle));
    if (expired.length) {
      Promise.all(expired.map((bundle) => this.refreshStoredToken(bundle).catch(() => {}))).catch(() => {});
    }
    if (refresh) {
      Promise.all(accounts.map((bundle) => this.warmAccount(bundle).catch(() => {}))).catch(() => {});
    }
    return this.store.list().map((bundle) => this.accountSummary(bundle));
  }

  async refreshStoredToken(bundle) {
    if (!bundle?.refresh_token) return bundle;
    if (!isExpired(bundle)) return bundle;
    const refreshed = await refreshAccessToken(bundle, Math.min(this.settings.requestTimeoutMs, 15_000));
    this.store.save(refreshed, { activate: false });
    return this.findAccount(accountIdOf(refreshed)) || refreshed;
  }

  async generate(payload) {
    if (this.settings.debugRequests) console.log(`[up] generate ${payload.model} thinking=${JSON.stringify(payload.request?.generationConfig?.thinkingConfig || null)}`);
    const response = await this.post(this.generateUrl(), payload);
    return response.body ? JSON.parse(response.body) : {};
  }

  async *stream(payload) {
    if (this.settings.debugRequests) console.log(`[up] stream ${payload.model} thinking=${JSON.stringify(payload.request?.generationConfig?.thinkingConfig || null)}`);
    const response = await this.post(this.streamUrl(), payload, { stream: true });
    if (this.settings.debugRequests) {
      console.log(`[up] stream status=${response.status} ctype=${response.headers?.["content-type"] || ""} enc=${response.headers?.["content-encoding"] || ""}`);
    }
    let events = 0;
    try {
      for await (const event of iterateSse(response.stream, {
        onFirstBytes: this.settings.debugRequests
          ? (raw) => console.log(`[up] stream first ${raw.length}B ${JSON.stringify(raw.slice(0, 240))}`)
          : undefined,
      })) {
        events += 1;
        yield event;
      }
    } finally {
      if (this.settings.debugRequests) console.log(`[up] stream events=${events} model=${payload.model}`);
      response.stream?.resume();
    }
  }

  async chatCompletions(body) {
    const resolved = await this.resolveRequestModel(body);
    const bundle = await this.readyBundle();
    const payload = await this.generate(openaiToUpstream(body, resolved));
    const out = geminiToOpenai(payload, resolved.model);
    this.recordUsage(this.store.load() || bundle, { ok: true, prompt: out.usage?.prompt_tokens, completion: out.usage?.completion_tokens });
    return out;
  }

  async *chatCompletionsStream(body) {
    const resolved = await this.resolveRequestModel(body);
    const acc = new StreamAccumulator(resolved.model);
    const bundle = await this.readyBundle();
    for await (const event of this.stream(openaiToUpstream(body, resolved))) {
      for (const chunk of acc.ingest(event)) yield `data: ${JSON.stringify(chunk)}\n\n`;
    }
    for (const chunk of acc.finish()) yield `data: ${JSON.stringify(chunk)}\n\n`;
    this.recordUsage(this.store.load() || bundle, { ok: true, prompt: acc.usage?.prompt_tokens, completion: acc.usage?.completion_tokens });
    yield "data: [DONE]\n\n";
  }

  async messages(body) {
    const resolved = await this.resolveRequestModel(body);
    const bundle = await this.readyBundle();
    const payload = await this.generate(anthropicToUpstream(body, resolved));
    const out = geminiToAnthropic(payload, resolved.model);
    this.recordUsage(this.store.load() || bundle, { ok: true, prompt: out.usage?.input_tokens, completion: out.usage?.output_tokens });
    return out;
  }

  async *messagesStream(body) {
    const resolved = await this.resolveRequestModel(body);
    const acc = new AnthropicStreamAccumulator(resolved.model);
    const bundle = await this.readyBundle();
    let opened = false;
    try {
      for await (const event of withIdlePings(this.stream(anthropicToUpstream(body, resolved)))) {
        if (event?.__ping) {
          if (opened) yield formatSse("ping", { type: "ping" });
          continue;
        }
        for (const item of acc.ingest(event)) {
          opened = true;
          yield formatSse(item.type, item);
        }
      }
    } catch (err) {
      if (this.settings.debugRequests) console.log(`[up] stream failed ${resolved.model}: ${err.message}`);
      if (!opened) throw err;
      yield anthropicErrorEvent(err);
      for (const item of acc.finish()) yield formatSse(item.type, item);
      return;
    }
    if (!opened) {
      for (const event of acc.start()) {
        if (event.message) event.message.usage = { ...acc.usage };
        yield formatSse(event.type, event);
      }
    }
    for (const item of acc.finish()) yield formatSse(item.type, item);
    this.recordUsage(this.store.load() || bundle, { ok: true, prompt: acc.usage?.input_tokens, completion: acc.usage?.output_tokens });
  }

  async responses(body) {
    const prepared = this.prepareResponses(body);
    const chat = await this.chatCompletions(prepared.chat);
    return this.persistResponses(prepared, chat);
  }

  async *responsesStream(body) {
    const prepared = this.prepareResponses(body);
    const resolved = await this.resolveRequestModel(prepared.chat);
    const model = resolved.model;
    const acc = new ResponsesStreamAccumulator({
      id: prepared.id,
      model,
      previousId: prepared.previousId,
    });
    let opened = false;
    for await (const event of this.stream(openaiToUpstream(prepared.chat, resolved))) {
      for (const item of acc.ingest(event)) {
        opened = true;
        yield formatSse(item.type, item);
      }
    }
    if (!opened) {
      for (const event of acc.startEvents()) yield formatSse(event.type, event);
    }
    const done = acc.finishEvents();
    for (const item of done) yield formatSse(item.type, item);
    const completed = done.at(-1)?.response;
    if (completed && prepared.store) {
      this.responseStore.save({
        id: completed.id,
        model,
        messages: [...prepared.stored, responsesAssistantMessage({ choices: [{ message: { content: acc.seenText, tool_calls: acc.toolCalls } }] })],
        response: completed,
        createdAt: completed.created_at * 1000,
      });
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
        messages: [...prepared.stored, responsesAssistantMessage(chat)],
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

  async nativeGenerate(body, { stream = false } = {}) {
    const bundle = await this.readyBundle();
    let payload = { ...body };
    if (!payload.request) {
      payload = {
        project: projectOf(bundle),
        model: payload.model,
        userAgent: "antigravity",
        request: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "model" && key !== "project")),
      };
    }
    if (projectOf(bundle) && !payload.project) payload.project = projectOf(bundle);
    if (stream) return this.stream(payload);
    return unwrapResponse(await this.generate(payload));
  }
}
