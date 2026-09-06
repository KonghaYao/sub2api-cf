PRAGMA foreign_keys = ON;

CREATE TABLE admin_account_operation_guards (
  scope TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  action TEXT NOT NULL
    CHECK (action IN ('account.enable', 'account.disable', 'account.health_probe.queue')),
  target_count INTEGER NOT NULL CHECK (target_count BETWEEN 0 AND 25),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  PRIMARY KEY(scope, idempotency_key_hash)
) STRICT;

CREATE TRIGGER prevent_admin_account_operation_guard_update
BEFORE UPDATE ON admin_account_operation_guards
BEGIN
  SELECT RAISE(ABORT, 'admin_account_operation_guard_immutable');
END;

CREATE TRIGGER prevent_admin_account_operation_guard_delete
BEFORE DELETE ON admin_account_operation_guards
BEGIN
  SELECT RAISE(ABORT, 'admin_account_operation_guard_immutable');
END;

CREATE TABLE admin_account_audit_events (
  id TEXT NOT NULL PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_session_id TEXT NOT NULL CHECK (length(actor_session_id) BETWEEN 1 AND 512),
  action TEXT NOT NULL
    CHECK (action IN ('account.enable', 'account.disable', 'account.health_probe.queue')),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
  resource_version INTEGER NOT NULL
    CHECK (resource_version BETWEEN 0 AND 9007199254740991),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  metadata_json TEXT NOT NULL CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) = 'object'
  ),
  occurred_at_ms INTEGER NOT NULL
    CHECK (occurred_at_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE(idempotency_key_hash, action, resource_id)
) STRICT;

CREATE INDEX idx_admin_account_audit_resource_time
  ON admin_account_audit_events(resource_id, occurred_at_ms DESC, id DESC);

CREATE INDEX idx_admin_account_audit_actor_time
  ON admin_account_audit_events(actor_user_id, occurred_at_ms DESC, id DESC);

CREATE TRIGGER prevent_admin_account_audit_update
BEFORE UPDATE ON admin_account_audit_events
BEGIN
  SELECT RAISE(ABORT, 'admin_account_audit_immutable');
END;

CREATE TRIGGER prevent_admin_account_audit_delete
BEFORE DELETE ON admin_account_audit_events
BEGIN
  SELECT RAISE(ABORT, 'admin_account_audit_immutable');
END;

-- Pool fan-out is resumed by Queue one bounded page at a time. The cursor is
-- durable on the existing probe outbox so a lost continuation is recovered by Cron.
ALTER TABLE account_health_probes
  ADD COLUMN pool_sync_cursor_json TEXT CHECK (
    pool_sync_cursor_json IS NULL OR (
      json_valid(pool_sync_cursor_json)
      AND json_type(pool_sync_cursor_json) = 'object'
      AND json_type(pool_sync_cursor_json, '$.group_id') = 'text'
      AND json_type(pool_sync_cursor_json, '$.model_id') = 'text'
      AND json_type(pool_sync_cursor_json, '$.endpoint') = 'text'
    )
  );

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (58, 'account_operations', CAST(unixepoch('subsec') * 1000 AS INTEGER));
