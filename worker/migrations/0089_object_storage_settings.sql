CREATE TABLE object_storage_settings(id TEXT PRIMARY KEY CHECK(id IN('backup','images','schedule')),config_json TEXT NOT NULL CHECK(json_valid(config_json)),nonce_b64 TEXT NOT NULL,ciphertext_b64 TEXT NOT NULL,control_version INTEGER NOT NULL DEFAULT 0,updated_at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE managed_backup_records(id TEXT PRIMARY KEY,status TEXT NOT NULL,record_json TEXT NOT NULL CHECK(json_valid(record_json)),created_at_ms INTEGER NOT NULL) STRICT;
INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(89,'object_storage_settings',CAST(unixepoch('subsec')*1000 AS INTEGER));
ALTER TABLE image_task_outputs ADD COLUMN external_storage_ref TEXT;
