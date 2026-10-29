# Tickwise — Scheduled Task Manager (frontend MVP)

Plain **HTML + CSS + vanilla JS** frontend for a scheduled task manager. The
scheduler runs tasks on a fixed interval, shows the next execution time, records
every outcome (with retry attempts) and lets you pause/resume/run tasks on demand.

This folder is the **frontend half** of the hackathon MVP. It ships with a mock
backend (seeded data + a simulated scheduler) so the whole flow demos before the
FastAPI service exists.

```
index.html      landing page, auth screen, dashboard, history modal
styles.css      design tokens, dark/light themes, layout, components
app.js          router, mock API layer, polling, validation, voice input
screenshots/    reference screenshots of the three screens
```

## Run it

No build step, no dependencies.

```bash
# option 1 — any static server
python3 -m http.server 8000
# open http://localhost:8000

# option 2 — just double-click index.html
# (works too: storage falls back to memory, so nothing crashes)
```

> Use `localhost` (not `file://`) if you want the Web Speech API to work —
> browsers only grant microphone access on secure origins (`https` or
> `localhost`).

## Screens

| Route | Screen | Purpose |
| --- | --- | --- |
| `#/` | Landing | Hero, feature grid, 3-step explainer, CTA |
| `#/auth` | Auth | Login / signup UI (mock — any valid email + 6-char password) |
| `#/dashboard` | Dashboard | Create-task form, KPI row, task list, 5s polling |
| — | History modal | Executions per task: status, timestamp, duration, attempt, detail |

## Features

- **Create task** — name, interval (5–86400s), action type (`Log Message` / `HTTP Ping`), payload, max retries.
- **Task list** — name, status badge, live countdown to next run, action type, payload preview, progress bar.
- **Live updates** — `fetch`-style poll every **5 s**, plus a 1 s local tick that only patches countdown text (no full re-render, so typing in the form never gets interrupted).
- **Retries** — a failed execution is retried up to `max_retries`; each attempt is stored and labelled `retry 2`, `retry 3` in the history modal.
- **Pause / Resume / Run now / Delete** — with optimistic toasts and `confirm()` guard on delete.
- **Voice input (wow feature)** — the mic next to *Task name* uses `webkitSpeechRecognition`. It also parses intent: *“ping the api every 60 seconds”* sets the name, the interval to `60` and the action to HTTP Ping.
- **Validation** — client-side, with inline field errors for both the task form and the auth form; URLs must be `http(s)` (blocks `javascript:` payloads).
- **Dark/light theme** — toggled in the top bar, persisted in `localStorage`.
- **Reporting** — total/active tasks, executions in the last 24 h, success rate.

## Connecting the real FastAPI backend

Everything the UI needs is behind one object, `api`, near the top of `app.js`.
Each method has the real `fetch` call written out in comments directly below the
mock branch.

```js
// app.js
const USE_MOCK_BACKEND = true;              // -> false to go live
const API_BASE = "http://localhost:8000";   // uvicorn default
```

Expected endpoints (`snake_case` JSON, ISO-8601 UTC timestamps):

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/tasks` | — | `{ tasks: Task[], runs: Run[] }` |
| `POST` | `/tasks` | `{name, interval_seconds, action_type, payload, max_retries}` | `Task` (422 on invalid) |
| `PATCH` | `/tasks/{id}` | `{status: "active"\|"paused"}` | `Task` |
| `POST` | `/tasks/{id}/run` | — | `Run` |
| `DELETE` | `/tasks/{id}` | — | `{ok: true}` |
| `GET` | `/tasks/{id}/runs?limit=50` | — | `Run[]` |

### Data model

```jsonc
// Task
{
  "id": "tsk_ping01",
  "name": "Ping payment gateway",          // 1..80 chars
  "interval_seconds": 30,                  // 5..86400
  "action_type": "http",                   // "log" | "http"
  "payload": "https://api.stripe.com/health", // message, or an http(s) URL
  "status": "active",                      // "active" | "paused"
  "max_retries": 2,                        // 0..5
  "next_run_at": "2026-10-29T12:40:00Z",   // null when paused
  "created_at": "2026-10-28T10:00:00Z",
  "last_run_at": "2026-10-29T12:39:30Z",
  "last_status": "success"                 // "success" | "failed" | null
}

// Run (one row per attempt — retries create sibling rows)
{
  "id": "run_ab12cd",
  "task_id": "tsk_ping01",
  "started_at": "2026-10-29T12:39:30Z",
  "duration_ms": 182,
  "status": "success",                     // "success" | "failed"
  "attempt": 1,                            // >1 means a retry
  "detail": "200 OK · https://api.stripe.com/health"
}
```

SQL equivalent (Postgres) — see the README section below:

```sql
CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  name             TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  interval_seconds INTEGER     NOT NULL CHECK (interval_seconds BETWEEN 5 AND 86400),
  action_type      TEXT        NOT NULL CHECK (action_type IN ('log','http')),
  payload          TEXT        NOT NULL CHECK (char_length(payload) <= 500),
  status           TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  max_retries      INTEGER     NOT NULL DEFAULT 2 CHECK (max_retries BETWEEN 0 AND 5),
  next_run_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at      TIMESTAMPTZ,
  last_status      TEXT
);

CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER     NOT NULL,
  status      TEXT        NOT NULL CHECK (status IN ('success','failed')),
  attempt     INTEGER     NOT NULL DEFAULT 1,
  detail      TEXT
);

CREATE INDEX runs_task_started_idx ON runs (task_id, started_at DESC);
CREATE INDEX tasks_due_idx ON tasks (next_run_at) WHERE status = 'active';
```

## Environment variables (backend)

```bash
# .env.example — FastAPI service
DATABASE_URL=postgresql://user:pass@host:5432/tickwise
SCHEDULER_TICK_SECONDS=1          # how often the worker claims due tasks
MAX_RETRIES_DEFAULT=2
HTTP_TIMEOUT_SECONDS=5
CORS_ORIGINS=http://localhost:3000,https://your-frontend.vercel.app
```

## Test strategy

The MVP needs two tests: the happy path and one major failure path.

**Happy path — task is created and executes**

1. Open `#/dashboard`, note `Total tasks`.
2. Create `Smoke test`, interval `12`, action `Log Message`, payload `hello`.
3. Assert: toast "Task scheduled", new card on top, countdown running, total +1.
4. Wait one interval → assert a `success` row appears in *View history* and the KPI "Runs · 24h" increases.

**Failure path — attempt exhausts retries**

1. Create a task with action `HTTP Ping` and a payload containing `fail`
   (e.g. `https://legacy-billing.internal/fail/hook`) and `max retries = 2`.
   *Rationale: the mock worker fails deterministically on that marker, so the demo is reproducible.*
2. Wait one interval, open *View history*.
3. Assert: 3 rows for the execution (`1`, `retry 2`, `retry 3`) all `Failed`,
   the card's "Last:" shows `failed`, and the success-rate KPI drops.

Additional edge cases covered in code: interval below 5s / above 24h, non-integer
interval, empty payload, `javascript:` URL payload, retries outside 0–5, empty
task list, filter with no matches, and mic permission denied (`not-allowed`).

`pytest` variant for the backend once it exists:

```python
def test_create_and_run(client):
    task = client.post("/tasks", json={
        "name": "smoke", "interval_seconds": 5,
        "action_type": "log", "payload": "hi", "max_retries": 1,
    }).json()
    assert task["status"] == "active"
    run = client.post(f"/tasks/{task['id']}/run").json()
    assert run["status"] == "success"

def test_http_failure_retries(client):
    task = client.post("/tasks", json={
        "name": "broken", "interval_seconds": 5, "action_type": "http",
        "payload": "https://httpbin.org/status/503", "max_retries": 2,
    }).json()
    runs = client.get(f"/tasks/{task['id']}/runs").json()
    assert [r["status"] for r in runs].count("failed") == 3
    assert max(r["attempt"] for r in runs) == 3
```

## 3-minute demo script

1. **Landing (20s)** — one sentence on the product, point at the animated
   scheduler monitor, click **Get started**.
2. **Auth (15s)** — type any email/password; say out loud that auth is mocked for
   the MVP and the JWT seam is documented in `app.js`.
3. **Create with voice (40s)** — tap the mic, say *"ping the api every 30
   seconds"*. Show that name, interval and action type were all filled in
   automatically. Add a URL and **Schedule task**.
4. **Watch it run (40s)** — the card countdown ticks, the progress bar fills, the
   card flashes when the run lands, and the KPIs update from the 5 s poll.
5. **Failure + retries (40s)** — create an HTTP task pointing at `…/fail/hook`,
   open **View history**, point at `attempt 1/3`, `retry 2`, `retry 3`.
6. **Trade-offs (25s)** — mock scheduler in the client vs. a real worker loop;
   polling vs. WebSockets; localStorage vs. Postgres; no-auth vs. JWT.

## Architecture trade-offs (for the demo Q&A)

| Decision | Why | Cost |
| --- | --- | --- |
| Client-side mock "server" that advances `next_run_at` on read | Whole flow demos with no backend, and behaviour survives a refresh | Seeded scheduler stops when the tab is closed — the real worker lives in FastAPI |
| Hash router, three views in one HTML file | Zero build step, deploys to Vercel/Netlify/GitHub Pages as static files | Not code-split; fine at this size |
| 5 s polling instead of WebSockets | Simpler, stateless, works behind any proxy | Up to 5 s of staleness; noted as a "next improvement" |
| 1 s local tick patches only countdown text | Live feel without re-rendering the form (keeps focus/typing) | Two timers to reason about |
| `snake_case` payloads end-to-end | Matches FastAPI/Pydantic defaults with no serialisation layer | Slightly unusual in JS |
| Retries as sibling `runs` rows | Full audit trail of every attempt | Frontend groups them into executions for the KPI rate |

## What's next

- Real auth (JWT) + per-user task ownership
- Server-side worker with durable claims (SKIP LOCKED) so jobs survive restarts
- WebSocket/SSE push instead of polling
- Cron-expression schedules alongside fixed intervals
- Backoff between retries, alerting when a task fails N times in a row
