-- Historical usage lacks trustworthy TTL evidence; retain zero without changing costs.
ALTER TABLE usage_projection ADD COLUMN cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_5m_tokens >= 0);
ALTER TABLE usage_projection ADD COLUMN cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_1h_tokens >= 0);
ALTER TABLE account_usage_15m_rollup ADD COLUMN cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_5m_tokens >= 0);
ALTER TABLE account_usage_15m_rollup ADD COLUMN cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_1h_tokens >= 0);
INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (119, 'cache_write_ttl_usage', CAST(unixepoch('subsec') * 1000 AS INTEGER));
