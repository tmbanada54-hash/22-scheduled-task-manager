"""Transactional persistence for tasks, runs, attempts, and worker leases."""

import json
import sqlite3
from datetime import datetime, timedelta
from uuid import uuid4

from pydantic import ValidationError

from .config import Settings
from .database import SCHEMA_VERSION, Database
from .models import CronSchedule, IntervalSchedule, OnceSchedule, TaskCreate, TaskPatch
from .schedules import from_db, next_cron_time, to_db
from .security import TargetPolicy


class NotFoundError(Exception):
    pass


class ConflictError(Exception):
    pass


class InputError(Exception):
    def __init__(self, detail):
        self.detail = detail
        super().__init__(str(detail))


def _id() -> str:
    return str(uuid4())


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _task(row: sqlite3.Row) -> dict:
    if row["schedule_type"] == "cron":
        schedule = {"type": "cron", "expression": row["cron_expression"]}
    elif row["schedule_type"] == "interval":
        schedule = {"type": "interval", "seconds": row["interval_seconds"]}
    else:
        schedule = {"type": "once", "run_at": row["run_at"]}
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "action_type": row["action_type"],
        "url": row["url"],
        "message": row["message"],
        "method": row["method"],
        "headers": json.loads(row["headers_json"]),
        "body": json.loads(row["body_json"]) if row["body_json"] is not None else None,
        "schedule": schedule,
        "retry": {"max_retries": row["max_retries"], "delay_seconds": row["retry_delay_seconds"]},
        "timeout_seconds": row["timeout_seconds"],
        "enabled": bool(row["enabled"]),
        "next_run_at": row["next_run_at"],
        "last_run_at": row["last_run_at"],
        "last_status": row["last_status"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _attempt(row: sqlite3.Row) -> dict:
    return {
        key: row[key]
        for key in ("number", "status", "started_at", "finished_at", "http_status", "error", "output")
    }


def _run(row: sqlite3.Row, attempts: list[dict]) -> dict:
    result = {
        key: row[key]
        for key in (
            "id",
            "task_id",
            "trigger",
            "scheduled_for",
            "status",
            "attempt_count",
            "next_attempt_at",
            "started_at",
            "finished_at",
            "last_http_status",
            "last_error",
            "created_at",
        )
    }
    result["attempts"] = attempts
    return result


def _snapshot(row: sqlite3.Row) -> str:
    return _json(
        {
            "action_type": row["action_type"],
            "url": row["url"],
            "message": row["message"],
            "method": row["method"],
            "headers": json.loads(row["headers_json"]),
            "body": json.loads(row["body_json"]) if row["body_json"] is not None else None,
            "timeout_seconds": row["timeout_seconds"],
            "max_retries": row["max_retries"],
            "retry_delay_seconds": row["retry_delay_seconds"],
        }
    )


_TASK_QUERY = """SELECT t.*,
    (SELECT COALESCE(r.started_at, r.created_at) FROM runs r WHERE r.task_id = t.id
        ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS last_run_at,
    (SELECT r.status FROM runs r WHERE r.task_id = t.id
        ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS last_status
    FROM tasks t"""


def _require_task(conn: sqlite3.Connection, task_id: str) -> sqlite3.Row:
    row = conn.execute(_TASK_QUERY + " WHERE t.id = ?", (task_id,)).fetchone()
    if row is None:
        raise NotFoundError("Task not found")
    return row


def _validate_once_future(task: TaskCreate, now: datetime) -> None:
    if isinstance(task.schedule, OnceSchedule) and task.schedule.run_at <= now:
        raise InputError("A one-time schedule must be in the future")


def _next_for_new_schedule(task: TaskCreate, now: datetime) -> str | None:
    if not task.enabled:
        return None
    if isinstance(task.schedule, CronSchedule):
        return to_db(next_cron_time(task.schedule.expression, now))
    if isinstance(task.schedule, IntervalSchedule):
        return to_db(now + timedelta(seconds=task.schedule.seconds))
    return to_db(task.schedule.run_at)


def _task_values(task: TaskCreate) -> tuple:
    schedule = task.schedule
    return (
        task.name,
        task.description,
        task.action_type,
        task.url,
        task.message,
        task.method,
        _json(task.headers),
        _json(task.body) if task.body is not None else None,
        schedule.type,
        schedule.expression if isinstance(schedule, CronSchedule) else None,
        schedule.seconds if isinstance(schedule, IntervalSchedule) else None,
        to_db(schedule.run_at) if isinstance(schedule, OnceSchedule) else None,
        task.retry.max_retries,
        task.retry.delay_seconds,
        task.timeout_seconds,
        int(task.enabled),
    )


class Repository:
    def __init__(self, settings: Settings):
        self.db = Database(settings.database_path)
        self.policy = TargetPolicy(settings)
        self.lease_grace_seconds = settings.lease_grace_seconds

    def initialize(self) -> None:
        self.db.initialize()

    def ping(self) -> bool:
        with self.db.read() as conn:
            if conn.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
                return False
            # Also detect a missing/corrupt schema after startup, not just a live connection.
            for table in ("tasks", "runs", "attempts"):
                conn.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone()
            return True

    def create_task(self, task: TaskCreate, now: datetime) -> dict:
        try:
            if task.url is not None:
                self.policy.validate_url(task.url)
        except ValueError as exc:
            raise InputError(str(exc)) from exc
        _validate_once_future(task, now)
        task_id = _id()
        timestamp = to_db(now)
        next_run = _next_for_new_schedule(task, now)
        with self.db.transaction() as conn:
            conn.execute(
                """INSERT INTO tasks (id, name, description, action_type, url, message, method,
                    headers_json, body_json, schedule_type, cron_expression, interval_seconds, run_at,
                    max_retries, retry_delay_seconds, timeout_seconds, enabled, next_run_at, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (task_id, *_task_values(task), next_run, timestamp, timestamp),
            )
            return _task(_require_task(conn, task_id))

    def get_task(self, task_id: str) -> dict:
        with self.db.read() as conn:
            return _task(_require_task(conn, task_id))

    def list_tasks(self, limit: int, offset: int, enabled: bool | None = None) -> list[dict]:
        query = _TASK_QUERY
        params: list = []
        if enabled is not None:
            query += " WHERE t.enabled = ?"
            params.append(int(enabled))
        query += " ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        with self.db.read() as conn:
            return [_task(row) for row in conn.execute(query, params).fetchall()]

    def update_task(self, task_id: str, patch: TaskPatch, now: datetime) -> dict:
        changes = patch.model_dump(exclude_unset=True)
        with self.db.transaction() as conn:
            row = _require_task(conn, task_id)
            current = _task(row)
            merged = {key: current[key] for key in TaskCreate.model_fields}
            merged.update(changes)
            try:
                task = TaskCreate.model_validate(merged)
                if ("url" in changes or "action_type" in changes) and task.url is not None:
                    self.policy.validate_url(task.url)
            except ValidationError as exc:
                errors = [
                    {key: error[key] for key in ("type", "loc", "msg")}
                    for error in exc.errors(include_context=False, include_url=False)
                ]
                raise InputError(errors) from exc
            except ValueError as exc:
                raise InputError(str(exc)) from exc

            schedule_changed = "schedule" in changes
            if schedule_changed:
                _validate_once_future(task, now)
                next_run = _next_for_new_schedule(task, now)
                once_consumed = 0
            elif row["enabled"] and not task.enabled:
                next_run = None
                once_consumed = row["once_consumed"]
            elif not row["enabled"] and task.enabled:
                once_consumed = row["once_consumed"]
                if isinstance(task.schedule, CronSchedule):
                    next_run = to_db(next_cron_time(task.schedule.expression, now))
                elif isinstance(task.schedule, IntervalSchedule):
                    next_run = to_db(now + timedelta(seconds=task.schedule.seconds))
                else:
                    # A paused, not-yet-fired one-off runs as soon as it can after resume.
                    next_run = None if once_consumed else to_db(task.schedule.run_at)
            else:
                next_run = row["next_run_at"]
                once_consumed = row["once_consumed"]

            conn.execute(
                """UPDATE tasks SET name=?, description=?, action_type=?, url=?, message=?, method=?,
                    headers_json=?, body_json=?, schedule_type=?, cron_expression=?, interval_seconds=?,
                    run_at=?, max_retries=?, retry_delay_seconds=?, timeout_seconds=?, enabled=?,
                    next_run_at=?, once_consumed=?, updated_at=? WHERE id=?""",
                (*_task_values(task), next_run, once_consumed, to_db(now), task_id),
            )
            return _task(_require_task(conn, task_id))

    def delete_task(self, task_id: str) -> None:
        with self.db.transaction() as conn:
            _require_task(conn, task_id)
            conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))

    def _insert_run(
        self, conn: sqlite3.Connection, task: sqlite3.Row, trigger: str, scheduled_for: str, now: datetime
    ) -> str:
        run_id = _id()
        timestamp = to_db(now)
        conn.execute(
            """INSERT INTO runs (id, task_id, trigger, scheduled_for, status, next_attempt_at,
                snapshot_json, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)""",
            (run_id, task["id"], trigger, scheduled_for, timestamp, _snapshot(task), timestamp),
        )
        return run_id

    def trigger_task(self, task_id: str, now: datetime) -> dict:
        with self.db.transaction() as conn:
            task = _require_task(conn, task_id)
            if not task["enabled"]:
                raise ConflictError("Paused tasks cannot be triggered")
            active = conn.execute(
                "SELECT 1 FROM runs WHERE task_id = ? AND status IN ('queued', 'running', 'retrying')",
                (task_id,),
            ).fetchone()
            if active:
                raise ConflictError("Task already has an unfinished run")
            run_id = self._insert_run(conn, task, "manual", to_db(now), now)
            row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            return _run(row, [])

    def get_run(self, run_id: str) -> dict:
        with self.db.read() as conn:
            row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if row is None:
                raise NotFoundError("Run not found")
            attempts = conn.execute(
                "SELECT * FROM attempts WHERE run_id = ? ORDER BY number", (run_id,)
            ).fetchall()
            return _run(row, [_attempt(attempt) for attempt in attempts])

    def dashboard_stats(self, now: datetime) -> dict:
        with self.db.read() as conn:
            tasks = conn.execute(
                """SELECT COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN t.enabled = 1 AND
                        (t.schedule_type != 'once' OR t.next_run_at IS NOT NULL OR EXISTS (
                            SELECT 1 FROM runs r WHERE r.task_id = t.id
                            AND r.status IN ('queued', 'running', 'retrying')
                        )) THEN 1 ELSE 0 END), 0) AS active
                    FROM tasks t"""
            ).fetchone()
            runs = conn.execute(
                """SELECT COUNT(*) AS total,
                    COALESCE(SUM(status = 'succeeded'), 0) AS succeeded,
                    COALESCE(SUM(status = 'failed'), 0) AS failed,
                    COALESCE(SUM(attempt_count > 1), 0) AS retried
                    FROM runs WHERE created_at >= ? AND status IN ('succeeded', 'failed')""",
                (to_db(now - timedelta(hours=24)),),
            ).fetchone()
            return {
                "total_tasks": tasks["total"],
                "active_tasks": tasks["active"],
                "runs_24h": runs["total"],
                "succeeded_24h": runs["succeeded"],
                "failed_24h": runs["failed"],
                "retried_24h": runs["retried"],
            }

    def list_runs(
        self,
        limit: int,
        offset: int,
        task_id: str | None = None,
        status: str | None = None,
        require_task: bool = False,
    ) -> list[dict]:
        clauses, params = [], []
        if task_id is not None:
            clauses.append("task_id = ?")
            params.append(task_id)
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        query = "SELECT * FROM runs" + (" WHERE " + " AND ".join(clauses) if clauses else "")
        query += " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        with self.db.read() as conn:
            if require_task and task_id is not None:
                _require_task(conn, task_id)
            rows = conn.execute(query, params).fetchall()
            if not rows:
                return []
            placeholders = ",".join("?" for _ in rows)
            attempts = conn.execute(
                f"SELECT * FROM attempts WHERE run_id IN ({placeholders}) ORDER BY run_id, number",
                [row["id"] for row in rows],
            ).fetchall()
            by_run: dict[str, list[dict]] = {row["id"]: [] for row in rows}
            for attempt in attempts:
                by_run[attempt["run_id"]].append(_attempt(attempt))
            return [_run(row, by_run[row["id"]]) for row in rows]

    def schedule_due(self, now: datetime, limit: int = 100) -> int:
        timestamp = to_db(now)
        created = 0
        with self.db.transaction() as conn:
            # A due one-off waits for the active run instead of being lost. Exclude
            # those rows here so many blocked one-offs cannot starve other tasks.
            tasks = conn.execute(
                """SELECT * FROM tasks t WHERE t.enabled = 1 AND t.next_run_at IS NOT NULL
                    AND t.next_run_at <= ? AND (t.schedule_type != 'once' OR NOT EXISTS (
                        SELECT 1 FROM runs r WHERE r.task_id = t.id
                        AND r.status IN ('queued', 'running', 'retrying')))
                    ORDER BY t.next_run_at, t.id LIMIT ?""",
                (timestamp, limit),
            ).fetchall()
            for task in tasks:
                active = conn.execute(
                    "SELECT 1 FROM runs WHERE task_id = ? AND status IN ('queued', 'running', 'retrying')",
                    (task["id"],),
                ).fetchone()
                if task["schedule_type"] == "cron":
                    # Coalesce missed occurrences; never enqueue a backlog after downtime.
                    next_run = to_db(next_cron_time(task["cron_expression"], now))
                    conn.execute("UPDATE tasks SET next_run_at = ? WHERE id = ?", (next_run, task["id"]))
                elif task["schedule_type"] == "interval":
                    due = from_db(task["next_run_at"])
                    elapsed = max(0, int((now - due).total_seconds()))
                    steps = elapsed // task["interval_seconds"] + 1
                    next_run = to_db(due + timedelta(seconds=steps * task["interval_seconds"]))
                    conn.execute("UPDATE tasks SET next_run_at = ? WHERE id = ?", (next_run, task["id"]))
                else:
                    conn.execute(
                        "UPDATE tasks SET next_run_at = NULL, once_consumed = 1 WHERE id = ?", (task["id"],)
                    )
                if not active:
                    self._insert_run(conn, task, "scheduled", task["next_run_at"], now)
                    created += 1
        return created

    def claim_next(self, now: datetime) -> dict | None:
        timestamp = to_db(now)
        with self.db.transaction() as conn:
            row = conn.execute(
                """SELECT r.* FROM runs r JOIN tasks t ON t.id = r.task_id
                   WHERE t.enabled = 1 AND r.status IN ('queued', 'retrying') AND r.next_attempt_at <= ?
                   ORDER BY r.next_attempt_at, r.created_at, r.id LIMIT 1""",
                (timestamp,),
            ).fetchone()
            if row is None:
                return None
            snapshot = json.loads(row["snapshot_json"])
            token = _id()
            number = row["attempt_count"] + 1
            lease_expires = to_db(
                now + timedelta(seconds=snapshot["timeout_seconds"] + self.lease_grace_seconds)
            )
            conn.execute(
                """UPDATE runs SET status = 'running', attempt_count = ?, next_attempt_at = NULL,
                    started_at = COALESCE(started_at, ?), lease_token = ?, lease_expires_at = ? WHERE id = ?""",
                (number, timestamp, token, lease_expires, row["id"]),
            )
            conn.execute(
                "INSERT INTO attempts (run_id, number, status, started_at) VALUES (?, ?, 'running', ?)",
                (row["id"], number, timestamp),
            )
            return {
                "run_id": row["id"],
                "task_id": row["task_id"],
                "token": token,
                "number": number,
                "snapshot": snapshot,
            }

    def _finish_attempt(
        self,
        conn: sqlite3.Connection,
        row: sqlite3.Row,
        now: datetime,
        http_status: int | None,
        error: str | None,
    ) -> None:
        timestamp = to_db(now)
        snapshot = json.loads(row["snapshot_json"])
        is_log = snapshot.get("action_type", "http") == "log"
        succeeded = error is None and (is_log or (http_status is not None and 200 <= http_status < 300))
        if not succeeded and error is None:
            error = f"HTTP {http_status}" if http_status is not None else "No HTTP response"
        output = snapshot.get("message") if succeeded and is_log else None
        conn.execute(
            """UPDATE attempts SET status = ?, finished_at = ?, http_status = ?, error = ?, output = ?
               WHERE run_id = ? AND number = ? AND status = 'running'""",
            (
                "succeeded" if succeeded else "failed",
                timestamp,
                http_status,
                error,
                output,
                row["id"],
                row["attempt_count"],
            ),
        )
        if succeeded:
            status, next_attempt, finished = "succeeded", None, timestamp
        elif row["attempt_count"] <= snapshot["max_retries"]:
            status = "retrying"
            next_attempt = to_db(now + timedelta(seconds=snapshot["retry_delay_seconds"]))
            finished = None
        else:
            status, next_attempt, finished = "failed", None, timestamp
        conn.execute(
            """UPDATE runs SET status = ?, next_attempt_at = ?, finished_at = ?, last_http_status = ?,
               last_error = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ?""",
            (status, next_attempt, finished, http_status, error, row["id"]),
        )

    def complete_attempt(
        self, run_id: str, token: str, now: datetime, http_status: int | None, error: str | None
    ) -> bool:
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM runs WHERE id = ? AND status = 'running' AND lease_token = ?",
                (run_id, token),
            ).fetchone()
            if row is None:
                return False
            self._finish_attempt(conn, row, now, http_status, error)
            return True

    def recover_expired(self, now: datetime) -> int:
        with self.db.transaction() as conn:
            rows = conn.execute(
                "SELECT * FROM runs WHERE status = 'running' AND lease_expires_at <= ?",
                (to_db(now),),
            ).fetchall()
            for row in rows:
                self._finish_attempt(conn, row, now, None, "Worker lease expired before the attempt finished")
            return len(rows)
