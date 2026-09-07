-- A dedicated virtual group preserves non-null financial foreign keys. Its catalog
-- starts empty and must be explicitly priced; it never inherits another group.
CREATE TRIGGER virtual_default_settings AFTER UPDATE OF gateway_json ON system_settings
WHEN NEW.id='global'
BEGIN
 INSERT INTO "groups"(id,name,platform,enabled,is_exclusive,catalog_mode,created_at_ms,updated_at_ms)
 SELECT 'worker-ungrouped-default','未分组（独立模型与价格）','composite',1,0,'allowlist',NEW.updated_at_ms,NEW.updated_at_ms
 WHERE json_extract(NEW.gateway_json,'$.allow_ungrouped_key_scheduling')=1
 AND NOT EXISTS(SELECT 1 FROM "groups" WHERE id='worker-ungrouped-default');
 UPDATE "groups" SET enabled=COALESCE(json_extract(NEW.gateway_json,'$.allow_ungrouped_key_scheduling')=1,0),
 control_version=control_version+1,updated_at_ms=NEW.updated_at_ms
 WHERE id='worker-ungrouped-default' AND enabled<>COALESCE(json_extract(NEW.gateway_json,'$.allow_ungrouped_key_scheduling')=1,0);
 INSERT OR IGNORE INTO account_groups(account_id,group_id,created_at_ms,updated_at_ms)
 SELECT a.id,'worker-ungrouped-default',NEW.updated_at_ms,NEW.updated_at_ms FROM accounts a
 WHERE EXISTS(SELECT 1 FROM "groups" WHERE id='worker-ungrouped-default')
 AND NOT EXISTS(SELECT 1 FROM account_groups ag WHERE ag.account_id=a.id);
END;
CREATE TRIGGER virtual_default_group_delete BEFORE DELETE ON "groups"
WHEN OLD.id='worker-ungrouped-default'
BEGIN SELECT RAISE(ABORT,'virtual_default_group_managed'); END;
CREATE TRIGGER virtual_default_group_update BEFORE UPDATE ON "groups"
WHEN OLD.id='worker-ungrouped-default' AND (
 NEW.id<>OLD.id OR NEW.platform<>'composite' OR NEW.group_type<>'standard' OR NEW.is_exclusive<>0 OR NEW.rate_multiplier_ppm<>1000000
 OR NEW.enabled<>CASE WHEN (SELECT json_extract(gateway_json,'$.allow_ungrouped_key_scheduling') FROM system_settings WHERE id='global')=1 THEN 1 ELSE 0 END
 OR COALESCE(json_extract(NEW.ui_config_json,'$.fallback_group_id'),'')<>''
 OR COALESCE(json_extract(NEW.ui_config_json,'$.fallback_group_id_on_invalid_request'),'')<>''
)
BEGIN SELECT RAISE(ABORT,'virtual_default_group_managed'); END;
CREATE TRIGGER virtual_default_account_insert AFTER INSERT ON accounts
BEGIN
 INSERT INTO account_groups(account_id,group_id,created_at_ms,updated_at_ms)
 SELECT NEW.id,'worker-ungrouped-default',NEW.created_at_ms,NEW.updated_at_ms
 WHERE EXISTS(SELECT 1 FROM "groups" WHERE id='worker-ungrouped-default');
END;
-- Moving into a real group atomically removes access from the ungrouped pool.
CREATE TRIGGER virtual_default_account_assigned AFTER INSERT ON account_groups
WHEN NEW.group_id<>'worker-ungrouped-default'
BEGIN DELETE FROM account_groups WHERE account_id=NEW.account_id AND group_id='worker-ungrouped-default'; END;
CREATE TRIGGER virtual_default_account_unassigned AFTER DELETE ON account_groups
BEGIN
 INSERT OR IGNORE INTO account_groups(account_id,group_id,created_at_ms,updated_at_ms)
 SELECT OLD.account_id,'worker-ungrouped-default',OLD.created_at_ms,OLD.updated_at_ms
 WHERE EXISTS(SELECT 1 FROM accounts WHERE id=OLD.account_id)
 AND EXISTS(SELECT 1 FROM "groups" WHERE id='worker-ungrouped-default')
 AND NOT EXISTS(SELECT 1 FROM account_groups WHERE account_id=OLD.account_id);
END;
CREATE TRIGGER virtual_default_account_link_guard BEFORE INSERT ON account_groups
WHEN NEW.group_id='worker-ungrouped-default' AND EXISTS(SELECT 1 FROM account_groups WHERE account_id=NEW.account_id AND group_id<>'worker-ungrouped-default')
BEGIN SELECT RAISE(ABORT,'virtual_default_requires_ungrouped_account'); END;
CREATE TRIGGER virtual_default_account_link_update BEFORE UPDATE OF group_id,account_id ON account_groups
WHEN OLD.group_id='worker-ungrouped-default' OR NEW.group_id='worker-ungrouped-default'
BEGIN SELECT RAISE(ABORT,'virtual_default_link_replace_required'); END;
INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(95,'ungrouped_scheduling',CAST(unixepoch('subsec')*1000 AS INTEGER));
