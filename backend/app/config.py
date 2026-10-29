"""Runtime configuration loaded from environment variables."""

import os
from dataclasses import dataclass


def _boolean(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    value = value.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")


def _csv(name: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in os.getenv(name, "").split(",") if item.strip())


@dataclass(frozen=True, slots=True)
class Settings:
    database_path: str = "data/tasks.sqlite3"
    scheduler_enabled: bool = True
    poll_interval_seconds: float = 1.0
    max_concurrency: int = 5
    lease_grace_seconds: int = 30
    allow_private_targets: bool = False
    allowed_target_hosts: tuple[str, ...] = ()
    api_key: str | None = None
    cors_origins: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.database_path or self.database_path == ":memory:":
            raise ValueError("DATABASE_PATH must be a SQLite file path")
        if not 0.05 <= self.poll_interval_seconds <= 60:
            raise ValueError("POLL_INTERVAL_SECONDS must be between 0.05 and 60")
        if not 1 <= self.max_concurrency <= 100:
            raise ValueError("MAX_CONCURRENCY must be between 1 and 100")
        if not 1 <= self.lease_grace_seconds <= 3600:
            raise ValueError("LEASE_GRACE_SECONDS must be between 1 and 3600")

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            database_path=os.getenv("DATABASE_PATH", "data/tasks.sqlite3"),
            scheduler_enabled=_boolean("SCHEDULER_ENABLED", True),
            poll_interval_seconds=float(os.getenv("POLL_INTERVAL_SECONDS", "1")),
            max_concurrency=int(os.getenv("MAX_CONCURRENCY", "5")),
            lease_grace_seconds=int(os.getenv("LEASE_GRACE_SECONDS", "30")),
            allow_private_targets=_boolean("ALLOW_PRIVATE_TARGETS", False),
            allowed_target_hosts=_csv("ALLOWED_TARGET_HOSTS"),
            api_key=os.getenv("API_KEY") or None,
            cors_origins=_csv("CORS_ORIGINS"),
        )
