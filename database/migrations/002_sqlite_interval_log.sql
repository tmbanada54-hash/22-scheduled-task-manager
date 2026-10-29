-- Upgrade the backend team's version-1 SQLite schema to version 2.
-- The application runs this inside a single transaction with foreign keys
-- temporarily disabled, then checks all foreign keys before committing.
CREATE TABLE tasks_v2 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    description TEXT,
    action_type TEXT NOT NULL DEFAULT 'http' CHECK (action_type IN ('http', 'log')),
    url TEXT,
    message TEXT,
    method TEXT NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
    headers_json TEXT NOT NULL,
    body_json TEXT,
    schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'interval', 'once')),
    cron_expression TEXT,
    interval_seconds INTEGER,
    run_at TEXT,
    once_consumed INTEGER NOT NULL DEFAULT 0 CHECK (once_consumed IN (0, 1)),
    max_retries INTEGER NOT NULL CHECK (max_retries BETWEEN 0 AND 10),
    retry_delay_seconds INTEGER NOT NULL CHECK (retry_delay_seconds BETWEEN 1 AND 86400),
    timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 1 AND 120),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((action_type = 'http' AND url IS NOT NULL AND message IS NULL)
        OR (action_type = 'log' AND url IS NULL AND message IS NOT NULL)),
    CHECK ((schedule_type = 'cron' AND cron_expression IS NOT NULL AND interval_seconds IS NULL AND run_at IS NULL)
        OR (schedule_type = 'interval' AND cron_expression IS NULL AND interval_seconds IS NOT NULL AND interval_seconds BETWEEN 5 AND 86400 AND run_at IS NULL)
        OR (schedule_type = 'once' AND cron_expression IS NULL AND interval_seconds IS NULL AND run_at IS NOT NULL))
);
INSERT INTO tasks_v2 (
    id, name, description, action_type, url, message, method, headers_json, body_json,
    schedule_type, cron_expression, interval_seconds, run_at, once_consumed, max_retries,
    retry_delay_seconds, timeout_seconds, enabled, next_run_at, created_at, updated_at
)
SELECT id, name, description, 'http', url, NULL, method, headers_json, body_json,
       schedule_type, cron_expression, NULL, run_at, once_consumed, max_retries,
       retry_delay_seconds, timeout_seconds, enabled, next_run_at, created_at, updated_at
FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_v2 RENAME TO tasks;
ALTER TABLE attempts ADD COLUMN output TEXT;
