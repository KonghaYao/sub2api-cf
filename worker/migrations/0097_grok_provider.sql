PRAGMA foreign_keys = ON;
-- Preserve the referenced accounts table and every provider column exactly.
CREATE TABLE migration_0097_provider_columns AS SELECT id,protocol,auth_scheme FROM accounts;
DROP TRIGGER validate_account_provider_insert;
DROP TRIGGER validate_account_provider_update;
DROP TRIGGER bump_gateway_revision_account_update;
ALTER TABLE accounts DROP COLUMN protocol;
ALTER TABLE accounts DROP COLUMN auth_scheme;
ALTER TABLE accounts ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai' CHECK (protocol IN ('openai','anthropic','gemini','codex'));
ALTER TABLE accounts ADD COLUMN auth_scheme TEXT NOT NULL DEFAULT 'bearer' CHECK (auth_scheme IN ('bearer','x-api-key','x-goog-api-key'));
UPDATE accounts SET protocol=(SELECT protocol FROM migration_0097_provider_columns old WHERE old.id=accounts.id), auth_scheme=(SELECT auth_scheme FROM migration_0097_provider_columns old WHERE old.id=accounts.id);
DROP TABLE migration_0097_provider_columns;
-- Cross-column matrix remains enforced by insert/update triggers. Antigravity
-- is schema-ready; application routing only exposes it once its adapter exists.
CREATE TRIGGER validate_account_provider_insert
BEFORE INSERT ON accounts
FOR EACH ROW
WHEN NOT (
  (NEW.platform = 'openai' AND NEW.protocol = 'openai' AND NEW.auth_scheme = 'bearer')
  OR (NEW.platform = 'anthropic' AND NEW.protocol = 'anthropic' AND NEW.auth_scheme = 'x-api-key')
  OR (NEW.platform = 'gemini' AND NEW.protocol = 'gemini' AND NEW.auth_scheme = 'x-goog-api-key')
  OR (NEW.platform = 'codex' AND NEW.protocol = 'codex' AND NEW.auth_scheme = 'bearer')
  OR (NEW.platform = 'grok' AND NEW.protocol = 'openai' AND NEW.auth_scheme = 'bearer')
  OR (NEW.platform = 'antigravity' AND NEW.protocol = 'gemini' AND NEW.auth_scheme = 'bearer')
)
OR EXISTS (SELECT 1 FROM json_each(NEW.provider_config_json) WHERE key NOT IN ('account_id', 'subscription_plan', 'use_default_base_url', 'project_id'))
OR (json_type(NEW.provider_config_json, '$.use_default_base_url') IS NOT NULL AND (NEW.platform <> 'grok' OR json_type(NEW.provider_config_json, '$.use_default_base_url') NOT IN ('true','false')))
OR (json_type(NEW.provider_config_json, '$.project_id') IS NOT NULL AND (NEW.platform <> 'antigravity' OR json_type(NEW.provider_config_json, '$.project_id') <> 'text' OR length(json_extract(NEW.provider_config_json, '$.project_id')) NOT BETWEEN 1 AND 256))
OR (NEW.platform = 'antigravity' AND json_type(NEW.provider_config_json, '$.project_id') IS NULL)
OR (NEW.platform <> 'codex' AND json_type(NEW.provider_config_json, '$.account_id') IS NOT NULL)
OR (NEW.platform <> 'openai' AND json_type(NEW.provider_config_json, '$.subscription_plan') IS NOT NULL)
OR (json_type(NEW.provider_config_json, '$.subscription_plan') IS NOT NULL AND (
  json_type(NEW.provider_config_json, '$.subscription_plan') <> 'text'
  OR length(json_extract(NEW.provider_config_json, '$.subscription_plan')) NOT BETWEEN 1 AND 64
  OR json_extract(NEW.provider_config_json, '$.subscription_plan') <> lower(trim(json_extract(NEW.provider_config_json, '$.subscription_plan')))
))
BEGIN SELECT RAISE(ABORT, 'invalid_account_provider'); END;

CREATE TRIGGER validate_account_provider_update
BEFORE UPDATE OF platform, protocol, auth_scheme, provider_config_json ON accounts
FOR EACH ROW
WHEN NOT (
  (NEW.platform = 'openai' AND NEW.protocol = 'openai' AND NEW.auth_scheme = 'bearer')
  OR (NEW.platform = 'anthropic' AND NEW.protocol = 'anthropic' AND NEW.auth_scheme = 'x-api-key')
  OR (NEW.platform = 'gemini' AND NEW.protocol = 'gemini' AND NEW.auth_scheme = 'x-goog-api-key')
  OR (NEW.platform = 'codex' AND NEW.protocol = 'codex' AND NEW.auth_scheme = 'bearer')
  OR (NEW.platform = 'grok' AND NEW.protocol = 'openai' AND NEW.auth_scheme = 'bearer')
  OR (NEW.platform = 'antigravity' AND NEW.protocol = 'gemini' AND NEW.auth_scheme = 'bearer')
)
OR EXISTS (SELECT 1 FROM json_each(NEW.provider_config_json) WHERE key NOT IN ('account_id', 'subscription_plan', 'use_default_base_url', 'project_id'))
OR (json_type(NEW.provider_config_json, '$.use_default_base_url') IS NOT NULL AND (NEW.platform <> 'grok' OR json_type(NEW.provider_config_json, '$.use_default_base_url') NOT IN ('true','false')))
OR (json_type(NEW.provider_config_json, '$.project_id') IS NOT NULL AND (NEW.platform <> 'antigravity' OR json_type(NEW.provider_config_json, '$.project_id') <> 'text' OR length(json_extract(NEW.provider_config_json, '$.project_id')) NOT BETWEEN 1 AND 256))
OR (NEW.platform = 'antigravity' AND json_type(NEW.provider_config_json, '$.project_id') IS NULL)
OR (NEW.platform <> 'codex' AND json_type(NEW.provider_config_json, '$.account_id') IS NOT NULL)
OR (NEW.platform <> 'openai' AND json_type(NEW.provider_config_json, '$.subscription_plan') IS NOT NULL)
OR (json_type(NEW.provider_config_json, '$.subscription_plan') IS NOT NULL AND (
  json_type(NEW.provider_config_json, '$.subscription_plan') <> 'text'
  OR length(json_extract(NEW.provider_config_json, '$.subscription_plan')) NOT BETWEEN 1 AND 64
  OR json_extract(NEW.provider_config_json, '$.subscription_plan') <> lower(trim(json_extract(NEW.provider_config_json, '$.subscription_plan')))
))
BEGIN SELECT RAISE(ABORT, 'invalid_account_provider'); END;

CREATE TRIGGER bump_gateway_revision_account_update
AFTER UPDATE OF platform, credential_ref, enabled, max_concurrency, protocol,
  base_url, auth_scheme, provider_config_json, image_adapter, credential_kind,
  config_version, health_status ON accounts
BEGIN
  UPDATE gateway_config_revision
     SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms
   WHERE singleton = 1;
END;

-- Preserve explicit composite routing while admitting the new native platforms.
CREATE TABLE migration_0097_composite_platforms AS SELECT id,target_platform FROM composite_model_routes;
ALTER TABLE composite_model_routes DROP COLUMN target_platform;
ALTER TABLE composite_model_routes ADD COLUMN target_platform TEXT NOT NULL DEFAULT 'openai' CHECK(target_platform IN('openai','anthropic','gemini','codex','grok','antigravity'));
UPDATE composite_model_routes SET target_platform=(SELECT target_platform FROM migration_0097_composite_platforms old WHERE old.id=composite_model_routes.id);
DROP TABLE migration_0097_composite_platforms;

INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(97,'grok_provider',CAST(unixepoch('subsec')*1000 AS INTEGER));
