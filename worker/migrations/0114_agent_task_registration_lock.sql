CREATE TABLE account_agent_task_registration (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  lease_token TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(lease_until_ms>=0)
);
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(114,'agent_task_registration_lock',CAST(unixepoch('subsec')*1000 AS INTEGER));
