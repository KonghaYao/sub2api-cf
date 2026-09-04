PRAGMA foreign_keys = ON;

-- Usage settlement is projected asynchronously. A settlement emitted before an
-- administrative quota reset must not add the reset usage back when Queue delivery
-- is delayed, so both D1 and SubscriptionStateDO carry a monotonic reset epoch.
ALTER TABLE user_subscriptions ADD COLUMN quota_reset_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (quota_reset_epoch >= 0 AND quota_reset_epoch <= 9007199254740991);

-- Every administrative reset, including weekly/monthly-only resets, advances this
-- generation. SubscriptionStateDO rejects ordinary gateway configuration attempts
-- that try to cross it, so a pending reset cannot be split around live usage.
ALTER TABLE user_subscriptions ADD COLUMN quota_reset_generation INTEGER NOT NULL DEFAULT 0
  CHECK (quota_reset_generation >= 0 AND quota_reset_generation <= 9007199254740991);

-- Daily windows are either UTC-aligned (anchor 0) or activation-aligned for a
-- term that began as a one-day entitlement. Persist the mode explicitly so D1,
-- the subscription Durable Object, and Queue projection never have to infer it
-- from a zero usage counter.
ALTER TABLE user_subscriptions ADD COLUMN daily_anchor_ms INTEGER NOT NULL DEFAULT 0
  CHECK (daily_anchor_ms >= 0 AND daily_anchor_ms <= 8640000000000000);

UPDATE user_subscriptions
   SET daily_anchor_ms = starts_at_ms
 WHERE expires_at_ms - starts_at_ms <= 86400000
    OR (
      daily_window_start_ms IS NOT NULL
      AND daily_window_start_ms % 86400000 <> 0
    );

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (15, 'subscription_quota_reset_epoch', CAST(unixepoch('subsec') * 1000 AS INTEGER));
