-- ARCHIVED POSTGRESQL PROTOTYPE ONLY, not used by the running application.
-- This is a psql include, not a portable or idempotent migration-tool file.
-- Run from psql only against a new, disposable PostgreSQL prototype database;
-- pgcrypto and pg_trgm extension privileges are required. It has not been
-- validated as a production migration or an upgrade path for SQLite data.
\echo 'Loading archived PostgreSQL prototype schema (not the runtime database)...'
\ir ../schema.sql
