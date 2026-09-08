ALTER TABLE account_usage_probe_state ADD COLUMN response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json));
ALTER TABLE account_usage_probe_state ADD COLUMN error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json));
ALTER TABLE account_usage_probe_state ADD COLUMN cache_until_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account_usage_probe_state ADD COLUMN cache_key TEXT;
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(108,'account_usage_response_cache',CAST(unixepoch('subsec')*1000 AS INTEGER));
