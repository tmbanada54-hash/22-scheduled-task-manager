-- Optional, safe demo data for the runtime schema. No outbound requests are made.
-- This task starts paused; resume it from the dashboard when you want to try it.
INSERT OR IGNORE INTO tasks (
    id, name, description, action_type, url, message, method, headers_json, body_json,
    schedule_type, cron_expression, interval_seconds, run_at, max_retries,
    retry_delay_seconds, timeout_seconds, enabled, next_run_at, created_at, updated_at
) VALUES (
    'demo-log-task', 'Demo heartbeat', 'A safe local log task', 'log', NULL,
    'Tickwise is running', 'POST', '{}', NULL, 'interval', NULL, 30, NULL, 0,
    60, 10, 0, NULL, strftime('%Y-%m-%dT%H:%M:%f000Z', 'now'),
    strftime('%Y-%m-%dT%H:%M:%f000Z', 'now')
);
