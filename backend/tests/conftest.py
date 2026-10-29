from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.repository import Repository


@pytest.fixture
def settings(tmp_path):
    return Settings(
        database_path=str(tmp_path / "tasks.sqlite3"), scheduler_enabled=False, lease_grace_seconds=2
    )


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as instance:
        yield instance


@pytest.fixture
def repo(settings):
    repository = Repository(settings)
    repository.initialize()
    return repository


@pytest.fixture
def now():
    return datetime(2026, 1, 1, tzinfo=UTC)


@pytest.fixture
def task_payload():
    return {
        "name": "Sync inventory",
        "url": "https://example.com/webhook",
        "method": "POST",
        "headers": {"X-Example": "demo"},
        "body": {"event": "sync"},
        "schedule": {"type": "cron", "expression": "*/5 * * * *"},
        "retry": {"max_retries": 2, "delay_seconds": 1},
        "timeout_seconds": 2,
    }
