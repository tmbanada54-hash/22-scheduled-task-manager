# Tickwise — Scheduled Task Manager

A single-host scheduler with a browser dashboard, a FastAPI service, and durable
SQLite storage. Create recurring log or HTTP tasks, inspect runs and attempts,
retry failures, and pause, resume, trigger, or delete tasks. The merged frontend,
backend and database contributions now use the same API and runtime schema.

## Quick start

Requirements: Python 3.11+ and a local filesystem writable by the app. From the
repository root:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cd backend
cp .env.example .env
.venv/bin/uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000/> and choose **Get started**. For this local-only
configuration, leave the workspace key blank; the dashboard starts empty. Create
a **Log Message** task, then use **Run now** and **View history**. The app
initializes `backend/data/tasks.sqlite3` automatically. See
[`database/README.md`](database/README.md) for an optional paused demo task.

`backend/.env` is loaded only when `--env-file .env` is specified. Before making
the service reachable by others, set a long random `API_KEY`, use HTTPS and
restrict network access. Enter the same key on the workspace access screen.
This is a **shared API key**, not individual user accounts. The frontend keeps
it in the current tab's session storage; it does not fabricate accounts, tasks,
or execution results.

The dashboard creates interval tasks (5–86,400 seconds) and displays existing
cron and one-time tasks. Its search filters the current task page; older tasks
and run history have pagination. Cron/once creation, configuration editing,
custom HTTP methods, headers and bodies are available via the API. Voice entry
uses the browser's Web Speech API and depends on browser/microphone support.

## API

Interactive documentation: <http://127.0.0.1:8000/docs>. API routes are under
`/api/v1`. If configured, send `X-API-Key: <your key>` on every API request;
`/`, `/health`, `/docs` and `/openapi.json` are public.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Database and scheduler health |
| `GET` | `/api/v1/stats` | Global task counts and completed-run statistics for the last 24h |
| `POST`, `GET` | `/api/v1/tasks` | Create or list tasks |
| `GET`, `PATCH`, `DELETE` | `/api/v1/tasks/{id}` | Inspect, update or delete a task and its history |
| `POST` | `/api/v1/tasks/{id}/pause`, `/resume` | Pause or resume |
| `POST` | `/api/v1/tasks/{id}/runs` | Queue a manual run; returns `202` and a `Location` header |
| `GET` | `/api/v1/tasks/{id}/runs` | A task's runs and their attempts |
| `GET` | `/api/v1/runs`, `/api/v1/runs/{id}` | Query all runs or inspect one run |

Lists are newest first; `limit` defaults to 50 and is capped at 100, and
`offset` is supported. Task lists accept `enabled`; run lists accept `status`
and the global list accepts `task_id`. Validation errors return `422`, missing
resources `404`, and manual triggers of paused tasks or those with an unfinished
run return `409`. Statistics count **terminal runs created in the last 24h**;
an enabled one-time task is no longer active once its run finishes.

Example log task:

```json
{
  "name": "Heartbeat",
  "action_type": "log",
  "message": "Service is running",
  "schedule": {"type": "interval", "seconds": 30},
  "retry": {"max_retries": 2, "delay_seconds": 60}
}
```

Example HTTP task (`api.example.com` is a placeholder; use an endpoint you
control):

```json
{
  "name": "Sync inventory",
  "action_type": "http",
  "url": "https://api.example.com/hooks/sync",
  "method": "POST",
  "headers": {"Authorization": "Bearer replace-me"},
  "body": {"source": "scheduler"},
  "schedule": {"type": "cron", "expression": "*/5 * * * *"},
  "retry": {"max_retries": 2, "delay_seconds": 60},
  "timeout_seconds": 10
}
```

HTTP is the default action when `action_type` is omitted. Supported methods are
`GET`, `POST`, `PUT`, `PATCH` and `DELETE`; JSON bodies are supported for POST,
PUT and PATCH. A log action requires a nonempty `message` and cannot include an
HTTP URL, headers or body. `max_retries` is **in addition to** the first attempt
(0–10); delay is 1–86,400 seconds and timeout is 1–120 seconds. The dashboard
uses a 60-second retry delay and a GET for HTTP pings. `PATCH` is partial at the
top level, but replaces nested `schedule` and `retry` objects.

Schedules are:

```json
{"type":"interval","seconds":30}
{"type":"cron","expression":"0 9 * * 1-5"}
{"type":"once","run_at":"2030-01-01T09:00:00Z"}
```

Cron uses five fields in **UTC**, with minute precision and traditional
OR semantics for restricted day-of-month/day-of-week fields. One-time values
must be future ISO 8601 timestamps with a timezone offset. Clients must handle
local time and daylight-saving conversions.

## Scheduling and delivery behavior

- Each invocation creates a run; each delivery is a numbered attempt. States are
  `queued`, `running`, `retrying`, `succeeded` and `failed`.
- HTTP `2xx` succeeds; other statuses, timeouts and network failures may retry
  after a fixed delay. Redirects are not followed; HTTP response bodies are not
  saved. Log output is recorded in the attempt history.
- Only one unfinished run per task is allowed. Manual runs do not move the
  schedule. Recurring ticks missed during downtime or an unfinished run are
  coalesced or skipped rather than replayed. A due one-time task waits for an
  existing run. Polling and queueing can add delay.
- Pausing stops future scheduling and holds queued runs/retries, but does not
  cancel a request already in flight. Resuming a recurring task starts a new
  interval or future cron tick. An unconsumed one-time task runs when resumed;
  a dispatched one-time task is not automatically rearmed.
- Settings are snapshotted per run: edits affect future runs, not unfinished
  ones. Deleting a task removes its history and cannot cancel an in-flight HTTP
  request.
- SQLite transactions and leases coordinate workers using the same local file.
  Recovery may retry after a worker crashes. **Delivery is not exactly once.**
  Receivers should deduplicate using the stable `Idempotency-Key` or
  `X-Scheduled-Run-Id` header; `X-Scheduled-Task-Id` and
  `X-Scheduled-Attempt` are also supplied.

## Configuration

Set environment variables directly or use `backend/.env.example` with
`uvicorn --env-file .env` from `backend/`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_PATH` | `data/tasks.sqlite3` | SQLite file path, relative to the working directory |
| `SCHEDULER_ENABLED` | `true` | Run the embedded scheduler; disabling it leaves runs queued unless another worker uses the same database |
| `POLL_INTERVAL_SECONDS` | `1` | Worker polling interval, 0.05–60 seconds |
| `MAX_CONCURRENCY` | `5` | Maximum simultaneous deliveries per process, 1–100 |
| `LEASE_GRACE_SECONDS` | `30` | Extra lease time beyond timeout, 1–3,600 seconds |
| `API_KEY` | unset | Shared key required in `X-API-Key` for `/api/v1` when set |
| `ALLOWED_TARGET_HOSTS` | unset | Comma-separated exact hostnames or IPs; unset permits any public target |
| `ALLOW_PRIVATE_TARGETS` | `false` | Allow non-public addresses; only for trusted environments |
| `CORS_ORIGINS` | unset | Comma-separated allowed cross-origin browser origins; unnecessary for the bundled same-origin UI |

## Deployment

`compose.yaml` builds the application from the repository root, mounts a named
volume at `/data`, requires an API key, and binds to `127.0.0.1:8000` by default
for use behind a TLS reverse proxy:

```bash
# Enter a long random secret without saving it in shell history or Git.
read -r -s -p 'Workspace API key: ' API_KEY; echo
export API_KEY
docker compose up -d --build
docker compose logs -f tickwise
```

Use `PORT` or `BIND_ADDRESS` to change the host binding. Only expose the service
through HTTPS and network access controls. If deploying without Compose:

```bash
docker build -f backend/Dockerfile -t tickwise .
docker run -d --name tickwise --restart unless-stopped \
  -p 127.0.0.1:8000:8000 -v tickwise-data:/data \
  -e API_KEY="$API_KEY" tickwise
```

Use one long-lived instance and a persistent **local** volume. The image runs
as UID 10001; a bind-mounted directory must be writable by that user. Do not
use an ephemeral filesystem or a network filesystem shared between machines.
SQLite is appropriate for a single host and modest workloads, not distributed
multi-host scaling. If the platform supplies a `PORT`, override the command
with `uvicorn app.main:app --host 0.0.0.0 --port "$PORT"`. The health check is
`/health`. No hosted URL is included.

### Backup

Before upgrading, take an online SQLite backup so committed WAL data is included.
For the Compose volume, for example:

```bash
docker compose exec tickwise python -c "import os,sqlite3; src=sqlite3.connect('/data/tasks.sqlite3'); dst=sqlite3.connect('/data/backup.sqlite3'); src.backup(dst); dst.close(); src.close(); os.chmod('/data/backup.sqlite3', 0o600)"
docker compose cp tickwise:/data/backup.sqlite3 ./backup.sqlite3
```

Store backups securely, test restoration, and delete the temporary copy from the
volume when no longer needed. For an existing backend v1 SQLite database, startup
automatically migrates to v2 while preserving data; back up first. The database
team's earlier unversioned prototype is incompatible and is rejected rather than
overwritten. It needs a separately designed data conversion.

## Security and limitations

- With no `API_KEY`, application API endpoints are unauthenticated. Use a
  random key, HTTPS, a restrictive firewall/reverse proxy and egress controls.
  There is no per-user authorization, account management, key rotation UI or
  request rate limiting.
- Private/local IPs are blocked by default. DNS answers are checked at delivery
  time, redirects and environment proxies are disabled, and TLS certificates
  are verified. Restrict `ALLOWED_TARGET_HOSTS` and infrastructure egress.
  `ALLOW_PRIVATE_TARGETS=true` can expose internal services and cloud metadata;
  use it only when task authors and target hosts are trusted.
- URLs, HTTP headers and bodies, log messages, and history are stored unencrypted
  and returned to authorized API clients. Protect the database and backups and
  avoid secrets in URLs. There is no automatic history-retention policy.
- The original frontend-team images in `screenshots/` depict the earlier
  prototype, including its simulated sign-in; the running UI uses API keys.
- The database team's PostgreSQL/Prisma work is preserved as a design prototype,
  not a supported runtime or automatic migration source. See
  [`database/README.md`](database/README.md) and the
  [runtime ER diagram](docs/ER_DIAGRAM.md).

## Testing

```bash
cd backend
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/ruff check .
.venv/bin/python -m pytest -q
cd ..

# Optional browser integration test (Node 22+, browser dependencies required)
npm ci
npx playwright install --with-deps chromium
PYTHON_BIN="$PWD/backend/.venv/bin/python" npm run test:ui
```

The browser test starts its own temporary API, scheduler and loopback HTTP
receiver; it uses a disposable database and enables private targets only for the
test. It covers key access, real task persistence, log and HTTP success/failure,
pause/resume, histories, pagination and deletion. GitHub Actions also builds and
smoke-tests the container with a persistent volume.

## Integration handoff and files created

- `app.js` now supplies the frontend↔backend integration that was missing from
  the frontend handoff: real same-origin API calls, a shared-key flow and
  persisted run history. The UI and API teams would normally agree on this
  adapter and the final contract together.
- `database/migrations/001_sqlite_backend_v1.sql` extracts the backend team's
  previous embedded schema; `002_sqlite_interval_log.sql` bridges it to the
  database/frontend teams' interval and log needs. The team SQLite prototype was
  preserved under `database/design/` rather than silently discarded.
- `database/seed.sqlite.sql` and `database/tests/test_constraints.sql` were
  referenced or needed by the database handoff but missing. They now target the
  supported SQLite runtime; the database team would normally supply/maintain
  these files. The original PostgreSQL constraint test was never supplied and
  remains a separate, unsupported prototype task.
- `backend/tests/test_team_integration.py`, `frontend-tests/smoke.cjs`,
  `package.json` and `package-lock.json` provide the cross-team integration
  checks that were missing from the individual branches.
- `.dockerignore` and `compose.yaml`, together with the updated Dockerfile and CI
  workflow, bridge the deployment handoff across all three teams. The original
  proposed ER diagram is preserved in `docs/design/`; `docs/ER_DIAGRAM.md` now
  describes the actual SQLite model.
