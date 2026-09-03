ALTER TABLE users
  ADD COLUMN control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0);

ALTER TABLE api_keys
  ADD COLUMN control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (5, 'control_versions', CAST(unixepoch('subsec') * 1000 AS INTEGER));
