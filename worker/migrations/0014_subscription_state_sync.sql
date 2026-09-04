PRAGMA foreign_keys = ON;

-- Durable Object synchronization is an explicit, replayable side effect of every
-- administrative entitlement mutation. The entitlement row, audit event, and this
-- intent are committed in one D1 transaction; an HTTP response is successful only
-- after the intent has been acknowledged by SubscriptionStateDO.
CREATE TABLE subscription_state_sync (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES user_subscriptions(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('configure', 'reset_quota')),
  control_version INTEGER NOT NULL
    CHECK (control_version >= 0 AND control_version <= 9007199254740991),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied')),
  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (attempts >= 0 AND attempts <= 9007199254740991),
  last_error TEXT,
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= 0 AND updated_at_ms <= 8640000000000000),
  applied_at_ms INTEGER
    CHECK (applied_at_ms IS NULL OR (applied_at_ms >= created_at_ms AND applied_at_ms <= 8640000000000000)),
  UNIQUE(request_id, subscription_id)
) STRICT;

CREATE INDEX idx_subscription_state_sync_pending
  ON subscription_state_sync(status, updated_at_ms, id);

CREATE INDEX idx_subscription_state_sync_subscription_pending
  ON subscription_state_sync(subscription_id, status, control_version, created_at_ms, id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (14, 'subscription_state_sync', CAST(unixepoch('subsec') * 1000 AS INTEGER));
