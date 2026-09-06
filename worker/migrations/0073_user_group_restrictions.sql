ALTER TABLE users
  ADD COLUMN restrict_public_groups INTEGER NOT NULL DEFAULT 0
    CHECK (restrict_public_groups IN (0, 1));

CREATE INDEX idx_user_group_permissions_user_group
  ON user_group_permissions(user_id, group_id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (73, 'user_group_restrictions', CAST(unixepoch('subsec') * 1000 AS INTEGER));
