PRAGMA foreign_keys = ON;

CREATE TABLE system_settings (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  public_json TEXT NOT NULL CHECK (
    json_valid(public_json)
    AND json_type(public_json, '$.site_name') = 'text'
    AND json_type(public_json, '$.registration_enabled') IN ('true', 'false')
    AND json_type(public_json, '$.email_verification_enabled') IN ('true', 'false')
    AND json_type(public_json, '$.turnstile_enabled') IN ('true', 'false')
    AND json_type(public_json, '$.turnstile_site_key') = 'text'
    AND json_type(public_json, '$.turnstile_secret_key') IS NULL
  ),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE TABLE system_setting_secrets (
  settings_id TEXT NOT NULL REFERENCES system_settings(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (key IN ('turnstile_secret_key')),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  nonce_b64 TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (settings_id, key)
) STRICT;

CREATE TABLE admin_settings_audit_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = 'system_settings.update'),
  resource_id TEXT NOT NULL CHECK (resource_id = 'global'),
  resource_version INTEGER NOT NULL CHECK (resource_version > 0),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  changed_fields_json TEXT NOT NULL CHECK (json_valid(changed_fields_json)),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;

CREATE INDEX idx_admin_settings_audit_actor_time
  ON admin_settings_audit_events(actor_user_id, occurred_at_ms DESC, id);

INSERT INTO system_settings (id, schema_version, control_version, public_json, updated_at_ms)
VALUES (
  'global',
  1,
  0,
  json_object(
    'site_name', 'Sub2API',
    'registration_enabled', json('false'),
    'email_verification_enabled', json('false'),
    'turnstile_enabled', json('false'),
    'turnstile_site_key', ''
  ),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (10, 'settings', CAST(unixepoch('subsec') * 1000 AS INTEGER));
