# API ↔ DB Contract

> **Archived design, not the running application.** This database-team document describes a PostgreSQL/Prisma prototype using `executions` and `retry_queue`. The integrated service uses SQLite `tasks`, `runs`, and `attempts`; see [the runtime database guide](README.md) and [API documentation](../README.md#api). PostgreSQL support and migration of prototype data are not implemented.

Backend team: these are the DB operations behind each endpoint.

## Tasks

| Method | Endpoint | DB |
|---|---|---|
| POST | /api/tasks | `INSERT INTO tasks (...) RETURNING *` + compute `next_run_at` via `cron-parser` |
| GET | /api/tasks?status=active | `SELECT * FROM tasks ORDER BY next_run_at ASC` |
| GET | /api/tasks/:id | `SELECT * FROM tasks WHERE id=$1` |
| PATCH | /api/tasks/:id | `UPDATE tasks SET ... WHERE id=$1 RETURNING *` + recompute `next_run_at` if schedule changed |
| POST | /api/tasks/:id/pause | `UPDATE tasks SET status='paused', is_enabled=false WHERE id=$1` |
| POST | /api/tasks/:id/resume | `UPDATE tasks SET status='active', is_enabled=true WHERE id=$1` |
| DELETE | /api/tasks/:id | `UPDATE tasks SET status='archived', is_enabled=false WHERE id=$1` (soft) |
| GET | /api/tasks/upcoming | `SELECT * FROM tasks WHERE status='active' ORDER BY next_run_at LIMIT 5` |

## Executions

| Method | Endpoint | DB |
|---|---|---|
| POST | /api/tasks/:id/run | `INSERT INTO executions (task_id, scheduled_for, triggered_by='manual', status='pending')` |
| GET | /api/tasks/:id/executions | `SELECT * FROM executions WHERE task_id=$1 ORDER BY scheduled_for DESC LIMIT 20 OFFSET $2` |
| GET | /api/executions/:id | `SELECT * FROM executions WHERE id=$1` |

## Scheduler (internal)

```
Every 30s:
  SELECT ... FOR UPDATE SKIP LOCKED WHERE next_run_at <= NOW()
  → INSERT executions (pending)
  → UPDATE tasks SET next_run_at = nextCron(cron_expression), last_run_at = NOW()
```

## Runner (internal)

```
On success: UPDATE executions SET status='success', finished_at=NOW(), result_output=$1
On failure: UPDATE executions SET status='failed', error_message=$1, next_retry_at=NOW()+backoff
            → if retries left: INSERT executions (is_retry=true, attempt_number+1)
```

## Stats

```
GET /api/stats/overview → SELECT * FROM v_task_stats
GET /api/stats/failures → SELECT * FROM v_failed_needing_retry
GET /api/stats/chart?days=7 → grouped executions by day
```
