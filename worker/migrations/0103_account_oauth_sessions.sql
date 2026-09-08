CREATE TABLE account_oauth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL,
  nonce_b64 TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  proxy_id TEXT,
  lease_token TEXT,
  lease_expires_at_ms INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms)
) STRICT;
CREATE INDEX account_oauth_sessions_expiry ON account_oauth_sessions(expires_at_ms);
CREATE INDEX account_oauth_sessions_owner ON account_oauth_sessions(user_id);
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(103,'account_oauth_sessions',CAST(unixepoch('subsec')*1000 AS INTEGER));
