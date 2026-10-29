# Scheduled Task Manager — MVP

> Schedule tasks, display next execution times, record outcomes, retry failed executions.

## Quick Start

```bash
git clone <repo>
git checkout develop
# Database is on `database` branch
git checkout database

# Backend (Node/Express example)
cd backend && npm install && npm run dev

# Database
psql $DATABASE_URL -f database/schema.sql
psql $DATABASE_URL -f database/seed.sql
```

## Branches

- `main` — stable / deployed
- `develop` — integration
- `database` — this branch (schema, seed, migrations)
- `scheduler` / `task-runner` / `ui` — sibling teams

## Roles

- **Scheduler** — polls `tasks.next_run_at`, creates `executions`
- **Task runner** — executes payload, writes outcome, handles retry
- **Persistence** — this branch (schema, queries, views)
- **UI** — dashboard, forms, history

## Database Docs

- `database/schema.sql` — Postgres main schema
- `database/schema.sqlite.sql` — SQLite fallback
- `database/seed.sql` — 6 demo tasks + history
- `database/QUERIES.md` — scheduler, dashboard, retry queries
- `database/README.md` — full DB documentation
- `docs/ER_DIAGRAM.md` — ER diagram (Mermaid + ASCII)

## Demo (2 min)

1. Show `v_task_stats` dashboard (tasks + next run)
2. Trigger manual run → success
3. Show failing task → retry chain via `parent_execution_id`
4. Explain `next_run_at` indexing + backoff

## Env

See `.env.example`
