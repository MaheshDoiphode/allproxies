import crypto from "node:crypto";
import {
  VERTEX_API_KEY_HEADER,
  VERTEX_API_VERSION,
  VERTEX_USER_AGENT,
  parseVertexPublisherError,
  vertexGeneratePath,
  vertexModelsPath,
  vertexRegionalBase,
  vertexStreamPath,
  withVertexProjectPath,
} from "../../core/vertex-constants.js";
import { AuthRequiredError, HttpError, UpstreamError } from "../../core/errors.js";
import { iterateSse, request, requestJson } from "../../http/request.js";
import { ResponseStore } from "../antigravity/responses-store.js";
import { streamAnthropicMessages } from "../anthropic-stream.js";
import { loadStaticVertexCatalog, mergeVertexCatalog, nextPageTokenOf, parseVertexModels, resolveVertexRoute } from "./catalog.js";
import {
  TokenStore,
  accountIdOf,
  createVertexBundle,
  hydrateVertexBundle,
  isAccountDisabled,
  isManuallyDisabled,
  isQuotaError,
  isRetryableUpstreamError,
  setAccountEnabled,
  touchAccountStats,
  addUsageStats,
  vertexApiKeyOf,
  vertexLocationOf,
  vertexProjectOf,
} from "./tokens.js";
import {
  AnthropicStreamAccumulator,
  ResponsesStreamAccumulator,
  StreamAccumulator,
  anthropicToVertex,
  geminiToAnthropic,
  geminiToOpenai,
  openaiToResponses,
  openaiToVertex,
  responsesAssistantMessage,
  responsesToChatBody,
  unwrapResponse,
  vertexHttpBody,
} from "./translate.js";

function joinUrl(base, pathname) {
  return `${String(base).replace(/\/$/, "")}/${String(pathname).replace(/^\//, "")}`;
}

function formatSse(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}


function catalogErrorMessage(err) {
  const msg = String(err?.message || err || "").trim();
  if (/API keys are not supported/i.test(msg)) {
    return "Express Mode cannot list the live publisher catalog. Showing Google's documented Express models; any other Vertex id still works as vertex/<id>.";
  }
  return msg.slice(0, 400) || "Vertex model list failed";
}


export class VertexClient {
  constructor(settings, { store } = {}) {
    this.settings = settings;
    this.store = store || new TokenStore(settings.vertexTokenPath || settings.tokenPath);
    this.responseStore = new ResponseStore(this.store.path);
    this.modelsCache = { at: 0, models: loadStaticVertexCatalog() };
    this.modelsTtlMs = 60_000;
    this.catalog = { at: 0, error: null, listed: this.modelsCache.models.length, source: "express" };
    this.stats = { requests: 0, success: 0, failed: 0, prompt_tokens: 0, completion_tokens: 0 };
    this.inFlight = new Map();
    this.sessionPins = new Map();
    this.catalogPromise = null;
  }

  rememberSessionAccount(sessionKey, bundle) {
    if (!sessionKey || !bundle) return;
    const id = accountIdOf(bundle);
    if (!id) return;
    if (this.sessionPins.size > 256) {
      const oldest = this.sessionPins.keys().next().value;
      if (oldest) this.sessionPins.delete(oldest);
    }
    this.sessionPins.delete(sessionKey);
    this.sessionPins.set(sessionKey, { accountId: id, at: Date.now() });
  }

  pinnedAccountFor(sessionKey) {
    if (!sessionKey) return null;
    const entry = this.sessionPins.get(sessionKey);
    if (!entry) return null;
    if (Date.now() - entry.at > 30 * 60 * 1000) {
      this.sessionPins.delete(sessionKey);
      return null;
    }
    return entry.accountId;
  }

  inFlightOf(item) {
    return this.inFlight.get(accountIdOf(item)) || 0;
  }

  acquireSlot(bundle) {
    const id = accountIdOf(bundle);
    if (!id) return () => {};
    this.inFlight.set(id, (this.inFlight.get(id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.inFlight.get(id) || 1) - 1;
      if (next <= 0) this.inFlight.delete(id);
      else this.inFlight.set(id, next);
    };
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

  catalogStatus() {
    return {
      provider: "vertex",
      at: this.catalog.at || 0,
      error: this.catalog.error || null,
      listed: this.catalog.listed ?? this.modelsCache?.models?.length ?? 0,
      source: this.catalog.source || (this.catalog.error ? "express" : "live"),
      listable: !this.catalog.error,
    };
  }

  rememberCatalog({ models = null, error = null, source } = {}) {
    const now = Date.now();
    const fallback = loadStaticVertexCatalog();
    const incoming = Array.isArray(models) ? models : [];
    const list = incoming.length ? incoming : error ? fallback : this.modelsCache?.models || fallback;
    const nextSource = source || (incoming.length ? "live" : error ? "express" : this.catalog.source || "express");
    this.modelsCache = { at: now, models: list };
    this.catalog = {
      at: now,
      error: error ? catalogErrorMessage(error) : null,
      listed: list.length,
      source: nextSource,
    };
    return list;
  }

  get defaultLocation() {
    return this.settings.vertexLocation || "global";
  }

  get defaultProject() {
    return String(this.settings.vertexProject || "").trim();
  }

  get defaultBaseUrl() {
    return String(this.settings.vertexBaseUrl || vertexRegionalBase(this.defaultLocation)).replace(/\/$/, "");
  }

  get baseUrl() {
    const active = this.activeAccount();
    if (active) return this.baseUrlFor(active);
    return this.defaultBaseUrl;
  }

  baseUrlFor(bundle) {
    if (this.settings.vertexBaseUrl) return String(this.settings.vertexBaseUrl).replace(/\/$/, "");
    return vertexRegionalBase(vertexLocationOf(bundle) || this.defaultLocation);
  }

  versioned(base, pathname) {
    return joinUrl(joinUrl(base, VERTEX_API_VERSION), pathname);
  }

  accounts() {
    return this.store.list().map((item) => hydrateVertexBundle(item));
  }

  activeAccount() {
    return hydrateVertexBundle(this.store.load());
  }

  accountSummary(bundle, now = Date.now()) {
    if (!bundle) return null;
    const hydrated = hydrateVertexBundle(bundle);
    const limited = Number(hydrated.disabled_until || 0) > now;
    const disabled = isAccountDisabled(hydrated, now);
    return {
      id: accountIdOf(hydrated),
      email: hydrated.email || null,
      project: vertexProjectOf(hydrated) || this.defaultProject || null,
      provider: "vertex",
      plan: "express",
      expired: false,
      catalog_error: this.catalog.error || null,
      catalog_listed: this.catalog.listed ?? 0,
      catalog_source: this.catalog.source || null,
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
      location: vertexLocationOf(hydrated),
      project_id: vertexProjectOf(hydrated) || this.defaultProject || null,
    };
  }

  findAccount(id) {
    const wanted = String(id || "").trim().toLowerCase();
    return this.accounts().find((item) => accountIdOf(item) === wanted || String(item.email || "").toLowerCase() === wanted) || null;
  }

  setEnabled(id, enabled) {
    const match = this.findAccount(id);
    if (!match) throw new AuthRequiredError(`No saved Vertex key matching ${id}`);
    const next = setAccountEnabled(match, enabled);
    this.store.save(createVertexBundle(next), { activate: enabled });
    if (enabled) this.store.use(accountIdOf(next));
    else if (accountIdOf(this.store.load()) === accountIdOf(next)) {
      const fallback = this.accounts().find((item) => !isManuallyDisabled(item) && vertexApiKeyOf(item) && accountIdOf(item) !== accountIdOf(next));
      if (fallback) this.store.use(accountIdOf(fallback));
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
    this.store.save(createVertexBundle(touchAccountStats(current, { ok, prompt, completion })), { activate: false });
  }

  headers(bundle) {
    return {
      [VERTEX_API_KEY_HEADER]: vertexApiKeyOf(bundle),
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": VERTEX_USER_AGENT,
    };
  }

  addAccount({ apiKey, location, project, projectId, label } = {}) {
    const key = String(apiKey || "").trim();
    if (!key) throw new HttpError(400, "Vertex API key is required", { type: "invalid_request_error" });
    const bundle = createVertexBundle({
      api_key: key,
      location: location || this.defaultLocation,
      project_id: project || projectId || this.defaultProject,
      label,
      enabled: true,
      expires_at: 4_000_000_000,
    });
    this.store.save(bundle);
    this.rememberCatalog({ models: loadStaticVertexCatalog(), source: "express" });
    this.warmAccount(this.store.load()).catch(() => {});
    return hydrateVertexBundle(this.store.load());
  }

  async completeLogin(body) {
    return this.addAccount(body);
  }

  async login({ apiKey, location, project, projectId, label } = {}) {
    if (!apiKey) throw new AuthRequiredError("Vertex Express Mode needs an API key. Paste it in the dashboard or: node src/cli.js login-vertex --key AQ....");
    return this.addAccount({ apiKey, location, project, projectId, label });
  }

  async switchAccount(id) {
    const match = this.store.use(id);
    if (!match) throw new AuthRequiredError(`No saved Vertex key matching ${id}`);
    this.rememberCatalog({ models: loadStaticVertexCatalog(), source: "express" });
    return hydrateVertexBundle(match);
  }

  async removeAccount(id) {
    const ok = this.store.remove(id);
    if (!ok) throw new AuthRequiredError(`No saved Vertex key matching ${id}`);
    this.rememberCatalog({ models: loadStaticVertexCatalog(), source: "express" });
    return this.accounts();
  }

  requireBundle({ exclude = [], sessionKey = null } = {}) {
    const skip = new Set([...exclude].map((id) => String(id || "").toLowerCase()).filter(Boolean));
    const accounts = this.accounts();
    const current = this.activeAccount();
    // Enabled keys stay in the pool. Dashboard "ready"/last-used and leftover disabled_until
    // parks must not hide a key the user left enabled.
    const usable = (item) => vertexApiKeyOf(item) && !isManuallyDisabled(item) && !skip.has(accountIdOf(item));
    const pool = accounts.filter(usable);
    if (!pool.length) {
      if (!accounts.length) throw new AuthRequiredError("Vertex login required. Add an Express Mode API key.");
      throw new AuthRequiredError("All Vertex keys are disabled. Enable one in the dashboard.");
    }
    const minBusy = Math.min(...pool.map((item) => this.inFlightOf(item)));
    // Preserve conversation-to-project affinity so Google Vertex's implicit prefix KV-cache
    // (systemInstruction + tools + prior turns) stays warm on the same GCP project, while
    // concurrent conversations from other VS Code windows spread onto idle keys.
    const pinnedId = this.pinnedAccountFor(sessionKey);
    if (pinnedId) {
      const pinned = pool.find((item) => accountIdOf(item) === pinnedId);
      if (pinned && this.inFlightOf(pinned) <= minBusy) return pinned;
    }
    if (usable(current) && this.inFlightOf(current) <= minBusy) return current;
    const next = pool
      .slice()
      .sort((a, b) => this.inFlightOf(a) - this.inFlightOf(b) || (a.last_used || 0) - (b.last_used || 0))[0];
    if (!current || (this.inFlightOf(current) === 0 && accountIdOf(next) !== accountIdOf(current))) {
      this.store.use(accountIdOf(next));
    }
    return next;
  }

  async readyBundle({ exclude = [] } = {}) {
    return this.requireBundle({ exclude });
  }

  markFailed(bundle, err) {
    const reason = String(err?.code || err?.message || "upstream").slice(0, 180);
    const failedId = accountIdOf(bundle);
    // Remember why this key failed for the dashboard, but never lock an enabled key
    // out of the pool. The next enabled key is used automatically.
    this.store.save(createVertexBundle({
      ...hydrateVertexBundle(bundle),
      disabled_until: 0,
      disabled_reason: reason,
    }), { activate: false });
    const next = this.accounts()
      .filter((item) => vertexApiKeyOf(item) && !isManuallyDisabled(item) && accountIdOf(item) !== failedId)
      .sort((a, b) => this.inFlightOf(a) - this.inFlightOf(b) || (a.last_used || 0) - (b.last_used || 0))[0];
    if (next) {
      this.store.use(accountIdOf(next));
      this.rememberCatalog({ models: loadStaticVertexCatalog(), source: "express" });
    }
    return next || null;
  }

  enableAccount(id) {
    return this.setEnabled(id, true);
  }

  raiseUpstream(response) {
    let message = response.body || "";
    let code;
    let payload = response.parsed;
    if (payload === undefined && response.body) {
      try {
        payload = JSON.parse(response.body);
      } catch {
        payload = undefined;
      }
    }
    if (payload && typeof payload === "object") {
      if (payload.error && typeof payload.error === "object") {
        message = String(payload.error.message || message);
        code = payload.error.status || payload.error.code;
      } else if (payload.message) {
        message = String(payload.message);
      }
    }
    const retryAfter = response.headers?.["retry-after"] ?? response.headers?.["Retry-After"];
    let retryAfterMs = 0;
    if (retryAfter != null && retryAfter !== "") {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) retryAfterMs = Math.round(seconds * 1000);
      else {
        const when = Date.parse(String(retryAfter));
        if (!Number.isNaN(when)) retryAfterMs = Math.max(0, when - Date.now());
      }
    }
    throw new UpstreamError(response.status, message, code ? String(code) : undefined, {
      retryAfterMs,
      headers: response.headers || null,
    });
  }

  async post(url, payload, { stream = false, maxPasses = 5, retryDelayMs = 1500, sessionKey = null } = {}) {
    let lastError;
    let recoveredOnce = false;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const tried = new Set();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        let bundle;
        try {
          bundle = this.requireBundle({ exclude: tried, sessionKey });
        } catch (err) {
          if (!lastError) lastError = err;
          break;
        }
        const id = accountIdOf(bundle);
        if (tried.has(id)) break;
        tried.add(id);
        const releaseSlot = this.acquireSlot(bundle);
        const target = this.rewriteUrl(url, bundle);
        let response;
        try {
          response = await this.send(target, payload, bundle, { stream });
        } catch (err) {
          releaseSlot();
          lastError = err;
          this.recordUsage(bundle, { ok: false });
          if (isRetryableUpstreamError(err) && this.markFailed(bundle, err)) continue;
          if (isRetryableUpstreamError(err) && pass + 1 < maxPasses) break;
          err.retriedUpstream = pass > 0 || tried.size > 1;
          throw err;
        }
        if (response.status < 400) {
          this.rememberSessionAccount(sessionKey, bundle);
          response.bundle = bundle;
          response.releaseSlot = releaseSlot;
          if (!stream) releaseSlot();
          return response;
        }
        if (stream && response.stream) {
          const chunks = [];
          try {
            for await (const chunk of response.stream) chunks.push(chunk);
          } finally {
            releaseSlot();
          }
          response.body = Buffer.concat(chunks).toString("utf8");
          try {
            response.parsed = JSON.parse(response.body);
          } catch {
            response.parsed = undefined;
          }
        } else {
          releaseSlot();
        }
        try {
          this.raiseUpstream(response);
        } catch (err) {
          lastError = err;
          this.recordUsage(bundle, { ok: false });
          if (!recoveredOnce) {
            const recovered = this.recoverPublisherMiss(bundle, err, url);
            if (recovered) {
              recoveredOnce = true;
              tried.delete(id);
              url = recovered.url;
              continue;
            }
          }
          if (this.settings.debugRequests) {
            console.warn(`[vertex] key=${bundle.email || id} status=${err.status} code=${err.code || ""} msg=${String(err.message || "").slice(0, 140)}`);
          }
          if (isRetryableUpstreamError(err) && this.markFailed(bundle, err)) continue;
          if (isRetryableUpstreamError(err) && pass + 1 < maxPasses) break;
          err.retriedUpstream = pass > 0 || tried.size > 1;
          throw err;
        }
      }
      if (!lastError || !isRetryableUpstreamError(lastError) || pass + 1 >= maxPasses) break;
      // Exponential backoff per Google's js-genai SDK (1.5s, 3s, 6s, 12s, capped at 30s) so a
      // 60-second Vertex TPM/RPM window resets instead of failing the turn with 429.
      const expWait = retryDelayMs * (2 ** pass);
      const waitMs = Math.min(30_000, Math.max(expWait, Number(lastError.retryAfterMs || 0)));
      if (this.settings.debugRequests) {
        console.warn(`[vertex] pass ${pass + 1}/${maxPasses} exhausted (${lastError.code || lastError.message}); backing off ${waitMs}ms`);
      }
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    if (lastError) lastError.retriedUpstream = true;
    throw lastError || new AuthRequiredError("Vertex login required. Add an Express Mode API key.");
  }

  rewriteUrl(url, bundle) {
    const scoped = withVertexProjectPath(url, this.routeOpts(bundle));
    if (this.settings.vertexBaseUrl) return scoped;
    try {
      const parsed = new URL(scoped);
      const next = new URL(this.baseUrlFor(bundle));
      parsed.protocol = next.protocol;
      parsed.host = next.host;
      return parsed.toString();
    } catch {
      return scoped;
    }
  }

  routeOpts(bundle) {
    const hydrated = hydrateVertexBundle(bundle || this.activeAccount());
    return {
      project: vertexProjectOf(hydrated) || this.defaultProject,
      location: vertexLocationOf(hydrated) || this.defaultLocation,
    };
  }

  rememberProject(bundle, project) {
    const current = hydrateVertexBundle(bundle || this.activeAccount());
    if (!current || !project || vertexProjectOf(current) === String(project)) return current;
    const next = createVertexBundle({ ...current, project_id: project });
    this.store.save(next, { activate: false });
    return this.findAccount(accountIdOf(next)) || next;
  }

  recoverPublisherMiss(bundle, err, url) {
    const parsed = parseVertexPublisherError({ parsed: { error: { message: err?.message } }, body: err?.message });
    if (!parsed?.project) return null;
    if (vertexProjectOf(bundle)) return null;
    const next = this.rememberProject(bundle, parsed.project);
    return { bundle: next, url: this.rewriteUrl(url, next) };
  }

  send(url, payload, bundle, { stream = false } = {}) {
    const body = JSON.stringify(payload);
    const headers = this.headers(bundle);
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
    const cached = this.modelsCache?.models || [];
    if (!this.settings.liveModels) {
      const models = cached.length ? cached : loadStaticVertexCatalog();
      if (!cached.length) this.rememberCatalog({ models, source: "express" });
      return models;
    }
    if (this.catalog.error) return cached.length ? cached : loadStaticVertexCatalog();
    if (!refresh && cached.length && now - (this.modelsCache.at || 0) < this.modelsTtlMs) {
      return cached;
    }
    if (!refresh && cached.length) {
      this.refreshLiveModels().catch(() => {});
      return cached;
    }
    return this.refreshLiveModels();
  }

  modelsListUrl(bundle, pageToken = "") {
    const url = new URL(this.versioned(this.baseUrlFor(bundle), vertexModelsPath(this.routeOpts(bundle))));
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    return url.toString();
  }

  async listAllPublisherModels(bundle) {
    const collected = [];
    let pageToken = "";
    for (let page = 0; page < 20; page += 1) {
      const response = await requestJson(this.modelsListUrl(bundle, pageToken), {
        method: "GET",
        headers: this.headers(bundle),
        timeoutMs: Math.min(this.settings.requestTimeoutMs, 20_000),
      });
      if (response.status >= 400) {
        if (!collected.length) this.raiseUpstream({ ...response, parsed: response.parsed, body: response.body });
        break;
      }
      collected.push(...parseVertexModels(response.parsed || {}));
      pageToken = nextPageTokenOf(response.parsed || {});
      if (!pageToken) break;
    }
    return mergeVertexCatalog([], collected);
  }

  async refreshLiveModels() {
    if (this.catalogPromise) return this.catalogPromise;
    this.catalogPromise = (async () => {
      try {
        const bundle = this.requireBundle();
        const models = await this.listAllPublisherModels(bundle);
        return this.rememberCatalog({ models, source: "live" });
      } catch (err) {
        return this.rememberCatalog({ models: loadStaticVertexCatalog(), error: err, source: "express" });
      } finally {
        this.catalogPromise = null;
      }
    })();
    return this.catalogPromise;
  }

  async resolveRequestModel(body) {
    const catalog = await this.fetchModels();
    return resolveVertexRoute(body, catalog);
  }

  async fetchQuotasFor(bundle) {
    return bundle?.quotas || [];
  }

  async refreshAccountQuotas(id) {
    const match = this.findAccount(id);
    if (!match) throw new AuthRequiredError(`No saved Vertex key matching ${id}`);
    try {
      await this.refreshLiveModels();
    } catch {
      // listing is enough to prove the key still works
    }
    return this.accountSummary(this.findAccount(id) || match);
  }

  async listAccountViews({ refresh: _refresh = false } = {}) {
    return this.accounts().map((bundle) => this.accountSummary(bundle));
  }

  async warmAccount(bundle) {
    if (!vertexApiKeyOf(bundle)) return bundle;
    try {
      await this.refreshLiveModels();
    } catch {
      // catalog can wait
    }
    return this.findAccount(accountIdOf(bundle)) || bundle;
  }

  generateUrl(model, bundle) {
    const active = bundle || this.activeAccount();
    return this.versioned(this.baseUrlFor(active), vertexGeneratePath(model, this.routeOpts(active)));
  }

  streamUrl(model, bundle) {
    const active = bundle || this.activeAccount();
    return this.versioned(this.baseUrlFor(active), vertexStreamPath(model, this.routeOpts(active)));
  }

  describeContents(contents) {
    return (contents || []).map((turn, index) => ({
      i: index,
      role: turn?.role,
      parts: (turn?.parts || []).map((part) => {
        if (!part || typeof part !== "object") return { empty: true };
        if (part.functionCall) return { functionCall: part.functionCall.name };
        if (part.functionResponse) return { functionResponse: part.functionResponse.name };
        if (part.inlineData || part.inline_data) return { inlineData: (part.inlineData || part.inline_data).mimeType || true };
        if (part.fileData || part.file_data) return { fileData: true };
        if (part.thought) return { thought: String(part.text || "").length };
        if (typeof part.text === "string") return { text: part.text.length };
        return { keys: Object.keys(part) };
      }),
    }));
  }

  async generate(wrapped, { onBundle } = {}) {
    const body = vertexHttpBody(wrapped);
    if (this.settings.debugRequests) {
      console.log(`[vertex] generate ${wrapped.model} session=${wrapped.sessionKey || "-"} last=${body.contents?.at?.(-1)?.role} turns=${this.describeContents(body.contents).map((t) => `${t.role}:${t.parts.map((p) => Object.keys(p)[0]).join("+")}`).join(",")}`);
    }
    const response = await this.post(this.generateUrl(wrapped.model), body, { sessionKey: wrapped.sessionKey });
    onBundle?.(response.bundle);
    return response.body ? JSON.parse(response.body) : {};
  }

  async *stream(wrapped, { onBundle } = {}) {
    const body = vertexHttpBody(wrapped);
    const t0 = Date.now();
    if (this.settings.debugRequests) {
      console.log(`[vertex] stream ${wrapped.model} session=${wrapped.sessionKey || "-"} last=${body.contents?.at?.(-1)?.role} turns=${this.describeContents(body.contents).map((t) => `${t.role}:${t.parts.map((p) => Object.keys(p)[0]).join("+")}`).join(",")}`);
    }
    const response = await this.post(this.streamUrl(wrapped.model), body, { stream: true, sessionKey: wrapped.sessionKey });
    const usedKey = response.bundle?.email || accountIdOf(response.bundle);
    if (this.settings.debugRequests) {
      console.log(`[vertex] stream ${wrapped.model} key=${usedKey} session=${wrapped.sessionKey || "-"} headers=${Date.now() - t0}ms status=${response.status}`);
    }
    onBundle?.(response.bundle);
    let chunks = 0;
    let promptTokens = 0;
    let cachedTokens = 0;
    let outputTokens = 0;
    try {
      for await (const event of iterateSse(response.stream, {
        onFirstBytes: () => {
          if (this.settings.debugRequests) {
            console.log(`[vertex] stream ${wrapped.model} key=${usedKey} first-chunk=${Date.now() - t0}ms`);
          }
        },
      })) {
        chunks += 1;
        const meta = event?.usageMetadata || event?.response?.usageMetadata;
        if (meta) {
          if (meta.promptTokenCount) promptTokens = meta.promptTokenCount;
          if (meta.cachedContentTokenCount) cachedTokens = meta.cachedContentTokenCount;
          if (meta.candidatesTokenCount) outputTokens = meta.candidatesTokenCount;
        }
        yield event;
      }
    } finally {
      if (this.settings.debugRequests) {
        const hitPct = promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0;
        console.log(`[vertex] stream ${wrapped.model} key=${usedKey} done=${Date.now() - t0}ms events=${chunks} prompt=${promptTokens} cached=${cachedTokens}(${hitPct}%) out=${outputTokens}`);
      }
      response.releaseSlot?.();
      response.stream?.resume();
    }
  }

  async chatCompletions(body) {
    const resolved = await this.resolveRequestModel(body);
    let usedBundle = null;
    const payload = await this.generate(openaiToVertex(body, resolved), { onBundle: (b) => { usedBundle = b; } });
    const out = geminiToOpenai(payload, resolved.model);
    this.recordUsage(usedBundle || this.store.load(), { ok: true, prompt: out.usage?.prompt_tokens, completion: out.usage?.completion_tokens });
    return out;
  }

  async *chatCompletionsStream(body) {
    const resolved = await this.resolveRequestModel(body);
    const acc = new StreamAccumulator(resolved.model);
    let usedBundle = null;
    for await (const event of this.stream(openaiToVertex(body, resolved), { onBundle: (b) => { usedBundle = b; } })) {
      for (const chunk of acc.ingest(event)) yield `data: ${JSON.stringify(chunk)}\n\n`;
    }
    for (const chunk of acc.finish()) yield `data: ${JSON.stringify(chunk)}\n\n`;
    this.recordUsage(usedBundle || this.store.load(), { ok: true, prompt: acc.usage?.prompt_tokens, completion: acc.usage?.completion_tokens });
    yield "data: [DONE]\n\n";
  }

  async messages(body) {
    const resolved = await this.resolveRequestModel(body);
    let usedBundle = null;
    const payload = await this.generate(anthropicToVertex(body, resolved), { onBundle: (b) => { usedBundle = b; } });
    const out = geminiToAnthropic(payload, resolved.model);
    this.recordUsage(usedBundle || this.store.load(), { ok: true, prompt: out.usage?.input_tokens, completion: out.usage?.output_tokens });
    return out;
  }

  async *messagesStream(body) {
    const resolved = await this.resolveRequestModel(body);
    const wrapped = anthropicToVertex(body, resolved);
    let usedBundle = null;
    const acc = yield* streamAnthropicMessages({
      open: () => this.stream(wrapped, { onBundle: (b) => { usedBundle = b; } }),
      makeAccumulator: () => new AnthropicStreamAccumulator(resolved.model),
      log: (msg) => console.warn(`[vertex] ${resolved.model}: ${msg}`),
    });
    this.recordUsage(usedBundle || this.store.load(), { ok: true, prompt: acc.usage?.input_tokens, completion: acc.usage?.output_tokens });
  }

  async responses(body) {
    const prepared = this.prepareResponses(body);
    const chat = await this.chatCompletions(prepared.chat);
    return this.persistResponses(prepared, chat);
  }

  async *responsesStream(body) {
    const prepared = this.prepareResponses(body);
    const resolved = await this.resolveRequestModel(prepared.chat);
    const acc = new ResponsesStreamAccumulator({
      id: prepared.id,
      model: resolved.model,
      previousId: prepared.previousId,
    });
    let opened = false;
    for await (const event of this.stream(openaiToVertex(prepared.chat, resolved))) {
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
        model: resolved.model,
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
