import json
import threading
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@contextmanager
def webhook_server():
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            attempt = int(self.headers.get("X-Scheduled-Attempt", "0"))
            with self.server.lock:
                self.server.calls.append(
                    {
                        "path": self.path,
                        "attempt": attempt,
                        "run_id": self.headers.get("X-Scheduled-Run-Id"),
                        "task_id": self.headers.get("X-Scheduled-Task-Id"),
                        "idempotency_key": self.headers.get("Idempotency-Key"),
                        "body": json.loads(body) if body else None,
                    }
                )
                self.server.active += 1
                self.server.max_active = max(self.server.max_active, self.server.active)
            try:
                if self.path == "/slow":
                    time.sleep(1.5)
                if self.path == "/concurrency":
                    time.sleep(0.25)
                code = 503 if self.path == "/fail" or (self.path == "/flaky" and attempt == 1) else 200
                if self.path == "/redirect":
                    code = 302
                self.send_response(code)
                if code == 302:
                    self.send_header("Location", "/landed")
                self.send_header("Content-Length", "0")
                self.end_headers()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with self.server.lock:
                    self.server.active -= 1

        def log_message(self, format, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    server.calls = []
    server.lock = threading.Lock()
    server.active = 0
    server.max_active = 0
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def payload_for(server, path, *, delay=3600, retries=1):
    due = datetime.now(UTC) + timedelta(seconds=delay)
    return {
        "name": "Integration task",
        "url": f"http://127.0.0.1:{server.server_port}{path}",
        "schedule": {"type": "once", "run_at": due.isoformat()},
        "retry": {"max_retries": retries, "delay_seconds": 1},
        "timeout_seconds": 2,
        "body": {"event": "integration-test"},
    }


def wait_for_run(client, task_id, desired, timeout=8):
    deadline = time.monotonic() + timeout
    last = []
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/tasks/{task_id}/runs")
        assert response.status_code == 200, response.text
        last = response.json()
        if last and last[0]["status"] == desired:
            return last[0]
        time.sleep(0.05)
    pytest.fail(f"run did not become {desired}: {last}")


def test_scheduled_webhook_retries_and_records_success(tmp_path):
    with webhook_server() as server:
        settings = Settings(
            database_path=str(tmp_path / "runs.sqlite3"),
            poll_interval_seconds=0.05,
            allow_private_targets=True,
            allowed_target_hosts=("127.0.0.1",),
        )
        with TestClient(create_app(settings)) as client:
            assert client.get("/health").json()["scheduler"] == "running"
            response = client.post("/api/v1/tasks", json=payload_for(server, "/flaky", delay=1.2))
            assert response.status_code == 201, response.text
            task_id = response.json()["id"]
            run = wait_for_run(client, task_id, "succeeded")
            assert run["trigger"] == "scheduled"
            assert run["attempt_count"] == 2
            assert [a["http_status"] for a in run["attempts"]] == [503, 200]
            assert [a["status"] for a in run["attempts"]] == ["failed", "succeeded"]
            assert client.get(f"/api/v1/tasks/{task_id}").json()["next_run_at"] is None
            assert [call["attempt"] for call in server.calls] == [1, 2]
            assert {call["run_id"] for call in server.calls} == {run["id"]}
            assert {call["idempotency_key"] for call in server.calls} == {run["id"]}
            assert {call["task_id"] for call in server.calls} == {task_id}
            assert all(call["body"] == {"event": "integration-test"} for call in server.calls)


def test_failure_retries_are_bounded_and_history_survives_restart(tmp_path):
    with webhook_server() as server:
        settings = Settings(
            database_path=str(tmp_path / "runs.sqlite3"),
            poll_interval_seconds=0.05,
            allow_private_targets=True,
        )
        app = create_app(settings)
        with TestClient(app) as client:
            task_id = client.post("/api/v1/tasks", json=payload_for(server, "/fail", retries=1)).json()["id"]
            run_id = client.post(f"/api/v1/tasks/{task_id}/runs").json()["id"]
            run = wait_for_run(client, task_id, "failed")
            assert run["attempt_count"] == 2
            assert run["last_error"] == "HTTP 503"
            assert len(server.calls) == 2
        # Reopening the database doesn't lose the terminal outcome or attempt history.
        with TestClient(create_app(settings)) as client:
            restored = client.get(f"/api/v1/runs/{run_id}").json()
            assert restored["status"] == "failed"
            assert [a["http_status"] for a in restored["attempts"]] == [503, 503]
            time.sleep(0.2)
            assert len(server.calls) == 2


def test_redirects_are_recorded_as_failures_and_never_followed(tmp_path):
    with webhook_server() as server:
        settings = Settings(
            database_path=str(tmp_path / "runs.sqlite3"),
            poll_interval_seconds=0.05,
            allow_private_targets=True,
        )
        with TestClient(create_app(settings)) as client:
            task_id = client.post("/api/v1/tasks", json=payload_for(server, "/redirect", retries=0)).json()[
                "id"
            ]
            client.post(f"/api/v1/tasks/{task_id}/runs")
            run = wait_for_run(client, task_id, "failed")
            assert run["last_http_status"] == 302
            assert run["last_error"] == "HTTP 302"
            assert [call["path"] for call in server.calls] == ["/redirect"]


def test_request_timeout_is_a_recorded_failure(tmp_path):
    with webhook_server() as server:
        settings = Settings(
            database_path=str(tmp_path / "runs.sqlite3"),
            poll_interval_seconds=0.05,
            allow_private_targets=True,
        )
        with TestClient(create_app(settings)) as client:
            payload = payload_for(server, "/slow", retries=0)
            payload["timeout_seconds"] = 1
            task_id = client.post("/api/v1/tasks", json=payload).json()["id"]
            client.post(f"/api/v1/tasks/{task_id}/runs")
            run = wait_for_run(client, task_id, "failed")
            assert run["last_http_status"] is None
            assert run["last_error"] == "Request timed out after 1 seconds"
            assert run["attempt_count"] == 1


def test_worker_respects_maximum_concurrency(tmp_path):
    with webhook_server() as server:
        path = str(tmp_path / "runs.sqlite3")
        api_only = Settings(database_path=path, scheduler_enabled=False, allow_private_targets=True)
        with TestClient(create_app(api_only)) as client:
            ids = []
            for i in range(4):
                payload = payload_for(server, "/concurrency", retries=0)
                payload["name"] = f"Concurrent task {i}"
                task_id = client.post("/api/v1/tasks", json=payload).json()["id"]
                ids.append(task_id)
                assert client.post(f"/api/v1/tasks/{task_id}/runs").status_code == 202
        settings = Settings(
            database_path=path, poll_interval_seconds=0.05, allow_private_targets=True, max_concurrency=2
        )
        with TestClient(create_app(settings)) as client:
            for task_id in ids:
                wait_for_run(client, task_id, "succeeded")
            assert server.max_active == 2


def test_queued_run_is_processed_after_scheduler_restarts(tmp_path):
    with webhook_server() as server:
        path = str(tmp_path / "runs.sqlite3")
        api_only = Settings(database_path=path, scheduler_enabled=False, allow_private_targets=True)
        with TestClient(create_app(api_only)) as client:
            task_id = client.post("/api/v1/tasks", json=payload_for(server, "/ok", retries=0)).json()["id"]
            run_id = client.post(f"/api/v1/tasks/{task_id}/runs").json()["id"]
            assert client.get(f"/api/v1/runs/{run_id}").json()["status"] == "queued"
            assert not server.calls
        active = Settings(database_path=path, poll_interval_seconds=0.05, allow_private_targets=True)
        with TestClient(create_app(active)) as client:
            run = wait_for_run(client, task_id, "succeeded")
            assert run["id"] == run_id
            assert len(server.calls) == 1
