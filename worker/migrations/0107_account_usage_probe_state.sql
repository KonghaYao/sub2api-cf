CREATE TABLE account_usage_probe_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_attempt_at_ms INTEGER NOT NULL,
  lease_token TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0
);
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(107,'account_usage_probe_state',CAST(unixepoch('subsec')*1000 AS INTEGER));
