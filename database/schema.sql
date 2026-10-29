-- ============================================================
-- Scheduled Task Manager — PostgreSQL Schema (MVP v1.0)
-- Compatible with: Postgres 14+, Supabase, Neon, Railway, Render
-- Branch: database (from develop)
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()
-- For Supabase: also available as uuid_generate_v4() via pgcrypto
-- Alternative: CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. ENUM TYPES (via CHECK constraints for SQLite portability)
-- We use VARCHAR + CHECK so schema is easy to port to SQLite
-- ============================================================

-- ============================================================
-- 2. TABLE: tasks
-- Core entity. Holds definition + scheduling config + current state
-- ============================================================
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,

    -- What to run (flexible for MVP)
    -- type: 'webhook' | 'http' | 'command' | 'email' | 'custom'
    task_type VARCHAR(50) NOT NULL DEFAULT 'webhook',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Example payload for webhook:
    -- { "url": "https://api.example.com/sync", "method": "POST", "headers": {}, "body": {} }
    -- Example for command:
    -- { "command": "npm run backup" }

    -- Scheduling (3 modes)
    schedule_type VARCHAR(20) NOT NULL DEFAULT 'cron',
    cron_expression VARCHAR(100),          -- e.g. '*/5 * * * *' (every 5 min), '0 9 * * MON'
    interval_seconds INTEGER,               -- e.g. 3600 = every hour
    run_once_at TIMESTAMPTZ,               -- for one-time tasks

    timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
    -- Scheduler computes this after each run
    next_run_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,

    -- Lifecycle
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,

    -- Retry policy (per-task)
    max_retries INTEGER NOT NULL DEFAULT 3,
    retry_strategy VARCHAR(20) NOT NULL DEFAULT 'exponential',
    retry_delay_seconds INTEGER NOT NULL DEFAULT 60,
    timeout_seconds INTEGER NOT NULL DEFAULT 300,

    -- Concurrency control
    concurrency_policy VARCHAR(20) NOT NULL DEFAULT 'skip',

    -- Metadata
    tags VARCHAR(255)[],                   -- e.g. '{billing,critical}'
    priority INTEGER NOT NULL DEFAULT 0,   -- higher = runs first if contended

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by VARCHAR(255),               -- user id/email if auth added later

    -- Validation constraints
    CONSTRAINT chk_tasks_name_not_empty CHECK (char_length(trim(name)) > 0),
    CONSTRAINT chk_tasks_schedule_type CHECK (schedule_type IN ('cron', 'interval', 'once')),
    CONSTRAINT chk_tasks_status CHECK (status IN ('active', 'paused', 'disabled', 'archived')),
    CONSTRAINT chk_tasks_task_type CHECK (task_type IN ('webhook', 'http', 'command', 'email', 'custom')),
    CONSTRAINT chk_tasks_retry_strategy CHECK (retry_strategy IN ('none', 'fixed', 'exponential', 'linear')),
    CONSTRAINT chk_tasks_concurrency CHECK (concurrency_policy IN ('allow', 'skip', 'queue')),
    CONSTRAINT chk_tasks_max_retries CHECK (max_retries >= 0 AND max_retries <= 10),
    CONSTRAINT chk_tasks_retry_delay CHECK (retry_delay_seconds >= 0 AND retry_delay_seconds <= 86400),
    CONSTRAINT chk_tasks_timeout CHECK (timeout_seconds > 0 AND timeout_seconds <= 86400),
    CONSTRAINT chk_tasks_priority CHECK (priority >= 0 AND priority <= 100),

    -- Schedule-specific validation
    CONSTRAINT chk_tasks_cron_required CHECK (
        (schedule_type = 'cron' AND cron_expression IS NOT NULL) OR
        (schedule_type != 'cron')
    ),
    CONSTRAINT chk_tasks_interval_required CHECK (
        (schedule_type = 'interval' AND interval_seconds IS NOT NULL AND interval_seconds > 0) OR
        (schedule_type != 'interval')
    ),
    CONSTRAINT chk_tasks_once_required CHECK (
        (schedule_type = 'once' AND run_once_at IS NOT NULL) OR
        (schedule_type != 'once')
    ),
    -- Basic cron format check (5 fields, allows */,-, numbers)
    CONSTRAINT chk_tasks_cron_format CHECK (
        cron_expression IS NULL OR
        cron_expression ~ '^([*\/0-9,\-]+\s+){4}[*\/0-9,\-]+$'
    )
);

COMMENT ON TABLE tasks IS 'Defines scheduled tasks with scheduling config and retry policy';
COMMENT ON COLUMN tasks.payload IS 'JSON config: webhook URL/method/body or shell command';
COMMENT ON COLUMN tasks.next_run_at IS 'Computed by scheduler/backend after each run; used for dashboard + polling';
COMMENT ON COLUMN tasks.concurrency_policy IS 'allow: parallel runs ok, skip: skip if already running, queue: wait';

-- ============================================================
-- 3. TABLE: executions (also called runs / history)
-- Every scheduled attempt + every retry is a row here
-- ============================================================
CREATE TABLE executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,

    -- Scheduling context
    scheduled_for TIMESTAMPTZ NOT NULL,       -- when it was supposed to run
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,

    -- Outcome
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempt_number INTEGER NOT NULL DEFAULT 1,
    duration_ms INTEGER,                     -- computed: finished - started

    -- Result data
    result_output TEXT,                      -- stdout / response body (truncated)
    error_message TEXT,                      -- stderr / error
    http_status_code INTEGER,                -- for webhook tasks
    metadata JSONB DEFAULT '{}'::jsonb,      -- extra worker info

    -- Retry linking
    parent_execution_id UUID REFERENCES executions(id) ON DELETE SET NULL,
    is_retry BOOLEAN NOT NULL DEFAULT FALSE,
    next_retry_at TIMESTAMPTZ,              -- when retry is scheduled

    -- Trigger source
    triggered_by VARCHAR(20) NOT NULL DEFAULT 'schedule',
    worker_id VARCHAR(100),                  -- which worker picked it up
    logs TEXT,                               -- aggregated logs

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_exec_status CHECK (status IN ('pending', 'queued', 'running', 'success', 'failed', 'timeout', 'skipped', 'cancelled')),
    CONSTRAINT chk_exec_triggered_by CHECK (triggered_by IN ('schedule', 'manual', 'retry', 'api')),
    CONSTRAINT chk_exec_attempt CHECK (attempt_number >= 1 AND attempt_number <= 20),
    CONSTRAINT chk_exec_duration CHECK (duration_ms IS NULL OR duration_ms >= 0),
    CONSTRAINT chk_exec_http_code CHECK (http_status_code IS NULL OR (http_status_code >= 100 AND http_status_code <= 599)),
    CONSTRAINT chk_exec_parent_not_self CHECK (parent_execution_id IS NULL OR parent_execution_id != id)
);

COMMENT ON TABLE executions IS 'Immutable history of every task run and retry; source of truth for monitoring';
COMMENT ON COLUMN executions.scheduled_for IS 'The tick that triggered this execution (for cron/interval)';
COMMENT ON COLUMN executions.attempt_number IS '1 = first try, 2+ = retries';

-- ============================================================
-- 4. TABLE: execution_retries (optional detailed retry log)
-- For MVP you can rely solely on executions.is_retry;
-- this table is useful if you want explicit retry queue visibility
-- ============================================================
CREATE TABLE retry_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    scheduled_for TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_retry_status CHECK (status IN ('pending', 'processing', 'success', 'failed', 'exhausted')),
    CONSTRAINT uq_retry_execution_attempt UNIQUE (execution_id, attempt_number)
);

-- ============================================================
-- 5. INDEXES (critical for scheduler performance)
-- ============================================================

-- Scheduler polling: "find due tasks" — most important index
CREATE INDEX idx_tasks_next_run ON tasks (next_run_at) WHERE status = 'active' AND is_enabled = TRUE;
CREATE INDEX idx_tasks_status_enabled ON tasks (status, is_enabled);
CREATE INDEX idx_tasks_schedule_type ON tasks (schedule_type);
CREATE INDEX idx_tasks_created_at ON tasks (created_at DESC);

-- Executions: dashboard + history queries
CREATE INDEX idx_exec_task_scheduled ON executions (task_id, scheduled_for DESC);
CREATE INDEX idx_exec_task_status ON executions (task_id, status);
CREATE INDEX idx_exec_status ON executions (status);
CREATE INDEX idx_exec_scheduled_for ON executions (scheduled_for DESC);
CREATE INDEX idx_exec_next_retry ON executions (next_retry_at) WHERE status = 'failed' AND next_retry_at IS NOT NULL;
CREATE INDEX idx_exec_parent ON executions (parent_execution_id) WHERE parent_execution_id IS NOT NULL;

-- Retry queue
CREATE INDEX idx_retry_task_status ON retry_queue (task_id, status);
CREATE INDEX idx_retry_scheduled ON retry_queue (scheduled_for) WHERE status = 'pending';

-- Full-text search on task name (optional, for UI)
CREATE INDEX idx_tasks_name_trgm ON tasks USING gin (name gin_trgm_ops);
-- Requires: CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- 6. UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
CREATE TRIGGER trg_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 7. HELPER: Auto-calculate duration_ms
-- ============================================================
CREATE OR REPLACE FUNCTION set_execution_duration()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.started_at IS NOT NULL AND NEW.finished_at IS NOT NULL THEN
        NEW.duration_ms := EXTRACT(EPOCH FROM (NEW.finished_at - NEW.started_at)) * 1000;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_exec_duration ON executions;
CREATE TRIGGER trg_exec_duration
    BEFORE INSERT OR UPDATE ON executions
    FOR EACH ROW EXECUTE FUNCTION set_execution_duration();

-- ============================================================
-- 8. VIEWS — For dashboard & monitoring
-- ============================================================

-- Latest execution per task (for "last run" column)
CREATE OR REPLACE VIEW v_task_latest_execution AS
SELECT DISTINCT ON (e.task_id)
    e.task_id,
    e.id AS execution_id,
    e.status,
    e.scheduled_for,
    e.started_at,
    e.finished_at,
    e.duration_ms,
    e.attempt_number,
    e.error_message
FROM executions e
ORDER BY e.task_id, e.scheduled_for DESC, e.created_at DESC;

-- Task health summary (for dashboard cards)
CREATE OR REPLACE VIEW v_task_stats AS
SELECT
    t.id AS task_id,
    t.name,
    t.status AS task_status,
    t.next_run_at,
    t.last_run_at,
    COUNT(e.id) AS total_runs,
    COUNT(e.id) FILTER (WHERE e.status = 'success') AS success_count,
    COUNT(e.id) FILTER (WHERE e.status = 'failed') AS failure_count,
    COUNT(e.id) FILTER (WHERE e.scheduled_for >= NOW() - INTERVAL '24 hours') AS runs_24h,
    COUNT(e.id) FILTER (WHERE e.status = 'failed' AND e.scheduled_for >= NOW() - INTERVAL '24 hours') AS failures_24h,
    AVG(e.duration_ms) FILTER (WHERE e.status = 'success')::INTEGER AS avg_duration_ms,
    MAX(e.scheduled_for) AS last_execution_at
FROM tasks t
LEFT JOIN executions e ON e.task_id = t.id
GROUP BY t.id, t.name, t.status, t.next_run_at, t.last_run_at;

-- Failed executions needing retry (for retry worker)
CREATE OR REPLACE VIEW v_failed_needing_retry AS
SELECT
    e.id AS execution_id,
    e.task_id,
    t.name AS task_name,
    t.max_retries,
    t.retry_strategy,
    t.retry_delay_seconds,
    e.attempt_number,
    e.error_message,
    e.next_retry_at,
    (t.max_retries - e.attempt_number) AS retries_remaining
FROM executions e
JOIN tasks t ON t.id = e.task_id
WHERE e.status = 'failed'
  AND e.attempt_number < t.max_retries + 1
  AND (e.next_retry_at IS NULL OR e.next_retry_at <= NOW());

-- ============================================================
-- 9. EXAMPLE QUERIES (keep for team reference)
-- ============================================================

-- -- Find due tasks (scheduler polls every 30s):
-- SELECT * FROM tasks
-- WHERE status = 'active' AND is_enabled = TRUE
--   AND next_run_at <= NOW()
-- ORDER BY priority DESC, next_run_at ASC
-- LIMIT 100;

-- -- Get next 5 upcoming runs:
-- SELECT id, name, schedule_type, cron_expression, next_run_at
-- FROM tasks
-- WHERE status = 'active' AND is_enabled = TRUE
-- ORDER BY next_run_at ASC
-- LIMIT 5;

-- -- Task history with pagination:
-- SELECT * FROM executions
-- WHERE task_id = '...' ORDER BY scheduled_for DESC LIMIT 20 OFFSET 0;

-- -- Retry: insert new execution linked to parent
-- -- INSERT INTO executions (task_id, scheduled_for, status, attempt_number, parent_execution_id, is_retry, triggered_by)
-- -- VALUES (..., NOW(), 'pending', 2, 'parent-uuid', TRUE, 'retry');

