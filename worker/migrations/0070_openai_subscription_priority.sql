PRAGMA foreign_keys = ON;

DROP TRIGGER validate_account_provider_insert;
DROP TRIGGER validate_account_provider_update;

CREATE TRIGGER validate_account_provider_insert
BEFORE INSERT ON accounts
FOR EACH ROW
WHEN NOT (
  (NEW.platform = 'openai' AND NEW.protocol = 'openai' AND NEW.auth_scheme = 'bearer')
  OR (NEW.platform = 'anthropic' AND NEW.protocol = 'anthropic' AND NEW.auth_scheme = 'x-api-key')
  OR (NEW.platform = 'gemini' AND NEW.protocol = 'gemini' AND NEW.auth_scheme = 'x-goog-api-key')
  OR (NEW.platform = 'codex' AND NEW.protocol = 'codex' AND NEW.auth_scheme = 'bearer')
)
OR EXISTS (SELECT 1 FROM json_each(NEW.provider_config_json) WHERE key NOT IN ('account_id', 'subscription_plan'))
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
)
OR EXISTS (SELECT 1 FROM json_each(NEW.provider_config_json) WHERE key NOT IN ('account_id', 'subscription_plan'))
OR (NEW.platform <> 'codex' AND json_type(NEW.provider_config_json, '$.account_id') IS NOT NULL)
OR (NEW.platform <> 'openai' AND json_type(NEW.provider_config_json, '$.subscription_plan') IS NOT NULL)
OR (json_type(NEW.provider_config_json, '$.subscription_plan') IS NOT NULL AND (
  json_type(NEW.provider_config_json, '$.subscription_plan') <> 'text'
  OR length(json_extract(NEW.provider_config_json, '$.subscription_plan')) NOT BETWEEN 1 AND 64
  OR json_extract(NEW.provider_config_json, '$.subscription_plan') <> lower(trim(json_extract(NEW.provider_config_json, '$.subscription_plan')))
))
BEGIN SELECT RAISE(ABORT, 'invalid_account_provider'); END;

UPDATE system_settings
   SET public_json = json_set(
     public_json,
     '$.openai_advanced_scheduler_subscription_priority_enabled',
     json('false')
   )
 WHERE id = 'global'
   AND json_type(public_json, '$.openai_advanced_scheduler_subscription_priority_enabled') IS NULL;

CREATE TRIGGER bump_gateway_revision_subscription_priority_setting
AFTER UPDATE OF public_json ON system_settings
WHEN json_extract(NEW.public_json, '$.openai_advanced_scheduler_subscription_priority_enabled')
       IS NOT json_extract(OLD.public_json, '$.openai_advanced_scheduler_subscription_priority_enabled')
BEGIN
  UPDATE gateway_config_revision
     SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms
   WHERE singleton = 1;
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (70, 'openai_subscription_priority', CAST(unixepoch('subsec') * 1000 AS INTEGER));
