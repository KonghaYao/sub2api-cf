-- Restore old original-form accounts that already declare a model whitelist but
-- have no Worker capability rows. Never override an explicit mode or capability
-- configuration. Empty/absent mappings cannot prove the original write intent.
UPDATE accounts
SET ui_config_json = json_set(ui_config_json, '$.original_model_routing', json('true')),
    config_version = config_version + 1,
    control_version = control_version + 1
WHERE json_type(ui_config_json, '$.original_model_routing') IS NULL
  AND json_type(ui_config_json, '$.credentials.model_mapping') = 'object'
  AND EXISTS (
    SELECT 1 FROM json_each(json_extract(accounts.ui_config_json, '$.credentials.model_mapping')) entry
    WHERE entry.type = 'text' AND length(entry.key) > 0
  )
  AND NOT EXISTS (SELECT 1 FROM account_models am WHERE am.account_id = accounts.id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (82, 'original_account_model_routing', CAST(unixepoch('subsec') * 1000 AS INTEGER));
