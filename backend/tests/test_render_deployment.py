"""Verify the native Render configuration and its actual start command."""

import json
import os
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pytest
import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def render_service():
    blueprint = yaml.safe_load((PROJECT_ROOT / "render.yaml").read_text(encoding="utf-8"))
    assert len(blueprint["services"]) == 1
    return blueprint["services"][0]


def test_render_blueprint_uses_one_native_python_service_and_persistent_disk():
    service = render_service()
    assert service["type"] == "web"
    assert service["runtime"] == "python"
    assert service.get("rootDir", "") in {"", "."}
    assert service["plan"] == "0.5c-512mb"  # Render's paid, disk-capable plan
    assert service["numInstances"] == 1
    assert service["buildCommand"] == "pip install -r backend/requirements.txt"
    assert "$PORT" in service["startCommand"]
    assert service["healthCheckPath"] == "/health"
    assert service["disk"]["mountPath"] == "/var/data"
    assert service["disk"]["sizeGB"] >= 1
    env = {entry["key"]: entry for entry in service["envVars"]}
    assert env["DATABASE_PATH"]["value"] == "/var/data/tasks.sqlite3"
    assert env["SCHEDULER_ENABLED"]["value"] == "true"
    assert env["API_KEY"]["sync"] is False
    assert (PROJECT_ROOT / ".python-version").read_text().strip() == "3.11"


def _unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _request(base, path, *, key=None, method="GET", payload=None):
    headers = {}
    if key is not None:
        headers["X-API-Key"] = key
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request = Request(
        base + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
        method=method,
    )
    with urlopen(request, timeout=2) as response:  # Local test service.
        return response.status, response.read()


@contextmanager
def _running_service(tmp_path, database_path):
    port = _unused_port()
    base = f"http://127.0.0.1:{port}"
    env = os.environ.copy()
    env.update(
        {
            "PORT": str(port),
            "DATABASE_PATH": str(database_path),
            "API_KEY": "render-test-key",
            "SCHEDULER_ENABLED": "true",
            "POLL_INTERVAL_SECONDS": "0.05",
            # Use the same virtualenv as pytest, even if it is not activated.
            "PATH": str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", ""),
        }
    )
    with (tmp_path / "render-start.log").open("w+", encoding="utf-8") as log:
        process = subprocess.Popen(  # Checked-in deployment command.
            render_service()["startCommand"],
            cwd=PROJECT_ROOT,
            env=env,
            shell=True,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    break
                try:
                    if _request(base, "/health")[0] == 200:
                        yield base
                        return
                except (ConnectionError, TimeoutError, URLError):
                    pass
                time.sleep(0.05)
            log.flush()
            log.seek(0)
            pytest.fail(f"Render start command failed to become healthy: {log.read()}")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def test_render_command_serves_dashboard_and_persists_runs_across_restart(tmp_path):
    database = tmp_path / "disk" / "tasks.sqlite3"
    key = "render-test-key"
    with _running_service(tmp_path, database) as base:
        assert b"Tickwise" in _request(base, "/")[1]
        assert _request(base, "/app.js")[0] == 200
        assert _request(base, "/styles.css")[0] == 200
        with pytest.raises(HTTPError) as unauthorized:
            _request(base, "/api/v1/tasks")
        assert unauthorized.value.code == 401

        status, body = _request(
            base,
            "/api/v1/tasks",
            key=key,
            method="POST",
            payload={
                "name": "Render deployment test",
                "action_type": "log",
                "message": "running without Docker",
                "schedule": {"type": "interval", "seconds": 3600},
            },
        )
        assert status == 201
        task_id = json.loads(body)["id"]
        runs_path = f"/api/v1/tasks/{task_id}/runs"
        assert _request(base, runs_path, key=key, method="POST")[0] == 202
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            runs = json.loads(_request(base, runs_path, key=key)[1])
            if runs and runs[0]["status"] == "succeeded":
                break
            time.sleep(0.05)
        else:
            pytest.fail(f"Render scheduler did not complete the test task: {runs}")
        assert runs[0]["attempts"][0]["output"] == "running without Docker"

    # The data path represents the disk mount; restarting the process must not
    # erase the task or its run history.
    with _running_service(tmp_path, database) as base:
        task = json.loads(_request(base, f"/api/v1/tasks/{task_id}", key=key)[1])
        assert task["name"] == "Render deployment test"
        runs = json.loads(_request(base, runs_path, key=key)[1])
        assert runs[0]["attempts"][0]["output"] == "running without Docker"
