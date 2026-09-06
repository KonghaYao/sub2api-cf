CREATE TABLE composite_model_routes (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  public_model TEXT NOT NULL,
  match_type TEXT NOT NULL CHECK (match_type IN ('exact', 'prefix')),
  target_platform TEXT NOT NULL CHECK (target_platform IN ('openai', 'anthropic', 'gemini', 'codex')),
  upstream_model TEXT NOT NULL,
  endpoint TEXT NOT NULL CHECK (endpoint IN ('any', 'messages', 'count_tokens', 'responses', 'chat_completions', 'embeddings', 'images', 'gemini')),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 1 AND priority <= 1000000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  notes TEXT NOT NULL DEFAULT '',
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_composite_model_routes_resolve
  ON composite_model_routes(group_id, enabled, endpoint, priority, id);

CREATE TRIGGER validate_composite_model_route_group_insert
BEFORE INSERT ON composite_model_routes
FOR EACH ROW WHEN (SELECT platform FROM "groups" WHERE id = NEW.group_id) <> 'composite'
BEGIN SELECT RAISE(ABORT, 'invalid_composite_route_group'); END;

CREATE TRIGGER validate_composite_model_route_group_update
BEFORE UPDATE OF group_id ON composite_model_routes
FOR EACH ROW WHEN (SELECT platform FROM "groups" WHERE id = NEW.group_id) <> 'composite'
BEGIN SELECT RAISE(ABORT, 'invalid_composite_route_group'); END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (69, 'composite_model_routes', CAST(unixepoch('subsec') * 1000 AS INTEGER));
