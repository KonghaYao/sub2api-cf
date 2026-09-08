ALTER TABLE account_oauth_refresh_state ADD COLUMN credential_ref TEXT;
ALTER TABLE account_oauth_refresh_state ADD COLUMN credential_key_version INTEGER NOT NULL DEFAULT 0;
UPDATE account_oauth_refresh_state SET
  credential_ref=(SELECT credential_ref FROM accounts WHERE accounts.id=account_oauth_refresh_state.account_id),
  credential_key_version=COALESCE((SELECT s.key_version FROM accounts a JOIN account_secrets s
    ON s.id=a.credential_ref WHERE a.id=account_oauth_refresh_state.account_id),0);
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(94,'account_oauth_refresh_generation',CAST(unixepoch('subsec')*1000 AS INTEGER));
