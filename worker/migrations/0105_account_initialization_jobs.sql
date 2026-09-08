CREATE TABLE account_initialization_jobs (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  credential_key_version INTEGER NOT NULL CHECK(credential_key_version > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','superseded')),
  lease_token TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  next_dispatch_at_ms INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_mode TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX account_initialization_due ON account_initialization_jobs(status,next_dispatch_at_ms,lease_until_ms);
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(105,'account_initialization_jobs',CAST(unixepoch('subsec')*1000 AS INTEGER));
