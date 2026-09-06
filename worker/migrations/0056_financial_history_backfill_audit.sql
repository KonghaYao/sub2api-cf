PRAGMA foreign_keys = ON;

CREATE TABLE admin_financial_history_backfill_audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_session_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN (
    'financial_history.backfill.progress', 'financial_history.backfill.completed',
    'financial_history.backfill.blocked', 'financial_history.backfill.failed'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('recorded', 'succeeded', 'blocked', 'failed')),
  snapshot_state_version INTEGER CHECK (snapshot_state_version IS NULL OR snapshot_state_version >= 0),
  snapshot_high_water_sequence INTEGER CHECK (
    snapshot_high_water_sequence IS NULL OR snapshot_high_water_sequence >= 1
  ),
  snapshot_ledger_count INTEGER CHECK (snapshot_ledger_count IS NULL OR snapshot_ledger_count >= 1),
  snapshot_digest TEXT CHECK (
    snapshot_digest IS NULL OR (length(snapshot_digest) = 64 AND snapshot_digest = lower(snapshot_digest))
  ),
  ledger_entries_scanned INTEGER NOT NULL CHECK (ledger_entries_scanned >= 0),
  financial_events_verified INTEGER NOT NULL CHECK (financial_events_verified >= 0),
  pages_scanned INTEGER NOT NULL CHECK (pages_scanned >= 0),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  CHECK (
    (snapshot_state_version IS NULL AND snapshot_high_water_sequence IS NULL
      AND snapshot_ledger_count IS NULL AND snapshot_digest IS NULL)
    OR
    (snapshot_state_version IS NOT NULL AND snapshot_high_water_sequence IS NOT NULL
      AND snapshot_ledger_count IS NOT NULL AND snapshot_digest IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_financial_backfill_audit_target_time
  ON admin_financial_history_backfill_audit_events(target_user_id, occurred_at_ms DESC);

CREATE TRIGGER admin_financial_history_backfill_audit_no_update
BEFORE UPDATE ON admin_financial_history_backfill_audit_events
BEGIN SELECT RAISE(ABORT, 'financial history backfill audit is immutable'); END;

CREATE TRIGGER admin_financial_history_backfill_audit_no_delete
BEFORE DELETE ON admin_financial_history_backfill_audit_events
BEGIN SELECT RAISE(ABORT, 'financial history backfill audit is immutable'); END;

INSERT INTO schema_migrations (version, name, applied_at_ms)
VALUES (56, 'financial_history_backfill_audit', unixepoch('now') * 1000);
