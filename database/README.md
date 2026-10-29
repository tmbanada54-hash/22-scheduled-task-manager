# Database guide

## What the application actually uses

The integrated backend runs on **SQLite**, on a persistent local filesystem. Its
canonical schema is [`schema.sqlite.sql`](schema.sqlite.sql), currently
`PRAGMA user_version = 2`. Application startup creates or upgrades it
automatically; do not apply the PostgreSQL prototype to the application database.
The runtime has:

- `tasks`: HTTP/log action, cron/interval/once schedule, retry policy and next run.
- `runs`: scheduled/manual invocation, status, worker lease, and a snapshot of the
  task settings used for that invocation.
- `attempts`: numbered outcomes within a run, including HTTP status or log output.
- `v_task_stats` and `v_failed_needing_retry`: monitoring views adapted from the
  database team's proposal to the runtime model.

See the [runtime ER diagram](../docs/ER_DIAGRAM.md), the [API contract and
scheduling behavior](../README.md#api), and `backend/app/repository.py` for the
actual transactions. Foreign keys cascade deletions, and a partial unique index
prevents multiple unfinished runs of one task.

## Initialization, upgrade, and backup

- New databases are initialized from `schema.sqlite.sql` on startup.
- An existing backend v1 database is upgraded automatically and transactionally
  using [`migrations/002_sqlite_interval_log.sql`](migrations/002_sqlite_interval_log.sql),
  preserving valid backend-created tasks, pending runs, attempts, snapshots and history.
  If a manually altered row violates the new constraints, the upgrade rolls back
  instead of discarding it; repair the data from a backup before retrying. The old schema
  is retained as [`migrations/001_sqlite_backend_v1.sql`](migrations/001_sqlite_backend_v1.sql).
- Back up the SQLite database **with its WAL** using SQLite's online backup API
  before upgrades; see the [deployment guide](../README.md#backup). Test restores.
- The old database-team SQLite prototype is unversioned and has an incompatible
  `tasks`/`executions`/`retry_queue` model. It is preserved at
  [`design/schema.sqlite-proposed.sql`](design/schema.sqlite-proposed.sql).
  Startup refuses to overwrite those unversioned tables. There is **no automatic
  data conversion** for this prototype; an explicit export, mapping and migration
  are required if any real prototype data exists.
- Do not run the v1→v2 SQL by itself on a live database: the application performs
  it under a lock, checks foreign keys, and commits or rolls back atomically.

## Optional demo data

[`seed.sqlite.sql`](seed.sqlite.sql) adds a single **paused** local log task. It
makes no outbound HTTP requests and is never applied automatically. After the app
has initialized its database, stop the app, back up the file, and run the
following from the repository root, adjusting the path to match `DATABASE_PATH`:

```bash
python3 - <<'PY'
import sqlite3
from pathlib import Path
with sqlite3.connect('backend/data/tasks.sqlite3') as db:
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript(Path('database/seed.sqlite.sql').read_text())
PY
```

Restart the app and resume **Demo heartbeat** in the dashboard. Do not apply the
PostgreSQL `seed.sql` to SQLite.

## Tests

The missing team handoff [`tests/test_constraints.sql`](tests/test_constraints.sql)
now exercises the **SQLite runtime** constraints, partial unique index and
cascades on a disposable database. `backend/tests/test_team_integration.py` runs
it automatically and separately checks foreign-key rejection, v1 migration,
concurrent initialization and history preservation. Run the full suite as
shown in the [root README](../README.md#testing). The SQL test is SQLite syntax;
it is not the previously proposed, but never supplied, PostgreSQL test script.

## Archived database-team prototype

The following original handoff files are preserved as a **design proposal** and
are not wired to the FastAPI application: `schema.sql`, `seed.sql`,
`prisma.schema.example.prisma`, `ARCHITECTURE_DECISIONS.md`, `QUERIES.md`,
`api-contract.md`, `tests/test_plan.md`, and `docs/index.html`. They describe
PostgreSQL/Prisma, `executions`/`retry_queue`, extra actions, time zones and
API paths that the runtime does not implement. They are not a supported hosting
option. [`migrations/001_initial.sql`](migrations/001_initial.sql) is only a
non-idempotent `psql` include for this prototype, not a portable migration-tool
file. The prototype's `gin_trgm_ops` index requires the `pg_trgm` extension
(and extension privileges); it is now declared alongside `pgcrypto` in its
schema. PostgreSQL deployment, prototype constraint coverage, and a conversion
path need separate implementation and testing before use.
