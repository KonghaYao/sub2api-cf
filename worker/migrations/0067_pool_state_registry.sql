-- Only pools that have been configured by a gateway request are recorded here.
-- This prevents the admin summary from creating empty Durable Objects while
-- discovering capacity.
CREATE TABLE pool_state_registry (
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL CHECK (endpoint IN ('chat_completions', 'responses', 'embeddings', 'images')),
  config_revision INTEGER NOT NULL CHECK (config_revision > 0),
  last_synced_at_ms INTEGER NOT NULL CHECK (last_synced_at_ms >= 0),
  PRIMARY KEY (group_id, model_id, endpoint)
) STRICT;
CREATE INDEX idx_pool_state_registry_group ON pool_state_registry(group_id, model_id, endpoint);
INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (67, 'pool_state_registry', CAST(unixepoch('subsec') * 1000 AS INTEGER));
