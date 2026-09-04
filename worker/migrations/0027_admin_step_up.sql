PRAGMA foreign_keys = ON;

-- The switch is authoritative in D1 rather than KV so a stale cache can never
-- silently disable the privileged-operation gate. Existing installations keep
-- their pre-migration behavior until an administrator explicitly enables it.
ALTER TABLE system_settings ADD COLUMN step_up_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (step_up_enabled IN (0, 1));

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (27, 'admin_step_up', CAST(unixepoch('subsec') * 1000 AS INTEGER));
