PRAGMA foreign_keys = ON;
CREATE TABLE runtime_settings (
  name TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE panel_rate_windows (
  subject_digest TEXT NOT NULL,
  window_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY(subject_digest, window_ms, kind)
);
CREATE INDEX panel_rate_windows_expiry ON panel_rate_windows(expires_at_ms);
CREATE TABLE stream_timeout_events (
  request_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  occurred_at_ms INTEGER NOT NULL
);
CREATE INDEX stream_timeout_events_account ON stream_timeout_events(account_id, occurred_at_ms);
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES (83,'runtime_settings',CAST(unixepoch('subsec')*1000 AS INTEGER));
