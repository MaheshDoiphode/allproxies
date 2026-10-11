(() => {
  const TOKEN_KEY = "ap_admin_token";
  const PREFIX_KEY = "ap_guide_prefixed";
  const HIDDEN_KEY = "ap_hidden_models";
  const CLAUDE_KEY = "ap_claude_picks";
  const CLAUDE_1M_KEY = "ap_claude_1m";
  const CODEX_KEY = "ap_codex_model";
  const selected = new Set();
  let accounts = [];
  let models = [];
  let catalogs = {};
  let guides = null;
  let hiddenModels = new Set();
  let claudePicks = {};
  let claudeMillion = {};
  let codexModel = "";
  let pollTimer = null;

  const $ = (id) => document.getElementById(id);
  const token = () => localStorage.getItem(TOKEN_KEY) || "";

  function toast(msg) {
    const el = document.createElement("div");
    el.textContent = msg;
    el.style.cssText = "position:fixed;bottom:16px;right:16px;background:#111;color:#fff;padding:8px 12px;border-radius:8px;z-index:9";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (token()) headers["X-Admin-Token"] = token();
    if (options.body && typeof options.body !== "string") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch("/admin/api" + path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || data.error || res.statusText);
    return data;
  }

  function applyTheme(pref) {
    const dark = pref === "dark" || (pref !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("ap_theme", pref);
  }

  function nextTheme() {
    const cur = localStorage.getItem("ap_theme") || "system";
    applyTheme(cur === "system" ? "dark" : cur === "dark" ? "light" : "system");
  }

  function pct(used, remaining) {
    if (used != null) return Math.max(0, Math.min(100, used * 100));
    if (remaining != null) return Math.max(0, Math.min(100, (1 - remaining) * 100));
    return 0;
  }

  function fmtReset(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const delta = t - Date.now();
    if (delta <= 0) return "reset due";
    const m = Math.round(delta / 60000);
    if (m < 60) return `resets in ${m}m`;
    const h = Math.round(m / 60);
    if (h < 36) return `resets in ${h}h`;
    return `resets ${new Date(t).toLocaleString()}`;
  }

  function windowLabel(q) {
    return ({ hourly: "Hourly", "5h": "5 hour", daily: "Daily", weekly: "Weekly", monthly: "Monthly" }[q.window] || q.label || "Quota");
  }

  function renderQuotas(list) {
    if (!list || !list.length) return '<div class="muted">No quota windows yet. Refresh after the account is used.</div>';
    return '<div class="quotas">' + list.map((q) => {
      const used = pct(q.used, q.remaining);
      const klass = used > 90 ? "critical" : used > 70 ? "high" : "";
      const remain = q.remaining == null ? "—" : Math.round(q.remaining * 100) + "% left";
      return `<div class="quota">
        <div class="quota-row"><span>${escapeHtml(windowLabel(q))}</span><span>${remain}</span></div>
        <div class="bar ${klass}"><span style="width:${used}%"></span></div>
        <div class="quota-meta">${escapeHtml(q.label || "")} ${escapeHtml(fmtReset(q.reset_time))}</div>
      </div>`;
    }).join("") + "</div>";
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function statusBadge(a) {
    if (a.enabled === false) return '<span class="badge">disabled</span>';
    if (a.limited) return '<span class="badge warn">limited</span>';
    if (a.expired) return '<span class="badge warn">refreshing…</span>';
    return '<span class="badge ok">ready</span>';
  }

  function projectBadge(a) {
    if (a.project) return `<span class="badge">${escapeHtml(a.project)}</span>`;
    if (!a.quotas_at) return '<span class="badge warn">onboarding…</span>';
    return '<span class="badge warn">no project</span>';
  }

  function accountProvider(a) {
    return a.provider || "antigravity";
  }

  function filtered() {
    const q = ($("filterSearch")?.value || "").toLowerCase();
    const st = $("filterStatus")?.value || "all";
    const provider = $("filterProvider")?.value || "all";
    return accounts.filter((a) => {
      if (provider !== "all" && accountProvider(a) !== provider) return false;
      if (q && !(a.email || a.id || "").toLowerCase().includes(q)) return false;
      if (st === "enabled" && a.enabled === false) return false;
      if (st === "disabled" && a.enabled !== false) return false;
      if (st === "limited" && !a.limited) return false;
      return true;
    });
  }

  function renderAccountCard(a) {
    const id = `${accountProvider(a)}:${a.id}`;
    const checked = selected.has(id) ? "checked" : "";
    return `<article class="account-card ${selected.has(id) ? "selected" : ""}" data-id="${escapeHtml(id)}">
      <div class="account-head">
        <div>
          <label class="check"><input type="checkbox" class="pick" data-id="${escapeHtml(id)}" ${checked} />
            <span class="account-email">${escapeHtml(a.email || id)}</span>
          </label>
          <div class="account-meta">
            ${a.active ? '<span class="badge ok">last used</span>' : ""}
            ${statusBadge(a)}
            ${accountProvider(a) === "chatgpt" ? `<span class="badge">${escapeHtml(a.plan || "chatgpt")}</span>` : projectBadge(a)}
            <span class="badge">${a.request_count || 0} req</span>
          </div>
        </div>
        <div class="account-actions">
          <button class="btn btn-sm" data-act="refresh" data-id="${escapeHtml(id)}">Refresh</button>
          <button class="btn btn-sm" data-act="use" data-id="${escapeHtml(id)}">Use</button>
          <button class="btn btn-sm" data-act="toggle" data-id="${escapeHtml(id)}">${a.enabled === false ? "Enable" : "Disable"}</button>
          <button class="btn btn-sm danger" data-act="delete" data-id="${escapeHtml(id)}">Delete</button>
        </div>
      </div>
      ${renderQuotas(a.quotas)}
    </article>`;
  }

  function accountGroupEmpty(id) {
    if (id === "chatgpt") return "No ChatGPT accounts. Add ChatGPT account to load gpt-* / o-series models.";
    if (id === "vertex") return "No Vertex key. Add a Vertex Express key to use vertex/… models.";
    return "No Antigravity accounts. Add a Google Pro account.";
  }

  function renderAccounts() {
    const root = $("accountsList");
    if (!root) return;
    const rows = filtered();
    const groups = [
      { id: "antigravity", title: "Antigravity", hint: "Cloud Code / Copilot Gemini via Google login" },
      { id: "chatgpt", title: "ChatGPT / Codex", hint: "gpt-* and o-series from a ChatGPT login" },
      { id: "vertex", title: "Vertex AI", hint: "Express Mode API key (AQ.)" },
    ];
    const leftover = rows.filter((a) => !groups.some((g) => g.id === accountProvider(a)));
    if (!accounts.length) {
      root.innerHTML = '<div class="empty">No accounts yet. Add a Google, ChatGPT, or Vertex login.</div>';
      $("batchBar")?.classList.toggle("hidden", true);
      return;
    }
    root.innerHTML = groups.concat(leftover.length ? [{ id: "other", title: "Other", hint: "" }] : []).map((group) => {
      const list = group.id === "other" ? leftover : rows.filter((a) => accountProvider(a) === group.id);
      const empty = !list.length ? accountGroupEmpty(group.id) : "";
      return `<section class="account-group">
        <div class="model-group-head">
          <h3>${escapeHtml(group.title)} <span class="muted">${list.length}</span></h3>
          ${group.hint ? `<p class="muted">${escapeHtml(group.hint)}</p>` : ""}
        </div>
        ${list.length ? list.map(renderAccountCard).join("") : `<div class="empty">${escapeHtml(empty)}</div>`}
      </section>`;
    }).join("");
    $("batchBar")?.classList.toggle("hidden", selected.size === 0);
  }

  function renderStats(status) {
    const items = status.items || accounts;
    const available = items.filter((a) => a && !a.disabled).length;
    $("statAccounts").textContent = items.length;
    $("statAvailable").textContent = `${available} available`;
    const stats = status.stats || {};
    $("statRequests").textContent = stats.requests || 0;
    $("statTokens").textContent = `${(stats.prompt_tokens || 0) + (stats.completion_tokens || 0)} tokens`;
    $("statSuccess").textContent = stats.success || 0;
    const total = stats.requests || 0;
    $("statSuccessRate").textContent = total ? Math.round(((stats.success || 0) / total) * 100) + "%" : "0%";
    $("statFailed").textContent = stats.failed || 0;
    $("statActive").textContent = status.active?.email ? `last used ${status.active.email}` : "no accounts in use";
  }

  function modelProvider(m) {
    return m.provider || m.owned_by || (m.family === "gpt" ? "chatgpt" : "antigravity");
  }

  function renderModelTable(list) {
    if (!list.length) return "";
    return `<div class="table-wrap"><table><thead><tr><th>Setup</th><th>Id</th><th>Name</th><th>Family</th><th>Think</th><th>Images</th><th>Source</th><th>Quota left</th></tr></thead><tbody>${
      list.map((m) => `<tr class="${hiddenModels.has(m.id) ? "hidden-model" : ""}">
        <td><label class="check"><input type="checkbox" class="setup-vis" data-id="${escapeHtml(m.id)}" ${hiddenModels.has(m.id) ? "" : "checked"} /></label></td>
        <td><code>${escapeHtml(m.id)}</code></td>
        <td>${escapeHtml(m.name || "")}</td>
        <td>${escapeHtml(m.family || "")}</td>
        <td>${m.supports_thinking ? "yes" : ""}</td>
        <td>${m.supports_images === false ? "" : "yes"}</td>
        <td>${escapeHtml(m.source || "")}</td>
        <td>${m.remaining_fraction == null ? "—" : Math.round(m.remaining_fraction * 100) + "%"}</td>
      </tr>`).join("")
    }</tbody></table></div>`;
  }

  function providerAccounts(id) {
    return accounts.filter((a) => accountProvider(a) === id);
  }

  function vertexCatalogNote() {
    const src = catalogs?.vertex?.source;
    if (src === "express" || catalogs?.vertex?.error) {
      return "Express Mode has no list API. These are Google's documented Express models — copy an id into Setup or any client. Other Vertex ids still work as vertex/<id>.";
    }
    return "Live publisher catalog. Use vertex/model-name.";
  }

  function modelGroupEmpty(id) {
    const listed = providerAccounts(id);
    const enabled = listed.filter((a) => a.enabled !== false && !a.disabled);
    if (id === "chatgpt") {
      if (!listed.length) return "No ChatGPT account. Add one on the Accounts tab to load gpt-* / o-series models.";
      if (!enabled.length) return "ChatGPT account is disabled. Enable it on the Accounts tab to load models.";
      return catalogs?.chatgpt?.error || "ChatGPT catalog is empty. Refresh after the account is ready.";
    }
    if (id === "vertex") {
      if (!listed.length) return "No Vertex key. Add an Express Mode key on the Accounts tab.";
      if (!enabled.length) return "Vertex key is disabled. Enable it on the Accounts tab to use vertex/… models.";
      return catalogs?.vertex?.error || "No Vertex models listed.";
    }
    if (!listed.length) return "No Antigravity account. Add a Google Pro login on the Accounts tab.";
    if (!enabled.length) return "Antigravity account is disabled. Enable it on the Accounts tab to load models.";
    return "No Antigravity models listed.";
  }

  function renderModels() {
    const root = $("modelsList");
    if (!root) return;
    const groups = [
      { id: "antigravity", title: "Antigravity", hint: "Cloud Code / Copilot Gemini via Google login" },
      { id: "chatgpt", title: "ChatGPT / Codex", hint: "gpt-* and o-series from a ChatGPT login" },
      { id: "vertex", title: "Vertex AI", hint: vertexCatalogNote() },
    ];
    const leftover = models.filter((m) => !groups.some((g) => g.id === modelProvider(m)));
    const intro = $("modelsIntro");
    if (intro) {
      const hidden = models.filter((m) => hiddenModels.has(m.id)).length;
      intro.textContent = `${models.length} models · ${hidden} hidden from Setup · ${groups.map((g) => `${g.title} ${models.filter((m) => modelProvider(m) === g.id).length}`).join(" · ")}`;
    }
    root.innerHTML = groups.concat(leftover.length ? [{ id: "other", title: "Other", hint: "" }] : []).map((group) => {
      const list = group.id === "other" ? leftover : models.filter((m) => modelProvider(m) === group.id);
      return `<section class="model-group">
        <div class="model-group-head">
          <h3>${escapeHtml(group.title)} <span class="muted">${list.length}</span></h3>
          ${group.hint ? `<p class="muted">${escapeHtml(group.hint)}</p>` : ""}
        </div>
        ${list.length ? renderModelTable(list) : `<div class="empty">${escapeHtml(modelGroupEmpty(group.id))}</div>`}
      </section>`;
    }).join("");
  }

  async function loadAll(refresh = false) {
    const status = await api("/status" + (refresh ? "?refresh=1" : ""));
    accounts = status.items || [];
    if (status.vertex_catalog) catalogs = { ...catalogs, vertex: status.vertex_catalog };
    renderStats(status);
    renderAccounts();
    if (refresh) scheduleFollowup();
  }

  let followTimer = null;
  function scheduleFollowup() {
    clearInterval(followTimer);
    let n = 0;
    followTimer = setInterval(async () => {
      n += 1;
      try {
        const status = await api("/status");
        accounts = status.items || [];
        renderStats(status);
        renderAccounts();
      } catch {
        // ignore transient poll errors
      }
      if (n >= 8) clearInterval(followTimer);
    }, 750);
  }

  async function loadModels() {
    const payload = await api("/models?refresh=1");
    if (Array.isArray(payload)) {
      models = payload;
      catalogs = {};
    } else {
      models = payload?.models || [];
      catalogs = payload?.catalogs || {};
    }
    renderModels();
  }

  function pretty(value) {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  function currentVscodeSnippet() {
    const kind = $("vscodeApiType")?.value || "messages";
    return guides?.vscode?.[kind] || {};
  }

  function renderGuides() {
    if (!guides) return;
    if ($("vscodeJson")) $("vscodeJson").textContent = pretty(currentVscodeSnippet());
    if ($("claudeJson")) $("claudeJson").textContent = pretty(guides.claude_code);
    if ($("codexToml")) $("codexToml").textContent = guides.codex || "";
    if ($("endpointsJson")) $("endpointsJson").textContent = pretty(guides.endpoints);
    if ($("guideIntro")) {
      $("guideIntro").textContent = `Base ${guides.base_url} · token ${guides.auth_token} · ${guides.vscode?.messages?.models?.length || 0} models`;
    }
  }

  function restorePrefixed() {
    const box = $("guidePrefixed");
    if (!box) return;
    box.checked = localStorage.getItem(PREFIX_KEY) === "1";
  }

  function persistPrefixed() {
    const box = $("guidePrefixed");
    if (!box) return;
    localStorage.setItem(PREFIX_KEY, box.checked ? "1" : "0");
  }

  function loadPrefs() {
    restorePrefixed();
    try {
      hiddenModels = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]"));
    } catch {
      hiddenModels = new Set();
    }
    try {
      claudePicks = JSON.parse(localStorage.getItem(CLAUDE_KEY) || "{}") || {};
    } catch {
      claudePicks = {};
    }
    try {
      claudeMillion = JSON.parse(localStorage.getItem(CLAUDE_1M_KEY) || "{}") || {};
    } catch {
      claudeMillion = {};
    }
    codexModel = localStorage.getItem(CODEX_KEY) || "";
  }

  function persistHidden() {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenModels]));
  }

  function persistClaude() {
    localStorage.setItem(CLAUDE_KEY, JSON.stringify(claudePicks));
    localStorage.setItem(CLAUDE_1M_KEY, JSON.stringify(claudeMillion));
  }

  function persistCodex() {
    localStorage.setItem(CODEX_KEY, codexModel || "");
  }

  function supportsMillion(id) {
    return Boolean((guides?.choices || []).find((item) => item.id === id)?.million);
  }

  function modelOptions(selected) {
    const choices = guides?.choices || [];
    return choices.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHtml(item.name)} (${escapeHtml(item.id)})</option>`).join("");
  }

  function renderClaudePicks() {
    const root = $("claudePicks");
    if (!root) return;
    const slots = guides?.claude_slots || [];
    const defaults = guides?.claude_defaults || {};
    root.innerHTML = slots.map((slot) => {
      const selected = claudePicks[slot.key] || defaults[slot.key] || "";
      const checked = claudeMillion[slot.key] ? "checked" : "";
      return `<div class="pick-row">
        <span>${escapeHtml(slot.label)}</span>
        <select data-claude="${escapeHtml(slot.key)}">${modelOptions(selected)}</select>
        <label class="check"><input type="checkbox" class="claude-1m-toggle" data-slot="${escapeHtml(slot.key)}" ${checked} /> 1M</label>
      </div>`;
    }).join("");
  }

  function renderCodexPicks() {
    const root = $("codexPicks");
    if (!root) return;
    const selected = codexModel || guides?.codex_default || "";
    root.innerHTML = `<div class="pick-row">
      <span>Model</span>
      <select id="codexModel">${modelOptions(selected)}</select>
      <span></span>
    </div>`;
  }

  function currentClaudeSettings() {
    if (!guides?.claude_code) return {};
    const next = JSON.parse(JSON.stringify(guides.claude_code));
    const env = next.env || {};
    const slots = {
      model: "ANTHROPIC_MODEL",
      sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
      opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
      haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      fast: "ANTHROPIC_SMALL_FAST_MODEL",
      subagent: "CLAUDE_CODE_SUBAGENT_MODEL",
    };
    const defaults = guides.claude_defaults || {};
    for (const [key, envKey] of Object.entries(slots)) {
      const picked = claudePicks[key] || defaults[key] || env[envKey] || "";
      let base = String(picked).replace(/\[1m\]$/i, "");
      if (claudeMillion[key] && base) base += "[1m]";
      env[envKey] = base;
    }
    next.env = env;
    return next;
  }

  function currentCodexConfig() {
    if (!guides?.codex) return "";
    const picked = codexModel || guides.codex_default || "";
    if (!picked) return guides.codex;
    return guides.codex.replace(/^model\s*=\s*"[^"]*"/m, `model = "${picked.replace(/"/g, '\\"')}"`);
  }

  function renderGuideSnippets() {
    if (!guides) return;
    if ($("vscodeJson")) $("vscodeJson").textContent = pretty(currentVscodeSnippet());
    if ($("claudeJson")) $("claudeJson").textContent = pretty(currentClaudeSettings());
    if ($("codexToml")) $("codexToml").textContent = currentCodexConfig();
    if ($("guideIntro")) {
      $("guideIntro").textContent = `Base ${guides.base_url} · token ${guides.auth_token} · ${guides.vscode?.messages?.models?.length || 0} models`;
    }
  }

  function renderGuides() {
    if (!guides) return;
    renderClaudePicks();
    renderCodexPicks();
    renderGuideSnippets();
  }

  async function loadGuides({ rebuild = true } = {}) {
    persistPrefixed();
    persistHidden();
    persistClaude();
    persistCodex();
    const params = new URLSearchParams();
    if ($("guidePrefixed")?.checked) params.set("prefixed", "1");
    if (hiddenModels.size) params.set("hidden", [...hiddenModels].join(","));
    for (const [key, value] of Object.entries(claudePicks)) {
      if (value) params.set("claude_" + key, value);
    }
    for (const [key, value] of Object.entries(claudeMillion)) {
      if (value) params.set("claude_" + key + "_1m", "1");
    }
    if (codexModel) params.set("codex", codexModel);
    if ($("guideIntro")) $("guideIntro").textContent = "Loading setup snippets…";
    try {
      guides = await api("/guides?" + params.toString());
      if (guides.claude_defaults) {
        for (const [key, value] of Object.entries(guides.claude_defaults)) {
          if (!claudePicks[key]) claudePicks[key] = value;
        }
      }
      if (!codexModel && guides.codex_default) codexModel = guides.codex_default;
      if (rebuild) renderGuides();
      else renderGuideSnippets();
    } catch (err) {
      if ($("guideIntro")) $("guideIntro").textContent = "Could not load setup snippets: " + err.message;
      throw err;
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      toast("Copied");
    }
  }

  async function addVertexKey() {
    const key = window.prompt("Vertex Express Mode API key (starts with AQ.)");
    if (!key) return;
    const location = window.prompt("Location (global)", "global") || "global";
    const label = window.prompt("Label (optional)", "") || undefined;
    const hint = $("vertexLoginHint");
    if (hint) hint.classList.remove("hidden");
    try {
      await api("/accounts/login-vertex", { method: "POST", body: { api_key: key.trim(), location, label } });
      toast("Vertex key added");
      await loadAll(false);
      await loadModels().catch(() => {});
      loadAll(true).catch(() => {});
    } finally {
      if (hint) hint.classList.add("hidden");
    }
  }

  async function startLogin(path, hintId, okMessage) {
    const rec = await api(path, { method: "POST" });
    const hint = $(hintId);
    if (hint) hint.classList.remove("hidden");
    window.open(rec.authorize_url, "_blank", "noopener");
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const poll = await api("/accounts/login/" + encodeURIComponent(rec.state) + "/poll");
        if (!poll.done) return;
        clearInterval(pollTimer);
        if (hint) hint.classList.add("hidden");
        if (poll.error) toast(poll.error);
        else toast(okMessage);
        await loadAll(false);
        loadAll(true).catch(() => {});
      } catch (err) {
        clearInterval(pollTimer);
        if (hint) hint.classList.add("hidden");
        toast(err.message);
      }
    }, 1500);
  }

  async function showMain() {
    $("loginPage").classList.add("hidden");
    $("mainPage").classList.remove("hidden");
    loadPrefs();
    await loadAll(false);
    loadModels().catch(() => {});
    setTimeout(() => loadAll(true).catch(() => {}), 250);
  }

  async function boot() {
    const boot = await fetch("/admin/api/bootstrap").then((r) => r.json());
    if (boot.auth_required && !boot.authorized && !token()) {
      $("loginPage").classList.remove("hidden");
      $("mainPage").classList.add("hidden");
      return;
    }
    if (boot.auth_required && !boot.authorized && token()) {
      try {
        await api("/status");
      } catch {
        localStorage.removeItem(TOKEN_KEY);
        $("loginPage").classList.remove("hidden");
        return;
      }
    }
    await showMain();
  }

  $("loginForm")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    $("loginError").classList.add("hidden");
    try {
      const out = await api("/session", { method: "POST", body: { password: $("pwdField").value } });
      if (out.token) localStorage.setItem(TOKEN_KEY, out.token);
      await showMain();
    } catch (err) {
      $("loginError").textContent = err.message;
      $("loginError").classList.remove("hidden");
    }
  });

  $("logoutBtn")?.addEventListener("click", async () => {
    await api("/session", { method: "DELETE" }).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    location.reload();
  });

  $("addAccountBtn")?.addEventListener("click", () => startLogin("/accounts/login", "loginHint", "Google account added").catch((err) => toast(err.message)));
  $("addChatgptBtn")?.addEventListener("click", () => startLogin("/accounts/login-chatgpt", "chatgptLoginHint", "ChatGPT account added").catch((err) => toast(err.message)));
  $("addVertexBtn")?.addEventListener("click", () => addVertexKey().catch((err) => toast(err.message)));
  $("refreshBtn")?.addEventListener("click", () => loadAll(true).catch((err) => toast(err.message)));
  $("refreshModelsBtn")?.addEventListener("click", () => loadModels().catch((err) => toast(err.message)));
  $("filterSearch")?.addEventListener("input", renderAccounts);
  $("filterProvider")?.addEventListener("change", renderAccounts);
  $("filterStatus")?.addEventListener("change", renderAccounts);
  $("selectAll")?.addEventListener("change", (ev) => {
    selected.clear();
    if (ev.target.checked) filtered().forEach((a) => selected.add(`${a.provider || "antigravity"}:${a.id}`));
    renderAccounts();
  });

  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => btn.addEventListener("click", nextTheme));
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el === btn));
      $("tabAccounts").classList.toggle("hidden", btn.dataset.tab !== "accounts");
      $("tabModels").classList.toggle("hidden", btn.dataset.tab !== "models");
      $("tabSetup")?.classList.toggle("hidden", btn.dataset.tab !== "setup");
      if (btn.dataset.tab === "models") loadModels().catch((err) => toast(err.message));
      if (btn.dataset.tab === "setup") loadGuides().catch((err) => toast(err.message));
    });
  });

  $("vscodeApiType")?.addEventListener("change", renderGuides);
  $("guidePrefixed")?.addEventListener("change", () => loadGuides().catch((err) => toast(err.message)));
  $("guideRefresh")?.addEventListener("click", () => loadGuides().catch((err) => toast(err.message)));
  $("modelsList")?.addEventListener("change", (ev) => {
    const box = ev.target.closest(".setup-vis");
    if (!box) return;
    if (box.checked) hiddenModels.delete(box.dataset.id);
    else hiddenModels.add(box.dataset.id);
    persistHidden();
    renderModels();
  });
  $("claudePicks")?.addEventListener("change", (ev) => {
    const select = ev.target.closest("select[data-claude]");
    if (select) {
      const slotKey = select.dataset.claude || select.getAttribute("data-claude");
      claudePicks[slotKey] = select.value;
      persistClaude();
      renderGuideSnippets();
      loadGuides({ rebuild: false }).catch(() => {});
      return;
    }
    const box = ev.target.closest("input.claude-1m-toggle");
    if (box) {
      ev.stopPropagation();
      const slotKey = box.dataset.slot || box.getAttribute("data-slot");
      if (slotKey) {
        claudeMillion[slotKey] = Boolean(box.checked);
        persistClaude();
        renderGuideSnippets();
        loadGuides({ rebuild: false }).catch(() => {});
      }
    }
  });
  $("codexPicks")?.addEventListener("change", (ev) => {
    const select = ev.target.closest("#codexModel");
    if (!select) return;
    codexModel = select.value;
    persistCodex();
    renderGuideSnippets();
    loadGuides({ rebuild: false }).catch(() => {});
  });
  $("tabSetup")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-copy]");
    if (!btn) return;
    const id = btn.dataset.copy;
    const text = id === "vscodeJson" ? pretty(currentVscodeSnippet()) : ($(id)?.textContent || "");
    copyText(text);
  });

  $("accountsList")?.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-act]");
    const pick = ev.target.closest(".pick");
    if (pick) {
      if (pick.checked) selected.add(pick.dataset.id);
      else selected.delete(pick.dataset.id);
      renderAccounts();
      return;
    }
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      if (btn.dataset.act === "refresh") await api("/accounts/" + encodeURIComponent(id) + "/refresh", { method: "POST" });
      if (btn.dataset.act === "use") await api("/accounts/" + encodeURIComponent(id), { method: "PUT", body: { active: true } });
      if (btn.dataset.act === "toggle") {
        const acc = accounts.find((a) => `${a.provider || "antigravity"}:${a.id}` === id || a.id === id);
        await api("/accounts/" + encodeURIComponent(id), { method: "PUT", body: { enabled: acc?.enabled === false } });
      }
      if (btn.dataset.act === "delete") {
        if (!confirm("Remove this account?")) return;
        await api("/accounts/" + encodeURIComponent(id), { method: "DELETE" });
      }
      await loadAll(btn.dataset.act === "refresh");
    } catch (err) {
      toast(err.message);
    }
  });

  $("batchBar")?.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-batch]");
    if (!btn) return;
    const ids = [...selected];
    if (!ids.length) return;
    try {
      await api("/accounts/batch", { method: "POST", body: { ids, action: btn.dataset.batch } });
      selected.clear();
      await loadAll(btn.dataset.batch === "refresh");
    } catch (err) {
      toast(err.message);
    }
  });

  boot().catch((err) => toast(err.message));
})();
