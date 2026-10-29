# Scheduled Task Manager

A backend for scheduling HTTP tasks, showing when they will run next, recording every execution attempt, and retrying failures. It is built with **FastAPI, SQLite, and an embedded asynchronous scheduler**. The interactive API documentation is the MVP interface; a dashboard can be added separately.

## Quick start

Requirements: Python **3.11+** and pip.

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate             # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --env-file .env --host 127.0.0.1 --port 8000
```

Visit [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs) for the interactive OpenAPI interface or [http://127.0.0.1:8000/health](http://127.0.0.1:8000/health) for health. The SQLite database is created automatically at `backend/data/tasks.sqlite3`. Keep the process running for scheduled work to execute.

> **Security:** the default configuration has no API key and is intended only for local development. Before exposing the API, set a strong `API_KEY`, serve it over HTTPS, restrict `ALLOWED_TARGET_HOSTS`, and enforce network egress restrictions. Task URLs, headers, and bodies are stored in plaintext and returned by the task API. See [Security and limitations](#security-and-limitations).

## Local end-to-end demo

This demo schedules a webhook that fails twice, then succeeds on the third attempt. It uses a deliberately local, unauthenticated sample receiver; do not deploy that receiver.

1. In a separate terminal, run:

   ```bash
   cd backend
   python examples/webhook_receiver.py
   ```

2. For this local demo **only**, set these values in `backend/.env` and restart the API:

   ```dotenv
   ALLOW_PRIVATE_TARGETS=true
   ALLOWED_TARGET_HOSTS=127.0.0.1
   ```

   Keep `API_KEY` empty for the commands below, or add `-H "X-API-Key: $API_KEY"` to each request if you configured a key.

3. From a terminal, create a one-time task due in 15 seconds:

   ```bash
   RUN_AT="$(python -c 'from datetime import datetime, timedelta, timezone; print((datetime.now(timezone.utc) + timedelta(seconds=15)).isoformat())')"
   TASK_ID="$(curl -sS -X POST http://127.0.0.1:8000/api/v1/tasks \
     -H 'Content-Type: application/json' \
     -d "{\"name\":\"Demo webhook\",\"url\":\"http://127.0.0.1:9001/flaky\",\"schedule\":{\"type\":\"once\",\"run_at\":\"$RUN_AT\"},\"body\":{\"event\":\"demo\"},\"retry\":{\"max_retries\":2,\"delay_seconds\":2}}" \
     | python -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
   echo "Task: $TASK_ID"
   curl -sS "http://127.0.0.1:8000/api/v1/tasks/$TASK_ID" | python -m json.tool
   ```

4. Refresh the run history after the due time; the three attempts should have HTTP statuses `503`, `503`, then `200`:

   ```bash
   curl -sS "http://127.0.0.1:8000/api/v1/tasks/$TASK_ID/runs" | python -m json.tool
   ```

   `/ok` always returns 200; `/fail` always returns 503. Stop the receiver and restore `ALLOW_PRIVATE_TARGETS=false` after the demo.

## API

All application endpoints are under `/api/v1`. When `API_KEY` is set, pass it in the `X-API-Key` header, or use **Authorize** in `/docs`. `/health`, `/docs`, and `/openapi.json` are public.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Database and scheduler process health |
| `POST` | `/api/v1/tasks` | Create a task and calculate its next execution |
| `GET` | `/api/v1/tasks` | List tasks; optional `enabled`, `limit`, `offset` |
| `GET` / `PATCH` / `DELETE` | `/api/v1/tasks/{task_id}` | Inspect, edit, or delete a task |
| `POST` | `/api/v1/tasks/{task_id}/pause` | Pause scheduling and pending retries |
| `POST` | `/api/v1/tasks/{task_id}/resume` | Resume a paused task |
| `POST` | `/api/v1/tasks/{task_id}/runs` | Queue a manual run; returns `202` and a `Location` header |
| `GET` | `/api/v1/tasks/{task_id}/runs` | Task run history, including attempts |
| `GET` | `/api/v1/runs` | All run history; optional `task_id`, `status`, `limit`, `offset` |
| `GET` | `/api/v1/runs/{run_id}` | Inspect a run and its attempts |

Lists return arrays, newest first; `limit` defaults to 50 and is capped at 100. Invalid input returns `422`, unknown resources `404`, and manual triggers of paused tasks or tasks with unfinished runs return `409`.

Example recurring task (`example.com` is a placeholder; use an endpoint you control):

```json
{
  "name": "Sync inventory",
  "description": "Ask the inventory service to refresh",
  "url": "https://api.example.com/hooks/sync",
  "method": "POST",
  "headers": {"Authorization": "Bearer replace-me"},
  "body": {"source": "scheduler"},
  "schedule": {"type": "cron", "expression": "*/5 * * * *"},
  "retry": {"max_retries": 2, "delay_seconds": 60},
  "timeout_seconds": 10,
  "enabled": true
}
```

`name`, `url`, and `schedule` are required. Supported methods are `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`; JSON bodies are supported for `POST`, `PUT`, and `PATCH`. A body of `null` means no body. `retry.max_retries` defaults to 2 and ranges from 0–10; `retry.delay_seconds` defaults to 60 and ranges from 1–86,400. `timeout_seconds` defaults to 10 and ranges from 1–120. `PATCH` is partial at the top level, but nested `schedule` and `retry` objects are replaced rather than merged; omitted retry fields use their defaults. Setting `description` or `body` to `null` clears it.

Schedules are either:

```json
{"type": "cron", "expression": "0 9 * * 1-5"}
```

or:

```json
{"type": "once", "run_at": "2030-01-01T09:00:00Z"}
```

Cron uses five fields (minute, hour, day of month, month, day of week), in **UTC**, with minute-level precision. As with traditional cron, when both day-of-month and day-of-week are restricted, either may match. One-time timestamps must include a timezone offset and must be in the future when created or changed; they are normalized to UTC. Convert local time and daylight-saving rules in the client.

## Scheduling and retry behavior

- Each scheduled occurrence or manual trigger creates a **run**. Each HTTP request is a numbered **attempt**. Run states are `queued`, `running`, `retrying`, `succeeded`, and `failed`.
- A `2xx` response succeeds; any other HTTP status, network error, or timeout fails an attempt. Redirects are not followed. Responses are considered complete when their status/headers arrive; response bodies are not stored. Retries use a fixed delay and the run's saved configuration. `max_retries` is **in addition to** the first attempt.
- Manual runs are independent of the schedule: triggering one does not move or consume the next scheduled execution.
- Only one unfinished run per task is allowed, including time spent waiting for a retry. Manual triggering while a run is unfinished returns `409`. Recurring ticks that occur during an unfinished run are skipped. A due one-time schedule instead waits until the active run finishes.
- After downtime, missed recurring ticks are coalesced into one run, not replayed individually. A missed one-time task runs when the scheduler is available. Polling may add up to the configured poll interval and queueing delay.
- Pausing prevents new scheduled runs and holds queued runs/retries, but does not cancel a request already in flight. Resuming a recurring task schedules its next future tick. An unconsumed one-time task whose time passed while paused runs when resumed; a one-time schedule already dispatched is not rearmed. Change its schedule to run it again.
- Editing a task affects future runs, not the URL, payload, headers, timeout, or retry policy already snapshotted for an unfinished run. Deleting a task also deletes its run/attempt history; it cannot stop an HTTP request already in flight.
- SQLite transactions and worker leases prevent simultaneous claims against the **same local database**. A crashed worker's attempt becomes a failure after its timeout plus lease grace period; it will be retried if retries remain. Delivery is **not exactly once**: an endpoint may receive a request before a worker crashes, then receive a retry. Handle duplicate requests using the stable `Idempotency-Key` and `X-Scheduled-Run-Id` headers (both contain the run ID). `X-Scheduled-Task-Id` and `X-Scheduled-Attempt` are also sent; these headers cannot be overridden.

## Configuration

Copy `backend/.env.example` to `backend/.env` and use `uvicorn --env-file .env`, or set the environment variables directly. The `.env` file is not loaded automatically without that flag.

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_PATH` | `data/tasks.sqlite3` | SQLite file path, relative to the working directory |
| `SCHEDULER_ENABLED` | `true` | Run the embedded scheduler. If false, runs remain queued unless another scheduler uses the same database. |
| `POLL_INTERVAL_SECONDS` | `1` | Scheduler polling interval, 0.05–60 seconds |
| `MAX_CONCURRENCY` | `5` | Maximum simultaneous deliveries per scheduler process, 1–100 |
| `LEASE_GRACE_SECONDS` | `30` | Extra seconds beyond the request timeout before a worker lease expires, 1–3,600 |
| `API_KEY` | unset | If set, all `/api/v1` requests require this value in `X-API-Key` |
| `ALLOWED_TARGET_HOSTS` | unset | Comma-separated **exact** hostnames/IPs without schemes or ports; unset allows any public hostname |
| `ALLOW_PRIVATE_TARGETS` | `false` | Permit local, private, and other non-public IPs; only use in trusted environments |
| `CORS_ORIGINS` | unset | Comma-separated browser frontend origins; no cross-origin access by default |

## Data model and architecture

The API validates task input and stores it in SQLite. The scheduler polls for due schedules, atomically creates runs, claims them with a lease, performs HTTP requests, and persists each outcome. A partial unique index enforces one active run per task; foreign keys cascade task deletion to history. Times are stored as fixed-width UTC timestamps.

- `tasks`: task definition, schedule, retry policy, enabled state, and next scheduled execution.
- `runs`: trigger, scheduled time, state, next attempt, lease, terminal result, and immutable delivery snapshot.
- `attempts`: attempt number, start/finish times, HTTP status, and sanitized error.

SQLite is suitable for a single host and modest workloads. Use a persistent **local** disk, not an ephemeral container filesystem or a network filesystem shared between machines. Multiple local processes can coordinate through the same database, but `MAX_CONCURRENCY` is per process. For multi-host scaling, a database-backed queue and distributed worker design should replace SQLite. Back up a live database with SQLite's online backup API so its WAL is included.

## Security and limitations

- With no `API_KEY`, all application endpoints are unauthenticated. Use a long, random key, HTTPS, restrictive CORS, and network access controls for any shared deployment. This is a single shared key, not per-user authorization or auditing.
- By default, literal private/local IPs are rejected. DNS results are checked at delivery time, and the checked addresses are used for the actual connection; any non-public DNS answer is rejected. Redirects and environment proxies are disabled, and TLS certificates are verified. An exact target-host allowlist and infrastructure-level egress rules are still recommended; this is not a substitute for network isolation.
- `ALLOW_PRIVATE_TARGETS=true` permits access to internal services, including cloud metadata endpoints. Only enable it when task authors and target hosts are trusted, and keep the host allowlist narrow.
- Target headers, URLs, and bodies, including any credentials, are stored unencrypted in the database and returned to API clients. Protect the database and backups; do not put secrets in query strings. Request bodies are limited to 128 KiB; task JSON bodies to 64 KiB.
- SQLite and the embedded poller are intentionally simple. There is no UI, user management, result-body capture, job-history retention policy, or distributed multi-host scheduler yet.

## Running tests

```bash
cd backend
source .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest -q
ruff check .
```

The suite covers API validation/authentication, schedule and pause/resume behavior, retries and exhaustion, real HTTP delivery, timeouts, redirect and network restrictions, restart persistence, leases, and competing workers.

## Deployment example

A Dockerfile is included; build from the `backend` directory:

```bash
cd backend
docker build -t scheduled-task-manager .
docker run --rm -p 8000:8000 -v scheduled-task-data:/data \
  -e API_KEY='replace-with-a-long-random-secret' \
  -e ALLOWED_TARGET_HOSTS='api.example.com' \
  scheduled-task-manager
```

In a hosting service, run a long-lived instance and mount a persistent volume at `/data` (or set `DATABASE_PATH` to another persistent local path). If the platform supplies a `PORT`, override the container command with `uvicorn app.main:app --host 0.0.0.0 --port "$PORT"`. The health endpoint is `/health`. This repository does not include a deployed URL.
