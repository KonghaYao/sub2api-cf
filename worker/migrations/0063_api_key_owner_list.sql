CREATE INDEX idx_api_keys_owner_visible_created
  ON api_keys(user_id, created_at_ms DESC, id DESC)
  WHERE revoked_at_ms IS NULL;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (63, 'api_key_owner_list', CAST(unixepoch('subsec') * 1000 AS INTEGER));
