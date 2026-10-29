-- ============================================================
-- Scheduled Task Manager — Seed Data (PostgreSQL)
-- 6 sample tasks covering all schedule types + edge cases
-- Run: psql $DATABASE_URL -f seed.sql
-- ============================================================

-- Clear existing (dev only)
-- TRUNCATE executions, retry_queue, tasks CASCADE;

-- ------------------------------------------------------------
-- TASK 1: Cron — Every minute (for live demo)
-- ------------------------------------------------------------
INSERT INTO tasks (id, name, description, task_type, payload, schedule_type, cron_expression, timezone, status, next_run_at, max_retries, retry_strategy, retry_delay_seconds, timeout_seconds, tags, priority)
VALUES (
    '00000000-0000-4000-a000-000000000001',
    'Heartbeat Ping',
    'Pings health endpoint every minute. Used for live demo.',
    'webhook',
    '{"url": "https://httpbin.org/status/200", "method": "GET", "headers": {}, "timeout": 5000}'::jsonb,
    'cron',
    '* * * * *',
    'UTC',
    'active',
    NOW() + INTERVAL '1 minute',
    2,
    'fixed',
    30,
    30,
    ARRAY['demo','health'],
    10
) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- TASK 2: Cron — Daily at 9am (business logic)
-- ------------------------------------------------------------
INSERT INTO tasks (id, name, description, task_type, payload, schedule_type, cron_expression, timezone, status, next_run_at, max_retries, retry_strategy, retry_delay_seconds, timeout_seconds, tags)
VALUES (
    '00000000-0000-4000-a000-000000000002',
    'Daily Report Generator',
    'Generates daily sales CSV and emails stakeholders at 09:00 WAT.',
    'webhook',
    '{"url": "https://api.example.com/reports/daily", "method": "POST", "body": {"type": "sales", "format": "csv"}}'::jsonb,
    'cron',
    '0 9 * * *',
    'Africa/Lagos',
    'active',
    (date_trunc('day', NOW() AT TIME ZONE 'Africa/Lagos') + INTERVAL '9 hours') AT TIME ZONE 'Africa/Lagos',
    3,
    'exponential',
    60,
    300,
    ARRAY['reporting','critical']
) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- TASK 3: Interval — Every 30 seconds (fast polling)
-- ------------------------------------------------------------
INSERT INTO tasks (id, name, description, task_type, payload, schedule_type, interval_seconds, timezone, status, next_run_at, max_retries, retry_strategy, retry_delay_seconds, concurrency_policy, tags)
VALUES (
    '00000000-0000-4000-a000-000000000003',
    'Sync Inventory Cache',
    'Polls external inventory API and refreshes Redis cache.',
    'http',
    '{"url": "https://httpbin.org/delay/1", "method": "GET"}'::jsonb,
    'interval',
    30,
    'UTC',
    'active',
    NOW() + INTERVAL '30 seconds',
    3,
    'linear',
    10,
    'skip',
    ARRAY['sync','cache']
) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- TASK 4: Interval — Every hour (background job)
-- ------------------------------------------------------------
INSERT INTO tasks (id, name, description, task_type, payload, schedule_type, interval_seconds, timezone, status, next_run_at, max_retries, retry_strategy, retry_delay_seconds, timeout_seconds, concurrency_policy, tags)
VALUES (
    '00000000-0000-4000-a000-000000000004',
    'Database Backup',
    'Triggers pg_dump and uploads to S3. Hour-long interval.',
    'command',
    '{"command": "pg_dump $DATABASE_URL | aws s3 cp - s3://backups/daily-$(date +%F).sql.gz"}'::jsonb,
    'interval',
    3600,
    'UTC',
    'paused',
    NOW() + INTERVAL '1 hour',
    2,
    'exponential',
    120,
    1800,
    'skip',
    ARRAY['infra','backup']
) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- TASK 5: Once — One-time future task (tests run_once_at)
-- ------------------------------------------------------------
INSERT INTO tasks (id, name, description, task_type, payload, schedule_type, run_once_at, timezone, status, next_run_at, max_retries, retry_strategy, tags)
VALUES (
    '00000000-0000-4000-a000-000000000005',
    'Black Friday Promo Launch',
    'One-time campaign trigger for Nov 28 09:00 UTC.',
    'webhook',
    '{"url": "https://api.example.com/campaigns/launch", "method": "POST", "body": {"campaign": "bf-2026"}}'::jsonb,
    'once',
    '2026-11-28 09:00:00+00',
    'UTC',
    'active',
    '2026-11-28 09:00:00+00',
    5,
    'exponential',
    ARRAY['marketing','once']
) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- TASK 6: Cron — Broken endpoint (to demo retries & failure)
-- ------------------------------------------------------------
INSERT INTO tasks (id, name, description, task_type, payload, schedule_type, cron_expression, timezone, status, next_run_at, max_retries, retry_strategy, retry_delay_seconds, tags, priority)
VALUES (
    '00000000-0000-4000-a000-000000000006',
    'Unstable Third-Party Sync',
    'Intentionally fails (500) to demonstrate retry + failure UI.',
    'webhook',
    '{"url": "https://httpbin.org/status/500", "method": "GET"}'::jsonb,
    'cron',
    '*/2 * * * *',
    'UTC',
    'active',
    NOW() + INTERVAL '2 minutes',
    3,
    'exponential',
    60,
    ARRAY['demo','failure-test'],
    5
) ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Sample Executions: history for dashboard
-- ============================================================

-- Success history for Heartbeat
INSERT INTO executions (task_id, scheduled_for, started_at, finished_at, status, attempt_number, duration_ms, result_output, http_status_code, triggered_by)
VALUES
    ('00000000-0000-4000-a000-000000000001', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '5 minutes' + INTERVAL '120 ms', 'success', 1, 120, '{"ok": true}', 200, 'schedule'),
    ('00000000-0000-4000-a000-000000000001', NOW() - INTERVAL '4 minutes', NOW() - INTERVAL '4 minutes', NOW() - INTERVAL '4 minutes' + INTERVAL '98 ms', 'success', 1, 98, '{"ok": true}', 200, 'schedule'),
    ('00000000-0000-4000-a000-000000000001', NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '3 minutes' + INTERVAL '110 ms', 'success', 1, 110, '{"ok": true}', 200, 'schedule'),
    ('00000000-0000-4000-a000-000000000001', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes' + INTERVAL '105 ms', 'success', 1, 105, '{"ok": true}', 200, 'schedule'),
    ('00000000-0000-4000-a000-000000000001', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute' + INTERVAL '115 ms', 'success', 1, 115, '{"ok": true}', 200, 'schedule')
ON CONFLICT DO NOTHING;

-- Mixed history for Daily Report (incl. one failure then retry success)
INSERT INTO executions (id, task_id, scheduled_for, started_at, finished_at, status, attempt_number, duration_ms, error_message, is_retry, triggered_by)
VALUES
    ('10000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000002', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days' + INTERVAL '2 seconds', 'success', 1, 2100, NULL, false, 'schedule'),
    ('10000000-0000-4000-a000-000000000002', '00000000-0000-4000-a000-000000000002', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day' + INTERVAL '800 ms', 'failed', 1, 800, 'ETIMEDOUT: upstream API timeout', false, 'schedule')
ON CONFLICT DO NOTHING;

-- Retry child for the failed daily report
INSERT INTO executions (id, task_id, scheduled_for, started_at, finished_at, status, attempt_number, duration_ms, result_output, parent_execution_id, is_retry, triggered_by)
VALUES
    ('10000000-0000-4000-a000-000000000003', '00000000-0000-4000-a000-000000000002', NOW() - INTERVAL '1 day' + INTERVAL '1 minute', NOW() - INTERVAL '1 day' + INTERVAL '1 minute', NOW() - INTERVAL '1 day' + INTERVAL '1 minute' + INTERVAL '1.8 seconds', 'success', 2, 1800, '{"report_id": "rpt_20261028", "rows": 1243}', '10000000-0000-4000-a000-000000000002', true, 'retry')
ON CONFLICT DO NOTHING;

-- Failure streak for Unstable Sync (to show monitoring)
INSERT INTO executions (task_id, scheduled_for, started_at, finished_at, status, attempt_number, duration_ms, error_message, http_status_code, triggered_by)
VALUES
    ('00000000-0000-4000-a000-000000000006', NOW() - INTERVAL '6 minutes', NOW() - INTERVAL '6 minutes', NOW() - INTERVAL '6 minutes' + INTERVAL '400 ms', 'failed', 1, 400, 'Internal Server Error', 500, 'schedule'),
    ('00000000-0000-4000-a000-000000000006', NOW() - INTERVAL '4 minutes', NOW() - INTERVAL '4 minutes', NOW() - INTERVAL '4 minutes' + INTERVAL '380 ms', 'failed', 1, 380, 'Internal Server Error', 500, 'schedule'),
    ('00000000-0000-4000-a000-000000000006', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes' + INTERVAL '410 ms', 'failed', 1, 410, 'Internal Server Error', 500, 'schedule')
ON CONFLICT DO NOTHING;

-- Running execution (to demo live state)
INSERT INTO executions (task_id, scheduled_for, started_at, status, attempt_number, triggered_by)
VALUES
    ('00000000-0000-4000-a000-000000000003', NOW(), NOW(), 'running', 1, 'schedule')
ON CONFLICT DO NOTHING;

-- Update last_run_at for tasks that have executions
UPDATE tasks t SET last_run_at = sub.last_finished FROM (
    SELECT task_id, MAX(finished_at) AS last_finished FROM executions WHERE finished_at IS NOT NULL GROUP BY task_id
) sub WHERE t.id = sub.task_id;

-- Verify
-- SELECT * FROM v_task_stats ORDER BY next_run_at;
-- SELECT * FROM executions ORDER BY scheduled_for DESC LIMIT 10;
