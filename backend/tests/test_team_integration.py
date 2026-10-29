import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.database import DATABASE_DIR, Database
from app.main import create_app
from app.models import TaskCreate, TaskPatch
from app.schedules import from_db


def test_interval_schedules_coalesce_and_resume(repo, now):
    payload = TaskCreate.model_validate(
        {
            "name": "Heartbeat",
            "action_type": "log",
            "message": "service is alive",
            "schedule": {"type": "interval", "seconds": 5},
        }
    )
    task = repo.create_task(payload, now)
    assert from_db(task["next_run_at"]) == now + timedelta(seconds=5)
    assert repo.schedule_due(now + timedelta(seconds=16)) == 1
    run = repo.list_runs(10, 0, task_id=task["id"])[0]
    assert from_db(run["scheduled_for"]) == now + timedelta(seconds=5)
    assert from_db(repo.get_task(task["id"])["next_run_at"]) == now + timedelta(seconds=20)
    assert repo.schedule_due(now + timedelta(seconds=20)) == 0  # no overlap
    assert from_db(repo.get_task(task["id"])["next_run_at"]) == now + timedelta(seconds=25)
    repo.update_task(task["id"], TaskPatch(enabled=False), now + timedelta(seconds=21))
    resumed = repo.update_task(task["id"], TaskPatch(enabled=True), now + timedelta(seconds=50))
    assert from_db(resumed["next_run_at"]) == now + timedelta(seconds=55)


def test_log_task_runs_and_dashboard_stats_are_persisted(tmp_path):
    settings = Settings(database_path=str(tmp_path / "integration.sqlite3"), poll_interval_seconds=0.05)
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/v1/tasks",
            json={
                "name": "Heartbeat",
                "action_type": "log",
                "message": "Hello from Tickwise",
                "schedule": {"type": "interval", "seconds": 5},
            },
        )
        assert response.status_code == 201, response.text
        task_id = response.json()["id"]
        assert client.post(f"/api/v1/tasks/{task_id}/runs").status_code == 202
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            runs = client.get(f"/api/v1/tasks/{task_id}/runs").json()
            if runs and runs[0]["status"] == "succeeded":
                break
            time.sleep(0.05)
        else:
            pytest.fail(f"Log task did not complete: {runs}")
        attempt = runs[0]["attempts"][0]
        assert attempt["output"] == "Hello from Tickwise"
        assert attempt["http_status"] is None
        task = client.get(f"/api/v1/tasks/{task_id}").json()
        assert task["last_status"] == "succeeded"
        assert task["last_run_at"] is not None
        assert client.get("/api/v1/stats").json() == {
            "total_tasks": 1,
            "active_tasks": 1,
            "runs_24h": 1,
            "succeeded_24h": 1,
            "failed_24h": 0,
            "retried_24h": 0,
        }
    with TestClient(create_app(settings)) as client:
        assert (
            client.get(f"/api/v1/tasks/{task_id}/runs").json()[0]["attempts"][0]["output"]
            == "Hello from Tickwise"
        )


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "bad", "action_type": "log", "message": "", "schedule": {"type": "interval", "seconds": 5}},
        {
            "name": "bad",
            "action_type": "log",
            "message": "hello",
            "url": "https://example.com",
            "schedule": {"type": "interval", "seconds": 5},
        },
        {"name": "bad", "action_type": "http", "schedule": {"type": "interval", "seconds": 5}},
        {
            "name": "bad",
            "action_type": "log",
            "message": "hello",
            "schedule": {"type": "interval", "seconds": 4},
        },
        {
            "name": "bad",
            "action_type": "log",
            "message": "hello",
            "schedule": {"type": "interval", "seconds": 5.5},
        },
    ],
)
def test_log_and_interval_validation(client, payload):
    assert client.post("/api/v1/tasks", json=payload).status_code == 422


def make_v1_database(path: Path) -> None:
    old_schema = (DATABASE_DIR / "migrations" / "001_sqlite_backend_v1.sql").read_text()
    with sqlite3.connect(path) as db:
        db.executescript(old_schema)
        timestamp = datetime(2026, 1, 1, tzinfo=UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
        db.execute(
            """INSERT INTO tasks (id,name,url,method,headers_json,schedule_type,cron_expression,
                      max_retries,retry_delay_seconds,timeout_seconds,enabled,next_run_at,created_at,updated_at)
                      VALUES ('old-task','Old task','https://example.com','POST','{}','cron','* * * * *',
                              2,60,10,1,?,?,?)""",
            (timestamp, timestamp, timestamp),
        )
        db.execute(
            """INSERT INTO runs (id,task_id,trigger,scheduled_for,status,attempt_count,
                      snapshot_json,created_at) VALUES ('old-run','old-task','manual',?,'failed',1,'{}',?)""",
            (timestamp, timestamp),
        )
        db.execute(
            """INSERT INTO attempts (run_id,number,status,started_at,finished_at,error)
                      VALUES ('old-run',1,'failed',?,?,'HTTP 503')""",
            (timestamp, timestamp),
        )


def test_migrates_v1_database_atomically_and_preserves_history(tmp_path):
    path = tmp_path / "old.sqlite3"
    make_v1_database(path)
    # Two API processes can start together without running the migration twice.
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: Database(str(path)).initialize(), range(2)))
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 2
        assert db.execute("SELECT action_type, url, message FROM tasks WHERE id='old-task'").fetchone() == (
            "http",
            "https://example.com",
            None,
        )
        assert db.execute("SELECT error, output FROM attempts WHERE run_id='old-run'").fetchone() == (
            "HTTP 503",
            None,
        )
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        db.executescript((DATABASE_DIR / "seed.sqlite.sql").read_text())
        assert db.execute("SELECT action_type, enabled FROM tasks WHERE id='demo-log-task'").fetchone() == (
            "log",
            0,
        )


def test_unversioned_team_prototype_is_not_silently_overwritten(tmp_path):
    path = tmp_path / "prototype.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, payload TEXT)")
        db.execute("INSERT INTO tasks VALUES ('preserve-me', '{}')")
    with pytest.raises(RuntimeError, match="Unversioned task tables"):
        Database(str(path)).initialize()
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT id FROM tasks").fetchone()[0] == "preserve-me"


def test_completed_one_time_task_is_not_counted_as_active(repo, now):
    task = repo.create_task(
        TaskCreate.model_validate(
            {
                "name": "One-time log",
                "action_type": "log",
                "message": "Finished",
                "schedule": {"type": "once", "run_at": (now + timedelta(seconds=1)).isoformat()},
            }
        ),
        now,
    )
    assert repo.dashboard_stats(now)["active_tasks"] == 1
    repo.schedule_due(now + timedelta(seconds=2))
    assert repo.dashboard_stats(now)["active_tasks"] == 1  # queued
    claim = repo.claim_next(now + timedelta(seconds=2))
    assert claim is not None
    repo.complete_attempt(claim["run_id"], claim["token"], now + timedelta(seconds=3), None, None)
    assert repo.get_task(task["id"])["enabled"] is True
    assert repo.dashboard_stats(now + timedelta(seconds=3))["active_tasks"] == 0


def test_runtime_sql_constraints_and_foreign_keys(tmp_path):
    path = tmp_path / "constraints.sqlite3"
    Database(str(path)).initialize()
    with sqlite3.connect(path) as db:
        db.executescript((DATABASE_DIR / "tests" / "test_constraints.sql").read_text())
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        assert db.execute("SELECT count(*) FROM tasks").fetchone()[0] == 0
        db.execute("PRAGMA foreign_keys=ON")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(
                """INSERT INTO runs (id, task_id, trigger, scheduled_for, status, snapshot_json, created_at)
                   VALUES ('bad-run', 'missing-task', 'manual', 't', 'queued', '{}', 't')"""
            )


def test_failed_v1_migration_rolls_back_without_data_loss(tmp_path):
    path = tmp_path / "invalid-v1.sqlite3"
    make_v1_database(path)
    with sqlite3.connect(path) as db:
        # A manually modified v1 row that violates the v2 name constraint.
        db.execute("UPDATE tasks SET name = '   ' WHERE id = 'old-task'")
    with pytest.raises(sqlite3.IntegrityError):
        Database(str(path)).initialize()
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 1
        assert db.execute("SELECT name FROM tasks WHERE id='old-task'").fetchone()[0] == "   "
        assert db.execute("SELECT error FROM attempts WHERE run_id='old-run'").fetchone()[0] == "HTTP 503"
        assert "action_type" not in {row[1] for row in db.execute("PRAGMA table_info(tasks)")}
        assert "output" not in {row[1] for row in db.execute("PRAGMA table_info(attempts)")}


def test_dashboard_counts_failed_retried_runs_only_once(repo, now):
    task = repo.create_task(
        TaskCreate.model_validate(
            {
                "name": "Retrying log",
                "action_type": "log",
                "message": "hello",
                "schedule": {"type": "interval", "seconds": 30},
                "retry": {"max_retries": 1, "delay_seconds": 1},
            }
        ),
        now,
    )
    run = repo.trigger_task(task["id"], now)
    first = repo.claim_next(now)
    assert first is not None
    repo.complete_attempt(run["id"], first["token"], now, None, "temporary failure")
    assert repo.dashboard_stats(now)["runs_24h"] == 0  # retrying is not terminal
    second = repo.claim_next(now + timedelta(seconds=1))
    assert second is not None
    repo.complete_attempt(run["id"], second["token"], now + timedelta(seconds=1), None, "failed again")
    assert repo.dashboard_stats(now + timedelta(seconds=1)) == {
        "total_tasks": 1,
        "active_tasks": 1,
        "runs_24h": 1,
        "succeeded_24h": 0,
        "failed_24h": 1,
        "retried_24h": 1,
    }
