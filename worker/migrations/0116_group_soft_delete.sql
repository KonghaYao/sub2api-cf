-- Disabled groups remain editable; deleted groups are retained only for history.
ALTER TABLE "groups" ADD COLUMN deleted_at_ms INTEGER
  CHECK (deleted_at_ms IS NULL OR (deleted_at_ms >= 0 AND enabled = 0));

CREATE INDEX idx_groups_not_deleted
  ON "groups"(sort_order, id) WHERE deleted_at_ms IS NULL;

-- Apply association cleanup in the same transaction as the tombstone, including
-- writes from maintenance tools. Keep usage, keys, pricing and subscriptions for audit.
CREATE TRIGGER cleanup_soft_deleted_group
AFTER UPDATE OF deleted_at_ms ON "groups"
WHEN OLD.deleted_at_ms IS NULL AND NEW.deleted_at_ms IS NOT NULL
BEGIN
  DELETE FROM account_groups WHERE group_id = NEW.id;
  DELETE FROM user_group_permissions WHERE group_id = NEW.id;
  DELETE FROM user_group_rate_overrides WHERE group_id = NEW.id;
  DELETE FROM user_group_rpm_overrides WHERE group_id = NEW.id;
  DELETE FROM channel_groups WHERE group_id = NEW.id;
  UPDATE composite_model_routes SET enabled = 0,
    control_version = control_version + 1, updated_at_ms = NEW.deleted_at_ms
    WHERE group_id = NEW.id;
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (116, 'group_soft_delete', CAST(unixepoch('subsec') * 1000 AS INTEGER));
