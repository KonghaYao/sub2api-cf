ALTER TABLE account_initialization_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'openai_privacy'
  CHECK(kind IN ('openai_privacy','openai_responses'));
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(106,'account_initialization_kind',CAST(unixepoch('subsec')*1000 AS INTEGER));
