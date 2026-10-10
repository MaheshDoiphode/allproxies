(() => {
  const TOKEN_KEY = "ap_admin_token";
  const selected = new Set();
  let accounts = [];
  let models = [];
  let guides = null;
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

  function filtered() {
    const q = ($("filterSearch").value || "").toLowerCase();
    const st = $("filterStatus").value;
    return accounts.filter((a) => {
      if (q && !(a.email || a.id || "").toLowerCase().includes(q)) return false;
      if (st === "enabled" && a.enabled === false) return false;
      if (st === "disabled" && a.enabled !== false) return false;
      if (st === "limited" && !a.limited) return false;
      return true;
    });
  }

  function renderAccounts() {
    const root = $("accountsList");
    const rows = filtered();
    if (!rows.length) {
      root.innerHTML = '<div class="empty">No accounts yet. Add a Google Pro account.</div>';
      return;
    }
    root.innerHTML = rows.map((a) => {
      const id = `${a.provider || "antigravity"}:${a.id}`;
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
              ${a.provider === "chatgpt" ? `<span class="badge">${escapeHtml(a.plan || "chatgpt")}</span>` : projectBadge(a)}
              <span class="badge">${escapeHtml(a.provider || "antigravity")}</span>
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
    }).join("");
    $("batchBar").classList.toggle("hidden", selected.size === 0);
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

  function renderModels() {
    const root = $("modelsList");
    if (!models.length) {
      root.innerHTML = '<div class="empty">No models loaded.</div>';
      return;
    }
    root.innerHTML = `<table><thead><tr><th>Id</th><th>Name</th><th>Think</th><th>Quota left</th><th>Reset</th></tr></thead><tbody>${
      models.map((m) => `<tr>
        <td><code>${escapeHtml(m.id)}</code></td>
        <td>${escapeHtml(m.name || "")}</td>
        <td>${m.supports_thinking ? "yes" : ""}</td>
        <td>${m.remaining_fraction == null ? "—" : Math.round(m.remaining_fraction * 100) + "%"}</td>
        <td>${escapeHtml(fmtReset(m.reset_time))}</td>
      </tr>`).join("")
    }</tbody></table>`;
  }

  async function loadAll(refresh = false) {
    const status = await api("/status" + (refresh ? "?refresh=1" : ""));
    accounts = status.items || [];
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
    models = await api("/models");
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

  async function loadGuides() {
    const prefixed = $("guidePrefixed")?.checked ? "1" : "0";
    if ($("guideIntro")) $("guideIntro").textContent = "Loading setup snippets…";
    try {
      guides = await api("/guides?prefixed=" + prefixed);
      renderGuides();
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
  $("refreshBtn")?.addEventListener("click", () => loadAll(true).catch((err) => toast(err.message)));
  $("filterSearch")?.addEventListener("input", renderAccounts);
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
