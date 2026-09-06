CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at_ms INTEGER NOT NULL
);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (1, 'initial', 1);
