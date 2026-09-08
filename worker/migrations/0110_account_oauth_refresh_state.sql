CREATE TABLE account_oauth_refresh_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  lease_token TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(lease_until_ms >= 0),
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  last_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT
);
CREATE INDEX account_oauth_refresh_due ON account_oauth_refresh_state(next_attempt_at_ms);
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(110,'account_oauth_refresh_state',CAST(unixepoch('subsec')*1000 AS INTEGER));
