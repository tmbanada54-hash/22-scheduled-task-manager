"""API request and response contracts."""

import json
import re
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StrictBool, field_validator, model_validator

from .schedules import as_utc, validate_cron
from .security import parse_target_url


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CronSchedule(StrictModel):
    type: Literal["cron"]
    expression: str = Field(min_length=1, max_length=120)

    @field_validator("expression")
    @classmethod
    def valid_expression(cls, value: str) -> str:
        return validate_cron(value)


class OnceSchedule(StrictModel):
    type: Literal["once"]
    run_at: datetime

    @field_validator("run_at", mode="before")
    @classmethod
    def aware_run_at(cls, value: object) -> datetime:
        if isinstance(value, str):
            try:
                value = datetime.fromisoformat(value)
            except ValueError as exc:
                raise ValueError("Use an ISO 8601 timestamp with a timezone offset") from exc
        if not isinstance(value, datetime):
            # Pydantic v2 converts ValueError (not TypeError) into a 422 response.
            raise ValueError("Use an ISO 8601 timestamp with a timezone offset")  # noqa: TRY004
        return as_utc(value)


Schedule = Annotated[CronSchedule | OnceSchedule, Field(discriminator="type")]


class RetryPolicy(StrictModel):
    max_retries: int = Field(default=2, ge=0, le=10, strict=True)
    delay_seconds: int = Field(default=60, ge=1, le=86400, strict=True)


_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_RESERVED_HEADERS = {
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "proxy-authorization",
    "proxy-connection",
    "upgrade",
    "idempotency-key",
    "x-scheduled-task-id",
    "x-scheduled-run-id",
    "x-scheduled-attempt",
}


class TaskCreate(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    url: str
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"] = "POST"
    headers: dict[str, str] = Field(default_factory=dict)
    body: JsonValue | None = None
    schedule: Schedule
    retry: RetryPolicy = Field(default_factory=RetryPolicy)
    timeout_seconds: int = Field(default=10, ge=1, le=120, strict=True)
    enabled: StrictBool = True

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Name cannot be blank")
        return value

    @field_validator("url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        parse_target_url(value)
        return value

    @field_validator("headers")
    @classmethod
    def valid_headers(cls, value: dict[str, str]) -> dict[str, str]:
        if len(value) > 20:
            raise ValueError("At most 20 headers are allowed")
        seen: set[str] = set()
        for name, header_value in value.items():
            lower = name.lower()
            if not _HEADER_NAME.fullmatch(name) or lower in _RESERVED_HEADERS:
                raise ValueError("Invalid or reserved header name")
            if lower in seen:
                raise ValueError("Header names must be unique, ignoring case")
            has_control = any((ord(char) < 32 and char != "\t") or ord(char) == 127 for char in header_value)
            if len(name) > 100 or len(header_value) > 4096 or has_control:
                raise ValueError("Invalid header value or length")
            seen.add(lower)
        if sum(len(k) + len(v) for k, v in value.items()) > 8192:
            raise ValueError("Headers are too large")
        return value

    @model_validator(mode="after")
    def valid_body(self) -> "TaskCreate":
        try:
            strings = [self.name, self.url, *(item for pair in self.headers.items() for item in pair)]
            if self.description is not None:
                strings.append(self.description)
            for value in strings:
                value.encode("utf-8")
        except UnicodeError as exc:
            raise ValueError("Strings must contain valid Unicode") from exc
        if self.body is not None and self.method not in {"POST", "PUT", "PATCH"}:
            raise ValueError("A JSON body is only supported for POST, PUT, and PATCH")
        if self.body is not None:
            try:
                encoded_body = json.dumps(self.body, ensure_ascii=False, allow_nan=False).encode("utf-8")
            except (ValueError, UnicodeError) as exc:
                raise ValueError("Body must be valid JSON with finite numbers") from exc
            if len(encoded_body) > 65536:
                raise ValueError("JSON body must not exceed 64 KiB")
        return self


class TaskPatch(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    url: str | None = None
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"] | None = None
    headers: dict[str, str] | None = None
    body: JsonValue | None = None
    schedule: Schedule | None = None
    retry: RetryPolicy | None = None
    timeout_seconds: int | None = Field(default=None, ge=1, le=120, strict=True)
    enabled: StrictBool | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_empty_or_null(cls, value):
        if not isinstance(value, dict) or not value:
            raise ValueError("Provide at least one field to update")
        for field in ("name", "url", "method", "headers", "schedule", "retry", "timeout_seconds", "enabled"):
            if field in value and value[field] is None:
                raise ValueError(f"{field} cannot be null")
        return value


class TaskOut(TaskCreate):
    id: str
    next_run_at: datetime | None
    created_at: datetime
    updated_at: datetime


RunStatus = Literal["queued", "running", "retrying", "succeeded", "failed"]


class AttemptOut(StrictModel):
    number: int
    status: Literal["running", "succeeded", "failed"]
    started_at: datetime
    finished_at: datetime | None
    http_status: int | None
    error: str | None


class RunOut(StrictModel):
    id: str
    task_id: str
    trigger: Literal["scheduled", "manual"]
    scheduled_for: datetime
    status: RunStatus
    attempt_count: int
    next_attempt_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None
    last_http_status: int | None
    last_error: str | None
    created_at: datetime
    attempts: list[AttemptOut] = Field(default_factory=list)
