PRAGMA foreign_keys = ON;

-- Preserve the original gateway semantics: concurrency is a user-wide ceiling
-- (0 = unlimited), while RPM has a user-wide hard ceiling plus an optional
-- per-(user, group) override of the group limit.
ALTER TABLE users ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 5
  CHECK (concurrency >= 0 AND concurrency <= 9007199254740991);
ALTER TABLE users ADD COLUMN rpm_limit INTEGER NOT NULL DEFAULT 0
  CHECK (rpm_limit >= 0 AND rpm_limit <= 9007199254740991);
ALTER TABLE "groups" ADD COLUMN rpm_limit INTEGER NOT NULL DEFAULT 0
  CHECK (rpm_limit >= 0 AND rpm_limit <= 9007199254740991);

CREATE TABLE user_group_rpm_overrides (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  rpm_override INTEGER NOT NULL
    CHECK (rpm_override >= 0 AND rpm_override <= 9007199254740991),
  control_version INTEGER NOT NULL DEFAULT 0
    CHECK (control_version >= 0 AND control_version <= 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= 0 AND updated_at_ms <= 8640000000000000),
  PRIMARY KEY (user_id, group_id)
) STRICT;

CREATE INDEX idx_user_group_rpm_overrides_group
  ON user_group_rpm_overrides(group_id, user_id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (22, 'api_key_limits', CAST(unixepoch('subsec') * 1000 AS INTEGER));
