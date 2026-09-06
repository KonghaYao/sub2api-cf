ALTER TABLE accounts ADD COLUMN ui_config_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(ui_config_json));

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (64, 'account_ui_compat', CAST(unixepoch('subsec') * 1000 AS INTEGER));
