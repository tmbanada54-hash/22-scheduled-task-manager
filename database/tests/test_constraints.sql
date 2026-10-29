-- SQLite runtime constraint smoke test. Run against a disposable v2 database.
-- It rolls back all test rows. Python CI executes this file and separately
-- checks foreign-key rejection in backend/tests/test_team_integration.py.
PRAGMA foreign_keys = ON;
BEGIN;
CREATE TEMP TABLE constraint_assertions (passed INTEGER NOT NULL CHECK (passed = 1));

INSERT INTO tasks (id,name,action_type,message,method,headers_json,schedule_type,interval_seconds,
                   max_retries,retry_delay_seconds,timeout_seconds,enabled,created_at,updated_at)
VALUES ('constraint-valid','Valid','log','ok','POST','{}','interval',5,0,60,10,1,
        '2026-01-01T00:00:00.000000Z','2026-01-01T00:00:00.000000Z');

-- OR IGNORE must reject each invalid row; the assertions below fail otherwise.
INSERT OR IGNORE INTO tasks (id,name,action_type,message,method,headers_json,schedule_type,interval_seconds,
                             max_retries,retry_delay_seconds,timeout_seconds,enabled,created_at,updated_at)
VALUES ('constraint-invalid-action','Invalid','other','ok','POST','{}','interval',5,0,60,10,1,'t','t');
INSERT OR IGNORE INTO tasks (id,name,action_type,message,method,headers_json,schedule_type,interval_seconds,
                             max_retries,retry_delay_seconds,timeout_seconds,enabled,created_at,updated_at)
VALUES ('constraint-invalid-interval','Invalid','log','ok','POST','{}','interval',4,0,60,10,1,'t','t');
INSERT OR IGNORE INTO tasks (id,name,action_type,message,method,headers_json,schedule_type,cron_expression,
                             interval_seconds,max_retries,retry_delay_seconds,timeout_seconds,enabled,created_at,updated_at)
VALUES ('constraint-invalid-schedule','Invalid','log','ok','POST','{}','interval','* * * * *',5,0,60,10,1,'t','t');
INSERT OR IGNORE INTO tasks (id,name,action_type,message,method,headers_json,schedule_type,interval_seconds,
                             max_retries,retry_delay_seconds,timeout_seconds,enabled,created_at,updated_at)
VALUES ('constraint-invalid-name','  ','log','ok','POST','{}','interval',5,0,60,10,1,'t','t');
INSERT OR IGNORE INTO tasks (id,name,action_type,message,method,headers_json,schedule_type,interval_seconds,
                             max_retries,retry_delay_seconds,timeout_seconds,enabled,created_at,updated_at)
VALUES ('constraint-invalid-retries','Invalid','log','ok','POST','{}','interval',5,11,60,10,1,'t','t');
INSERT OR IGNORE INTO tasks (id,name,action_type,method,headers_json,schedule_type,interval_seconds,
                             max_retries,retry_delay_seconds,timeout_seconds,enabled,created_at,updated_at)
VALUES ('constraint-invalid-http','Invalid','http','POST','{}','interval',5,0,60,10,1,'t','t');
INSERT INTO constraint_assertions SELECT COUNT(*) = 0 FROM tasks WHERE id LIKE 'constraint-invalid-%';

-- The partial unique index permits at most one unfinished run for a task.
INSERT INTO runs (id,task_id,trigger,scheduled_for,status,next_attempt_at,snapshot_json,created_at)
VALUES ('constraint-run','constraint-valid','manual','t','queued','t','{}','t');
INSERT OR IGNORE INTO runs (id,task_id,trigger,scheduled_for,status,next_attempt_at,snapshot_json,created_at)
VALUES ('constraint-run-duplicate','constraint-valid','manual','t','retrying','t','{}','t');
INSERT INTO constraint_assertions SELECT COUNT(*) = 1 FROM runs WHERE task_id = 'constraint-valid';

INSERT OR IGNORE INTO attempts (run_id,number,status,started_at)
VALUES ('constraint-run',1,'unknown','t');
INSERT INTO constraint_assertions SELECT COUNT(*) = 0 FROM attempts WHERE run_id = 'constraint-run';
INSERT INTO attempts (run_id,number,status,started_at) VALUES ('constraint-run',1,'running','t');
DELETE FROM tasks WHERE id = 'constraint-valid';
INSERT INTO constraint_assertions SELECT COUNT(*) = 0 FROM runs WHERE id = 'constraint-run';
INSERT INTO constraint_assertions SELECT COUNT(*) = 0 FROM attempts WHERE run_id = 'constraint-run';
ROLLBACK;
