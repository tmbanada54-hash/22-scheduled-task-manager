-- Previous backend runtime schema, kept for migration tests and recovery.
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    url TEXT NOT NULL,
    method TEXT NOT NULL,
    headers_json TEXT NOT NULL,
    body_json TEXT,
    schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'once')),
    cron_expression TEXT,
    run_at TEXT,
    once_consumed INTEGER NOT NULL DEFAULT 0 CHECK (once_consumed IN (0, 1)),
    max_retries INTEGER NOT NULL,
    retry_delay_seconds INTEGER NOT NULL,
    timeout_seconds INTEGER NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retrying', 'succeeded', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
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
    number INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    http_status INTEGER,
    error TEXT,
    PRIMARY KEY (run_id, number)
);
PRAGMA user_version = 1;
