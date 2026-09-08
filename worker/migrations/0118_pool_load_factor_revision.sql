-- Refresh snapshots made by health probes that omitted the account load factor.
UPDATE gateway_config_revision SET revision = revision + 1 WHERE singleton = 1;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (118, 'pool_load_factor_revision', CAST(unixepoch('subsec') * 1000 AS INTEGER));
