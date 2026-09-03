PRAGMA foreign_keys = ON;

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms),
  last_seen_at_ms INTEGER CHECK (last_seen_at_ms IS NULL OR last_seen_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX idx_admin_sessions_user_active
  ON admin_sessions(user_id, expires_at_ms DESC)
  WHERE revoked_at_ms IS NULL;

CREATE TABLE control_idempotency (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  PRIMARY KEY (scope, key_hash)
) STRICT;

CREATE INDEX idx_control_idempotency_expiry
  ON control_idempotency(expires_at_ms, scope, key_hash);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (4, 'control_plane', CAST(unixepoch('subsec') * 1000 AS INTEGER));
