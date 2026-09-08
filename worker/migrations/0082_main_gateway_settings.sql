ALTER TABLE system_settings ADD COLUMN gateway_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(gateway_json));
INSERT INTO schema_migrations (version, name, applied_at_ms)
VALUES (82, 'main_gateway_settings', CAST(unixepoch('subsec') * 1000 AS INTEGER));

CREATE TABLE registration_domain_checks (domain TEXT PRIMARY KEY);
CREATE TRIGGER registration_domain_quota_guard BEFORE INSERT ON registration_domain_checks
WHEN EXISTS (SELECT 1 FROM users WHERE lower(substr(email, instr(email, '@') + 1)) = NEW.domain)
BEGIN
  SELECT RAISE(ABORT, 'EMAIL_DOMAIN_QUOTA_EXCEEDED');
END;

CREATE TABLE system_setting_secrets_expanded (
 settings_id TEXT NOT NULL REFERENCES system_settings(id) ON DELETE CASCADE,
 key TEXT NOT NULL CHECK (key IN ('turnstile_secret_key','tencent_captcha_app_secret_key','tencent_captcha_cloud_secret_id','tencent_captcha_cloud_secret_key','aliyun_captcha_access_key_secret')),
 schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version=1),
 key_version INTEGER NOT NULL CHECK (key_version>0), nonce_b64 TEXT NOT NULL, ciphertext_b64 TEXT NOT NULL,
 updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms>=0), PRIMARY KEY(settings_id,key)
) STRICT;
INSERT INTO system_setting_secrets_expanded SELECT * FROM system_setting_secrets;
DROP TABLE system_setting_secrets;
ALTER TABLE system_setting_secrets_expanded RENAME TO system_setting_secrets;

CREATE TABLE oauth_pending_registrations (
 id TEXT PRIMARY KEY,
 browser_hash TEXT NOT NULL,
 nonce_b64 TEXT NOT NULL,
 ciphertext_b64 TEXT NOT NULL,
 consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 expires_at_ms INTEGER NOT NULL,
 created_at_ms INTEGER NOT NULL,
 UNIQUE(id,consumed)
) STRICT;
CREATE INDEX oauth_pending_registrations_expiry ON oauth_pending_registrations(expires_at_ms);

CREATE TABLE oauth_pending_registration_claims (
 pending_id TEXT PRIMARY KEY,
 consumed INTEGER NOT NULL DEFAULT 1 CHECK(consumed=1),
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 FOREIGN KEY(pending_id,consumed) REFERENCES oauth_pending_registrations(id,consumed) ON DELETE CASCADE
) STRICT;

PRAGMA defer_foreign_keys = ON;
CREATE TABLE oauth_providers_expanded (
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
  advanced_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(advanced_json)),
  CHECK (
    (secret_key_version IS NULL AND secret_nonce_b64 IS NULL AND secret_ciphertext_b64 IS NULL)
    OR
    (secret_key_version IS NOT NULL AND length(secret_nonce_b64) > 0 AND length(secret_ciphertext_b64) > 0)
  )
) STRICT;
INSERT INTO oauth_providers_expanded SELECT *, '{}' FROM oauth_providers;
DROP TABLE oauth_providers;
ALTER TABLE oauth_providers_expanded RENAME TO oauth_providers;
PRAGMA defer_foreign_keys = OFF;

CREATE TABLE oauth_wechat_variants (
 mode TEXT PRIMARY KEY CHECK(mode IN ('open','mp','mobile')),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), client_id TEXT NOT NULL,
 nonce_b64 TEXT NOT NULL, ciphertext_b64 TEXT NOT NULL
) STRICT;
ALTER TABLE oauth_flows ADD COLUMN provider_variant TEXT NOT NULL DEFAULT 'open' CHECK(provider_variant IN ('open','mp','mobile'));

ALTER TABLE payment_config ADD COLUMN load_balance_strategy TEXT NOT NULL DEFAULT 'round_robin' CHECK(load_balance_strategy IN ('round_robin','least_amount'));
ALTER TABLE payment_config ADD COLUMN selection_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_config ADD COLUMN cancel_rate_limit_enabled INTEGER NOT NULL DEFAULT 0 CHECK(cancel_rate_limit_enabled IN (0,1));
ALTER TABLE payment_config ADD COLUMN cancel_rate_limit_max INTEGER NOT NULL DEFAULT 10 CHECK(cancel_rate_limit_max BETWEEN 1 AND 10000);
ALTER TABLE payment_config ADD COLUMN cancel_rate_limit_window INTEGER NOT NULL DEFAULT 1 CHECK(cancel_rate_limit_window BETWEEN 1 AND 10000);
ALTER TABLE payment_config ADD COLUMN cancel_rate_limit_unit TEXT NOT NULL DEFAULT 'day' CHECK(cancel_rate_limit_unit IN ('minute','hour','day'));
ALTER TABLE payment_config ADD COLUMN cancel_rate_limit_window_mode TEXT NOT NULL DEFAULT 'rolling' CHECK(cancel_rate_limit_window_mode IN ('rolling','fixed'));
CREATE INDEX payment_cancel_admission ON payment_orders(user_id,status,updated_at_ms);
