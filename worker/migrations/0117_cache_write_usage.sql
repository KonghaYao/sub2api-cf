-- Preserve reported cache creation separately from total input. Historical rows
-- have no reliable write evidence and retain zero; amounts are not rewritten.
ALTER TABLE usage_projection ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0);
ALTER TABLE account_usage_15m_rollup ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (117, 'cache_write_usage', CAST(unixepoch('subsec') * 1000 AS INTEGER));
