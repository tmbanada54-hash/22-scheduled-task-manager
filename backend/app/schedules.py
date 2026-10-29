"""UTC schedule calculations and timestamp serialization."""

from datetime import UTC, datetime

from croniter import CroniterBadCronError, CroniterBadDateError, croniter


def utc_now() -> datetime:
    return datetime.now(UTC)


def as_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("A timezone offset is required")
    try:
        return value.astimezone(UTC)
    except (OverflowError, ValueError) as exc:
        raise ValueError("Timestamp is outside the supported UTC range") from exc


def to_db(value: datetime) -> str:
    # Fixed-width UTC values keep SQLite's text ordering chronological.
    return as_utc(value).isoformat(timespec="microseconds").replace("+00:00", "Z")


def from_db(value: str) -> datetime:
    return datetime.fromisoformat(value).astimezone(UTC)


def validate_cron(expression: str) -> str:
    expression = " ".join(expression.split())
    if len(expression.split()) != 5 or not croniter.is_valid(expression):
        raise ValueError("Use a valid five-field cron expression in UTC")
    # is_valid checks ranges, but not impossible combinations such as February 30.
    try:
        next_cron_time(expression, utc_now())
    except (CroniterBadCronError, CroniterBadDateError, ValueError, OverflowError) as exc:
        raise ValueError("Cron expression has no attainable next execution") from exc
    return expression


def next_cron_time(expression: str, after: datetime) -> datetime:
    return as_utc(croniter(expression, as_utc(after)).get_next(datetime))
