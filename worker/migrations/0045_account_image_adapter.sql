PRAGMA foreign_keys = ON;

ALTER TABLE accounts
  ADD COLUMN image_adapter TEXT NOT NULL DEFAULT 'direct_images'
  CHECK (image_adapter IN ('direct_images', 'responses_image_tool'));

ALTER TABLE accounts
  ADD COLUMN credential_kind TEXT NOT NULL DEFAULT 'api_key'
  CHECK (credential_kind IN ('api_key', 'oauth', 'setup_token'));

-- The pre-v0.24 Worker represented ChatGPT-backed OAuth accounts as the Codex
-- platform and always sent their image requests through the Responses tool.
-- Preserve that behavior while making future routing explicit.
UPDATE accounts
   SET image_adapter = 'responses_image_tool', credential_kind = 'oauth'
 WHERE platform = 'codex';

DROP TRIGGER bump_gateway_revision_account_update;
CREATE TRIGGER bump_gateway_revision_account_update
AFTER UPDATE OF platform, credential_ref, enabled, max_concurrency, protocol,
  base_url, auth_scheme, provider_config_json, image_adapter, credential_kind,
  config_version, health_status ON accounts
BEGIN
  UPDATE gateway_config_revision
     SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms
   WHERE singleton = 1;
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (45, 'account_image_adapter', CAST(unixepoch('subsec') * 1000 AS INTEGER));
