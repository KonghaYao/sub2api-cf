PRAGMA foreign_keys = ON;

CREATE TABLE admin_channel_audit_events (
  id TEXT NOT NULL PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('channel.create', 'channel.update', 'channel.delete')),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
  resource_version INTEGER NOT NULL
    CHECK (resource_version BETWEEN 0 AND 9007199254740991),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  changed_fields_json TEXT NOT NULL CHECK (
    json_valid(changed_fields_json) AND json_type(changed_fields_json) = 'array'
  ),
  occurred_at_ms INTEGER NOT NULL
    CHECK (occurred_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE INDEX idx_admin_channel_audit_resource_time
  ON admin_channel_audit_events(resource_id, occurred_at_ms DESC, id DESC);

CREATE INDEX idx_admin_channel_audit_actor_time
  ON admin_channel_audit_events(actor_user_id, occurred_at_ms DESC, id DESC);

CREATE TRIGGER prevent_admin_channel_audit_update
BEFORE UPDATE ON admin_channel_audit_events
BEGIN
  SELECT RAISE(ABORT, 'admin_channel_audit_immutable');
END;

CREATE TRIGGER prevent_admin_channel_audit_delete
BEFORE DELETE ON admin_channel_audit_events
BEGIN
  SELECT RAISE(ABORT, 'admin_channel_audit_immutable');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (51, 'channel_audit', CAST(unixepoch('subsec') * 1000 AS INTEGER));
