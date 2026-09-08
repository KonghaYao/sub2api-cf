-- Preserve explicit/global Anthropic cache TTL usage-override evidence.
ALTER TABLE usage_projection ADD COLUMN cache_ttl_overridden INTEGER NOT NULL DEFAULT 0 CHECK (cache_ttl_overridden IN (0,1));
INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (121, 'cache_ttl_override_usage', CAST(unixepoch('subsec') * 1000 AS INTEGER));
