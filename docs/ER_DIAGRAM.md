# Runtime ER diagram

The integrated FastAPI service uses the SQLite v2 schema in
[`database/schema.sqlite.sql`](../database/schema.sqlite.sql). The database team's
[original PostgreSQL design](design/ER_DIAGRAM.postgres-proposed.md) is preserved
for reference, but it is not the runtime model.

```mermaid
erDiagram
    tasks ||--o{ runs : schedules
    runs ||--o{ attempts : contains

    tasks {
        text id PK
        text name
        text action_type "http or log"
        text url "nullable for log"
        text message "nullable for http"
        text method
        text headers_json
        text body_json
        text schedule_type "cron, interval, once"
        text cron_expression
        integer interval_seconds
        text run_at
        integer once_consumed
        integer max_retries
        integer retry_delay_seconds
        integer timeout_seconds
        integer enabled
        text next_run_at
        text created_at
        text updated_at
    }
    runs {
        text id PK
        text task_id FK
        text trigger "scheduled or manual"
        text scheduled_for
        text status "queued, running, retrying, succeeded, failed"
        integer attempt_count
        text next_attempt_at
        text started_at
        text finished_at
        integer last_http_status
        text last_error
        text lease_token
        text lease_expires_at
        text snapshot_json
        text created_at
    }
    attempts {
        text run_id PK, FK
        integer number PK
        text status "running, succeeded, failed"
        text started_at
        text finished_at
        integer http_status
        text error
        text output "log message when successful"
    }
```

- A task owns many runs; a run owns numbered attempts. Foreign keys cascade
  deletions. A partial unique index permits at most one unfinished run per task.
- `runs.snapshot_json` freezes action and retry settings when a run is queued;
  leases prevent multiple workers from claiming the same attempt concurrently.
- Times are stored as fixed-width UTC text. `v_task_stats` and
  `v_failed_needing_retry` are read-only monitoring views, not extra tables.
- There is no runtime `executions` or `retry_queue` table. See the
  [database guide](../database/README.md) for migrations and limitations.
