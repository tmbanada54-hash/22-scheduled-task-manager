# Scheduled Task Manager — Key Queries

> **Archived design, not the running application.** This database-team document describes a PostgreSQL/Prisma prototype using `executions` and `retry_queue`. The integrated service uses SQLite `tasks`, `runs`, and `attempts`; see [the runtime database guide](README.md) and [API documentation](../README.md#api). PostgreSQL support and migration of prototype data are not implemented.

These are proposed PostgreSQL queries and are not the runtime query contract.

---

## 1. Scheduler: Poll Due Tasks (every 15-30s)
```sql
-- Run inside a transaction with FOR UPDATE SKIP LOCKED for multi-worker safety
BEGIN;
SELECT id, name, payload, timeout_seconds, concurrency_policy
FROM tasks
WHERE status = 'active'
  AND is_enabled = TRUE
  AND next_run_at <= NOW()
ORDER BY priority DESC, next_run_at ASC
LIMIT 100
FOR UPDATE SKIP LOCKED;

-- After claiming, create execution row + update next_run_at:
-- INSERT INTO executions (task_id, scheduled_for, status, triggered_by) VALUES (...);
-- UPDATE tasks SET last_run_at = NOW(), next_run_at = compute_next_run(cron_expression, NOW()) WHERE id = $1;
COMMIT;
```

## 2. Dashboard: Next 5 Upcoming Runs
```sql
SELECT id, name, schedule_type, cron_expression, interval_seconds, next_run_at,
       EXTRACT(EPOCH FROM (next_run_at - NOW()))/60 AS minutes_until_run
FROM tasks
WHERE status = 'active' AND is_enabled = TRUE
ORDER BY next_run_at ASC
LIMIT 5;
```

## 3. Task Detail + Stats (single task page)
```sql
SELECT * FROM v_task_stats WHERE task_id = $1;

SELECT * FROM executions
WHERE task_id = $1
ORDER BY scheduled_for DESC
LIMIT 20 OFFSET 0;
```

## 4. Record Outcome (success)
```sql
UPDATE executions
SET status = 'success',
    finished_at = NOW(),
    result_output = $1,
    http_status_code = 200
WHERE id = $2;
-- duration_ms is auto-set by trigger
```

## 5. Record Outcome (failure + schedule retry)
```sql
-- Mark failed
UPDATE executions
SET status = 'failed',
    finished_at = NOW(),
    error_message = $1,
    next_retry_at = CASE
        WHEN attempt_number < (SELECT max_retries FROM tasks WHERE id = task_id)
        THEN NOW() + (SELECT retry_delay_seconds FROM tasks WHERE id = task_id) * INTERVAL '1 second' * POWER(2, attempt_number - 1) -- exponential
        ELSE NULL
    END
WHERE id = $2;

-- Retry worker picks it up later:
INSERT INTO executions (task_id, scheduled_for, status, attempt_number, parent_execution_id, is_retry, triggered_by)
SELECT task_id, NOW(), 'pending', attempt_number + 1, id, TRUE, 'retry'
FROM executions
WHERE id = $1 AND status = 'failed' AND attempt_number <= (SELECT max_retries FROM tasks WHERE id = task_id);
```

## 6. Monitoring: Failure Rate (24h)
```sql
SELECT * FROM v_task_stats
WHERE failures_24h > 0
ORDER BY failures_24h DESC;

-- System-wide
SELECT
    COUNT(*) AS total_executions_24h,
    COUNT(*) FILTER (WHERE status = 'success') AS successes,
    COUNT(*) FILTER (WHERE status = 'failed') AS failures,
    ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'failed') / NULLIF(COUNT(*),0), 2) AS failure_rate_pct,
    AVG(duration_ms) FILTER (WHERE status = 'success')::INT AS avg_duration_ms
FROM executions
WHERE scheduled_for >= NOW() - INTERVAL '24 hours';
```

## 7. Edge Cases

### Overdue / Missed runs (scheduler was down)
```sql
SELECT id, name, next_run_at, NOW() - next_run_at AS overdue_by
FROM tasks
WHERE status = 'active' AND next_run_at < NOW() - INTERVAL '5 minutes'
ORDER BY next_run_at ASC;
```

### Concurrency: Skip if already running
```sql
SELECT 1 FROM executions
WHERE task_id = $1 AND status = 'running'
LIMIT 1;
-- If exists and concurrency_policy = 'skip' → skip this tick
```

### Paused / Disabled tasks should never run
```sql
-- Already filtered in scheduler query; also for UI:
SELECT id, name, status, is_enabled,
       CASE WHEN status != 'active' OR NOT is_enabled THEN 'paused' ELSE 'scheduled' END AS effective_status
FROM tasks;
```

### Retry exhausted (max retries hit)
```sql
SELECT e.*, t.max_retries
FROM executions e
JOIN tasks t ON t.id = e.task_id
WHERE e.status = 'failed' AND e.attempt_number >= t.max_retries
ORDER BY e.scheduled_for DESC;
```

## 8. Analytics for Demo

```sql
-- Success vs failure over last 7 days (for chart)
SELECT
    date_trunc('day', scheduled_for) AS day,
    COUNT(*) FILTER (WHERE status = 'success') AS successes,
    COUNT(*) FILTER (WHERE status = 'failed') AS failures
FROM executions
WHERE scheduled_for >= NOW() - INTERVAL '7 days'
GROUP BY 1
ORDER BY 1;

-- Slowest tasks
SELECT t.name, AVG(e.duration_ms)::INT AS avg_ms, MAX(e.duration_ms) AS max_ms
FROM executions e JOIN tasks t ON t.id = e.task_id
WHERE e.status = 'success'
GROUP BY t.name
ORDER BY avg_ms DESC;
```
