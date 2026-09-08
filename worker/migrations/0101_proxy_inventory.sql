-- Keep the deployed numeric proxy identity, encrypted payload, creation key and
-- JSON configuration authoritative. Read projections let account lifecycle and
-- routing consumers use the same fields without rebuilding existing rows.
ALTER TABLE proxies ADD COLUMN protocol TEXT GENERATED ALWAYS AS (json_extract(config_json, '$.protocol')) VIRTUAL;
ALTER TABLE proxies ADD COLUMN host TEXT GENERATED ALWAYS AS (json_extract(config_json, '$.host')) VIRTUAL;
ALTER TABLE proxies ADD COLUMN port INTEGER GENERATED ALWAYS AS (json_extract(config_json, '$.port')) VIRTUAL;
ALTER TABLE proxies ADD COLUMN status TEXT GENERATED ALWAYS AS (json_extract(config_json, '$.status')) VIRTUAL;
ALTER TABLE proxies ADD COLUMN expires_at INTEGER GENERATED ALWAYS AS (json_extract(config_json, '$.expires_at')) VIRTUAL;
ALTER TABLE proxies ADD COLUMN fallback_mode TEXT GENERATED ALWAYS AS (COALESCE(json_extract(config_json, '$.fallback_mode'), 'none')) VIRTUAL;
ALTER TABLE proxies ADD COLUMN backup_proxy_id INTEGER GENERATED ALWAYS AS (json_extract(config_json, '$.backup_proxy_id')) VIRTUAL;
ALTER TABLE proxies ADD COLUMN expiry_warn_days INTEGER GENERATED ALWAYS AS (COALESCE(json_extract(config_json, '$.expiry_warn_days'), 0)) VIRTUAL;
CREATE INDEX idx_proxies_status_created ON proxies(status, created_at_ms DESC, id);
INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (101, 'proxy_inventory', CAST(unixepoch('subsec') * 1000 AS INTEGER));
