PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN password_credential TEXT;
ALTER TABLE users
  ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0);
ALTER TABLE users ADD COLUMN email_verified_at_ms INTEGER
  CHECK (email_verified_at_ms IS NULL OR email_verified_at_ms >= 0);
ALTER TABLE users ADD COLUMN password_changed_at_ms INTEGER
  CHECK (password_changed_at_ms IS NULL OR password_changed_at_ms >= 0);
ALTER TABLE users ADD COLUMN last_login_at_ms INTEGER
  CHECK (last_login_at_ms IS NULL OR last_login_at_ms >= 0);

CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_version INTEGER NOT NULL CHECK (auth_version > 0),
  access_token_hash TEXT NOT NULL UNIQUE CHECK (length(access_token_hash) = 64),
  refresh_token_hash TEXT NOT NULL UNIQUE CHECK (length(refresh_token_hash) = 64),
  previous_refresh_token_hash TEXT UNIQUE
    CHECK (previous_refresh_token_hash IS NULL OR length(previous_refresh_token_hash) = 64),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  access_expires_at_ms INTEGER NOT NULL CHECK (access_expires_at_ms > created_at_ms),
  refresh_expires_at_ms INTEGER NOT NULL CHECK (refresh_expires_at_ms > access_expires_at_ms),
  rotated_at_ms INTEGER CHECK (rotated_at_ms IS NULL OR rotated_at_ms >= created_at_ms),
  last_seen_at_ms INTEGER CHECK (last_seen_at_ms IS NULL OR last_seen_at_ms >= created_at_ms),
  revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  revoke_reason TEXT,
  user_agent TEXT NOT NULL DEFAULT '',
  ip_hash TEXT
    CHECK (ip_hash IS NULL OR length(ip_hash) = 64)
) STRICT;

CREATE INDEX idx_user_sessions_user_active
  ON user_sessions(user_id, refresh_expires_at_ms DESC, id)
  WHERE revoked_at_ms IS NULL;

CREATE INDEX idx_user_sessions_family
  ON user_sessions(family_id, created_at_ms, id);

CREATE TABLE auth_audit_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'blocked')),
  email_hash TEXT CHECK (email_hash IS NULL OR length(email_hash) = 64),
  ip_hash TEXT CHECK (ip_hash IS NULL OR length(ip_hash) = 64),
  session_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;

CREATE INDEX idx_auth_audit_user_time
  ON auth_audit_events(user_id, occurred_at_ms DESC, id);

CREATE INDEX idx_auth_audit_type_time
  ON auth_audit_events(event_type, occurred_at_ms DESC, id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (9, 'user_identity', CAST(unixepoch('subsec') * 1000 AS INTEGER));
