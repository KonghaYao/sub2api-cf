CREATE TABLE proxies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('http', 'https', 'socks5', 'socks5h')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'expired')),
  expires_at INTEGER,
  fallback_mode TEXT NOT NULL DEFAULT 'none' CHECK (fallback_mode IN ('none', 'proxy', 'direct')),
  backup_proxy_id TEXT REFERENCES proxies(id) ON DELETE RESTRICT,
  expiry_warn_days INTEGER NOT NULL DEFAULT 0 CHECK (expiry_warn_days >= 0),
  nonce_b64 TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  control_version INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (backup_proxy_id IS NULL OR backup_proxy_id <> id),
  CHECK (fallback_mode <> 'proxy' OR backup_proxy_id IS NOT NULL)
) STRICT;
CREATE INDEX idx_proxies_status_created ON proxies(status, created_at_ms DESC, id);
CREATE INDEX idx_accounts_proxy ON accounts(CAST(json_extract(ui_config_json, '$.proxy_id') AS TEXT));
CREATE TRIGGER proxy_delete_referenced_account
BEFORE DELETE ON proxies
WHEN EXISTS (SELECT 1 FROM accounts WHERE CAST(json_extract(ui_config_json, '$.proxy_id') AS TEXT) = OLD.id)
BEGIN SELECT RAISE(ABORT, 'proxy_in_use'); END;
CREATE TRIGGER account_proxy_insert_reference
BEFORE INSERT ON accounts
WHEN COALESCE(CAST(json_extract(NEW.ui_config_json, '$.proxy_id') AS TEXT), '0') <> '0'
  AND NOT EXISTS (SELECT 1 FROM proxies WHERE id=CAST(json_extract(NEW.ui_config_json, '$.proxy_id') AS TEXT))
BEGIN SELECT RAISE(ABORT, 'invalid_account_proxy'); END;
CREATE TRIGGER account_proxy_update_reference
BEFORE UPDATE OF ui_config_json ON accounts
WHEN json_extract(NEW.ui_config_json, '$.proxy_id') IS NOT json_extract(OLD.ui_config_json, '$.proxy_id')
  AND COALESCE(CAST(json_extract(NEW.ui_config_json, '$.proxy_id') AS TEXT), '0') <> '0'
  AND NOT EXISTS (SELECT 1 FROM proxies WHERE id=CAST(json_extract(NEW.ui_config_json, '$.proxy_id') AS TEXT))
BEGIN SELECT RAISE(ABORT, 'invalid_account_proxy'); END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (84, 'proxy_inventory', CAST(unixepoch('subsec') * 1000 AS INTEGER));
