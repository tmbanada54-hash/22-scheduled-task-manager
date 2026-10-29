-- Migration: 001_initial
-- Description: Initial schema for Scheduled Task Manager MVP
-- Created: 2026-10-29
-- Branch: database

\echo 'Running migration 001_initial...'
\echo 'This file is identical to database/schema.sql — kept for migration tooling'

-- Migration tools (golang-migrate, dbmate, Supabase CLI) expect idempotent files.
-- For this MVP, we use the main schema.sql as source of truth.
-- Copy contents of schema.sql here OR import it:

\i database/schema.sql

\echo 'Migration 001_initial completed.'
