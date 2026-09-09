-- Tighten legacy original-form support to the account's declared mapping instead of
-- treating every existing group model as supported. Current account writes materialize
-- mappings into account_models; this branch remains only for pre-materialization rows.
DROP VIEW group_model_account_support;

CREATE VIEW group_model_account_support AS
SELECT ag.group_id, am.model_id, a.id AS account_id
  FROM account_groups ag
  JOIN accounts a ON a.id = ag.account_id
  JOIN account_models am ON am.account_id = a.id
  JOIN "groups" g ON g.id = ag.group_id
  JOIN models m ON m.id = am.model_id
 WHERE a.enabled = 1
   AND (am.chat_completions = 1 OR am.responses = 1 OR am.embeddings = 1 OR am.image_generation = 1)
   AND (g.platform = 'composite' OR g.platform = m.platform)
UNION
SELECT ag.group_id, gm.model_id, a.id AS account_id
  FROM account_groups ag
  JOIN accounts a ON a.id = ag.account_id
  JOIN group_models gm ON gm.group_id = ag.group_id
  JOIN "groups" g ON g.id = ag.group_id
  JOIN models m ON m.id = gm.model_id
  LEFT JOIN json_each(
    CASE WHEN json_type(a.ui_config_json, '$.credentials.model_mapping') = 'object'
      THEN json_extract(a.ui_config_json, '$.credentials.model_mapping') ELSE '{}' END
  ) mapping ON 1
 WHERE a.enabled = 1
   AND json_extract(a.ui_config_json, '$.original_model_routing') = 1
   AND NOT EXISTS (SELECT 1 FROM account_models existing WHERE existing.account_id = a.id)
   AND a.platform = m.platform
   AND (g.platform = 'composite' OR g.platform = m.platform)
   AND (
     (
       a.platform IN ('openai', 'codex')
       AND CASE
         WHEN json_type(a.ui_config_json, '$.extra.openai_passthrough') IN ('true', 'false')
           THEN json_extract(a.ui_config_json, '$.extra.openai_passthrough')
         ELSE json_type(a.ui_config_json, '$.extra.openai_oauth_passthrough') = 'true'
       END
     )
     OR (
       NOT EXISTS (
         SELECT 1 FROM json_each(
           CASE WHEN json_type(a.ui_config_json, '$.credentials.model_mapping') = 'object'
             THEN json_extract(a.ui_config_json, '$.credentials.model_mapping') ELSE '{}' END
         ) configured_mapping
         WHERE configured_mapping.type = 'text'
       )
       AND NOT (
         a.platform IN ('openai', 'codex')
         AND a.credential_kind = 'oauth'
         AND (
           lower(trim(json_extract(
             '[' || replace(json_quote(trim(COALESCE(gm.upstream_name_override, m.upstream_name))), '/', '","') || ']',
             '$[#-1]'
           ))) IN ('k3', 'k3-256k')
           OR EXISTS (
             SELECT 1 FROM json_each(
               '["deepseek-","glm-","kimi-","moonshot-","qwen-","qwen2-","qwen3-","qwen4-","qwq-","minimax-","gemini-","gemma-","grok-","doubao-","hunyuan-","llama-","llama2-","llama3-","meta-llama","mistral-","mixtral-","baichuan-","ernie-","step-","seed-","yi-"]'
             ) foreign_prefix
             WHERE substr(
               lower(trim(json_extract(
                 '[' || replace(json_quote(trim(COALESCE(gm.upstream_name_override, m.upstream_name))), '/', '","') || ']',
                 '$[#-1]'
               ))),
               1,
               length(foreign_prefix.value)
             ) = foreign_prefix.value
           )
         )
       )
     )
     OR (
       mapping.type = 'text'
       AND (
         mapping.key = trim(COALESCE(gm.upstream_name_override, m.upstream_name))
         OR (
           substr(mapping.key, -1) = '*'
           AND substr(trim(COALESCE(gm.upstream_name_override, m.upstream_name)), 1, length(mapping.key) - 1)
             = substr(mapping.key, 1, length(mapping.key) - 1)
         )
         OR (
           a.platform IN ('gemini', 'antigravity')
           AND trim(COALESCE(gm.upstream_name_override, m.upstream_name)) = 'gemini-3.1-pro-preview-customtools'
           AND (
             mapping.key = 'gemini-3.1-pro-preview'
             OR (
               substr(mapping.key, -1) = '*'
               AND substr('gemini-3.1-pro-preview', 1, length(mapping.key) - 1)
                 = substr(mapping.key, 1, length(mapping.key) - 1)
             )
           )
         )
       )
     )
   );

-- The original triggers restored every model for a legacy account. Recreate the
-- affected triggers so restoration is always guarded by the corrected projection.
DROP TRIGGER sync_group_models_account_group_insert;
CREATE TRIGGER sync_group_models_account_group_insert
AFTER INSERT ON account_groups
BEGIN
  INSERT INTO group_models (
    group_id, model_id, enabled, catalog_visible, sort_order,
    max_output_tokens, default_max_output_tokens, disabled_by_account_sync,
    created_at_ms, updated_at_ms
  )
  SELECT support.group_id, support.model_id, 1, 1, 0, 65536, 32768, 0,
         CAST(unixepoch('subsec') * 1000 AS INTEGER),
         CAST(unixepoch('subsec') * 1000 AS INTEGER)
    FROM group_model_account_support support
   WHERE support.group_id = NEW.group_id
     AND support.account_id = NEW.account_id
  ON CONFLICT(group_id, model_id) DO UPDATE SET
    enabled = 1,
    disabled_by_account_sync = 0,
    control_version = group_models.control_version + 1,
    updated_at_ms = excluded.updated_at_ms
  WHERE group_models.disabled_by_account_sync = 1;

  UPDATE group_models
     SET enabled = 1,
         disabled_by_account_sync = 0,
         control_version = control_version + 1,
         updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
   WHERE disabled_by_account_sync = 1
     AND group_id = NEW.group_id
     AND EXISTS (
       SELECT 1 FROM group_model_account_support support
        WHERE support.group_id = group_models.group_id
          AND support.model_id = group_models.model_id
     );
END;

DROP TRIGGER sync_group_models_account_enabled;
CREATE TRIGGER sync_group_models_account_enabled
AFTER UPDATE OF enabled ON accounts
WHEN NEW.enabled <> OLD.enabled
BEGIN
  UPDATE group_models
     SET enabled = 0,
         disabled_by_account_sync = 1,
         control_version = control_version + 1,
         updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
   WHERE NEW.enabled = 0
     AND enabled = 1
     AND group_id IN (SELECT group_id FROM account_groups WHERE account_id = NEW.id)
     AND NOT EXISTS (
       SELECT 1 FROM group_model_account_support support
        WHERE support.group_id = group_models.group_id
          AND support.model_id = group_models.model_id
     );

  INSERT INTO group_models (
    group_id, model_id, enabled, catalog_visible, sort_order,
    max_output_tokens, default_max_output_tokens, disabled_by_account_sync,
    created_at_ms, updated_at_ms
  )
  SELECT support.group_id, support.model_id, 1, 1, 0, 65536, 32768, 0,
         CAST(unixepoch('subsec') * 1000 AS INTEGER),
         CAST(unixepoch('subsec') * 1000 AS INTEGER)
    FROM group_model_account_support support
   WHERE NEW.enabled = 1
     AND support.account_id = NEW.id
  ON CONFLICT(group_id, model_id) DO UPDATE SET
    enabled = 1,
    disabled_by_account_sync = 0,
    control_version = group_models.control_version + 1,
    updated_at_ms = excluded.updated_at_ms
  WHERE group_models.disabled_by_account_sync = 1;

  UPDATE group_models
     SET enabled = 1,
         disabled_by_account_sync = 0,
         control_version = control_version + 1,
         updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
   WHERE NEW.enabled = 1
     AND disabled_by_account_sync = 1
     AND group_id IN (SELECT group_id FROM account_groups WHERE account_id = NEW.id)
     AND EXISTS (
       SELECT 1 FROM group_model_account_support support
        WHERE support.group_id = group_models.group_id
          AND support.model_id = group_models.model_id
     );
END;

DROP TRIGGER sync_group_models_original_routing;
CREATE TRIGGER sync_group_models_original_routing
AFTER UPDATE OF ui_config_json ON accounts
WHEN COALESCE(json_extract(NEW.ui_config_json, '$.original_model_routing'), 0)
       <> COALESCE(json_extract(OLD.ui_config_json, '$.original_model_routing'), 0)
  OR (
    (COALESCE(json_extract(NEW.ui_config_json, '$.original_model_routing'), 0) = 1
      OR COALESCE(json_extract(OLD.ui_config_json, '$.original_model_routing'), 0) = 1)
    AND COALESCE(json_extract(NEW.ui_config_json, '$.credentials.model_mapping'), '{}')
        <> COALESCE(json_extract(OLD.ui_config_json, '$.credentials.model_mapping'), '{}')
  )
BEGIN
  UPDATE group_models
     SET enabled = 0,
         disabled_by_account_sync = 1,
         control_version = control_version + 1,
         updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
   WHERE enabled = 1
     AND group_id IN (SELECT group_id FROM account_groups WHERE account_id = NEW.id)
     AND NOT EXISTS (
       SELECT 1 FROM group_model_account_support support
        WHERE support.group_id = group_models.group_id
          AND support.model_id = group_models.model_id
     );

  UPDATE group_models
     SET enabled = 1,
         disabled_by_account_sync = 0,
         control_version = control_version + 1,
         updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
   WHERE NEW.enabled = 1
     AND disabled_by_account_sync = 1
     AND group_id IN (SELECT group_id FROM account_groups WHERE account_id = NEW.id)
     AND EXISTS (
       SELECT 1 FROM group_model_account_support support
        WHERE support.group_id = group_models.group_id
          AND support.model_id = group_models.model_id
     );
END;

CREATE TRIGGER sync_group_models_upstream_override
AFTER UPDATE OF upstream_name_override ON group_models
WHEN NEW.upstream_name_override IS NOT OLD.upstream_name_override
BEGIN
  UPDATE group_models
     SET enabled = 0,
         disabled_by_account_sync = 1,
         control_version = control_version + 1,
         updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
   WHERE group_id = NEW.group_id
     AND model_id = NEW.model_id
     AND enabled = 1
     AND NOT EXISTS (
       SELECT 1 FROM group_model_account_support support
        WHERE support.group_id = NEW.group_id
          AND support.model_id = NEW.model_id
     );

  UPDATE group_models
     SET enabled = 1,
         disabled_by_account_sync = 0,
         control_version = control_version + 1,
         updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
   WHERE group_id = NEW.group_id
     AND model_id = NEW.model_id
     AND disabled_by_account_sync = 1
     AND EXISTS (
       SELECT 1 FROM group_model_account_support support
        WHERE support.group_id = NEW.group_id
          AND support.model_id = NEW.model_id
     );
END;

-- Repair production rows created under the broad legacy projection. Existing
-- configuration and pricing rows are retained; only publication state changes.
INSERT INTO group_models (
  group_id, model_id, enabled, catalog_visible, sort_order,
  max_output_tokens, default_max_output_tokens, disabled_by_account_sync,
  created_at_ms, updated_at_ms
)
SELECT DISTINCT support.group_id, support.model_id, 1, 1, 0, 65536, 32768, 0,
       CAST(unixepoch('subsec') * 1000 AS INTEGER),
       CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM group_model_account_support support
 WHERE 1
ON CONFLICT(group_id, model_id) DO NOTHING;

UPDATE group_models
   SET enabled = 0,
       disabled_by_account_sync = 1,
       control_version = control_version + 1,
       updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
 WHERE enabled = 1
   AND NOT EXISTS (
     SELECT 1 FROM group_model_account_support support
      WHERE support.group_id = group_models.group_id
        AND support.model_id = group_models.model_id
   );

UPDATE group_models
   SET enabled = 1,
       disabled_by_account_sync = 0,
       control_version = control_version + 1,
       updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
 WHERE disabled_by_account_sync = 1
   AND EXISTS (
     SELECT 1 FROM group_model_account_support support
      WHERE support.group_id = group_models.group_id
        AND support.model_id = group_models.model_id
   );

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (124, 'precise_legacy_group_model_support', CAST(unixepoch('subsec') * 1000 AS INTEGER));
