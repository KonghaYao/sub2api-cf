PRAGMA foreign_keys = ON;

ALTER TABLE "groups"
  ADD COLUMN group_type TEXT NOT NULL DEFAULT 'standard'
    CHECK (group_type IN ('standard', 'subscription'));
ALTER TABLE "groups"
  ADD COLUMN is_exclusive INTEGER NOT NULL DEFAULT 1
    CHECK (is_exclusive IN (0, 1));
ALTER TABLE "groups"
  ADD COLUMN daily_quota_micros INTEGER
    CHECK (daily_quota_micros IS NULL OR (daily_quota_micros >= 0 AND daily_quota_micros <= 9007199254740991));
ALTER TABLE "groups"
  ADD COLUMN weekly_quota_micros INTEGER
    CHECK (weekly_quota_micros IS NULL OR (weekly_quota_micros >= 0 AND weekly_quota_micros <= 9007199254740991));
ALTER TABLE "groups"
  ADD COLUMN monthly_quota_micros INTEGER
    CHECK (monthly_quota_micros IS NULL OR (monthly_quota_micros >= 0 AND monthly_quota_micros <= 9007199254740991));

CREATE TABLE user_group_permissions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  granted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  PRIMARY KEY (user_id, group_id)
) STRICT;

-- Existing keys were created before group access became explicit. Preserve
-- every currently bound user/group pair before exclusive access is enforced.
INSERT INTO user_group_permissions (user_id, group_id, created_at_ms)
SELECT user_id, group_id, MIN(created_at_ms)
  FROM api_keys
 WHERE group_id IS NOT NULL
 GROUP BY user_id, group_id;

-- The previous Worker can remain live for a few seconds after this migration is
-- applied. Keep keys created or rebound during that expand/deploy window visible
-- to the new exclusive-group authorization rules. The Worker also writes this
-- permission explicitly; INSERT OR IGNORE keeps both paths idempotent.
CREATE TRIGGER preserve_legacy_api_key_group_access_insert
AFTER INSERT ON api_keys
FOR EACH ROW
WHEN NEW.group_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO user_group_permissions (
    user_id, group_id, granted_by_user_id, created_at_ms
  )
  SELECT NEW.user_id, NEW.group_id, NULL, NEW.created_at_ms
    FROM "groups" g
   WHERE g.id = NEW.group_id
     AND g.group_type = 'standard'
     AND g.is_exclusive = 1;
END;

CREATE TRIGGER preserve_legacy_api_key_group_access_update
AFTER UPDATE OF user_id, group_id ON api_keys
FOR EACH ROW
WHEN NEW.group_id IS NOT NULL
 AND (OLD.user_id IS NOT NEW.user_id OR OLD.group_id IS NOT NEW.group_id)
BEGIN
  INSERT OR IGNORE INTO user_group_permissions (
    user_id, group_id, granted_by_user_id, created_at_ms
  )
  SELECT NEW.user_id, NEW.group_id, NULL, NEW.updated_at_ms
    FROM "groups" g
   WHERE g.id = NEW.group_id
     AND g.group_type = 'standard'
     AND g.is_exclusive = 1;
END;

CREATE TABLE user_group_rate_overrides (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  rate_multiplier_ppm INTEGER NOT NULL CHECK (rate_multiplier_ppm >= 0 AND rate_multiplier_ppm <= 9007199254740991),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0 AND control_version <= 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0 AND updated_at_ms <= 8640000000000000),
  PRIMARY KEY (user_id, group_id)
) STRICT;

CREATE TABLE subscription_plans (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  validity_days INTEGER NOT NULL CHECK (validity_days > 0 AND validity_days <= 36500),
  price_micros INTEGER NOT NULL DEFAULT 0 CHECK (price_micros >= 0 AND price_micros <= 9007199254740991),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  daily_quota_micros INTEGER CHECK (daily_quota_micros IS NULL OR (daily_quota_micros >= 0 AND daily_quota_micros <= 9007199254740991)),
  weekly_quota_micros INTEGER CHECK (weekly_quota_micros IS NULL OR (weekly_quota_micros >= 0 AND weekly_quota_micros <= 9007199254740991)),
  monthly_quota_micros INTEGER CHECK (monthly_quota_micros IS NULL OR (monthly_quota_micros >= 0 AND monthly_quota_micros <= 9007199254740991)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0 AND sort_order <= 9007199254740991),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0 AND control_version <= 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0 AND updated_at_ms <= 8640000000000000),
  UNIQUE(group_id, name)
) STRICT;

CREATE INDEX idx_subscription_plans_public
  ON subscription_plans(enabled, sort_order, id);

CREATE TABLE user_subscriptions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE RESTRICT,
  plan_id TEXT REFERENCES subscription_plans(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),
  starts_at_ms INTEGER NOT NULL CHECK (starts_at_ms >= 0 AND starts_at_ms <= 8640000000000000),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > starts_at_ms AND expires_at_ms <= 8640000000000000),
  daily_quota_micros INTEGER CHECK (daily_quota_micros IS NULL OR (daily_quota_micros >= 0 AND daily_quota_micros <= 9007199254740991)),
  weekly_quota_micros INTEGER CHECK (weekly_quota_micros IS NULL OR (weekly_quota_micros >= 0 AND weekly_quota_micros <= 9007199254740991)),
  monthly_quota_micros INTEGER CHECK (monthly_quota_micros IS NULL OR (monthly_quota_micros >= 0 AND monthly_quota_micros <= 9007199254740991)),
  daily_used_micros INTEGER NOT NULL DEFAULT 0 CHECK (daily_used_micros >= 0 AND daily_used_micros <= 9007199254740991),
  weekly_used_micros INTEGER NOT NULL DEFAULT 0 CHECK (weekly_used_micros >= 0 AND weekly_used_micros <= 9007199254740991),
  monthly_used_micros INTEGER NOT NULL DEFAULT 0 CHECK (monthly_used_micros >= 0 AND monthly_used_micros <= 9007199254740991),
  daily_window_start_ms INTEGER CHECK (daily_window_start_ms IS NULL OR (daily_window_start_ms >= 0 AND daily_window_start_ms <= 8640000000000000)),
  weekly_window_start_ms INTEGER CHECK (weekly_window_start_ms IS NULL OR (weekly_window_start_ms >= 0 AND weekly_window_start_ms <= 8640000000000000)),
  monthly_window_start_ms INTEGER CHECK (monthly_window_start_ms IS NULL OR (monthly_window_start_ms >= 0 AND monthly_window_start_ms <= 8640000000000000)),
  source_type TEXT NOT NULL CHECK (source_type IN ('admin', 'registration', 'redeem', 'payment')),
  source_id TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0 AND control_version <= 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0 AND updated_at_ms <= 8640000000000000),
  UNIQUE(user_id, group_id)
) STRICT;

CREATE INDEX idx_user_subscriptions_user_status_expiry
  ON user_subscriptions(user_id, status, expires_at_ms DESC, id);

CREATE TABLE redeem_codes (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  code_prefix TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('balance', 'subscription')),
  value_micros INTEGER NOT NULL DEFAULT 0 CHECK (value_micros >= 0 AND value_micros <= 9007199254740991),
  group_id TEXT REFERENCES "groups"(id) ON DELETE RESTRICT,
  validity_days INTEGER CHECK (validity_days IS NULL OR (validity_days > 0 AND validity_days <= 36500)),
  status TEXT NOT NULL DEFAULT 'unused'
    CHECK (status IN ('unused', 'processing', 'used', 'expired')),
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR (expires_at_ms >= 0 AND expires_at_ms <= 8640000000000000)),
  used_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  claimed_by_redemption_id TEXT,
  used_at_ms INTEGER CHECK (used_at_ms IS NULL OR (used_at_ms >= 0 AND used_at_ms <= 8640000000000000)),
  notes TEXT NOT NULL DEFAULT '',
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0 AND control_version <= 9007199254740991),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0 AND updated_at_ms <= 8640000000000000),
  CHECK (
    (type = 'balance' AND value_micros > 0 AND group_id IS NULL AND validity_days IS NULL)
    OR
    (type = 'subscription' AND value_micros = 0 AND group_id IS NOT NULL AND validity_days IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_redeem_codes_status_expiry
  ON redeem_codes(status, expires_at_ms, created_at_ms DESC);

CREATE TABLE redemptions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  code_id TEXT NOT NULL UNIQUE REFERENCES redeem_codes(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed')),
  type TEXT NOT NULL CHECK (type IN ('balance', 'subscription')),
  value_micros INTEGER NOT NULL DEFAULT 0 CHECK (value_micros >= 0 AND value_micros <= 9007199254740991),
  subscription_id TEXT REFERENCES user_subscriptions(id) ON DELETE SET NULL,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  effect_started_at_ms INTEGER
    CHECK (effect_started_at_ms IS NULL OR (effect_started_at_ms >= created_at_ms AND effect_started_at_ms <= 8640000000000000)),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR (completed_at_ms >= created_at_ms AND completed_at_ms <= 8640000000000000)),
  UNIQUE(user_id, idempotency_key_hash)
) STRICT;

CREATE INDEX idx_redemptions_user_time
  ON redemptions(user_id, created_at_ms DESC, id);

CREATE TABLE subscription_events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES user_subscriptions(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('assigned', 'extended', 'revoked', 'restored', 'quota_reset')),
  source_type TEXT NOT NULL CHECK (source_type IN ('admin', 'registration', 'redeem', 'payment', 'system')),
  source_id TEXT NOT NULL,
  validity_days INTEGER CHECK (validity_days IS NULL OR (validity_days > 0 AND validity_days <= 36500)),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0 AND occurred_at_ms <= 8640000000000000),
  UNIQUE(source_type, source_id, event_type)
) STRICT;

CREATE INDEX idx_subscription_events_subscription_time
  ON subscription_events(subscription_id, occurred_at_ms DESC, id);

CREATE TRIGGER validate_redemption_claim_insert
BEFORE INSERT ON redemptions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM redeem_codes rc
   WHERE rc.id = NEW.code_id
     AND rc.status = 'processing'
     AND rc.used_by_user_id = NEW.user_id
     AND rc.claimed_by_redemption_id = NEW.id
     AND rc.type = NEW.type
     AND rc.value_micros = NEW.value_micros
)
BEGIN
  SELECT RAISE(ABORT, 'redeem_code_unavailable');
END;

CREATE TRIGGER prevent_redemption_identity_rewrite
BEFORE UPDATE OF code_id, user_id, idempotency_key_hash, type, value_micros, created_at_ms
ON redemptions
BEGIN
  SELECT RAISE(ABORT, 'immutable_redemption');
END;

CREATE TRIGGER validate_redemption_effect_start
BEFORE UPDATE OF effect_started_at_ms ON redemptions
FOR EACH ROW
WHEN NEW.effect_started_at_ms IS NOT NULL
 AND (
   NEW.status <> 'processing'
   OR NEW.effect_started_at_ms < NEW.created_at_ms
   OR NEW.effect_started_at_ms > 8640000000000000
   OR NOT EXISTS (
     SELECT 1 FROM redeem_codes code
      WHERE code.id = NEW.code_id
        AND code.status = 'processing'
        AND code.used_by_user_id = NEW.user_id
        AND code.claimed_by_redemption_id = NEW.id
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'redeem_code_unavailable');
END;

CREATE TRIGGER prevent_redemption_effect_start_rewrite
BEFORE UPDATE OF effect_started_at_ms ON redemptions
FOR EACH ROW
WHEN OLD.effect_started_at_ms IS NOT NULL
 AND NEW.effect_started_at_ms IS NOT OLD.effect_started_at_ms
BEGIN
  SELECT RAISE(ABORT, 'immutable_redemption_effect_start');
END;

CREATE TRIGGER prevent_started_redemption_delete
BEFORE DELETE ON redemptions
FOR EACH ROW
WHEN OLD.effect_started_at_ms IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'redemption_effect_already_started');
END;

CREATE TRIGGER prevent_started_redemption_code_release
BEFORE UPDATE OF status, used_by_user_id, claimed_by_redemption_id ON redeem_codes
FOR EACH ROW
WHEN OLD.status = 'processing'
 AND (NEW.status NOT IN ('processing', 'used')
   OR NEW.used_by_user_id IS NOT OLD.used_by_user_id
   OR NEW.claimed_by_redemption_id IS NOT OLD.claimed_by_redemption_id)
 AND EXISTS (
   SELECT 1 FROM redemptions redemption
    WHERE redemption.id = OLD.claimed_by_redemption_id
      AND redemption.code_id = OLD.id
      AND redemption.effect_started_at_ms IS NOT NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'redemption_effect_already_started');
END;

CREATE TRIGGER validate_redeem_code_closeout
BEFORE UPDATE OF status ON redeem_codes
FOR EACH ROW
WHEN OLD.status = 'processing'
 AND NEW.status = 'used'
 AND NOT EXISTS (
   SELECT 1 FROM redemptions redemption
    WHERE redemption.id = OLD.claimed_by_redemption_id
      AND redemption.code_id = OLD.id
      AND redemption.user_id = OLD.used_by_user_id
      AND redemption.status = 'processing'
 )
BEGIN
  SELECT RAISE(ABORT, 'redemption_claim_missing');
END;

CREATE TRIGGER validate_redemption_closeout
BEFORE UPDATE OF status ON redemptions
FOR EACH ROW
WHEN OLD.status = 'processing'
 AND NEW.status = 'completed'
 AND (
   NEW.result_json IS NULL
   OR NEW.completed_at_ms IS NULL
   OR NOT EXISTS (
     SELECT 1 FROM redeem_codes code
      WHERE code.id = NEW.code_id
        AND code.status = 'used'
        AND code.used_by_user_id = NEW.user_id
        AND code.claimed_by_redemption_id = NEW.id
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'redemption_code_not_used');
END;

CREATE TRIGGER validate_subscription_redemption_closeout
BEFORE UPDATE OF status ON redemptions
FOR EACH ROW
WHEN OLD.status = 'processing'
 AND NEW.status = 'completed'
 AND NEW.type = 'subscription'
 AND (
   NEW.subscription_id IS NULL
   OR NOT EXISTS (
     SELECT 1 FROM subscription_events event
      WHERE event.subscription_id = NEW.subscription_id
        AND event.user_id = NEW.user_id
        AND event.source_type = 'redeem'
        AND event.source_id = NEW.id
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'redemption_subscription_event_missing');
END;

CREATE TRIGGER validate_subscription_plan_group_insert
BEFORE INSERT ON subscription_plans
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM "groups"
   WHERE id = NEW.group_id AND group_type = 'subscription'
)
BEGIN
  SELECT RAISE(ABORT, 'subscription_plan_requires_subscription_group');
END;

CREATE TRIGGER validate_subscription_plan_group_update
BEFORE UPDATE OF group_id ON subscription_plans
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM "groups"
   WHERE id = NEW.group_id AND group_type = 'subscription'
)
BEGIN
  SELECT RAISE(ABORT, 'subscription_plan_requires_subscription_group');
END;

CREATE TRIGGER validate_subscription_redeem_code_group_insert
BEFORE INSERT ON redeem_codes
FOR EACH ROW
WHEN NEW.type = 'subscription'
 AND NOT EXISTS (
   SELECT 1 FROM "groups"
    WHERE id = NEW.group_id AND group_type = 'subscription'
 )
BEGIN
  SELECT RAISE(ABORT, 'subscription_redeem_code_requires_subscription_group');
END;

CREATE TRIGGER validate_subscription_redeem_code_group_update
BEFORE UPDATE OF type, group_id ON redeem_codes
FOR EACH ROW
WHEN NEW.type = 'subscription'
 AND NOT EXISTS (
   SELECT 1 FROM "groups"
    WHERE id = NEW.group_id AND group_type = 'subscription'
 )
BEGIN
  SELECT RAISE(ABORT, 'subscription_redeem_code_requires_subscription_group');
END;

CREATE TRIGGER validate_user_subscription_group_insert
BEFORE INSERT ON user_subscriptions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM "groups"
   WHERE id = NEW.group_id AND group_type = 'subscription'
)
BEGIN
  SELECT RAISE(ABORT, 'user_subscription_requires_subscription_group');
END;

CREATE TRIGGER validate_user_subscription_group_update
BEFORE UPDATE OF group_id ON user_subscriptions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM "groups"
   WHERE id = NEW.group_id AND group_type = 'subscription'
)
BEGIN
  SELECT RAISE(ABORT, 'user_subscription_requires_subscription_group');
END;

CREATE TRIGGER validate_user_subscription_timestamps_insert
BEFORE INSERT ON user_subscriptions
FOR EACH ROW
WHEN NEW.starts_at_ms < 0 OR NEW.starts_at_ms > 8640000000000000
  OR NEW.expires_at_ms <= NEW.starts_at_ms OR NEW.expires_at_ms > 8640000000000000
  OR NEW.created_at_ms < 0 OR NEW.created_at_ms > 8640000000000000
  OR NEW.updated_at_ms < 0 OR NEW.updated_at_ms > 8640000000000000
  OR (NEW.daily_window_start_ms IS NOT NULL
    AND (NEW.daily_window_start_ms < 0 OR NEW.daily_window_start_ms > 8640000000000000))
  OR (NEW.weekly_window_start_ms IS NOT NULL
    AND (NEW.weekly_window_start_ms < 0 OR NEW.weekly_window_start_ms > 8640000000000000))
  OR (NEW.monthly_window_start_ms IS NOT NULL
    AND (NEW.monthly_window_start_ms < 0 OR NEW.monthly_window_start_ms > 8640000000000000))
BEGIN
  SELECT RAISE(ABORT, 'invalid_subscription_timestamp');
END;

CREATE TRIGGER validate_user_subscription_timestamps_update
BEFORE UPDATE OF starts_at_ms, expires_at_ms, created_at_ms, updated_at_ms,
  daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms
ON user_subscriptions
FOR EACH ROW
WHEN NEW.starts_at_ms < 0 OR NEW.starts_at_ms > 8640000000000000
  OR NEW.expires_at_ms <= NEW.starts_at_ms OR NEW.expires_at_ms > 8640000000000000
  OR NEW.created_at_ms < 0 OR NEW.created_at_ms > 8640000000000000
  OR NEW.updated_at_ms < 0 OR NEW.updated_at_ms > 8640000000000000
  OR (NEW.daily_window_start_ms IS NOT NULL
    AND (NEW.daily_window_start_ms < 0 OR NEW.daily_window_start_ms > 8640000000000000))
  OR (NEW.weekly_window_start_ms IS NOT NULL
    AND (NEW.weekly_window_start_ms < 0 OR NEW.weekly_window_start_ms > 8640000000000000))
  OR (NEW.monthly_window_start_ms IS NOT NULL
    AND (NEW.monthly_window_start_ms < 0 OR NEW.monthly_window_start_ms > 8640000000000000))
BEGIN
  SELECT RAISE(ABORT, 'invalid_subscription_timestamp');
END;

CREATE TRIGGER validate_user_subscription_plan_insert
BEFORE INSERT ON user_subscriptions
FOR EACH ROW
WHEN NEW.plan_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM subscription_plans plan
    WHERE plan.id = NEW.plan_id AND plan.group_id = NEW.group_id
 )
BEGIN
  SELECT RAISE(ABORT, 'user_subscription_plan_group_mismatch');
END;

CREATE TRIGGER validate_user_subscription_plan_update
BEFORE UPDATE OF plan_id, group_id ON user_subscriptions
FOR EACH ROW
WHEN NEW.plan_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM subscription_plans plan
    WHERE plan.id = NEW.plan_id AND plan.group_id = NEW.group_id
 )
BEGIN
  SELECT RAISE(ABORT, 'user_subscription_plan_group_mismatch');
END;

CREATE TRIGGER prevent_subscription_plan_group_rewrite_in_use
BEFORE UPDATE OF group_id ON subscription_plans
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM user_subscriptions subscription
   WHERE subscription.plan_id = OLD.id
     AND subscription.group_id <> NEW.group_id
)
BEGIN
  SELECT RAISE(ABORT, 'subscription_plan_group_in_use');
END;

CREATE TRIGGER validate_subscription_event_identity_insert
BEFORE INSERT ON subscription_events
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM user_subscriptions subscription
   WHERE subscription.id = NEW.subscription_id
     AND subscription.user_id = NEW.user_id
     AND subscription.group_id = NEW.group_id
)
BEGIN
  SELECT RAISE(ABORT, 'subscription_event_identity_mismatch');
END;

CREATE TRIGGER validate_subscription_event_identity_update
BEFORE UPDATE OF subscription_id, user_id, group_id ON subscription_events
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM user_subscriptions subscription
   WHERE subscription.id = NEW.subscription_id
     AND subscription.user_id = NEW.user_id
     AND subscription.group_id = NEW.group_id
)
BEGIN
  SELECT RAISE(ABORT, 'subscription_event_identity_mismatch');
END;

CREATE TRIGGER validate_redeem_subscription_event_claim
BEFORE INSERT ON subscription_events
FOR EACH ROW
WHEN NEW.source_type = 'redeem'
 AND NOT EXISTS (
   SELECT 1
     FROM redemptions redemption
     JOIN redeem_codes code ON code.id = redemption.code_id
    WHERE redemption.id = NEW.source_id
      AND redemption.user_id = NEW.user_id
      AND redemption.status = 'processing'
      AND redemption.type = 'subscription'
      AND code.type = 'subscription'
      AND code.group_id = NEW.group_id
      AND code.status = 'processing'
      AND code.used_by_user_id = NEW.user_id
      AND code.claimed_by_redemption_id = redemption.id
 )
BEGIN
  SELECT RAISE(ABORT, 'redeem_code_unavailable');
END;

CREATE TRIGGER validate_redeem_subscription_event_claim_update
BEFORE UPDATE OF subscription_id, user_id, group_id, source_type, source_id
ON subscription_events
FOR EACH ROW
WHEN NEW.source_type = 'redeem'
 AND NOT EXISTS (
   SELECT 1
     FROM redemptions redemption
     JOIN redeem_codes code ON code.id = redemption.code_id
    WHERE redemption.id = NEW.source_id
      AND redemption.user_id = NEW.user_id
      AND redemption.status = 'processing'
      AND redemption.type = 'subscription'
      AND code.type = 'subscription'
      AND code.group_id = NEW.group_id
      AND code.status = 'processing'
      AND code.used_by_user_id = NEW.user_id
      AND code.claimed_by_redemption_id = redemption.id
 )
BEGIN
  SELECT RAISE(ABORT, 'redeem_code_unavailable');
END;

CREATE TRIGGER validate_standard_group_quotas_insert
BEFORE INSERT ON "groups"
FOR EACH ROW
WHEN NEW.group_type = 'standard'
 AND (NEW.daily_quota_micros IS NOT NULL
   OR NEW.weekly_quota_micros IS NOT NULL
   OR NEW.monthly_quota_micros IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid_group_standard_subscription_quota');
END;

CREATE TRIGGER validate_standard_group_quotas_update
BEFORE UPDATE OF group_type, daily_quota_micros, weekly_quota_micros, monthly_quota_micros
ON "groups"
FOR EACH ROW
WHEN NEW.group_type = 'standard'
 AND (NEW.daily_quota_micros IS NOT NULL
   OR NEW.weekly_quota_micros IS NOT NULL
   OR NEW.monthly_quota_micros IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid_group_standard_subscription_quota');
END;

CREATE TRIGGER prevent_referenced_subscription_group_downgrade
BEFORE UPDATE OF group_type ON "groups"
FOR EACH ROW
WHEN OLD.group_type = 'subscription'
 AND NEW.group_type = 'standard'
 AND (
   EXISTS (SELECT 1 FROM subscription_plans WHERE group_id = OLD.id)
   OR EXISTS (SELECT 1 FROM redeem_codes WHERE group_id = OLD.id)
   OR EXISTS (SELECT 1 FROM user_subscriptions WHERE group_id = OLD.id)
 )
BEGIN
  SELECT RAISE(ABORT, 'invalid_group_has_subscription_relations');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (11, 'commerce_core', CAST(unixepoch('subsec') * 1000 AS INTEGER));
