PRAGMA foreign_keys = ON;

-- This ledger intentionally has no foreign key for target_user_id. User and
-- group permission rows cascade away with their resources, while the security
-- audit remains available after a target account has been deleted.
CREATE TABLE admin_user_group_access_audit_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_session_id TEXT NOT NULL CHECK (length(actor_session_id) BETWEEN 1 AND 512),
  action TEXT NOT NULL CHECK (action IN (
    'user.group_access.create',
    'user.group_access.replace'
  )),
  target_user_id TEXT NOT NULL CHECK (length(target_user_id) BETWEEN 1 AND 128),
  control_version INTEGER NOT NULL CHECK (control_version >= 0),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  metadata_json TEXT NOT NULL CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) = 'object'
      AND length(metadata_json) <= 16384
  ),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  UNIQUE(idempotency_key_hash, action, target_user_id)
) STRICT;

CREATE INDEX idx_admin_user_group_access_audit_target_time
  ON admin_user_group_access_audit_events(target_user_id, occurred_at_ms DESC, id DESC);
CREATE INDEX idx_admin_user_group_access_audit_actor_time
  ON admin_user_group_access_audit_events(actor_user_id, occurred_at_ms DESC, id DESC);

CREATE TRIGGER prevent_admin_user_group_access_audit_update
BEFORE UPDATE ON admin_user_group_access_audit_events
BEGIN
  SELECT RAISE(ABORT, 'admin_user_group_access_audit_immutable');
END;

CREATE TRIGGER prevent_admin_user_group_access_audit_delete
BEFORE DELETE ON admin_user_group_access_audit_events
BEGIN
  SELECT RAISE(ABORT, 'admin_user_group_access_audit_immutable');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (74, 'user_group_access_audit', CAST(unixepoch('subsec') * 1000 AS INTEGER));
