PRAGMA foreign_keys = ON;

-- Composite groups are a routing aggregate. They may reference models and
-- accounts from several concrete providers, while concrete groups retain the
-- original same-platform invariant.
DROP TRIGGER validate_group_model_insert;
DROP TRIGGER validate_group_model_update;
DROP TRIGGER validate_account_group_insert;
DROP TRIGGER validate_account_group_update;
DROP TRIGGER validate_group_platform_update;
DROP TRIGGER validate_model_platform_update;
DROP TRIGGER validate_account_platform_update;

CREATE TRIGGER validate_group_model_insert
BEFORE INSERT ON group_models
FOR EACH ROW
WHEN (
  (SELECT platform FROM "groups" WHERE id = NEW.group_id) <> 'composite'
  AND (SELECT platform FROM "groups" WHERE id = NEW.group_id)
    <> (SELECT platform FROM models WHERE id = NEW.model_id)
) OR NEW.default_max_output_tokens > NEW.max_output_tokens
BEGIN
  SELECT RAISE(ABORT, 'invalid_group_model');
END;

CREATE TRIGGER validate_group_model_update
BEFORE UPDATE ON group_models
FOR EACH ROW
WHEN (
  (SELECT platform FROM "groups" WHERE id = NEW.group_id) <> 'composite'
  AND (SELECT platform FROM "groups" WHERE id = NEW.group_id)
    <> (SELECT platform FROM models WHERE id = NEW.model_id)
) OR NEW.default_max_output_tokens > NEW.max_output_tokens
BEGIN
  SELECT RAISE(ABORT, 'invalid_group_model');
END;

CREATE TRIGGER validate_account_group_insert
BEFORE INSERT ON account_groups
FOR EACH ROW
WHEN NEW.priority < 0 OR (
  (SELECT platform FROM "groups" WHERE id = NEW.group_id) <> 'composite'
  AND (SELECT platform FROM accounts WHERE id = NEW.account_id)
    <> (SELECT platform FROM "groups" WHERE id = NEW.group_id)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_group');
END;

CREATE TRIGGER validate_account_group_update
BEFORE UPDATE ON account_groups
FOR EACH ROW
WHEN NEW.priority < 0 OR (
  (SELECT platform FROM "groups" WHERE id = NEW.group_id) <> 'composite'
  AND (SELECT platform FROM accounts WHERE id = NEW.account_id)
    <> (SELECT platform FROM "groups" WHERE id = NEW.group_id)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_group');
END;

CREATE TRIGGER validate_group_platform_update
BEFORE UPDATE OF platform ON "groups"
FOR EACH ROW
WHEN NEW.platform <> 'composite' AND (
  EXISTS (
    SELECT 1 FROM group_models gm JOIN models m ON m.id = gm.model_id
    WHERE gm.group_id = NEW.id AND m.platform <> NEW.platform
  ) OR EXISTS (
    SELECT 1 FROM account_groups ag JOIN accounts a ON a.id = ag.account_id
    WHERE ag.group_id = NEW.id AND a.platform <> NEW.platform
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_group_platform');
END;

CREATE TRIGGER validate_model_platform_update
BEFORE UPDATE OF platform ON models
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM group_models gm JOIN "groups" g ON g.id = gm.group_id
  WHERE gm.model_id = NEW.id
    AND g.platform <> 'composite'
    AND g.platform <> NEW.platform
) OR EXISTS (
  SELECT 1 FROM account_models am JOIN accounts a ON a.id = am.account_id
  WHERE am.model_id = NEW.id AND a.platform <> NEW.platform
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_model_platform');
END;

CREATE TRIGGER validate_account_platform_update
BEFORE UPDATE OF platform ON accounts
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM account_groups ag JOIN "groups" g ON g.id = ag.group_id
  WHERE ag.account_id = NEW.id
    AND g.platform <> 'composite'
    AND g.platform <> NEW.platform
) OR EXISTS (
  SELECT 1 FROM account_models am JOIN models m ON m.id = am.model_id
  WHERE am.account_id = NEW.id AND m.platform <> NEW.platform
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_platform');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (52, 'composite_group_platform', CAST(unixepoch('subsec') * 1000 AS INTEGER));
