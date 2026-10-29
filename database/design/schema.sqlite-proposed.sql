-- ARCHIVED DATABASE-TEAM PROTOTYPE: incompatible with the running application.
-- See ../schema.sqlite.sql for the canonical SQLite v2 runtime schema.

-- ============================================================
-- Scheduled Task Manager — SQLite Schema (MVP Lightweight)
-- For local dev, demos, file-based persistence, or Cloudflare D1
-- Same data model as schema.sql, adapted for SQLite
-- ============================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================
-- TABLE: tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, -- UUID as TEXT (generate in app: uuid.v4())
    name TEXT NOT NULL,
    description TEXT,
    task_type TEXT NOT NULL DEFAULT 'webhook' CHECK (task_type IN ('webhook','http','command','email','custom')),
    payload TEXT NOT NULL DEFAULT '{}', -- JSON string
    schedule_type TEXT NOT NULL DEFAULT 'cron' CHECK (schedule_type IN ('cron','interval','once')),
    cron_expression TEXT,
    interval_seconds INTEGER,
    run_once_at TEXT, -- ISO8601
    timezone TEXT NOT NULL DEFAULT 'UTC',
    next_run_at TEXT, -- ISO8601
    last_run_at TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled','archived')),
    is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0,1)),
    max_retries INTEGER NOT NULL DEFAULT 3 CHECK (max_retries >= 0 AND max_retries <= 10),
    retry_strategy TEXT NOT NULL DEFAULT 'exponential' CHECK (retry_strategy IN ('none','fixed','exponential','linear')),
    retry_delay_seconds INTEGER NOT NULL DEFAULT 60,
    timeout_seconds INTEGER NOT NULL DEFAULT 300,
    concurrency_policy TEXT NOT NULL DEFAULT 'skip' CHECK (concurrency_policy IN ('allow','skip','queue')),
    tags TEXT DEFAULT '[]', -- JSON array
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    created_by TEXT,

    CHECK (
        (schedule_type = 'cron' AND cron_expression IS NOT NULL) OR (schedule_type != 'cron')
    ),
    CHECK (
        (schedule_type = 'interval' AND interval_seconds IS NOT NULL) OR (schedule_type != 'interval')
    ),
    CHECK (
        (schedule_type = 'once' AND run_once_at IS NOT NULL) OR (schedule_type != 'once')
    )
);

-- Trigger for updated_at
CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at
AFTER UPDATE ON tasks
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

-- ============================================================
-- TABLE: executions
-- ============================================================
CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    scheduled_for TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','running','success','failed','timeout','skipped','cancelled')),
    attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number >= 1),
    duration_ms INTEGER,
    result_output TEXT,
    error_message TEXT,
    http_status_code INTEGER,
    metadata TEXT DEFAULT '{}',
    parent_execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL,
    is_retry INTEGER NOT NULL DEFAULT 0 CHECK (is_retry IN (0,1)),
    next_retry_at TEXT,
    triggered_by TEXT NOT NULL DEFAULT 'schedule' CHECK (triggered_by IN ('schedule','manual','retry','api')),
    worker_id TEXT,
    logs TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK (parent_execution_id IS NULL OR parent_execution_id != id)
);

-- ============================================================
-- TABLE: retry_queue
-- ============================================================
CREATE TABLE IF NOT EXISTS retry_queue (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','success','failed','exhausted')),
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (execution_id, attempt_number)
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run_at) WHERE status = 'active' AND is_enabled = 1;
CREATE INDEX IF NOT EXISTS idx_tasks_status_enabled ON tasks(status, is_enabled);
CREATE INDEX IF NOT EXISTS idx_exec_task_scheduled ON executions(task_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_exec_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_exec_next_retry ON executions(next_retry_at) WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS idx_retry_scheduled ON retry_queue(scheduled_for) WHERE status = 'pending';

-- ============================================================
-- VIEWS
-- ============================================================
CREATE VIEW IF NOT EXISTS v_task_stats AS
SELECT
    t.id AS task_id,
    t.name,
    t.status AS task_status,
    t.next_run_at,
    t.last_run_at,
    COUNT(e.id) AS total_runs,
    SUM(CASE WHEN e.status = 'success' THEN 1 ELSE 0 END) AS success_count,
    SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) AS failure_count,
    AVG(CASE WHEN e.status = 'success' THEN e.duration_ms END) AS avg_duration_ms,
    MAX(e.scheduled_for) AS last_execution_at
FROM tasks t
LEFT JOIN executions e ON e.task_id = t.id
GROUP BY t.id;

-- Verify tables
-- SELECT name FROM sqlite_master WHERE type='table';
