CREATE INDEX idx_user_group_rate_overrides_group
  ON user_group_rate_overrides(group_id, user_id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (68, 'group_rate_overrides_group_index', CAST(unixepoch('subsec') * 1000 AS INTEGER));
