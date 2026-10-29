-- Tickwise runtime schema, version 2 (SQLite 3.25+).
-- This is the schema used by the FastAPI backend. All timestamps are UTC.
-- Do not run this on the database team's earlier, incompatible prototype.

CREATE TABLE IF NOT EXISTS tasks (
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
CREATE INDEX IF NOT EXISTS tasks_due ON tasks(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retrying', 'succeeded', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    last_http_status INTEGER,
    last_error TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_due ON runs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS runs_task_history ON runs(task_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_task ON runs(task_id)
    WHERE status IN ('queued', 'running', 'retrying');

CREATE TABLE IF NOT EXISTS attempts (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    number INTEGER NOT NULL CHECK (number >= 1),
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    http_status INTEGER,
    error TEXT,
    output TEXT,
    PRIMARY KEY (run_id, number)
);

-- Monitoring views, adapted from the database team's design to the runtime model.
CREATE VIEW IF NOT EXISTS v_task_stats AS
SELECT t.id AS task_id, t.name, t.enabled, t.next_run_at,
       COUNT(r.id) AS total_runs,
       COALESCE(SUM(CASE WHEN r.status = 'succeeded' THEN 1 ELSE 0 END), 0) AS success_count,
       COALESCE(SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END), 0) AS failure_count,
       MAX(r.started_at) AS last_execution_at
FROM tasks t LEFT JOIN runs r ON r.task_id = t.id
GROUP BY t.id;

CREATE VIEW IF NOT EXISTS v_failed_needing_retry AS
SELECT id AS run_id, task_id, attempt_count, next_attempt_at, last_error
FROM runs WHERE status = 'retrying';

PRAGMA user_version = 2;
