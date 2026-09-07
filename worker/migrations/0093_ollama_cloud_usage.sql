CREATE TABLE ollama_cloud_usage_groups (
 group_key TEXT PRIMARY KEY,
 nonce_b64 TEXT,
 ciphertext_b64 TEXT,
 auto_refresh INTEGER NOT NULL DEFAULT 0 CHECK(auto_refresh IN (0,1)),
 snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
 control_version INTEGER NOT NULL DEFAULT 0,
 last_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
 lease_until_ms INTEGER NOT NULL DEFAULT 0,
 updated_at_ms INTEGER NOT NULL,
 CHECK((nonce_b64 IS NULL AND ciphertext_b64 IS NULL) OR (length(nonce_b64)>0 AND length(ciphertext_b64)>0))
) STRICT;
CREATE TABLE ollama_cloud_usage_accounts (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 group_key TEXT NOT NULL REFERENCES ollama_cloud_usage_groups(group_key) ON DELETE CASCADE
) STRICT;
CREATE INDEX ollama_usage_groups_due ON ollama_cloud_usage_groups(auto_refresh,lease_until_ms,last_attempt_at_ms);
CREATE INDEX ollama_usage_account_group ON ollama_cloud_usage_accounts(group_key);
INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(93,'ollama_cloud_usage',CAST(unixepoch('subsec')*1000 AS INTEGER));
