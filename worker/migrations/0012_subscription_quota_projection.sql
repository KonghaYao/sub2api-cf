PRAGMA foreign_keys = ON;

ALTER TABLE usage_projection ADD COLUMN billing_type TEXT NOT NULL DEFAULT 'balance'
  CHECK (billing_type IN ('balance', 'subscription'));
ALTER TABLE usage_projection ADD COLUMN subscription_id TEXT
  REFERENCES user_subscriptions(id) ON DELETE SET NULL;

ALTER TABLE settlement_recovery ADD COLUMN billing_type TEXT NOT NULL DEFAULT 'balance'
  CHECK (billing_type IN ('balance', 'subscription'));
ALTER TABLE settlement_recovery ADD COLUMN subscription_id TEXT
  REFERENCES user_subscriptions(id) ON DELETE RESTRICT;

CREATE INDEX idx_usage_projection_subscription_time
  ON usage_projection(subscription_id, occurred_at_ms DESC, event_id DESC);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (12, 'subscription_quota_projection', CAST(unixepoch('subsec') * 1000 AS INTEGER));
