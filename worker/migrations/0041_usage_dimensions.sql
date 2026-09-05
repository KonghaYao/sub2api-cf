PRAGMA foreign_keys = ON;

-- Retained usage filters and dashboard dimensions. These remain compact,
-- immutable projection facts; request/error diagnostics stay in migration 0040.
ALTER TABLE usage_projection ADD COLUMN platform TEXT NOT NULL DEFAULT ''
  CHECK (length(platform) <= 64);
ALTER TABLE usage_projection ADD COLUMN request_type INTEGER NOT NULL DEFAULT 0
  CHECK (request_type BETWEEN 0 AND 5);
ALTER TABLE usage_projection ADD COLUMN inbound_endpoint TEXT NOT NULL DEFAULT ''
  CHECK (length(inbound_endpoint) <= 128);
ALTER TABLE usage_projection ADD COLUMN upstream_endpoint TEXT NOT NULL DEFAULT ''
  CHECK (length(upstream_endpoint) <= 128);
ALTER TABLE usage_projection ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'token'
  CHECK (billing_mode IN ('token', 'per_request', 'image', 'video'));
ALTER TABLE usage_projection ADD COLUMN native_compaction_v2 INTEGER NOT NULL DEFAULT 0
  CHECK (native_compaction_v2 IN (0, 1));
-- Version 0 identifies writes from the previous Worker during a rolling deploy.
-- Version 1 makes request_type=0 an explicit "unknown" instead of conflating it
-- with an omitted request type that must be inferred from the legacy stream bit.
ALTER TABLE usage_projection ADD COLUMN dimensions_version INTEGER NOT NULL DEFAULT 0
  CHECK (dimensions_version IN (0, 1));

UPDATE usage_projection
   SET request_type = CASE WHEN stream = 1 THEN 2 ELSE 1 END,
       platform = COALESCE(
         (SELECT g.platform FROM "groups" g WHERE g.id = usage_projection.group_id),
         ''
       ),
       dimensions_version = 1;

CREATE INDEX idx_usage_projection_user_request_type_time
  ON usage_projection(user_id, request_type, occurred_at_ms DESC, event_id DESC);
CREATE INDEX idx_usage_projection_user_platform_time
  ON usage_projection(user_id, platform, occurred_at_ms DESC, event_id DESC);
CREATE INDEX idx_usage_projection_user_billing_mode_time
  ON usage_projection(user_id, billing_mode, occurred_at_ms DESC, event_id DESC);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (41, 'usage_dimensions', CAST(unixepoch('subsec') * 1000 AS INTEGER));
