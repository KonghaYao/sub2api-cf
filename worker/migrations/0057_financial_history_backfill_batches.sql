PRAGMA foreign_keys = ON;

CREATE TABLE admin_financial_history_backfill_batches (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'blocked', 'completed', 'failed')),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  total_users INTEGER NOT NULL CHECK (total_users BETWEEN 1 AND 25),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_by_session_id TEXT NOT NULL,
  last_run_by_user_id TEXT REFERENCES users(id),
  last_run_by_session_id TEXT,
  runner_lease_token TEXT,
  runner_lease_expires_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
  CHECK (
    (status = 'running' AND runner_lease_token IS NOT NULL AND runner_lease_expires_at_ms IS NOT NULL)
    OR
    (status <> 'running' AND runner_lease_token IS NULL AND runner_lease_expires_at_ms IS NULL)
  )
) STRICT;

CREATE TABLE admin_financial_history_backfill_batch_users (
  batch_id TEXT NOT NULL REFERENCES admin_financial_history_backfill_batches(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 24),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'running', 'blocked', 'completed', 'failed', 'manual_reconciliation'
  )),
  continuation_cursor TEXT CHECK (
    continuation_cursor IS NULL OR length(continuation_cursor) BETWEEN 1 AND 8192
  ),
  pages_processed INTEGER NOT NULL DEFAULT 0 CHECK (pages_processed >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token TEXT,
  lease_expires_at_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  completed_at_ms INTEGER,
  PRIMARY KEY (batch_id, user_id),
  UNIQUE (batch_id, ordinal),
  CHECK (
    (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
    OR
    (status <> 'running' AND lease_token IS NULL AND lease_expires_at_ms IS NULL)
  ),
  CHECK (
    status <> 'completed' OR (continuation_cursor IS NULL AND completed_at_ms IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('failed', 'manual_reconciliation')
    OR (error_code IS NOT NULL AND error_message IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_financial_backfill_batch_users_runnable
  ON admin_financial_history_backfill_batch_users(batch_id, status, ordinal);

CREATE TABLE admin_financial_history_backfill_batch_audit_events (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES admin_financial_history_backfill_batches(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'financial_history.backfill_batch.created',
    'financial_history.backfill_batch.continued'
  )),
  from_status TEXT,
  to_status TEXT NOT NULL,
  batch_control_version INTEGER NOT NULL CHECK (batch_control_version >= 0),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;

CREATE INDEX idx_financial_backfill_batch_audit_batch_time
  ON admin_financial_history_backfill_batch_audit_events(batch_id, occurred_at_ms, id);

CREATE TRIGGER admin_financial_history_backfill_batch_audit_no_update
BEFORE UPDATE ON admin_financial_history_backfill_batch_audit_events
BEGIN SELECT RAISE(ABORT, 'financial history backfill batch audit is immutable'); END;

CREATE TRIGGER admin_financial_history_backfill_batch_audit_no_delete
BEFORE DELETE ON admin_financial_history_backfill_batch_audit_events
BEGIN SELECT RAISE(ABORT, 'financial history backfill batch audit is immutable'); END;

INSERT INTO schema_migrations (version, name, applied_at_ms)
VALUES (57, 'financial_history_backfill_batches', unixepoch('now') * 1000);
