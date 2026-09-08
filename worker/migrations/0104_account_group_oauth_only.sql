-- Original require_oauth_only governs association, not the retroactive removal
-- of already-associated accounts when an administrator enables the group flag.
CREATE TRIGGER account_group_oauth_only_insert BEFORE INSERT ON account_groups
WHEN NOT EXISTS (SELECT 1 FROM account_groups WHERE account_id=NEW.account_id AND group_id=NEW.group_id) AND EXISTS (
  SELECT 1 FROM accounts a JOIN "groups" g ON g.id = NEW.group_id
  WHERE a.id = NEW.account_id AND a.credential_kind = 'api_key'
    AND json_extract(g.ui_config_json, '$.require_oauth_only') = 1
)
BEGIN SELECT RAISE(ABORT, 'account_group_oauth_only'); END;
CREATE TRIGGER account_group_oauth_only_update BEFORE UPDATE OF account_id, group_id ON account_groups
WHEN (NEW.account_id <> OLD.account_id OR NEW.group_id <> OLD.group_id) AND EXISTS (
  SELECT 1 FROM accounts a JOIN "groups" g ON g.id = NEW.group_id
  WHERE a.id = NEW.account_id AND a.credential_kind = 'api_key'
    AND json_extract(g.ui_config_json, '$.require_oauth_only') = 1
)
BEGIN SELECT RAISE(ABORT, 'account_group_oauth_only'); END;
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(104,'account_group_oauth_only',CAST(unixepoch('subsec')*1000 AS INTEGER));
