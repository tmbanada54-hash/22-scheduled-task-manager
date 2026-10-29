from datetime import UTC, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_crud_manual_runs_and_history(client, task_payload):
    assert client.get("/health").json() == {"status": "ok", "database": "ok", "scheduler": "disabled"}
    assert client.get("/", follow_redirects=False).headers["location"] == "/docs"
    assert client.get("/", follow_redirects=True).status_code == 200
    assert client.get("/openapi.json").status_code == 200
    created = client.post("/api/v1/tasks", json=task_payload)
    assert created.status_code == 201, created.text
    task = created.json()
    task_id = task["id"]
    assert task["name"] == "Sync inventory"
    assert task["schedule"] == task_payload["schedule"]
    assert task["next_run_at"].endswith("Z")
    assert client.get(f"/api/v1/tasks/{task_id}").json() == task
    assert client.get("/api/v1/tasks?limit=1").json()[0]["id"] == task_id
    assert client.get("/api/v1/tasks?limit=101").status_code == 422
    assert client.get("/api/v1/tasks?offset=999999999999999999999").status_code == 422

    update = client.patch(f"/api/v1/tasks/{task_id}", json={"name": "  Renamed  ", "description": "test"})
    assert update.status_code == 200
    assert update.json()["name"] == "Renamed"
    assert update.json()["next_run_at"] == task["next_run_at"]

    run_response = client.post(f"/api/v1/tasks/{task_id}/runs")
    assert run_response.status_code == 202
    run = run_response.json()
    assert run["status"] == "queued" and run["attempt_count"] == 0
    assert run_response.headers["location"] == f"/api/v1/runs/{run['id']}"
    assert client.post(f"/api/v1/tasks/{task_id}/runs").status_code == 409
    assert client.get(f"/api/v1/runs/{run['id']}").json() == run
    assert client.get(f"/api/v1/tasks/{task_id}/runs").json() == [run]
    assert client.get("/api/v1/runs?status=failed").json() == []
    assert client.get(f"/api/v1/runs?task_id={task_id}&status=queued").json() == [run]

    paused = client.post(f"/api/v1/tasks/{task_id}/pause")
    assert paused.status_code == 200
    assert not paused.json()["enabled"] and paused.json()["next_run_at"] is None
    assert client.post(f"/api/v1/tasks/{task_id}/runs").status_code == 409
    resumed = client.post(f"/api/v1/tasks/{task_id}/resume")
    assert resumed.status_code == 200 and resumed.json()["next_run_at"] is not None

    assert client.delete(f"/api/v1/tasks/{task_id}").status_code == 204
    assert client.get(f"/api/v1/tasks/{task_id}").status_code == 404
    assert client.get(f"/api/v1/runs/{run['id']}").status_code == 404
    assert client.get(f"/api/v1/tasks/{task_id}/runs").status_code == 404
    assert client.delete(f"/api/v1/tasks/{task_id}").status_code == 404


def test_auth_and_cors(tmp_path, task_payload):
    settings = Settings(
        database_path=str(tmp_path / "auth.sqlite3"),
        scheduler_enabled=False,
        api_key="a-long-secret",
        cors_origins=("https://frontend.example",),
    )
    with TestClient(create_app(settings)) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/api/v1/tasks").status_code == 401
        assert client.get("/api/v1/tasks", headers={"X-API-Key": "wrong"}).status_code == 401
        assert client.get("/api/v1/tasks", headers={"X-API-Key": "a-long-secret"}).status_code == 200
        preflight = client.options(
            "/api/v1/tasks",
            headers={
                "Origin": "https://frontend.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-api-key",
            },
        )
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-origin"] == "https://frontend.example"


@pytest.mark.parametrize(
    "mutation",
    [
        {"name": "    "},
        {"url": "ftp://example.com/file"},
        {"url": "https://user:pass@example.com/path"},
        {"url": "http://127.0.0.1:9001"},
        {"url": "http://169.254.169.254/latest/meta-data"},
        {"url": "http://localhost:9001"},
        {"url": "http://[::1]:9001"},
        {"url": "http://example.com/#fragment"},
        {"method": "GET"},  # existing JSON body is not legal for GET
        {"headers": {"Host": "something-else"}},
        {"headers": {"X-Safe": "ok\r\nInjected: yes"}},
        {"headers": {"idempotency-key": "forged"}},
        {"headers": {"X-Dupe": "1", "x-dupe": "2"}},
        {"schedule": {"type": "cron", "expression": "not cron"}},
        {"schedule": {"type": "cron", "expression": "0 0 30 2 *"}},
        {"schedule": {"type": "cron", "expression": "* * * * * *"}},
        {"schedule": {"type": "once", "run_at": "2099-01-01T00:00:00"}},
        {"schedule": {"type": "once", "run_at": 4102444800}},
        {"schedule": {"type": "once", "run_at": "9999-12-31T23:59:59-14:00"}},
        {"schedule": {"type": "once", "run_at": "2000-01-01T00:00:00Z"}},
        {"retry": {"max_retries": -1, "delay_seconds": 1}},
        {"retry": {"max_retries": 1.5, "delay_seconds": 1}},
        {"timeout_seconds": 0},
        {"unknown": "field"},
    ],
)
def test_invalid_task_input_is_rejected(client, task_payload, mutation):
    task_payload.update(mutation)
    result = client.post("/api/v1/tasks", json=task_payload)
    assert result.status_code == 422, result.text
    assert client.get("/api/v1/tasks").json() == []


def test_update_revalidates_the_combined_task_atomically(client, task_payload):
    task = client.post("/api/v1/tasks", json=task_payload).json()
    path = f"/api/v1/tasks/{task['id']}"
    assert client.patch(path, json={"method": "GET"}).status_code == 422
    assert client.patch(path, json={"url": "http://127.0.0.1"}).status_code == 422
    assert client.patch(path, json={"name": "  "}).status_code == 422
    assert client.patch(path, json={"name": None}).status_code == 422
    assert client.patch(path, json={}).status_code == 422
    assert client.patch(path, json={"id": "different"}).status_code == 422
    assert client.get(path).json() == task
    cleared = client.patch(path, json={"method": "GET", "body": None})
    assert cleared.status_code == 200
    assert cleared.json()["body"] is None and cleared.json()["method"] == "GET"


def test_once_accepts_timezone_offsets_and_normalizes_to_utc(client, task_payload):
    future = datetime.now(UTC) + timedelta(hours=1)
    local_time = future.astimezone(timezone(timedelta(hours=5, minutes=30)))
    task_payload["schedule"] = {"type": "once", "run_at": local_time.isoformat()}
    response = client.post("/api/v1/tasks", json=task_payload)
    assert response.status_code == 201, response.text
    task = response.json()
    assert task["schedule"]["run_at"].endswith("Z")
    assert datetime.fromisoformat(task["next_run_at"]) == future


def test_host_allowlist_and_body_size_limit(tmp_path, task_payload):
    settings = Settings(
        database_path=str(tmp_path / "hosts.sqlite3"),
        scheduler_enabled=False,
        allowed_target_hosts=("example.com",),
    )
    with TestClient(create_app(settings)) as client:
        assert client.post("/api/v1/tasks", json=task_payload).status_code == 201
        task_payload["url"] = "https://other.example/webhook"
        assert client.post("/api/v1/tasks", json=task_payload).status_code == 422
        task_payload["url"] = "https://example.com/webhook"
        task_payload["body"] = {"large": "a" * 65537}
        assert client.post("/api/v1/tasks", json=task_payload).status_code == 422
        assert (
            client.post(
                "/api/v1/tasks", content=b"x" * 131073, headers={"Content-Type": "application/json"}
            ).status_code
            == 413
        )


def test_malformed_json_values_do_not_cause_server_errors_or_echo_secrets(client):
    template = b'{"name":"demo","url":"https://example.com","schedule":{"type":"cron","expression":"* * * * *"},"body":{"secret":"do-not-echo","value":NaN}}'
    response = client.post("/api/v1/tasks", content=template, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert "do-not-echo" not in response.text
    invalid_unicode = (
        b'{"name":"\\ud800","url":"https://example.com","schedule":{"type":"cron","expression":"* * * * *"}}'
    )
    response = client.post(
        "/api/v1/tasks", content=invalid_unicode, headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422


def test_health_reports_missing_schema(client):
    with client.app.state.repository.db.transaction() as connection:
        connection.execute("DROP TABLE attempts")
    response = client.get("/health")
    assert response.status_code == 503
    assert response.json()["database"] == "unavailable"
