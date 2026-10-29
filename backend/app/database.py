"""SQLite connection management and the initial schema."""

import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path

SCHEMA_VERSION = 1

SCHEMA = """
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
"""


class Database:
    def __init__(self, path: str):
        self.path = path

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        return conn

    def initialize(self) -> None:
        Path(self.path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        # sqlite3 doesn't expand ~ itself.
        self.path = str(Path(self.path).expanduser())
        with closing(self.connect()) as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise RuntimeError("Database schema is newer than this application")
            conn.executescript("BEGIN IMMEDIATE;\n" + SCHEMA + "\nCOMMIT;")

    @contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            # Keep related SELECTs (e.g. a run and its attempts) on one snapshot.
            conn.execute("BEGIN")
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()
