-- Preserve new customer cache-write cost components. Historical charges remain unchanged.
ALTER TABLE usage_projection ADD COLUMN cache_write_amount_micros INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_amount_micros BETWEEN 0 AND 9007199254740991);
INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (120, 'cache_write_cost', CAST(unixepoch('subsec') * 1000 AS INTEGER));
