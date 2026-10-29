# Test Strategy — Database Layer

> **Archived design, not the running application.** This database-team document describes a PostgreSQL/Prisma prototype using `executions` and `retry_queue`. The integrated service uses SQLite `tasks`, `runs`, and `attempts`; see [the runtime database guide](../README.md) and [API documentation](../../README.md#api). PostgreSQL support and migration of prototype data are not implemented.

## Happy Path (must pass for demo)

```sql
-- 1. Create task
INSERT INTO tasks (name, task_type, payload, schedule_type, cron_expression, next_run_at)
VALUES ('Test Cron', 'webhook', '{"url":"https://httpbin.org/status/200"}', 'cron', '*/5 * * * *', NOW() + INTERVAL '5 minutes')
RETURNING id;

-- 2. Scheduler finds it
SELECT * FROM tasks WHERE status='active' AND next_run_at <= NOW(); -- 0 rows (not yet due)

-- 3. Simulate tick: insert execution
INSERT INTO executions (task_id, scheduled_for, status, triggered_by) VALUES ($id, NOW(), 'pending', 'schedule');

-- 4. Worker success
UPDATE executions SET status='success', result_output='ok', finished_at=NOW() WHERE id=$execId;
SELECT * FROM v_task_stats WHERE task_id=$id; -- success_count=1

-- 5. Update next_run_at
UPDATE tasks SET last_run_at=NOW(), next_run_at=NOW()+INTERVAL '5 minutes' WHERE id=$id;
```

## Failure + Retry Path (major edge case)

```sql
-- 1. Create failing task
-- 2. Execution fails
UPDATE executions SET status='failed', error_message='500', next_retry_at=NOW()+INTERVAL '60 seconds' WHERE id=$e1;
-- 3. Retry worker creates child
INSERT INTO executions (task_id, scheduled_for, status, attempt_number, parent_execution_id, is_retry) VALUES ($taskId, NOW(), 'pending', 2, $e1, TRUE);
-- 4. Verify v_failed_needing_retry shows it
SELECT * FROM v_failed_needing_retry WHERE task_id=$taskId;
```

## Constraint Tests

| Test | Expected |
|---|---|
| INSERT tasks without cron_expression when schedule_type='cron' | FAIL CHECK |
| INSERT tasks with interval_seconds=0 | FAIL CHECK |
| INSERT tasks with max_retries=99 | FAIL CHECK |
| INSERT executions with invalid status | FAIL CHECK |
| DELETE tasks → executions cascade | Success, 0 executions remain |

## Load Test (optional)

```sql
-- Insert 1000 tasks, 10000 executions, ensure idx_tasks_next_run < 10ms
EXPLAIN ANALYZE SELECT * FROM tasks WHERE status='active' AND next_run_at <= NOW() ORDER BY priority DESC LIMIT 100;
```
