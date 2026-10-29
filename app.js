/* Tickwise frontend: same-origin FastAPI client, dashboard, and voice entry. */

(function () {
  "use strict";

  /* ======================================================= 1. Config & helpers */

  // Resolve against the page origin so the same build works behind the preview proxy.
  const API_BASE = new URL("api/v1", document.baseURI).pathname.replace(/\/$/, "");
  const POLL_INTERVAL_MS = 5000;
  const TICK_MS = 1000;
  const PAGE_SIZE = 100;
  const HISTORY_PAGE_SIZE = 50;
  const API_KEY_STORAGE = "tickwise.api-key.v1";
  const THEME_KEY = "tickwise.theme.v1";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /**
   * Safe storage wrapper.
   * localStorage throws a SecurityError when the page is opened from file://
   * or inside a sandboxed iframe. The app must still work in that case, just
   * without persistence — so every access goes through here.
   */
  const memoryStore = new Map(); // fallback when localStorage is blocked

  const storage = {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return memoryStore.has(key) ? memoryStore.get(key) : null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        memoryStore.set(key, value); // session-only, but the app keeps working
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        memoryStore.delete(key);
      }
    },
  };

  // Declared up front (not later in the file) so no code path can hit a
  // temporal-dead-zone error if boot order ever changes.
  let currentView = null;
  let store = { tasks: [], stats: null };
  let pageOffset = 0;
  let pollTimer = null;
  let tickTimer = null;
  let lastSyncAt = 0;
  let polling = false;

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  const escapeHtml = (value = "") =>
    String(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));

  /** "14:32:07" */
  const fmtClock = (ms) =>
    new Date(ms).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

  /** "29 Oct, 14:32:07" */
  const fmtDateTime = (ms) =>
    new Date(ms).toLocaleString([], {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

  /** "in 24s" / "in 3m 05s" / "in 2h 10m" / "in 3d 4h" */
  function fmtCountdown(ms) {
    if (ms <= 0) return "due now";
    const total = Math.round(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (d > 0) return `in ${d}d ${h}h`;
    if (h > 0) return `in ${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `in ${m}m ${String(s).padStart(2, "0")}s`;
    return `in ${s}s`;
  }

  /** "30s" / "5m" / "1h 30m" / "2d" */
  function fmtInterval(seconds) {
    if (seconds % 86400 === 0 && seconds >= 86400) return `${seconds / 86400}d`;
    if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600}h`;
    if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60}m`;
    return `${seconds}s`;
  }

  /** "820ms" / "1.4s" */
  const fmtDuration = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

  /** Only http/https URLs are allowed — blocks javascript:/data: payloads. */
  function isSafeUrl(value) {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.hash;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------- Toasts */

  const toastStack = $("#toastStack");

  function toast(title, message = "", variant = "info") {
    const node = document.createElement("div");
    node.className = `toast toast--${variant}`;
    const glyph = variant === "success" ? "✓" : variant === "error" ? "!" : "i";
    node.innerHTML = `
      <span class="toast__icon" aria-hidden="true">${glyph}</span>
      <span class="toast__text">
        <span class="toast__title">${escapeHtml(title)}</span>
        ${message ? `<span class="toast__msg">${escapeHtml(message)}</span>` : ""}
      </span>`;
    toastStack.appendChild(node);
    setTimeout(() => {
      node.classList.add("is-out");
      node.addEventListener("animationend", () => node.remove(), { once: true });
    }, 3600);
  }

  /* =========================================== 2. Real FastAPI client */

  let sessionKey = "";

  function readApiKey() {
    try { return window.sessionStorage.getItem(API_KEY_STORAGE) || ""; }
    catch { return sessionKey; }
  }

  function writeApiKey(value) {
    sessionKey = value;
    try {
      if (value) window.sessionStorage.setItem(API_KEY_STORAGE, value);
      else window.sessionStorage.removeItem(API_KEY_STORAGE);
    } catch { /* Storage may be blocked in a sandboxed browser. */ }
  }

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function apiFetch(path, { method = "GET", body, key = readApiKey() } = {}) {
    const headers = {};
    if (key) headers["X-API-Key"] = key;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method, headers, cache: "no-store",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError(0, "Could not reach the server. Check your connection.");
    }
    if (!response.ok) {
      let detail = "The server rejected the request.";
      try {
        const data = await response.json();
        if (typeof data.detail === "string") detail = data.detail;
        else if (Array.isArray(data.detail)) {
          detail = data.detail.map((error) => (error.msg || "Invalid input").replace(/^Value error, /, "")).join("; ");
        }
      } catch { /* Use the generic message for non-JSON errors. */ }
      if (response.status === 401) detail = "A valid workspace API key is required.";
      throw new ApiError(response.status, detail);
    }
    return response.status === 204 ? null : response.json();
  }

  function mapTask(task) {
    const schedule = task.schedule || {};
    const scheduleLabel = schedule.type === "interval"
      ? `Every ${fmtInterval(schedule.seconds)}`
      : schedule.type === "cron"
        ? `Cron ${schedule.expression} (UTC)`
        : "One-time";
    return {
      id: task.id, name: task.name,
      interval_seconds: schedule.type === "interval" ? schedule.seconds : null,
      schedule_label: scheduleLabel,
      action_type: task.action_type,
      payload: task.action_type === "log" ? task.message : task.url,
      status: task.enabled ? "active" : "paused",
      completed: task.enabled && schedule.type === "once" && !task.next_run_at &&
        !["queued", "running", "retrying"].includes(task.last_status),
      in_progress: task.enabled && schedule.type === "once" && !task.next_run_at &&
        ["queued", "running", "retrying"].includes(task.last_status),
      max_retries: task.retry.max_retries,
      next_run_at: task.next_run_at, created_at: task.created_at,
      last_run_at: task.last_run_at, last_status: task.last_status,
    };
  }

  function mapAttempts(runs) {
    return runs.flatMap((run) => {
      if (!run.attempts.length) {
        return [{
          id: run.id, task_id: run.task_id, started_at: run.created_at,
          duration_ms: null, status: run.status, attempt: 0,
          detail: run.status === "queued" ? "Waiting for a worker" : run.status,
        }];
      }
      return run.attempts.map((attempt) => ({
        id: `${run.id}:${attempt.number}`, task_id: run.task_id,
        started_at: attempt.started_at,
        duration_ms: attempt.finished_at
          ? Math.max(0, new Date(attempt.finished_at) - new Date(attempt.started_at)) : null,
        status: attempt.status === "succeeded" ? "success" : attempt.status,
        attempt: attempt.number,
        detail: attempt.output ?? attempt.error ?? (attempt.http_status ? `HTTP ${attempt.http_status}` : "In progress"),
      }));
    });
  }

  const api = {
    async verifyKey(key) {
      await apiFetch("/tasks?limit=1", { key });
    },
    async listTasks() {
      const [tasks, stats] = await Promise.all([
        apiFetch(`/tasks?limit=${PAGE_SIZE}&offset=${pageOffset}`), apiFetch("/stats"),
      ]);
      return { tasks: tasks.map(mapTask), stats };
    },
    async createTask(values) {
      const payload = {
        name: values.name, action_type: values.action_type,
        schedule: { type: "interval", seconds: values.interval_seconds },
        retry: { max_retries: values.max_retries, delay_seconds: 60 },
        ...(values.action_type === "http"
          ? { url: values.payload, method: "GET" }
          : { message: values.payload }),
      };
      return mapTask(await apiFetch("/tasks", { method: "POST", body: payload }));
    },
    async setTaskStatus(id, status) {
      return apiFetch(`/tasks/${encodeURIComponent(id)}/${status === "active" ? "resume" : "pause"}`, { method: "POST" });
    },
    async runNow(id) {
      return apiFetch(`/tasks/${encodeURIComponent(id)}/runs`, { method: "POST" });
    },
    async deleteTask(id) {
      return apiFetch(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    async listRuns(id, offset) {
      const runs = await apiFetch(`/tasks/${encodeURIComponent(id)}/runs?limit=${HISTORY_PAGE_SIZE + 1}&offset=${offset}`);
      return {
        attempts: mapAttempts(runs.slice(0, HISTORY_PAGE_SIZE)),
        runCount: Math.min(runs.length, HISTORY_PAGE_SIZE),
        hasMore: runs.length > HISTORY_PAGE_SIZE,
      };
    },
  };

  /* ==================================================== 3. Router (hash based) */

  const views = {
    landing: $("#view-landing"),
    auth: $("#view-auth"),
    dashboard: $("#view-dashboard"),
  };
  const ROUTES = { "": "landing", "/": "landing", "/auth": "auth", "/dashboard": "dashboard" };

  function navigate(path) {
    if (location.hash !== `#${path}`) {
      location.hash = path; // triggers hashchange -> render
    } else {
      renderRoute();
    }
  }

  function renderRoute() {
    const path = location.hash.replace(/^#/, "") || "/";
    const name = ROUTES[path] || "landing";

    Object.entries(views).forEach(([key, node]) => {
      node.classList.toggle("is-active", key === name);
    });

    currentView = name;
    try { window.scrollTo({ top: 0, behavior: "auto" }); } catch { /* not implemented (jsdom) */ }

    if (name === "dashboard") startDashboard();
    else stopDashboard();
  }

  window.addEventListener("hashchange", renderRoute);

  /** Small helper so any link can deep-link without a framework. */
  document.addEventListener("click", (event) => {
    const link = event.target.closest('a[href^="#/"]');
    if (!link) return;
    event.preventDefault();
    navigate(link.getAttribute("href").slice(1));
  });

  /* ============================================================== 4. Theme */

  const themeToggle = $("#themeToggle");

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    storage.set(THEME_KEY, theme);
  }

  applyTheme(storage.get(THEME_KEY) || "dark");

  themeToggle.addEventListener("click", () => {
    const next =
      document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
  });

  /* ============================================== 5. Workspace access */

  const authForm = $("#authForm");
  const authSlot = $("#authSlot");
  const authKey = $("#authKey");
  const authSubmit = $("#authSubmit");

  function renderAuthSlot() {
    if (readApiKey()) {
      authSlot.innerHTML = `<span class="user-chip"><span class="user-chip__name">Key set</span></span>
        <button class="btn btn--ghost btn--sm" type="button" id="logoutBtn">Clear key</button>`;
      $("#logoutBtn").addEventListener("click", () => {
        writeApiKey("");
        authKey.value = "";
        renderAuthSlot();
        toast("Key cleared", "The workspace key was removed from this tab.", "info");
        navigate("/auth");
      });
    } else {
      authSlot.innerHTML = `<a class="btn btn--ghost btn--sm" href="#/auth">Workspace access</a>`;
    }
    $("#greetingName").textContent = "Workspace";
  }

  function setFieldError(inputId, message) {
    const input = $(`#${inputId}`);
    const error = $(`[data-error-for="${inputId}"]`);
    if (input) input.classList.toggle("is-invalid", Boolean(message));
    if (error) {
      error.hidden = !message;
      error.textContent = message || "";
    }
  }

  authKey.value = readApiKey();
  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setFieldError("authKey", "");
    const key = authKey.value;
    authSubmit.disabled = true;
    authSubmit.textContent = "Connecting…";
    try {
      await api.verifyKey(key);
      writeApiKey(key);
      renderAuthSlot();
      toast("Connected", "The workspace is ready.", "success");
      navigate("/dashboard");
    } catch (error) {
      setFieldError("authKey", error.message || "Could not connect.");
    } finally {
      authSubmit.disabled = false;
      authSubmit.textContent = "Open dashboard";
    }
  });

  /* =========================================== 6. Dashboard: state & rendering */

  const els = {
    taskList: $("#taskList"),
    taskCountLabel: $("#taskCountLabel"),
    taskSearch: $("#taskSearch"),
    syncChip: $("#syncChip"),
    syncText: $("#syncText"),
    statTotal: $("#statTotal"),
    statActive: $("#statActive"),
    statRuns: $("#statRuns"),
    statRate: $("#statRate"),
    statTotalHint: $("#statTotalHint"),
    statActiveHint: $("#statActiveHint"),
    statRunsHint: $("#statRunsHint"),
    statRateHint: $("#statRateHint"),
    pagination: $("#taskPagination"),
    prevPage: $("#prevPage"),
    nextPage: $("#nextPage"),
    pageLabel: $("#pageLabel"),
  };

  /** Last known server snapshot. */
  let searchTerm = "";
  let previousSignature = new Map(); // task id -> last_run_at, for the "just ran" flash

  let refreshQueued = false;
  async function refreshTasks({ silent = false } = {}) {
    if (polling) { refreshQueued = true; return; }
    polling = true;
    try {
      const data = await api.listTasks();
      store = { tasks: data.tasks, stats: data.stats };
      lastSyncAt = Date.now();
      els.syncChip.classList.remove("is-offline");
      renderStats();
      renderTasks();
    } catch (error) {
      els.syncChip.classList.add("is-offline");
      els.syncText.textContent = error.status === 401 ? "API key required" : "Offline — retrying";
      if (error.status === 401 && currentView === "dashboard") {
        setFieldError("authKey", "Enter a valid workspace API key.");
        navigate("/auth");
      } else if (!silent) {
        toast("Could not load tasks", error.message || "Backend unreachable.", "error");
      }
    } finally {
      polling = false;
      if (refreshQueued && currentView === "dashboard") {
        refreshQueued = false;
        queueMicrotask(() => refreshTasks({ silent: true }));
      } else {
        refreshQueued = false;
      }
    }
  }


    /* ------------------------------------------------------------- Stats row */

  function renderStats() {
    const stats = store.stats;
    if (!stats) return;
    const paused = stats.total_tasks - stats.active_tasks;
    const rate = stats.runs_24h ? Math.round((stats.succeeded_24h / stats.runs_24h) * 100) : null;
    els.statTotal.textContent = String(stats.total_tasks);
    els.statTotalHint.textContent = !stats.total_tasks ? "no tasks yet" : paused ? `${paused} paused or complete` : "all active";
    els.statActive.textContent = String(stats.active_tasks);
    els.statActiveHint.textContent = stats.active_tasks ? "enabled schedules" : "nothing scheduled";
    els.statRuns.textContent = String(stats.runs_24h);
    els.statRunsHint.textContent = stats.runs_24h
      ? `${stats.failed_24h} failed · ${stats.retried_24h} retried` : "no completed runs yet";
    els.statRate.textContent = rate === null ? "—" : `${rate}%`;
    els.statRateHint.textContent = rate === null ? "no data yet" : `${stats.succeeded_24h}/${stats.runs_24h} executions ok`;
  }


    /* ------------------------------------------------------------ Task cards */

  const ACTION_LABEL = { log: "Log Message", http: "HTTP Ping" };

  function taskCardHtml(task) {
    const paused = task.status === "paused";
    const nextRun = task.next_run_at ? new Date(task.next_run_at).getTime() : null;
    const countdown = nextRun ? fmtCountdown(nextRun - Date.now()) : paused ? "paused" : task.in_progress ? "in progress" : "completed";
    const lastRun = task.last_run_at
      ? `${fmtClock(new Date(task.last_run_at).getTime())} · ${task.last_status || "unknown"}`
      : "never run";
    const safeId = escapeHtml(task.id);

    return `
      <article class="task-card${paused ? " is-paused" : ""}" data-task-id="${safeId}">
        <div class="task-main">
          <div class="task-title-row">
            <h3 class="task-name" title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</h3>
            <span class="badge ${paused ? "badge--paused" : "badge--active"}">
              ${paused ? "Paused" : task.completed ? "Complete" : "Active"}
            </span>
            <span class="badge badge--type">${escapeHtml(ACTION_LABEL[task.action_type] || task.action_type)}</span>
          </div>

          <div class="task-meta">
            <span><strong>${escapeHtml(task.schedule_label)}</strong></span>
            <span class="sep">·</span>
            <span>Next run
              <strong data-countdown-for="${safeId}">${countdown}</strong>
            </span>
            <span class="sep">·</span>
            <span>Last: ${escapeHtml(lastRun)}</span>
            <span class="sep">·</span>
            <span>Retries <strong>${Number(task.max_retries || 0)}</strong></span>
          </div>

          <code class="task-payload" title="${escapeHtml(task.payload)}">
            ${escapeHtml(task.payload)}
          </code>
        </div>

        <div class="task-actions">
          <button class="btn btn--sm" type="button" data-op="history" data-id="${safeId}">
            View history
          </button>
          <button class="btn btn--sm btn--ghost" type="button" data-op="run" data-id="${safeId}"
                  ${paused ? "disabled" : ""}>Run now</button>
          <button class="btn btn--sm btn--ghost" type="button" data-op="toggle" data-id="${safeId}">
            ${paused ? "Resume" : "Pause"}
          </button>
          <button class="icon-btn" type="button" data-op="delete" data-id="${safeId}"
                  aria-label="Delete ${escapeHtml(task.name)}" title="Delete task">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
            </svg>
          </button>
        </div>

        <div class="task-progress" aria-hidden="true">
          <i data-progress-for="${safeId}"></i>
        </div>
      </article>`;
  }

  function renderTasks() {
    const term = searchTerm.trim().toLowerCase();
    const visible = term
      ? store.tasks.filter((t) =>
          `${t.name} ${t.payload} ${t.action_type}`.toLowerCase().includes(term)
        )
      : store.tasks;

    const total = store.stats?.total_tasks || 0;
    els.taskCountLabel.textContent = total
      ? `Showing ${visible.length} on this page · ${total} total${term ? ` · matching “${searchTerm}”` : ""}`
      : "No tasks yet";
    els.pagination.hidden = total <= PAGE_SIZE && pageOffset === 0;
    els.prevPage.disabled = pageOffset === 0;
    els.nextPage.disabled = pageOffset + PAGE_SIZE >= total;
    els.pageLabel.textContent = `Page ${Math.floor(pageOffset / PAGE_SIZE) + 1}`;

    if (!visible.length) {
      els.taskList.innerHTML = `
        <div class="empty">
          <span class="empty__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 2" />
            </svg>
          </span>
          <h3>${store.tasks.length ? "No tasks match that filter" : "Nothing scheduled yet"}</h3>
          <p>${
            store.tasks.length
              ? "Try a different keyword, or clear the filter."
              : "Create your first task with the form — it will fire its first run one interval from now."
          }</p>
        </div>`;
      return;
    }

    els.taskList.innerHTML = visible.map(taskCardHtml).join("");

    // Flash cards whose latest run changed since the previous poll.
    const nextSignature = new Map();
    store.tasks.forEach((task) => {
      const signature = `${task.last_run_at}|${task.last_status}`;
      nextSignature.set(task.id, signature);
      const before = previousSignature.get(task.id);
      if (before && before !== signature) {
        const card = $$("[data-task-id]", els.taskList).find((node) => node.dataset.taskId === task.id);
        if (card) {
          card.classList.add("is-just-ran");
          setTimeout(() => card.classList.remove("is-just-ran"), 950);
        }
      }
    });
    previousSignature = nextSignature;

    updateCountdowns();
  }

  /** Patches countdown text + progress bars once a second (no full re-render). */
  function updateCountdowns() {
    const now = Date.now();
    const labels = new Map($$("[data-countdown-for]", els.taskList).map((node) => [node.dataset.countdownFor, node]));
    const bars = new Map($$("[data-progress-for]", els.taskList).map((node) => [node.dataset.progressFor, node]));
    store.tasks.forEach((task) => {
      const label = labels.get(task.id);
      const bar = bars.get(task.id);
      if (!label) return;

      if (task.status === "paused" || !task.next_run_at) {
        label.textContent = task.status === "paused" ? "paused" : task.in_progress ? "in progress" : "completed";
        if (bar) bar.style.width = "0%";
        return;
      }

      const next = new Date(task.next_run_at).getTime();
      label.textContent = fmtCountdown(next - now);

      if (bar) {
        const interval = Number(task.interval_seconds) * 1000;
        const elapsed = interval - (next - now);
        bar.style.width = interval > 0 ? `${clamp((elapsed / interval) * 100, 0, 100)}%` : "0%";
      }
    });

    if (lastSyncAt && !els.syncChip.classList.contains("is-offline")) {
      const age = Math.round((now - lastSyncAt) / 1000);
      els.syncText.textContent =
        age <= 1 ? "Synced just now" : `Synced ${age}s ago · poll 5s`;
    }
  }

  /* ------------------------------------------------- Task list interactions */

  els.taskList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-op]");
    if (!button) return;
    const { op, id } = button.dataset;
    const task = store.tasks.find((t) => t.id === id);
    if (!task) return;

    if (op === "history") {
      openHistory(task);
      return;
    }

    if (op === "toggle") {
      const nextStatus = task.status === "active" ? "paused" : "active";
      button.disabled = true;
      try {
        await api.setTaskStatus(id, nextStatus);
        toast(
          nextStatus === "active" ? "Task resumed" : "Task paused",
          `“${task.name}” is now ${nextStatus}.`,
          "success"
        );
        await refreshTasks({ silent: true });
      } catch (error) {
        toast("Update failed", error.message, "error");
      } finally {
        button.disabled = false;
      }
      return;
    }

    if (op === "run") {
      button.disabled = true;
      const original = button.textContent;
      button.textContent = "Running…";
      try {
        await api.runNow(id);
        toast("Run queued", "Check its history for the result.", "success");
        await refreshTasks({ silent: true });
      } catch (error) {
        toast("Trigger failed", error.message, "error");
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
      return;
    }

    if (op === "delete") {
      const confirmed = window.confirm(
        `Delete “${task.name}”? Its execution history will be removed too.`
      );
      if (!confirmed) return;
      try {
        await api.deleteTask(id);
        if (store.tasks.length === 1 && pageOffset > 0) pageOffset = Math.max(0, pageOffset - PAGE_SIZE);
        toast("Task deleted", `“${task.name}” was removed.`, "info");
        await refreshTasks({ silent: true });
      } catch (error) {
        toast("Delete failed", error.message, "error");
      }
    }
  });

  els.prevPage.addEventListener("click", () => {
    pageOffset = Math.max(0, pageOffset - PAGE_SIZE);
    refreshTasks({ silent: true });
  });
  els.nextPage.addEventListener("click", () => {
    pageOffset += PAGE_SIZE;
    refreshTasks({ silent: true });
  });

  els.taskSearch.addEventListener("input", (event) => {
    searchTerm = event.target.value;
    renderTasks();
  });

  /* ================================================ 7. Create-task form */

  const taskForm = $("#taskForm");
  const nameInput = $("#taskName");
  const intervalInput = $("#taskInterval");
  const retriesInput = $("#taskRetries");
  const actionSelect = $("#taskAction");
  const payloadInput = $("#taskPayload");
  const payloadLabel = $("#payloadLabel");
  const payloadHint = $("#payloadHint");
  const createBtn = $("#createBtn");

  const PAYLOAD_COPY = {
    log: {
      label: "Message to log",
      hint: "Written to the run log every time the task fires.",
      placeholder: "e.g. Snapshot queued for pg_dump",
    },
    http: {
      label: "URL to ping",
      hint: "The worker sends a GET request to a permitted public URL. Failed attempts retry after 60 seconds.",
      placeholder: "https://api.example.com/health",
    },
  };

  function syncPayloadField() {
    const copy = PAYLOAD_COPY[actionSelect.value] || PAYLOAD_COPY.log;
    payloadLabel.textContent = copy.label;
    payloadHint.textContent = copy.hint;
    payloadInput.placeholder = copy.placeholder;
    payloadInput.value = "";
    setError("payload", "");
  }

  actionSelect.addEventListener("change", syncPayloadField);
  syncPayloadField();

  function setError(field, message) {
    const input =
      field === "name" ? nameInput
      : field === "interval" ? intervalInput
      : field === "maxRetries" ? retriesInput
      : payloadInput;
    const error = $(`[data-error-for="${field}"]`);
    if (input) input.classList.toggle("is-invalid", Boolean(message));
    if (error) {
      error.hidden = !message;
      error.textContent = message || "";
    }
  }

  function validateTask(values) {
    const errors = {};

    if (!values.name) errors.name = "Give the task a name.";
    else if (values.name.length < 3) errors.name = "Use at least 3 characters.";
    else if (values.name.length > 80) errors.name = "Keep the name under 80 characters.";

    if (!Number.isFinite(values.interval_seconds)) {
      errors.interval = "Enter a number of seconds.";
    } else if (values.interval_seconds < 5) {
      errors.interval = "Minimum interval is 5 seconds (protects the worker).";
    } else if (values.interval_seconds > 86400) {
      errors.interval = "Maximum interval is 86400 seconds (24 hours).";
    } else if (!Number.isInteger(values.interval_seconds)) {
      errors.interval = "Use whole seconds only.";
    }

    if (!Number.isInteger(values.max_retries) || values.max_retries < 0 || values.max_retries > 5) {
      errors.maxRetries = "Retries must be between 0 and 5.";
    }

    if (!values.payload) {
      errors.payload =
        values.action_type === "http" ? "Enter the URL to ping." : "Enter the message to log.";
    } else if (values.action_type === "http" && !isSafeUrl(values.payload)) {
      errors.payload = "Enter a full http:// or https:// URL.";
    } else if (values.payload.length > 500) {
      errors.payload = "Keep the payload under 500 characters.";
    }

    return errors;
  }

  [nameInput, intervalInput, retriesInput, payloadInput].forEach((input) => {
    input.addEventListener("input", () => {
      const field =
        input === nameInput ? "name"
        : input === intervalInput ? "interval"
        : input === retriesInput ? "maxRetries"
        : "payload";
      setError(field, "");
    });
  });

  taskForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const values = {
      name: nameInput.value.trim(),
      interval_seconds: Number(intervalInput.value),
      max_retries: Number(retriesInput.value || 0),
      action_type: actionSelect.value,
      payload: payloadInput.value.trim(),
    };

    const errors = validateTask(values);
    const fields = ["name", "interval", "maxRetries", "payload"];
    fields.forEach((field) => setError(field, errors[field] || ""));
    if (Object.keys(errors).length) {
      toast("Check the form", Object.values(errors)[0], "error");
      $(`[data-error-for="${Object.keys(errors)[0]}"]`)?.parentElement
        ?.querySelector("input, textarea")
        ?.focus();
      return;
    }

    createBtn.disabled = true;
    createBtn.textContent = "Scheduling…";

    try {
      const task = await api.createTask(values);
      pageOffset = 0;
      toast("Task scheduled", `“${task.name}” first runs ${fmtCountdown(
        new Date(task.next_run_at).getTime() - Date.now()
      )}.`, "success");
      taskForm.reset();
      intervalInput.value = "30";
      retriesInput.value = "2";
      syncPayloadField();
      clearVoiceHint();
      await refreshTasks({ silent: true });
    } catch (error) {
      toast("Could not schedule task", error.message || "Server rejected the request.", "error");
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = "Schedule task";
    }
  });

  $("#resetBtn").addEventListener("click", () => {
    setTimeout(() => {
      intervalInput.value = "30";
      retriesInput.value = "2";
      syncPayloadField();
      ["name", "interval", "maxRetries", "payload"].forEach((f) => setError(f, ""));
      clearVoiceHint();
    }, 0);
  });

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest('[data-action="focus-form"]');
    if (trigger) {
      if (currentView !== "dashboard") navigate("/dashboard");
      setTimeout(() => {
        nameInput.focus({ preventScroll: false });
        nameInput.select?.();
      }, 60);
    }
  });

  /* ==================================== 8. Voice input (Web Speech API) */

  /**
   * Wow feature: speak a task description and the form fills itself.
   * We also parse the intent, so "ping the api every 60 seconds" sets the
   * interval to 60 and switches the action type to HTTP Ping.
   */
  const micBtn = $("#micBtn");
  const voiceHint = $("#voiceHint");
  const voiceSupportHint = $("#voiceSupportHint");
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  const NUMBER_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
    thirty: 30, forty: 40, fifty: 50, sixty: 60,
  };

  const UNIT_SECONDS = {
    s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
    m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
    h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
    d: 86400, day: 86400, days: 86400,
  };

  /** Pulls interval + action type + URL out of a spoken sentence. */
  function parseVoiceCommand(transcript) {
    const text = ` ${transcript.toLowerCase().replace(/[.,!?]/g, " ")} `;
    const result = { name: "", interval: null, action: null, payload: null };

    // Interval: "every 60 seconds", "each 2 minutes", "every 30s"
    const intervalMatch = text.match(
      /\b(?:every|each|at)\s+([a-z]+|\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/
    );
    if (intervalMatch) {
      const rawValue = intervalMatch[1];
      const value = NUMBER_WORDS[rawValue] ?? Number(rawValue);
      const unit = UNIT_SECONDS[intervalMatch[2]];
      if (Number.isFinite(value) && unit) {
        result.interval = clamp(value * unit, 5, 86400);
      }
    }

    // Explicit URL anywhere in the sentence
    const urlMatch = transcript.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      result.payload = urlMatch[0];
      result.action = "http";
    }

    // Intent keywords
    if (/\b(ping|http|request|endpoint|api|curl|webhook|url)\b/.test(text)) {
      result.action = "http";
    } else if (/\b(log|message|note|record|print|remind)\b/.test(text)) {
      result.action = result.action || "log";
    }

    // Build a name: strip the scheduling phrase, keep the intent.
    let name = transcript
      .replace(/\s+/g, " ")
      .replace(/\b(every|each)\s+([a-z]+|\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/gi, "")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/^\s*(please\s+)?(create|schedule|add|set up|make)\s+(a\s+)?(new\s+)?task\s*(called|named|to)?\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!name) name = "Voice task";
    name = name.charAt(0).toUpperCase() + name.slice(1);
    result.name = name.slice(0, 80);

    // For Log Message tasks the remaining sentence is the payload.
    if (result.action !== "http" && !result.payload) {
      result.payload = name;
    }
    return result;
  }

  function showVoiceHint(message, isError = false) {
    voiceHint.hidden = !message;
    voiceHint.textContent = message;
    voiceHint.classList.toggle("is-error", isError);
    voiceHint.classList.add("voice-hint");
  }

  function clearVoiceHint() {
    voiceHint.hidden = true;
    voiceHint.textContent = "";
    voiceHint.classList.remove("is-error", "voice-hint");
  }

  if (!SpeechRecognitionCtor) {
    micBtn.disabled = true;
    micBtn.title = "Voice input is not supported in this browser";
    voiceSupportHint.textContent = "Voice input needs Chrome, Edge or Safari";
  } else {
    voiceSupportHint.textContent = "or tap the mic to speak";
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    let listening = false;

    function setListening(state) {
      listening = state;
      micBtn.classList.toggle("is-listening", state);
      micBtn.setAttribute("aria-pressed", String(state));
    }

    micBtn.addEventListener("click", () => {
      if (listening) {
        recognition.stop();
        return;
      }
      clearVoiceHint();
      try {
        recognition.start();
        setListening(true);
        showVoiceHint("Listening… say e.g. “ping the API every 60 seconds”");
      } catch (error) {
        showVoiceHint("Could not start the microphone. Try again.", true);
      }
    });

    recognition.addEventListener("result", (event) => {
      const transcript = Array.from(event.results)
        .map((r) => r[0].transcript)
        .join(" ")
        .trim();
      if (!transcript) return;

      // Live preview while the user is still speaking.
      if (!event.results[event.results.length - 1].isFinal) {
        showVoiceHint(`Hearing: “${transcript}”`);
        return;
      }

      const parsed = parseVoiceCommand(transcript);
      nameInput.value = parsed.name;
      setError("name", "");

      const filled = ["name"];
      if (parsed.interval) {
        intervalInput.value = String(parsed.interval);
        setError("interval", "");
        filled.push(`interval ${fmtInterval(parsed.interval)}`);
      }
      if (parsed.action) {
        actionSelect.value = parsed.action;
        syncPayloadField(); // clears stale payload
        filled.push(ACTION_LABEL[parsed.action]);
      }
      if (parsed.payload) {
        payloadInput.value = parsed.payload;
        setError("payload", "");
        filled.push("payload");
      }

      showVoiceHint(`Heard “${transcript}” — filled ${filled.join(", ")}. Review, then schedule.`);
      nameInput.focus();
      toast("Voice input captured", "Check the fields before scheduling.", "info");
    });

    recognition.addEventListener("error", (event) => {
      setListening(false);
      const map = {
        "not-allowed": "Microphone permission denied. Allow mic access, then retry.",
        "service-not-allowed": "Speech service blocked by the browser.",
        "no-speech": "No speech detected — tap the mic and try again.",
        "audio-capture": "No microphone found on this device.",
        network: "Speech recognition needs a network connection.",
        aborted: "",
      };
      const message = map[event.error] ?? `Voice error: ${event.error}`;
      showVoiceHint(message || "Recording stopped.", Boolean(message));
      if (event.error === "not-allowed") {
        toast("Mic blocked", "Allow microphone access in your browser settings.", "error");
      }
    });

    recognition.addEventListener("end", () => setListening(false));
    recognition.addEventListener("start", () => setListening(true));
  }

  /* ==================================================== 9. History modal */

  const historyModal = $("#historyModal");
  const historyTitle = $("#historyTitle");
  const historySub = $("#historySub");
  const historySummary = $("#historySummary");
  const historyBody = $("#historyBody");
  const historyPagination = $("#historyPagination");
  const historyPrev = $("#historyPrev");
  const historyNext = $("#historyNext");
  const historyPageLabel = $("#historyPageLabel");
  let lastFocused = null;
  let historyTask = null;
  let historyOffset = 0;
  let historyRequest = 0;

  async function openHistory(task, offset = 0) {
    if (historyModal.hidden) lastFocused = document.activeElement;
    historyTask = task;
    historyOffset = offset;
    const request = ++historyRequest;
    historyTitle.textContent = task.name;
    historySub.textContent = `${ACTION_LABEL[task.action_type] || task.action_type} · ${task.schedule_label} · max ${task.max_retries} retr${Number(task.max_retries) === 1 ? "y" : "ies"}`;
    historySummary.innerHTML = "";
    historyPagination.hidden = true;
    historyBody.innerHTML = `<p class="field__hint" style="padding:1rem 0">Loading runs…</p>`;
    historyModal.hidden = false;
    historyModal.querySelector(".modal__panel").focus();

    try {
      const page = await api.listRuns(task.id, offset);
      if (request !== historyRequest) return;
      const runs = page.attempts.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
      const attempts = runs.filter((r) => r.attempt > 0);
      const ok = attempts.filter((r) => r.status === "success").length;
      const failed = attempts.filter((r) => r.status === "failed").length;
      const retries = attempts.filter((r) => Number(r.attempt) > 1).length;
      const finished = attempts.filter((r) => r.duration_ms !== null);
      const avg = finished.length
        ? fmtDuration(Math.round(finished.reduce((sum, r) => sum + r.duration_ms, 0) / finished.length)) : "—";
      historyPagination.hidden = offset === 0 && !page.hasMore;
      historyPrev.disabled = offset === 0;
      historyNext.disabled = !page.hasMore;
      historyPageLabel.textContent = `Runs ${offset + 1}–${offset + page.runCount}`;
      historySummary.innerHTML = `
        <span class="chip">Runs <strong>${page.runCount}</strong></span>
        <span class="chip">Attempts <strong>${attempts.length}</strong></span>
        <span class="chip chip--ok">Succeeded <strong>${ok}</strong></span>
        <span class="chip chip--bad">Failed <strong>${failed}</strong></span>
        <span class="chip">Retry attempts <strong>${retries}</strong></span>
        <span class="chip">Avg duration <strong>${avg}</strong></span>`;

      if (!runs.length) {
        historyBody.innerHTML = `
          <div class="empty" style="margin-top:1rem;border:0">
            <h3>No executions recorded yet</h3>
            <p>This task has not fired. Use “Run now” to trigger one immediately.</p>
          </div>`;
        return;
      }

      historyBody.innerHTML = `
        <table class="hist-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Attempt</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            ${runs
              .map(
                (run) => `
              <tr>
                <td>
                  <span class="badge ${run.status === "success" ? "badge--success" : run.status === "failed" ? "badge--failed" : "badge--paused"}">
                    ${escapeHtml(run.status === "success" ? "Success" : run.status)}
                  </span>
                </td>
                <td class="mono">${escapeHtml(
                  fmtDateTime(new Date(run.started_at).getTime())
                )}</td>
                <td class="mono">${run.duration_ms === null ? "—" : fmtDuration(run.duration_ms)}</td>
                <td class="mono">${Number(run.attempt) > 1 ? `retry ${Number(run.attempt) - 1}` : run.attempt || "—"}</td>
                <td class="detail">${escapeHtml(run.detail || "—")}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>`;
    } catch (error) {
      if (request !== historyRequest) return;
      historyBody.innerHTML = `<p class="field__error" style="padding:1rem 0">
        Could not load history: ${escapeHtml(error.message || "unknown error")}
      </p>`;
    }
  }

  historyPrev.addEventListener("click", () => openHistory(historyTask, Math.max(0, historyOffset - HISTORY_PAGE_SIZE)));
  historyNext.addEventListener("click", () => openHistory(historyTask, historyOffset + HISTORY_PAGE_SIZE));

  function closeHistory() {
    historyRequest += 1;
    historyModal.hidden = true;
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

  document.addEventListener("click", (event) => {
    if (event.target.closest('[data-action="close-history"]')) closeHistory();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !historyModal.hidden) closeHistory();
  });

  /* ============================== 10. Live loop: countdown + 5s polling */

  function startDashboard() {
    if (pollTimer) return; // already running
    refreshTasks();
    pollTimer = setInterval(() => {
      // Poll only while the tab is visible — saves quota and worker noise.
      if (document.visibilityState === "visible") refreshTasks({ silent: true });
    }, POLL_INTERVAL_MS);

    tickTimer = setInterval(updateCountdowns, TICK_MS);
  }

  function stopDashboard() {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
  }

  // Re-sync immediately when the tab comes back into focus.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && currentView === "dashboard") {
      refreshTasks({ silent: true });
    }
  });

  /* ============================================================== 11. Boot */

  renderAuthSlot();
  renderRoute();
})();
