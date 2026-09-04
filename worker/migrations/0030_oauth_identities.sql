PRAGMA foreign_keys = ON;

-- Provider metadata is control-plane configuration. Secrets are AES-GCM
-- ciphertexts bound to environment/provider/key_version; plaintext never
-- enters D1.
CREATE TABLE oauth_providers (
  provider TEXT PRIMARY KEY
    CHECK (provider IN ('github', 'google', 'linuxdo', 'dingtalk', 'wechat', 'oidc')),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  adapter TEXT NOT NULL
    CHECK (adapter IN ('standard', 'github', 'dingtalk', 'wechat', 'oidc')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  authorization_endpoint TEXT NOT NULL CHECK (length(authorization_endpoint) BETWEEN 1 AND 2048),
  token_endpoint TEXT NOT NULL CHECK (length(token_endpoint) BETWEEN 1 AND 2048),
  userinfo_endpoint TEXT NOT NULL CHECK (length(userinfo_endpoint) BETWEEN 1 AND 2048),
  emails_endpoint TEXT CHECK (emails_endpoint IS NULL OR length(emails_endpoint) BETWEEN 1 AND 2048),
  jwks_endpoint TEXT CHECK (jwks_endpoint IS NULL OR length(jwks_endpoint) BETWEEN 1 AND 2048),
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 512),
  secret_key_version INTEGER CHECK (secret_key_version IS NULL OR secret_key_version > 0),
  secret_nonce_b64 TEXT,
  secret_ciphertext_b64 TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
  allowed_hosts_json TEXT NOT NULL
    CHECK (json_valid(allowed_hosts_json) AND json_type(allowed_hosts_json) = 'array'),
  frontend_callback_path TEXT NOT NULL CHECK (length(frontend_callback_path) BETWEEN 1 AND 2048),
  pkce_enabled INTEGER NOT NULL DEFAULT 1 CHECK (pkce_enabled IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (secret_key_version IS NULL AND secret_nonce_b64 IS NULL AND secret_ciphertext_b64 IS NULL)
    OR
    (secret_key_version IS NOT NULL AND length(secret_nonce_b64) > 0 AND length(secret_ciphertext_b64) > 0)
  ),
  CHECK (
    (adapter = 'oidc' AND jwks_endpoint IS NOT NULL)
    OR adapter <> 'oidc'
  )
) STRICT;

CREATE TABLE oauth_bind_tickets (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
  auth_version INTEGER NOT NULL CHECK (auth_version > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE INDEX idx_oauth_bind_tickets_expiry
  ON oauth_bind_tickets(expires_at_ms, id)
  WHERE consumed_at_ms IS NULL;

CREATE INDEX idx_oauth_bind_tickets_cleanup
  ON oauth_bind_tickets(expires_at_ms, id);

CREATE TABLE oauth_flows (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  provider TEXT NOT NULL REFERENCES oauth_providers(provider) ON DELETE RESTRICT,
  intent TEXT NOT NULL CHECK (intent IN ('login', 'link')),
  state_hash TEXT NOT NULL UNIQUE CHECK (length(state_hash) = 64),
  browser_token_hash TEXT NOT NULL CHECK (length(browser_token_hash) = 64),
  target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  target_session_id TEXT REFERENCES user_sessions(id) ON DELETE CASCADE,
  target_auth_version INTEGER CHECK (target_auth_version IS NULL OR target_auth_version > 0),
  verifier_key_version INTEGER CHECK (verifier_key_version IS NULL OR verifier_key_version > 0),
  verifier_nonce_b64 TEXT,
  verifier_ciphertext_b64 TEXT,
  nonce_hash TEXT CHECK (nonce_hash IS NULL OR length(nonce_hash) = 64),
  redirect_to TEXT NOT NULL CHECK (length(redirect_to) BETWEEN 1 AND 2048),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  CHECK (
    (intent = 'login' AND target_user_id IS NULL AND target_session_id IS NULL AND target_auth_version IS NULL)
    OR
    (intent = 'link' AND target_user_id IS NOT NULL AND target_session_id IS NOT NULL AND target_auth_version IS NOT NULL)
  ),
  CHECK (
    (verifier_key_version IS NULL AND verifier_nonce_b64 IS NULL AND verifier_ciphertext_b64 IS NULL)
    OR
    (verifier_key_version IS NOT NULL AND length(verifier_nonce_b64) > 0 AND length(verifier_ciphertext_b64) > 0)
  )
) STRICT;

CREATE INDEX idx_oauth_flows_expiry
  ON oauth_flows(expires_at_ms, id)
  WHERE consumed_at_ms IS NULL;

CREATE INDEX idx_oauth_flows_cleanup
  ON oauth_flows(expires_at_ms, id);

CREATE INDEX idx_oauth_flows_target
  ON oauth_flows(target_user_id, created_at_ms DESC, id)
  WHERE target_user_id IS NOT NULL;

CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL
    CHECK (provider IN ('github', 'google', 'linuxdo', 'dingtalk', 'wechat', 'oidc')),
  provider_key TEXT NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 2048),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 1024),
  issuer TEXT CHECK (issuer IS NULL OR length(issuer) BETWEEN 1 AND 2048),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      length(metadata_json) <= 16384
      AND json_valid(metadata_json)
      AND json_type(metadata_json) = 'object'
    ),
  verified_at_ms INTEGER CHECK (verified_at_ms IS NULL OR verified_at_ms >= 0),
  last_login_at_ms INTEGER CHECK (last_login_at_ms IS NULL OR last_login_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  UNIQUE(provider, provider_key, provider_subject)
) STRICT;

CREATE INDEX idx_auth_identities_user_provider
  ON auth_identities(user_id, provider, created_at_ms, id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (30, 'oauth_identities', CAST(unixepoch('subsec') * 1000 AS INTEGER));
