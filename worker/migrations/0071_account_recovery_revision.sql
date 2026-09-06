PRAGMA foreign_keys = ON;

-- A reset is a distinct administrative recovery signal. Health revisions
-- advance for normal probes, so pool state must use this separate monotonic
-- marker before it clears a local cooldown or failure count.
ALTER TABLE accounts
  ADD COLUMN recovery_revision INTEGER NOT NULL DEFAULT 0
    CHECK (recovery_revision >= 0);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (71, 'account_recovery_revision', CAST(unixepoch('subsec') * 1000 AS INTEGER));
