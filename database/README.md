# Scheduled Task Manager — Database Layer
**Branch:** `database` (from `develop`)
**Owner:** Database Team
**Stack:** PostgreSQL 14+ (Supabase / Neon / Railway) + SQLite fallback

---

## 1. Data Model Overview

```
┌───────────┐        ┌────────────┐        ┌─────────────┐
│   tasks   │1───*───│ executions │1───*───│ retry_queue │
│           │        │            │        │ (optional)  │
│ - id      │        │ - id       │        │ - attempt   │
│ - name    │        │ - status   │        │ - scheduled │
│ - payload │        │ - attempt  │        │ - status    │
│ - cron    │        │ - output   │        └─────────────┘
│ - next_run│        │ - error    │
└───────────┘        └────────────┘
       │                    │
       │                    ▼
       │            ┌───────────────┐
       └────────────│  VIEWS        │
                    │ v_task_stats  │
                    │ v_latest_exec │
                    │ v_failed_retry│
                    └───────────────┘
```

### Why this design?

| Decision | Trade-off |
|---|---|
| **Single `tasks` table with `schedule_type` enum** | Simpler than separate `schedules` table. Easy to demo. Trade-off: adding complex recurrence (e.g. rrule) later needs migration. |
| **`payload JSONB` not normalized** | Flexible for MVP (webhook / command / email all fit). Trade-off: less DB-level validation; app must validate shape per `task_type`. |
| **`next_run_at` stored, not computed on read** | Fast scheduler polling (`WHERE next_run_at <= NOW()`). Trade-off: backend must recompute after every run; cron logic lives in app, not DB. |
| **`executions` as immutable log** | Every attempt is a row → auditability + retry chain via `parent_execution_id`. Trade-off: grows fast; needs partitioning/archiving later. |
| **`retry_queue` optional** | Keeps retry visibility explicit. Can be removed if team prefers retries as just `executions.is_retry = true`. |
| **CHECK constraints instead of PG enums** | SQLite-portable. Easy to evolve. |

---

## 2. Tables

### `tasks`
Defines *what* to run and *when*.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `name` | VARCHAR(255) | Unique per team (add constraint if needed) |
| `task_type` | VARCHAR(50) | `webhook` \| `http` \| `command` \| `email` \| `custom` |
| `payload` | JSONB | URL, method, body, command, etc. |
| `schedule_type` | VARCHAR(20) | `cron` \| `interval` \| `once` |
| `cron_expression` | VARCHAR(100) | Required if `cron` |
| `interval_seconds` | INT | Required if `interval` |
| `run_once_at` | TIMESTAMPTZ | Required if `once` |
| `next_run_at` | TIMESTAMPTZ | **Computed by backend** — displayed in UI |
| `last_run_at` | TIMESTAMPTZ | Updated after each run |
| `status` | VARCHAR(20) | `active` / `paused` / `disabled` / `archived` |
| `max_retries` | INT 0-10 | Default 3 |
| `retry_strategy` | VARCHAR(20) | `none` / `fixed` / `exponential` / `linear` |
| `retry_delay_seconds` | INT | Base delay |
| `timeout_seconds` | INT | Kill long tasks |
| `concurrency_policy` | VARCHAR(20) | `allow` / `skip` / `queue` |
| `priority` | INT 0-100 | Scheduler ordering |

### `executions`
One row per attempt. **Never update `scheduled_for`; insert new row for retries.**

Key fields: `status` (`pending` → `running` → `success`/`failed`/`timeout`/`skipped`), `attempt_number`, `parent_execution_id`, `is_retry`, `next_retry_at`, `triggered_by` (`schedule`/`manual`/`retry`/`api`), `duration_ms` (auto via trigger).

### `retry_queue` (optional)
Explicit queue for retry worker. Can be omitted for MVP.

### Views
- `v_task_latest_execution` — last run per task (for dashboard)
- `v_task_stats` — counts, success/failure, avg duration
- `v_failed_needing_retry` — powers retry worker

---

## 3. Setup

### Option A: Supabase / Neon (recommended for hosted)

```bash
# 1. Create project at supabase.com or neon.tech
# 2. Copy connection string to .env
DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require

# 3. Run schema
psql $DATABASE_URL -f database/schema.sql

# 4. Seed demo data
psql $DATABASE_URL -f database/seed.sql

# 5. Verify
psql $DATABASE_URL -c "SELECT * FROM v_task_stats ORDER BY next_run_at;"
```

### Option B: Local Postgres (Docker)

```bash
docker run --name stm-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=stm -p 5432:5432 -d postgres:15

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stm
psql $DATABASE_URL -f database/schema.sql
psql $DATABASE_URL -f database/seed.sql
```

### Option C: SQLite (file-based MVP, no server)

```bash
sqlite3 stm.db < database/schema.sqlite.sql
sqlite3 stm.db < database/seed.sqlite.sql  # convert seed UUIDs to TEXT manually or use app seeder
```

### Option D: Using migration tool

```bash
# golang-migrate
migrate -path database/migrations -database $DATABASE_URL up

# Supabase CLI
supabase db push
```

---

## 4. Environment Variables

```env
# .env.example
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/stm
# For Supabase:
# DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true
# DIRECT_URL=postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres

# Scheduler
SCHEDULER_POLL_INTERVAL_MS=30000
SCHEDULER_BATCH_SIZE=100
TASK_TIMEOUT_MS=300000
RETRY_BASE_DELAY_MS=60000

# Optional
TZ=UTC
LOG_LEVEL=info
```

---

## 5. API Contract (for Backend Team)

The DB supports these endpoints; backend should implement:

```
POST   /api/tasks              → INSERT tasks, compute next_run_at
GET    /api/tasks              → SELECT * FROM tasks ORDER BY next_run_at
GET    /api/tasks/:id          → SELECT * FROM tasks WHERE id = $1
PATCH  /api/tasks/:id          → UPDATE tasks
DELETE /api/tasks/:id          → UPDATE tasks SET status='archived'
POST   /api/tasks/:id/run      → INSERT executions (triggered_by='manual')
GET    /api/tasks/:id/runs     → SELECT * FROM executions WHERE task_id=$1
GET    /api/executions/:id     → SELECT * FROM executions WHERE id=$1
GET    /api/stats              → SELECT * FROM v_task_stats
GET    /api/health             → monitoring query
```

**Next execution time is `tasks.next_run_at`** — backend computes it using `cron-parser` (Node) or `croniter` (Python) on create/update and after each execution.

---

## 6. Validation & Edge Cases

| Case | How DB Handles | App Must Also |
|---|---|---|
| Empty name | `chk_tasks_name_not_empty` | Trim + show error |
| Invalid cron | Regex CHECK (basic 5-field) | Use `cron-validator` lib for full check |
| `interval_seconds = 0` | CHECK >0 | Validate |
| Task deleted with history | `ON DELETE CASCADE` → executions deleted | Or soft-delete (`status='archived'`) |
| Scheduler down, missed runs | `overdue_by = NOW() - next_run_at` query | Catch-up policy (run once or skip) |
| Task still running, next tick fires | `concurrency_policy` + `SELECT ... WHERE status='running'` | `skip`/`queue`/`allow` |
| Retry storm | `max_retries <=10`, `retry_delay` exponential | Backoff + circuit breaker |
| Timezone changes | `timezone` stored per task | Convert with `luxon`/`date-fns-tz` |
| Long-running task | `timeout_seconds` | Worker must enforce + set `status='timeout'` |
| Huge payload/output | TEXT columns unbounded | Truncate to 10KB in worker |

---

## 7. Test Strategy

### Happy Path
1. Create task (cron `* * * * *`) → `next_run_at` = now+1m
2. Scheduler polls due tasks → creates `executions` row `pending`
3. Worker picks execution → `running` → calls webhook → `success` (+ duration)
4. `tasks.last_run_at` updated, `next_run_at` recomputed
5. Dashboard shows `v_task_stats` with new success count

### Failure + Retry Path (required)
1. Create task pointing to `https://httpbin.org/status/500`, `max_retries=3`, `retry_strategy=exponential`, `retry_delay=60`
2. Worker fails → `executions.status='failed'`, `error_message` set, `next_retry_at = NOW()+60s`
3. Retry worker inserts new execution `attempt_number=2, is_retry=true, parent_execution_id=<first>`
4. Second attempt fails → `attempt_number=2` → retry again with `delay*2 = 120s`
5. After 3rd failure → `retries_remaining=0` → no more retries, visible in `v_failed_needing_retry`
6. UI shows failure streak + retry lineage via `parent_execution_id`

### Run Tests

```bash
# Unit: schema validation
psql $DATABASE_URL -f database/tests/test_constraints.sql

# Integration (Node example)
npm run test -- task.test.ts execution.test.ts retry.test.ts

# Manual
psql $DATABASE_URL -c "SELECT * FROM v_failed_needing_retry;"
```

---

## 8. Indexing & Performance

- `idx_tasks_next_run` is **the** hot path — scheduler hits it every 15-30s. Keep it partial (`WHERE active`).
- `executions` grows fast → partition by month if >1M rows (e.g. `pg_partman`).
- For demo, `executions` with 10K rows is fine without partitioning.

---

## 9. Next Improvements (post-MVP)

- [ ] Auth: add `users` + `tasks.owner_id`
- [ ] Auditing: `task_audit_log` (who changed what, when)
- [ ] Scheduling: support `rrule` / cron with seconds
- [ ] Observability: Prometheus metrics from `v_task_stats`
- [ ] Archiving: move executions older than 90d to cold storage
- [ ] Unique name per user: `UNIQUE(owner_id, name)`

---

## 10. Demo Script (30 seconds)

> "Our database has two core tables: `tasks` — what to run and when — and `executions` — an immutable log of every attempt. The scheduler polls `WHERE next_run_at <= NOW()` using a partial index, so it's fast even with thousands of tasks. When a webhook fails, we mark the execution `failed` and schedule a retry using exponential backoff — `delay * 2^(attempt-1)` — linked via `parent_execution_id` so you can see the full chain in the UI. Views like `v_task_stats` power the dashboard without extra app logic."

---

## 11. Branch Workflow

```bash
git clone <repo>
git checkout develop
git pull
git checkout -b database
# ... edit database/schema.sql ...
git add database/
git commit -m "feat(db): initial schema with tasks, executions, retry views"
git push -u origin database
# Open PR → develop
```

---

**Maintained by:** Database team · Questions? Open an issue with `label:database`
