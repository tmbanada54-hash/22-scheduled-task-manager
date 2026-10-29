/* ==========================================================================
   Tickwise — Scheduled Task Manager
   app.js · vanilla JS single-page app
   --------------------------------------------------------------------------
   HOW THIS FILE IS ORGANISED
     1.  Config & tiny helpers
     2.  Mock backend  (swap for FastAPI — every call site is marked TODO/API)
     3.  Router (hash based: #/ , #/auth , #/dashboard)
     4.  Theme
     5.  Auth (visual only)
     6.  Dashboard: stats + task list rendering
     7.  Create-task form + validation
     8.  Voice input (Web Speech API)
     9.  History modal
     10. Live loop: 1s countdown, 5s polling
     11. Boot

   DATA MODEL (mirrors the FastAPI / SQLAlchemy schema in the README)
   --------------------------------------------------------------------------
   Task {
     id              string   "tsk_ab12cd"
     name            string   1..80 chars
     interval_seconds int      5..86400
     action_type     "log" | "http"
     payload         string   message text, or an http(s) URL
     status          "active" | "paused"
     max_retries     int      0..5
     next_run_at     ISO-8601 UTC  (null when paused)
     created_at      ISO-8601 UTC
     last_run_at     ISO-8601 UTC | null
     last_status     "success" | "failed" | null
   }
   Run (execution history row)
   {
     id            string
     task_id       string
     started_at    ISO-8601
     duration_ms   int
     status        "success" | "failed"
     attempt       int   1-based; >1 means a retry
     detail        string  worker output / error message
   }
   ========================================================================== */

(function () {
  "use strict";

  /* ======================================================= 1. Config & helpers */

  /**
   * USE_MOCK_BACKEND
   * true  -> the UI runs entirely on the seeded in-memory/localStorage store.
   * false -> every api.* call hits the FastAPI server at API_BASE.
   * Flip this to false once uvicorn is running and the endpoints exist.
   */
  const USE_MOCK_BACKEND = true;
  const API_BASE = "http://localhost:8000"; // FastAPI default (uvicorn --port 8000)
  const POLL_INTERVAL_MS = 5000;            // dashboard refresh cadence
  const TICK_MS = 1000;                     // countdown re-render cadence
  const STORAGE_KEY = "tickwise.state.v1";
  const USER_KEY = "tickwise.user.v1";
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
  let store = { tasks: [], runs: [] };
  let pollTimer = null;
  let tickTimer = null;
  let lastSyncAt = 0;
  let polling = false;

  const uid = (prefix = "tsk") =>
    `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  const escapeHtml = (value = "") =>
    String(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));

  const iso = (ms) => new Date(ms).toISOString();

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
      return url.protocol === "http:" || url.protocol === "https:";
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

  /* =============================================== 2. Mock backend ("server") */

  /**
   * A deliberately small stand-in for the FastAPI service. It keeps tasks in
   * localStorage, and — importantly — *runs the scheduler* on every read so the
   * demo behaves like a live worker: due tasks execute, produce history rows,
   * fail deterministically where seeded to fail, and retry.
   */

  /** Deterministic failure rule so demos are reproducible:
   *  an HTTP task whose payload includes "fail" always fails (and retries). */
  const shouldFail = (task) =>
    task.action_type === "http" && /fail/i.test(task.payload);

  /**
   * Generates realistic history rows. When a run fails and the task allows
   * retries, one row is produced per attempt — exactly what the worker does.
   */
  function seedRuns(task, count, { failEvery = 0 } = {}) {
    const runs = [];
    const now = Date.now();
    const maxAttempts = 1 + Number(task.max_retries || 0);

    for (let i = count; i >= 1; i -= 1) {
      const started = now - i * task.interval_seconds * 1000;
      const failed = failEvery > 0 && i % failEvery === 0;
      const attempts = failed ? maxAttempts : 1;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        runs.push({
          id: uid("run"),
          task_id: task.id,
          started_at: iso(started + (attempt - 1) * 2000),
          duration_ms: failed ? 1400 + attempt * 60 : 40 + Math.round(Math.random() * 220),
          status: failed ? "failed" : "success",
          attempt,
          detail: failed
            ? `attempt ${attempt}/${maxAttempts} · HTTPError: 503 Service Unavailable`
            : task.action_type === "http"
              ? `200 OK · ${task.payload}`
              : `logged: ${task.payload}`,
        });
      }
    }
    return runs;
  }

  function buildSeed() {
    const now = Date.now();

    const t1 = {
      id: "tsk_ping01",
      name: "Ping payment gateway",
      interval_seconds: 30,
      action_type: "http",
      payload: "https://api.stripe.com/health",
      status: "active",
      max_retries: 2,
      created_at: iso(now - 1000 * 60 * 60 * 26),
      next_run_at: iso(now + 8000),
      last_run_at: null,
      last_status: "success",
    };

    const t2 = {
      id: "tsk_log02",
      name: "Snapshot nightly metrics",
      interval_seconds: 10,
      action_type: "log",
      payload: "nightly metrics snapshot queued",
      status: "active",
      max_retries: 1,
      created_at: iso(now - 1000 * 60 * 60 * 4),
      next_run_at: iso(now + 4000),
      last_run_at: null,
      last_status: "success",
    };

    const t3 = {
      id: "tsk_fail03",
      name: "Webhook to legacy billing",
      interval_seconds: 45,
      action_type: "http",
      payload: "https://legacy-billing.internal/fail/hook",
      status: "active",
      max_retries: 2,
      created_at: iso(now - 1000 * 60 * 90),
      next_run_at: iso(now + 20000),
      last_run_at: null,
      last_status: "failed",
    };

    const t4 = {
      id: "tsk_pause04",
      name: "Daily Slack standup reminder",
      interval_seconds: 86400,
      action_type: "log",
      payload: "Standup in 10 minutes — post your update",
      status: "paused",
      max_retries: 0,
      created_at: iso(now - 1000 * 60 * 60 * 72),
      next_run_at: null,
      last_run_at: null,
      last_status: "success",
    };

    const tasks = [t1, t2, t3, t4];
    const runs = [
      ...seedRuns(t1, 5),                          // healthy HTTP task
      ...seedRuns(t2, 6),                          // healthy log task
      ...seedRuns(t3, 4, { failEvery: 1 }),        // always fails -> full retry trail
      ...seedRuns(t4, 2),                          // paused task history
    ].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

    tasks.forEach((task) => {
      const own = runs.filter((r) => r.task_id === task.id);
      task.last_run_at = own.length ? own[0].started_at : null;
      task.last_status = own.length ? own[0].status : null;
    });

    return { tasks, runs };
  }

  function loadState() {
    try {
      const raw = storage.get(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.tasks) && Array.isArray(parsed.runs)) {
          return parsed;
        }
      }
    } catch {
      /* corrupted store -> fall through to a fresh seed */
    }
    const seeded = buildSeed();
    saveState(seeded);
    return seeded;
  }

  function saveState(state) {
    try {
      storage.set(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* private mode / quota — the in-memory copy still works this session */
    }
  }

  let DB = loadState();

  const persist = () => saveState(DB);
  const findTask = (id) => DB.tasks.find((t) => t.id === id);

  /**
   * The mock scheduler. Runs every task whose next_run_at is in the past,
   * records the run(s) including retries, and rolls next_run_at forward.
   * Called on every read so the client never diverges from "the server".
   */
  function runDueTasks() {
    const now = Date.now();
    let changed = false;

    DB.tasks.forEach((task) => {
      if (task.status !== "active" || !task.next_run_at) return;

      let scheduled = new Date(task.next_run_at).getTime();
      let guard = 0;

      while (scheduled <= now && guard < 8) {
        guard += 1;
        const maxAttempts = 1 + Number(task.max_retries || 0);
        let attempt = 1;
        let succeeded = false;

        while (attempt <= maxAttempts) {
          const failed = shouldFail(task);
          const startedAt = scheduled + (attempt - 1) * 2000;
          DB.runs.push({
            id: uid("run"),
            task_id: task.id,
            started_at: iso(startedAt),
            duration_ms: failed ? 1500 : 40 + Math.round(Math.random() * 200),
            status: failed ? "failed" : "success",
            attempt,
            detail: failed
              ? `attempt ${attempt}/${maxAttempts} · HTTPError: 503 Service Unavailable`
              : task.action_type === "http"
                ? `200 OK · ${task.payload}`
                : `logged: ${task.payload}`,
          });
          if (!failed) {
            succeeded = true;
            break;
          }
          attempt += 1;
        }

        task.last_run_at = iso(scheduled);
        task.last_status = succeeded ? "success" : "failed";
        scheduled += task.interval_seconds * 1000;
        changed = true;
      }

      // Roll forward so a sleeping tab doesn't produce a backlog.
      while (scheduled <= now) scheduled += task.interval_seconds * 1000;
      task.next_run_at = iso(scheduled);
    });

    if (changed) {
      // Keep the log bounded for the MVP store.
      DB.runs = DB.runs
        .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
        .slice(0, 400);
      persist();
    }
  }

  /* ------------------------------------------------------------- API surface */

  /**
   * Every function below is the single seam between UI and backend.
   * To go live with FastAPI: set USE_MOCK_BACKEND = false (top of file) and
   * delete the mock branch — the fetch calls are already written out.
   */
  const api = {
    /** GET /tasks */
    async listTasks() {
      if (USE_MOCK_BACKEND) {
        await sleep(120);
        runDueTasks();
        return {
          tasks: JSON.parse(JSON.stringify(DB.tasks)),
          runs: JSON.parse(JSON.stringify(DB.runs)),
        };
      }
      // ---- REAL API -----------------------------------------------------
      // const res = await fetch(`${API_BASE}/tasks`, { headers: authHeader() });
      // if (!res.ok) throw new ApiError(res.status, await res.text());
      // return res.json();  // { tasks, runs }
    },

    /** POST /tasks */
    async createTask(payload) {
      if (USE_MOCK_BACKEND) {
        await sleep(320);
        const now = Date.now();
        const task = {
          id: uid("tsk"),
          name: payload.name,
          interval_seconds: payload.interval_seconds,
          action_type: payload.action_type,
          payload: payload.payload,
          status: "active",
          max_retries: payload.max_retries,
          created_at: iso(now),
          // First run fires one interval from now.
          next_run_at: iso(now + payload.interval_seconds * 1000),
          last_run_at: null,
          last_status: null,
        };
        DB.tasks.unshift(task);
        persist();
        return task;
      }
      // ---- REAL API -----------------------------------------------------
      // const res = await fetch(`${API_BASE}/tasks`, {
      //   method: "POST",
      //   headers: { "Content-Type": "application/json", ...authHeader() },
      //   body: JSON.stringify(payload),
      // });
      // if (res.status === 422) throw new ApiError(422, await res.text());
      // return res.json();
    },

    /** PATCH /tasks/{id}  — body: { status: "active" | "paused" } */
    async setTaskStatus(id, status) {
      if (USE_MOCK_BACKEND) {
        await sleep(140);
        const task = findTask(id);
        if (!task) throw new Error("Task not found");
        task.status = status;
        task.next_run_at =
          status === "active" ? iso(Date.now() + task.interval_seconds * 1000) : null;
        persist();
        return task;
      }
      // ---- REAL API -----------------------------------------------------
      // const res = await fetch(`${API_BASE}/tasks/${id}`, {
      //   method: "PATCH",
      //   headers: { "Content-Type": "application/json", ...authHeader() },
      //   body: JSON.stringify({ status }),
      // });
      // if (!res.ok) throw new Error(await res.text());
      // return res.json();
    },

    /** POST /tasks/{id}/run  — trigger one execution immediately */
    async runNow(id) {
      if (USE_MOCK_BACKEND) {
        await sleep(420);
        const task = findTask(id);
        if (!task) throw new Error("Task not found");
        const failed = shouldFail(task);
        const run = {
          id: uid("run"),
          task_id: id,
          started_at: iso(Date.now()),
          duration_ms: failed ? 1200 : 60 + Math.round(Math.random() * 180),
          status: failed ? "failed" : "success",
          attempt: 1,
          detail: failed
            ? "manual run · HTTPError: 503 Service Unavailable"
            : task.action_type === "http"
              ? `200 OK · ${task.payload}`
              : `logged: ${task.payload}`,
        };
        DB.runs.unshift(run);
        task.last_run_at = run.started_at;
        task.last_status = run.status;
        persist();
        return run;
      }
      // ---- REAL API -----------------------------------------------------
      // const res = await fetch(`${API_BASE}/tasks/${id}/run`, {
      //   method: "POST", headers: authHeader(),
      // });
      // if (!res.ok) throw new Error(await res.text());
      // return res.json();
    },

    /** DELETE /tasks/{id} */
    async deleteTask(id) {
      if (USE_MOCK_BACKEND) {
        await sleep(160);
        DB.tasks = DB.tasks.filter((t) => t.id !== id);
        DB.runs = DB.runs.filter((r) => r.task_id !== id);
        persist();
        return { ok: true };
      }
      // ---- REAL API -----------------------------------------------------
      // const res = await fetch(`${API_BASE}/tasks/${id}`, {
      //   method: "DELETE", headers: authHeader(),
      // });
      // if (!res.ok) throw new Error(await res.text());
      // return res.json();
    },

    /** GET /tasks/{id}/runs — execution history, newest first */
    async listRuns(id) {
      if (USE_MOCK_BACKEND) {
        await sleep(100);
        runDueTasks();
        return DB.runs.filter((r) => r.task_id === id);
      }
      // ---- REAL API -----------------------------------------------------
      // const res = await fetch(`${API_BASE}/tasks/${id}/runs?limit=50`, {
      //   headers: authHeader(),
      // });
      // if (!res.ok) throw new Error(await res.text());
      // return res.json();
    },
  };

  // Placeholder for a real bearer token once auth exists.
  // const authHeader = () => ({ Authorization: `Bearer ${localStorage.getItem("token")}` });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  /* ========================================================= 5. Auth (mocked) */

  const authForm = $("#authForm");
  const authSlot = $("#authSlot");
  const authTitle = $("#authTitle");
  const authSub = $("#authSub");
  const nameField = $("#nameField");
  const authSubmit = $("#authSubmit");
  let authMode = "login";

  const readUser = () => {
    try {
      return JSON.parse(storage.get(USER_KEY) || "null");
    } catch {
      return null;
    }
  };

  const writeUser = (user) => {
    try {
      if (user) storage.set(USER_KEY, JSON.stringify(user));
      else storage.remove(USER_KEY);
    } catch { /* ignore */ }
  };

  function renderAuthSlot() {
    const user = readUser();
    if (user) {
      const initials = (user.name || user.email || "U")
        .split(/[\s@.]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join("");
      authSlot.innerHTML = `
        <span class="user-chip" title="${escapeHtml(user.email)}">
          <span class="user-chip__avatar" aria-hidden="true">${escapeHtml(initials)}</span>
          <span class="user-chip__name">${escapeHtml(user.name || user.email.split("@")[0])}</span>
        </span>
        <button class="btn btn--ghost btn--sm" type="button" id="logoutBtn">Log out</button>`;
      $("#logoutBtn").addEventListener("click", () => {
        writeUser(null);
        renderAuthSlot();
        toast("Logged out", "Session cleared (mock auth).", "info");
        navigate("/");
      });
    } else {
      authSlot.innerHTML = `<a class="btn btn--ghost btn--sm" href="#/auth">Log in</a>`;
    }

    const user2 = readUser();
    $("#greetingName").textContent = user2
      ? `Welcome back, ${(user2.name || user2.email.split("@")[0]).split(" ")[0]}`
      : "Dashboard";
  }

  function setAuthMode(mode) {
    authMode = mode;
    $$("[data-auth-tab]").forEach((tab) => {
      const active = tab.dataset.authTab === mode;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    const signup = mode === "signup";
    nameField.hidden = !signup;
    authTitle.textContent = signup ? "Create your account" : "Welcome back";
    authSub.textContent = signup
      ? "Start scheduling in under a minute."
      : "Log in to manage your scheduled tasks.";
    authSubmit.textContent = signup ? "Create account" : "Log in";
    $("#authPassword").autocomplete = signup ? "new-password" : "current-password";
    clearAuthErrors();
  }

  $$("[data-auth-tab]").forEach((tab) =>
    tab.addEventListener("click", () => setAuthMode(tab.dataset.authTab))
  );

  function setFieldError(inputId, message) {
    const input = $(`#${inputId}`);
    const error = $(`[data-error-for="${inputId}"]`);
    if (input) input.classList.toggle("is-invalid", Boolean(message));
    if (error) {
      error.hidden = !message;
      error.textContent = message || "";
    }
  }

  function clearAuthErrors() {
    ["authName", "authEmail", "authPassword"].forEach((id) => setFieldError(id, ""));
  }

  authForm.addEventListener("submit", (event) => {
    event.preventDefault();
    clearAuthErrors();

    const name = $("#authName").value.trim();
    const email = $("#authEmail").value.trim();
    const password = $("#authPassword").value;

    let ok = true;
    if (authMode === "signup" && name.length < 2) {
      setFieldError("authName", "Enter your name (at least 2 characters).");
      ok = false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      setFieldError("authEmail", "Enter a valid email address.");
      ok = false;
    }
    if (password.length < 6) {
      setFieldError("authPassword", "Password must be at least 6 characters.");
      ok = false;
    }
    if (!ok) return;

    // NOTE: MVP only — no request is sent. A real build posts to
    // POST /auth/signup or /auth/login and stores the returned JWT.
    authSubmit.disabled = true;
    authSubmit.textContent = authMode === "signup" ? "Creating…" : "Logging in…";

    setTimeout(() => {
      writeUser({ name: authMode === "signup" ? name : email.split("@")[0], email });
      renderAuthSlot();
      authSubmit.disabled = false;
      setAuthMode(authMode);
      toast(
        authMode === "signup" ? "Account created" : "Welcome back",
        "Mock session started — real auth is on the roadmap.",
        "success"
      );
      navigate("/dashboard");
    }, 550);
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
  };

  /** Last known server snapshot. */
  let searchTerm = "";
  let previousSignature = new Map(); // task id -> last_run_at, for the "just ran" flash

  async function refreshTasks({ silent = false } = {}) {
    if (polling) return; // never overlap requests
    polling = true;
    try {
      /* ---- REAL API: GET /tasks (see api.listTasks) ---- */
      const data = await api.listTasks();
      store = {
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        runs: Array.isArray(data.runs) ? data.runs : [],
      };
      lastSyncAt = Date.now();
      els.syncChip.classList.remove("is-offline");
      els.syncChip.classList.toggle("is-mock", USE_MOCK_BACKEND);
      renderStats();
      renderTasks();
    } catch (error) {
      els.syncChip.classList.add("is-offline");
      els.syncChip.classList.remove("is-mock");
      els.syncText.textContent = "Offline — retrying";
      if (!silent) {
        toast("Could not load tasks", error.message || "Backend unreachable.", "error");
      }
    } finally {
      polling = false;
    }
  }

  /* ------------------------------------------------------------- Stats row */

  /**
   * Stats are computed over "executions" — one entry per scheduled fire —
   * rather than over raw attempt rows, so a task that succeeded on its 3rd
   * retry counts as one successful execution (and its retries are still
   * visible in the history modal).
   */
  function summariseRuns(runs) {
    const byExecution = new Map();
    runs.forEach((run) => {
      // started_at is stable per scheduled fire; attempts are spaced 2s apart,
      // so we bucket on a rounded 5s window.
      const bucket = Math.floor(new Date(run.started_at).getTime() / 5000);
      const key = `${run.task_id}|${bucket}`;
      const current = byExecution.get(key);
      if (!current) {
        byExecution.set(key, { ok: run.status === "success", attempts: 1, retries: Number(run.attempt) > 1 ? 1 : 0 });
      } else {
        current.ok = current.ok || run.status === "success";
        current.attempts += 1;
      }
    });
    const list = [...byExecution.values()];
    return {
      executions: list.length,
      succeeded: list.filter((e) => e.ok).length,
      failed: list.filter((e) => !e.ok).length,
      retried: list.filter((e) => e.attempts > 1).length,
    };
  }

  function renderStats() {
    const total = store.tasks.length;
    const active = store.tasks.filter((t) => t.status === "active").length;
    const paused = total - active;
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = store.runs.filter((r) => new Date(r.started_at).getTime() >= since);
    const stats = summariseRuns(recent);
    const rate = stats.executions
      ? Math.round((stats.succeeded / stats.executions) * 100)
      : null;

    els.statTotal.textContent = String(total);
    els.statTotalHint.textContent = paused ? `${paused} paused` : "all active";
    els.statActive.textContent = String(active);
    els.statActiveHint.textContent = active ? "running on interval" : "nothing scheduled";
    els.statRuns.textContent = String(stats.executions);
    els.statRunsHint.textContent = stats.executions
      ? `${stats.failed} failed · ${stats.retried} retried`
      : "no runs yet";
    els.statRate.textContent = rate === null ? "—" : `${rate}%`;
    els.statRateHint.textContent = rate === null
      ? "no data yet"
      : `${stats.succeeded}/${stats.executions} executions ok`;
  }

  /* ------------------------------------------------------------ Task cards */

  const ACTION_LABEL = { log: "Log Message", http: "HTTP Ping" };

  function taskCardHtml(task) {
    const paused = task.status === "paused";
    const nextRun = task.next_run_at ? new Date(task.next_run_at).getTime() : null;
    const countdown = nextRun ? fmtCountdown(nextRun - Date.now()) : "paused";
    const lastRun = task.last_run_at
      ? `${fmtClock(new Date(task.last_run_at).getTime())} · ${
          task.last_status === "failed" ? "failed" : "ok"
        }`
      : "never run";

    return `
      <article class="task-card${paused ? " is-paused" : ""}" data-task-id="${task.id}">
        <div class="task-main">
          <div class="task-title-row">
            <h3 class="task-name" title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</h3>
            <span class="badge ${paused ? "badge--paused" : "badge--active"}">
              ${paused ? "Paused" : "Active"}
            </span>
            <span class="badge badge--type">${escapeHtml(ACTION_LABEL[task.action_type] || task.action_type)}</span>
          </div>

          <div class="task-meta">
            <span>Every <strong>${escapeHtml(fmtInterval(task.interval_seconds))}</strong></span>
            <span class="sep">·</span>
            <span>Next run
              <strong data-countdown-for="${task.id}">${countdown}</strong>
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
          <button class="btn btn--sm" type="button" data-op="history" data-id="${task.id}">
            View history
          </button>
          <button class="btn btn--sm btn--ghost" type="button" data-op="run" data-id="${task.id}"
                  ${paused ? "disabled" : ""}>Run now</button>
          <button class="btn btn--sm btn--ghost" type="button" data-op="toggle" data-id="${task.id}">
            ${paused ? "Resume" : "Pause"}
          </button>
          <button class="icon-btn" type="button" data-op="delete" data-id="${task.id}"
                  aria-label="Delete ${escapeHtml(task.name)}" title="Delete task">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
            </svg>
          </button>
        </div>

        <div class="task-progress" aria-hidden="true">
          <i data-progress-for="${task.id}"></i>
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

    els.taskCountLabel.textContent = store.tasks.length
      ? `${visible.length} of ${store.tasks.length} task${store.tasks.length === 1 ? "" : "s"}${
          term ? ` matching “${searchTerm}”` : ""
        }`
      : "No tasks yet";

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
      const newest = store.runs.find((r) => r.task_id === task.id);
      const signature = `${task.last_run_at}|${newest ? newest.id : ""}`;
      nextSignature.set(task.id, signature);
      const before = previousSignature.get(task.id);
      if (before && before !== signature) {
        const card = els.taskList.querySelector(`[data-task-id="${task.id}"]`);
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
    store.tasks.forEach((task) => {
      const label = els.taskList.querySelector(`[data-countdown-for="${task.id}"]`);
      const bar = els.taskList.querySelector(`[data-progress-for="${task.id}"]`);
      if (!label) return;

      if (task.status === "paused" || !task.next_run_at) {
        label.textContent = "paused";
        if (bar) bar.style.width = "0%";
        return;
      }

      const next = new Date(task.next_run_at).getTime();
      label.textContent = fmtCountdown(next - now);

      if (bar) {
        const interval = Number(task.interval_seconds) * 1000;
        const elapsed = interval - (next - now);
        bar.style.width = `${clamp((elapsed / interval) * 100, 0, 100)}%`;
      }
    });

    if (lastSyncAt) {
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
        const run = await api.runNow(id);
        toast(
          run.status === "success" ? "Run succeeded" : "Run failed",
          run.detail,
          run.status === "success" ? "success" : "error"
        );
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
        toast("Task deleted", `“${task.name}” was removed.`, "info");
        await refreshTasks({ silent: true });
      } catch (error) {
        toast("Delete failed", error.message, "error");
      }
    }
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
      hint: "The worker sends a GET request and records the status code. Include “fail” in the URL to simulate an outage.",
      placeholder: "https://api.example.com/health",
    },
  };

  function syncPayloadField() {
    const copy = PAYLOAD_COPY[actionSelect.value] || PAYLOAD_COPY.log;
    payloadLabel.textContent = copy.label;
    payloadHint.textContent = copy.hint;
    payloadInput.placeholder = copy.placeholder;
    payloadInput.value = "";
    setFieldError("payload", "");
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
      /* ---- REAL API: POST /tasks (see api.createTask) ---- */
      const task = await api.createTask(values);
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
  let lastFocused = null;

  async function openHistory(task) {
    lastFocused = document.activeElement;
    historyTitle.textContent = task.name;
    historySub.textContent = `${ACTION_LABEL[task.action_type] || task.action_type} · every ${fmtInterval(
      task.interval_seconds
    )} · max ${task.max_retries} retr${Number(task.max_retries) === 1 ? "y" : "ies"}`;
    historySummary.innerHTML = "";
    historyBody.innerHTML = `<p class="field__hint" style="padding:1rem 0">Loading runs…</p>`;
    historyModal.hidden = false;
    historyModal.querySelector(".modal__panel").focus();

    try {
      /* ---- REAL API: GET /tasks/{id}/runs (see api.listRuns) ---- */
      const runs = (await api.listRuns(task.id)).sort(
        (a, b) => new Date(b.started_at) - new Date(a.started_at)
      );

      const ok = runs.filter((r) => r.status === "success").length;
      const failed = runs.length - ok;
      const retries = runs.filter((r) => Number(r.attempt) > 1).length;
      const avg = runs.length
        ? Math.round(runs.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / runs.length)
        : 0;

      historySummary.innerHTML = `
        <span class="chip">Runs <strong>${runs.length}</strong></span>
        <span class="chip chip--ok">Succeeded <strong>${ok}</strong></span>
        <span class="chip chip--bad">Failed <strong>${failed}</strong></span>
        <span class="chip">Retry attempts <strong>${retries}</strong></span>
        <span class="chip">Avg duration <strong>${fmtDuration(avg)}</strong></span>`;

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
                  <span class="badge ${run.status === "success" ? "badge--success" : "badge--failed"}">
                    ${run.status === "success" ? "Success" : "Failed"}
                  </span>
                </td>
                <td class="mono">${escapeHtml(
                  fmtDateTime(new Date(run.started_at).getTime())
                )}</td>
                <td class="mono">${fmtDuration(run.duration_ms || 0)}</td>
                <td class="mono">${Number(run.attempt) > 1 ? `retry ${run.attempt}` : "1"}</td>
                <td class="detail">${escapeHtml(run.detail || "—")}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>`;
    } catch (error) {
      historyBody.innerHTML = `<p class="field__error" style="padding:1rem 0">
        Could not load history: ${escapeHtml(error.message || "unknown error")}
      </p>`;
    }
  }

  function closeHistory() {
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
  setAuthMode("login");
  renderRoute();
})();
