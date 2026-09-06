CREATE INDEX idx_usage_projection_group_cost_time
  ON usage_projection(group_id, occurred_at_ms, amount_micros);
INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (66, 'group_usage_covering', CAST(unixepoch('subsec') * 1000 AS INTEGER));
