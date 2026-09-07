PRAGMA foreign_keys = ON;

-- The original user error table needs an exact total plus stable offset pages.
-- Keep that scan on the user's failed rows instead of walking every successful
-- request in the broader owner timeline index.
CREATE INDEX idx_request_observations_owner_error_seek
  ON request_observations(user_id, occurred_at_ms DESC, id DESC)
  WHERE lifecycle = 'failed';

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (80, 'owner_error_list_index', CAST(unixepoch('subsec') * 1000 AS INTEGER));
