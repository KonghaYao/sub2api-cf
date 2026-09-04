PRAGMA foreign_keys = ON;

-- Avatar bytes stay in R2. D1 only records the immutable object identity and
-- media metadata needed to construct the Worker-served URL.
ALTER TABLE users ADD COLUMN avatar_object_key TEXT;
ALTER TABLE users ADD COLUMN avatar_content_type TEXT
  CHECK (avatar_content_type IS NULL OR avatar_content_type IN (
    'image/png', 'image/jpeg', 'image/webp', 'image/gif'
  ));
ALTER TABLE users ADD COLUMN avatar_updated_at_ms INTEGER
  CHECK (avatar_updated_at_ms IS NULL OR avatar_updated_at_ms >= 0);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (13, 'user_profile_assets', CAST(unixepoch('subsec') * 1000 AS INTEGER));
