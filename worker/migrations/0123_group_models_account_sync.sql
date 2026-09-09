-- Keep a group model's published state synchronized with the enabled accounts linked to the group.
-- The marker distinguishes an automatic suspension from an administrator's explicit disable.
ALTER TABLE group_models ADD COLUMN disabled_by_account_sync INTEGER NOT NULL DEFAULT 0
  CHECK (disabled_by_account_sync IN (0, 1));

-- A routing-capable account can support a group model through an explicit capability row or
-- through the legacy original-form routing mode. Runtime health and rate-limit state stay out
-- of this projection so transient failures do not rewrite the durable catalog.
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
 WHERE a.enabled = 1
   AND json_extract(a.ui_config_json, '$.original_model_routing') = 1
   AND a.platform = m.platform
   AND (g.platform = 'composite' OR g.platform = m.platform);

-- Repair missing rows on upgrade without changing any existing administrator-visible state.
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

-- Converge already-stale rows during rollout while preserving routing options and price history.
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

CREATE TRIGGER sync_group_models_account_model_insert
AFTER INSERT ON account_models
BEGIN
  INSERT INTO group_models (
    group_id, model_id, enabled, catalog_visible, sort_order,
    max_output_tokens, default_max_output_tokens, disabled_by_account_sync,
    created_at_ms, updated_at_ms
  )
  SELECT ag.group_id, NEW.model_id, 1, 1, 0, 65536, 32768, 0,
         CAST(unixepoch('subsec') * 1000 AS INTEGER),
         CAST(unixepoch('subsec') * 1000 AS INTEGER)
    FROM account_groups ag
    JOIN accounts a ON a.id = ag.account_id
    JOIN "groups" g ON g.id = ag.group_id
    JOIN models m ON m.id = NEW.model_id
   WHERE ag.account_id = NEW.account_id AND a.enabled = 1
     AND (NEW.chat_completions = 1 OR NEW.responses = 1 OR NEW.embeddings = 1 OR NEW.image_generation = 1)
     AND (g.platform = 'composite' OR g.platform = m.platform)
  ON CONFLICT(group_id, model_id) DO UPDATE SET
    enabled = 1,
    disabled_by_account_sync = 0,
    control_version = group_models.control_version + 1,
    updated_at_ms = excluded.updated_at_ms
  WHERE group_models.disabled_by_account_sync = 1;
END;

CREATE TRIGGER sync_group_models_account_model_update
AFTER UPDATE OF account_id, model_id, chat_completions, responses, embeddings, image_generation ON account_models
BEGIN
  UPDATE group_models
     SET enabled = 0,
         disabled_by_account_sync = 1,
         control_version = control_version + 1,
         updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
   WHERE enabled = 1
     AND model_id = OLD.model_id
     AND group_id IN (SELECT group_id FROM account_groups WHERE account_id = OLD.account_id)
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
  SELECT ag.group_id, NEW.model_id, 1, 1, 0, 65536, 32768, 0,
         CAST(unixepoch('subsec') * 1000 AS INTEGER),
         CAST(unixepoch('subsec') * 1000 AS INTEGER)
    FROM account_groups ag
    JOIN accounts a ON a.id = ag.account_id
    JOIN "groups" g ON g.id = ag.group_id
    JOIN models m ON m.id = NEW.model_id
   WHERE ag.account_id = NEW.account_id AND a.enabled = 1
     AND (NEW.chat_completions = 1 OR NEW.responses = 1 OR NEW.embeddings = 1 OR NEW.image_generation = 1)
     AND (g.platform = 'composite' OR g.platform = m.platform)
  ON CONFLICT(group_id, model_id) DO UPDATE SET
    enabled = 1,
    disabled_by_account_sync = 0,
    control_version = group_models.control_version + 1,
    updated_at_ms = excluded.updated_at_ms
  WHERE group_models.disabled_by_account_sync = 1;
END;

CREATE TRIGGER sync_group_models_account_model_delete
AFTER DELETE ON account_models
BEGIN
  UPDATE group_models
     SET enabled = 0,
         disabled_by_account_sync = 1,
         control_version = control_version + 1,
         updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
   WHERE enabled = 1
     AND model_id = OLD.model_id
     AND group_id IN (SELECT group_id FROM account_groups WHERE account_id = OLD.account_id)
     AND NOT EXISTS (
       SELECT 1 FROM group_model_account_support support
        WHERE support.group_id = group_models.group_id
          AND support.model_id = group_models.model_id
     );
END;

CREATE TRIGGER sync_group_models_account_group_insert
AFTER INSERT ON account_groups
BEGIN
  INSERT INTO group_models (
    group_id, model_id, enabled, catalog_visible, sort_order,
    max_output_tokens, default_max_output_tokens, disabled_by_account_sync,
    created_at_ms, updated_at_ms
  )
  SELECT NEW.group_id, am.model_id, 1, 1, 0, 65536, 32768, 0,
         CAST(unixepoch('subsec') * 1000 AS INTEGER),
         CAST(unixepoch('subsec') * 1000 AS INTEGER)
    FROM accounts a
    JOIN account_models am ON am.account_id = a.id
    JOIN "groups" g ON g.id = NEW.group_id
    JOIN models m ON m.id = am.model_id
   WHERE a.id = NEW.account_id AND a.enabled = 1
     AND (am.chat_completions = 1 OR am.responses = 1 OR am.embeddings = 1 OR am.image_generation = 1)
     AND (g.platform = 'composite' OR g.platform = m.platform)
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
       SELECT 1 FROM accounts a
        WHERE a.id = NEW.account_id AND a.enabled = 1
          AND json_extract(a.ui_config_json, '$.original_model_routing') = 1
     );
END;

CREATE TRIGGER sync_group_models_account_group_delete
AFTER DELETE ON account_groups
BEGIN
  UPDATE group_models
     SET enabled = 0,
         disabled_by_account_sync = 1,
         control_version = control_version + 1,
         updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
   WHERE enabled = 1
     AND group_id = OLD.group_id
     AND (
       model_id IN (SELECT model_id FROM account_models WHERE account_id = OLD.account_id)
       OR EXISTS (
         SELECT 1 FROM accounts a
          WHERE a.id = OLD.account_id
            AND json_extract(a.ui_config_json, '$.original_model_routing') = 1
       )
     )
     AND NOT EXISTS (
       SELECT 1 FROM group_model_account_support support
        WHERE support.group_id = group_models.group_id
          AND support.model_id = group_models.model_id
     );
END;

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
     AND (
       model_id IN (SELECT model_id FROM account_models WHERE account_id = NEW.id)
       OR json_extract(NEW.ui_config_json, '$.original_model_routing') = 1
     )
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
  SELECT ag.group_id, am.model_id, 1, 1, 0, 65536, 32768, 0,
         CAST(unixepoch('subsec') * 1000 AS INTEGER),
         CAST(unixepoch('subsec') * 1000 AS INTEGER)
    FROM account_groups ag
    JOIN account_models am ON am.account_id = ag.account_id
    JOIN "groups" g ON g.id = ag.group_id
    JOIN models m ON m.id = am.model_id
   WHERE NEW.enabled = 1 AND ag.account_id = NEW.id
     AND (am.chat_completions = 1 OR am.responses = 1 OR am.embeddings = 1 OR am.image_generation = 1)
     AND (g.platform = 'composite' OR g.platform = m.platform)
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
     AND json_extract(NEW.ui_config_json, '$.original_model_routing') = 1;
END;

CREATE TRIGGER sync_group_models_original_routing
AFTER UPDATE OF ui_config_json ON accounts
WHEN COALESCE(json_extract(NEW.ui_config_json, '$.original_model_routing'), 0)
  <> COALESCE(json_extract(OLD.ui_config_json, '$.original_model_routing'), 0)
BEGIN
  UPDATE group_models
     SET enabled = 0,
         disabled_by_account_sync = 1,
         control_version = control_version + 1,
         updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
   WHERE json_extract(OLD.ui_config_json, '$.original_model_routing') = 1
     AND COALESCE(json_extract(NEW.ui_config_json, '$.original_model_routing'), 0) = 0
     AND enabled = 1
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
   WHERE json_extract(NEW.ui_config_json, '$.original_model_routing') = 1
     AND NEW.enabled = 1
     AND disabled_by_account_sync = 1
     AND group_id IN (SELECT group_id FROM account_groups WHERE account_id = NEW.id);
END;

CREATE TRIGGER sync_group_models_account_delete
BEFORE DELETE ON accounts
BEGIN
  UPDATE group_models
     SET enabled = 0,
         disabled_by_account_sync = 1,
         control_version = control_version + 1,
         updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
   WHERE enabled = 1
     AND group_id IN (SELECT group_id FROM account_groups WHERE account_id = OLD.id)
     AND (
       model_id IN (SELECT model_id FROM account_models WHERE account_id = OLD.id)
       OR json_extract(OLD.ui_config_json, '$.original_model_routing') = 1
     )
     AND NOT EXISTS (
       SELECT 1 FROM group_model_account_support support
        WHERE support.group_id = group_models.group_id
          AND support.model_id = group_models.model_id
          AND support.account_id <> OLD.id
     );
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (123, 'group_models_account_sync', CAST(unixepoch('subsec') * 1000 AS INTEGER));
