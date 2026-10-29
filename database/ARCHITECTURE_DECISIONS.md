# Architecture Decisions — Database Team

> **Archived design, not the running application.** This database-team document describes a PostgreSQL/Prisma prototype using `executions` and `retry_queue`. The integrated service uses SQLite `tasks`, `runs`, and `attempts`; see [the runtime database guide](README.md) and [API documentation](../README.md#api). PostgreSQL support and migration of prototype data are not implemented.

## 1. Why Postgres + SQLite dual schema?

- **Postgres** is free on Supabase/Neon/Render and supports `JSONB`, `TIMESTAMPTZ`, partial indexes, and `FOR UPDATE SKIP LOCKED` — all needed for reliable scheduling.
- **SQLite** is zero-config for local dev and demos on laptops with no Docker. Same logical model, portable.

## 2. Why `next_run_at` stored, not computed in SQL?

Cron calculation (`* * * * *` → next timestamp) requires a library (`cron-parser` in Node, `croniter` in Python). SQL can't do it cleanly. Storing it makes:

- Scheduler query trivial: `WHERE next_run_at <= NOW()` (indexed)
- Dashboard fast: `ORDER BY next_run_at` without computation
- Trade-off: App must recompute on every create/update/run. Documented in `QUERIES.md`.

## 3. Why separate `executions` instead of status on `tasks`?

- Need **history**: "Show me last 20 runs", "failure rate 24h", "retry lineage".
- `tasks.status` = lifecycle (`active`/`paused`), `executions.status` = outcome (`success`/`failed`).
- Immutable log pattern: never mutate old execution rows.

## 4. Retry design

- `attempt_number` + `parent_execution_id` + `is_retry` gives full chain.
- `next_retry_at` on the *failed* row tells retry worker when to act.
- Backoff formula (app-side): `delay * (2^(attempt-1))` for exponential, `delay * attempt` for linear.
- `max_retries` capped at 10 to prevent infinite loops.

## 5. Time handling (Learning Outcome)

- All timestamps are `TIMESTAMPTZ` (UTC in DB).
- Per-task `timezone` column (e.g. `Africa/Lagos`) lets UI show local time and scheduler compute correct next run for cron `0 9 * * *` in Lagos.
- Use `AT TIME ZONE` in queries; use `luxon`/`date-fns-tz` in app.

## 6. Monitoring built-in

- `v_task_stats` powers dashboard cards without app aggregation.
- Failure-rate queries are ready for Prometheus/Grafana later.
- `logs` + `result_output` + `error_message` give debuggability.

## 7. What we intentionally left out (MVP)

- `users` / `teams` — add `tasks.owner_id` later
- Full audit log — add `task_audit_log` table
- WebSockets — polling `GET /api/tasks` every 30s is enough for MVP
- Soft delete vs hard delete — we do soft (`status='archived'`) to keep history
