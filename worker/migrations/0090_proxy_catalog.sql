CREATE TABLE proxies (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL UNIQUE,
 config_json TEXT NOT NULL CHECK(json_valid(config_json)),
 nonce_b64 TEXT NOT NULL,
 ciphertext_b64 TEXT NOT NULL,
 control_version INTEGER NOT NULL DEFAULT 1,
 creation_key TEXT NOT NULL UNIQUE,
 created_at_ms INTEGER NOT NULL,
 updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE proxy_creation_requests (
 key_hash TEXT PRIMARY KEY,
 fingerprint TEXT NOT NULL,
 proxy_id INTEGER NOT NULL,
 created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE proxy_deletions(proxy_id INTEGER PRIMARY KEY,control_version INTEGER NOT NULL,deleted_at_ms INTEGER NOT NULL) STRICT;
CREATE TRIGGER proxy_delete_record AFTER DELETE ON proxies BEGIN INSERT INTO proxy_deletions VALUES(OLD.id,OLD.control_version,CAST(unixepoch('subsec')*1000 AS INTEGER)); END;
CREATE INDEX accounts_proxy_assignment ON accounts(json_extract(ui_config_json,'$.proxy_id'));
CREATE TRIGGER proxy_delete_assigned BEFORE DELETE ON proxies
 WHEN EXISTS(SELECT 1 FROM accounts WHERE json_extract(ui_config_json,'$.proxy_id')=OLD.id)
 OR EXISTS(SELECT 1 FROM proxies WHERE json_extract(config_json,'$.backup_proxy_id')=OLD.id)
 BEGIN SELECT RAISE(ABORT,'proxy_in_use'); END;
CREATE TRIGGER account_proxy_insert_reference BEFORE INSERT ON accounts
 WHEN json_extract(NEW.ui_config_json,'$.proxy_id') IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM proxies WHERE id=json_extract(NEW.ui_config_json,'$.proxy_id'))
 BEGIN SELECT RAISE(ABORT,'proxy_not_found'); END;
CREATE TRIGGER account_proxy_update_reference BEFORE UPDATE OF ui_config_json ON accounts
 WHEN json_extract(NEW.ui_config_json,'$.proxy_id') IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM proxies WHERE id=json_extract(NEW.ui_config_json,'$.proxy_id'))
 BEGIN SELECT RAISE(ABORT,'proxy_not_found'); END;
CREATE TRIGGER proxy_backup_insert_reference BEFORE INSERT ON proxies
 WHEN json_extract(NEW.config_json,'$.backup_proxy_id') IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM proxies WHERE id=json_extract(NEW.config_json,'$.backup_proxy_id'))
 BEGIN SELECT RAISE(ABORT,'proxy_not_found'); END;
CREATE TRIGGER proxy_backup_update_reference BEFORE UPDATE OF config_json ON proxies
 WHEN json_extract(NEW.config_json,'$.backup_proxy_id') IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM proxies WHERE id=json_extract(NEW.config_json,'$.backup_proxy_id'))
 BEGIN SELECT RAISE(ABORT,'proxy_not_found'); END;
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES (90,'proxy_catalog',CAST(unixepoch('subsec')*1000 AS INTEGER));
