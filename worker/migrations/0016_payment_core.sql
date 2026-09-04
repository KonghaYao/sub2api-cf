PRAGMA foreign_keys = ON;

-- The single public payment policy row is deliberately disabled by default.
-- Monetary limits use micros and all configurable rates use parts per million.
CREATE TABLE payment_config (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  min_amount_micros INTEGER NOT NULL DEFAULT 0
    CHECK (min_amount_micros >= 0 AND min_amount_micros <= 9007199254740991),
  max_amount_micros INTEGER NOT NULL DEFAULT 0
    CHECK (max_amount_micros >= 0 AND max_amount_micros <= 9007199254740991),
  daily_limit_micros INTEGER NOT NULL DEFAULT 0
    CHECK (daily_limit_micros >= 0 AND daily_limit_micros <= 9007199254740991),
  order_timeout_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (order_timeout_minutes >= 1 AND order_timeout_minutes <= 1440),
  max_pending_orders INTEGER NOT NULL DEFAULT 3
    CHECK (max_pending_orders >= 1 AND max_pending_orders <= 100),
  balance_disabled INTEGER NOT NULL DEFAULT 0 CHECK (balance_disabled IN (0, 1)),
  balance_recharge_multiplier_ppm INTEGER NOT NULL DEFAULT 1000000
    CHECK (
      balance_recharge_multiplier_ppm >= 0
      AND balance_recharge_multiplier_ppm <= 9007199254740991
    ),
  subscription_usd_to_cny_rate_ppm INTEGER NOT NULL DEFAULT 0
    CHECK (
      subscription_usd_to_cny_rate_ppm >= 0
      AND subscription_usd_to_cny_rate_ppm <= 9007199254740991
    ),
  recharge_fee_ppm INTEGER NOT NULL DEFAULT 0
    CHECK (recharge_fee_ppm >= 0 AND recharge_fee_ppm <= 1000000),
  product_name_prefix TEXT NOT NULL DEFAULT '',
  product_name_suffix TEXT NOT NULL DEFAULT '',
  help_url TEXT NOT NULL DEFAULT '',
  help_text TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0
    CHECK (version >= 0 AND version <= 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= created_at_ms AND updated_at_ms <= 8640000000000000),
  CHECK (max_amount_micros = 0 OR max_amount_micros >= min_amount_micros)
) STRICT;

INSERT INTO payment_config (id, created_at_ms, updated_at_ms)
VALUES (
  'global',
  CAST(unixepoch('subsec') * 1000 AS INTEGER),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
);

-- Payment credentials are encrypted by the Worker with a key kept in a
-- Cloudflare secret. D1 stores only the ciphertext envelope and key metadata.
CREATE TABLE payment_provider_instances (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  provider_key TEXT NOT NULL UNIQUE CHECK (length(provider_key) BETWEEN 1 AND 64),
  provider_type TEXT NOT NULL CHECK (
    provider_type IN (
      'alipay', 'wxpay', 'alipay_direct', 'wxpay_direct',
      'stripe', 'easypay', 'airwallex'
    )
  ),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  config_ciphertext TEXT NOT NULL CHECK (length(config_ciphertext) > 0),
  config_nonce TEXT NOT NULL CHECK (length(config_nonce) > 0),
  config_key_id TEXT NOT NULL CHECK (length(config_key_id) > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 0
    CHECK (version >= 0 AND version <= 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= created_at_ms AND updated_at_ms <= 8640000000000000)
) STRICT;

CREATE INDEX idx_payment_provider_instances_enabled
  ON payment_provider_instances(enabled, provider_type, provider_key);

-- The checkout contract is snapshotted on the order. Later plan edits cannot
-- change either the amount collected or the entitlement that will be granted.
CREATE TABLE payment_orders (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_instance_id TEXT NOT NULL
    REFERENCES payment_provider_instances(id) ON DELETE RESTRICT,
  provider_key_snapshot TEXT NOT NULL CHECK (length(provider_key_snapshot) BETWEEN 1 AND 64),
  out_trade_no TEXT NOT NULL UNIQUE CHECK (length(out_trade_no) BETWEEN 1 AND 128),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  provider_order_id TEXT CHECK (provider_order_id IS NULL OR length(provider_order_id) BETWEEN 1 AND 200),
  payment_intent_id TEXT CHECK (payment_intent_id IS NULL OR length(payment_intent_id) BETWEEN 1 AND 200),
  payment_trade_no TEXT CHECK (payment_trade_no IS NULL OR length(payment_trade_no) BETWEEN 1 AND 200),
  pay_url TEXT,
  order_type TEXT NOT NULL CHECK (order_type IN ('balance', 'subscription')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN (
      'PENDING', 'PAID', 'RECHARGING', 'COMPLETED', 'EXPIRED',
      'CANCELLED', 'FAILED', 'REFUND_REQUESTED', 'REFUNDING',
      'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_FAILED'
    )
  ),
  amount_micros INTEGER NOT NULL
    CHECK (amount_micros > 0 AND amount_micros <= 9007199254740991),
  pay_amount_micros INTEGER NOT NULL
    CHECK (pay_amount_micros >= amount_micros AND pay_amount_micros <= 9007199254740991),
  fee_ppm_snapshot INTEGER NOT NULL DEFAULT 0
    CHECK (fee_ppm_snapshot >= 0 AND fee_ppm_snapshot <= 1000000),
  paid_amount_micros INTEGER NOT NULL DEFAULT 0
    CHECK (paid_amount_micros >= 0 AND paid_amount_micros <= 9007199254740991),
  refunded_amount_micros INTEGER NOT NULL DEFAULT 0
    CHECK (
      refunded_amount_micros >= 0
      AND refunded_amount_micros <= paid_amount_micros
      AND refunded_amount_micros <= 9007199254740991
    ),
  currency TEXT NOT NULL CHECK (
    length(currency) = 3 AND currency = upper(currency) AND currency NOT GLOB '*[^A-Z]*'
  ),
  plan_id TEXT REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  plan_name_snapshot TEXT,
  plan_group_id_snapshot TEXT,
  plan_validity_days_snapshot INTEGER CHECK (
    plan_validity_days_snapshot IS NULL
    OR (plan_validity_days_snapshot > 0 AND plan_validity_days_snapshot <= 36500)
  ),
  plan_price_micros_snapshot INTEGER CHECK (
    plan_price_micros_snapshot IS NULL
    OR (plan_price_micros_snapshot >= 0 AND plan_price_micros_snapshot <= 9007199254740991)
  ),
  plan_currency_snapshot TEXT CHECK (
    plan_currency_snapshot IS NULL
    OR (
      length(plan_currency_snapshot) = 3
      AND plan_currency_snapshot = upper(plan_currency_snapshot)
      AND plan_currency_snapshot NOT GLOB '*[^A-Z]*'
    )
  ),
  plan_daily_quota_micros_snapshot INTEGER CHECK (
    plan_daily_quota_micros_snapshot IS NULL
    OR (plan_daily_quota_micros_snapshot >= 0 AND plan_daily_quota_micros_snapshot <= 9007199254740991)
  ),
  plan_weekly_quota_micros_snapshot INTEGER CHECK (
    plan_weekly_quota_micros_snapshot IS NULL
    OR (plan_weekly_quota_micros_snapshot >= 0 AND plan_weekly_quota_micros_snapshot <= 9007199254740991)
  ),
  plan_monthly_quota_micros_snapshot INTEGER CHECK (
    plan_monthly_quota_micros_snapshot IS NULL
    OR (plan_monthly_quota_micros_snapshot >= 0 AND plan_monthly_quota_micros_snapshot <= 9007199254740991)
  ),
  fulfillment_started_at_ms INTEGER CHECK (
    fulfillment_started_at_ms IS NULL
    OR (fulfillment_started_at_ms >= 0 AND fulfillment_started_at_ms <= 8640000000000000)
  ),
  subscription_id TEXT REFERENCES user_subscriptions(id) ON DELETE SET NULL,
  subscription_fulfilled_at_ms INTEGER CHECK (
    subscription_fulfilled_at_ms IS NULL
    OR (subscription_fulfilled_at_ms >= 0 AND subscription_fulfilled_at_ms <= 8640000000000000)
  ),
  refund_requested_at_ms INTEGER CHECK (
    refund_requested_at_ms IS NULL
    OR (refund_requested_at_ms >= 0 AND refund_requested_at_ms <= 8640000000000000)
  ),
  refund_completed_at_ms INTEGER CHECK (
    refund_completed_at_ms IS NULL
    OR (refund_completed_at_ms >= 0 AND refund_completed_at_ms <= 8640000000000000)
  ),
  source_url TEXT NOT NULL DEFAULT '',
  last_error TEXT,
  version INTEGER NOT NULL DEFAULT 0
    CHECK (version >= 0 AND version <= 9007199254740991),
  expires_at_ms INTEGER NOT NULL
    CHECK (expires_at_ms >= 0 AND expires_at_ms <= 8640000000000000),
  paid_at_ms INTEGER CHECK (paid_at_ms IS NULL OR (paid_at_ms >= 0 AND paid_at_ms <= 8640000000000000)),
  completed_at_ms INTEGER CHECK (
    completed_at_ms IS NULL OR (completed_at_ms >= 0 AND completed_at_ms <= 8640000000000000)
  ),
  failed_at_ms INTEGER CHECK (failed_at_ms IS NULL OR (failed_at_ms >= 0 AND failed_at_ms <= 8640000000000000)),
  failed_reason TEXT,
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= created_at_ms AND updated_at_ms <= 8640000000000000),
  CHECK (expires_at_ms > created_at_ms),
  CHECK (fulfillment_started_at_ms IS NULL OR fulfillment_started_at_ms >= created_at_ms),
  CHECK (
    subscription_fulfilled_at_ms IS NULL
    OR (subscription_id IS NOT NULL AND subscription_fulfilled_at_ms >= created_at_ms)
  ),
  CHECK (refund_requested_at_ms IS NULL OR refund_requested_at_ms >= created_at_ms),
  CHECK (
    refund_completed_at_ms IS NULL
    OR (refund_requested_at_ms IS NOT NULL AND refund_completed_at_ms >= refund_requested_at_ms)
  ),
  UNIQUE(user_id, idempotency_key_hash),
  CHECK (
    (
      order_type = 'subscription'
      AND plan_id IS NOT NULL
      AND plan_name_snapshot IS NOT NULL
      AND length(plan_name_snapshot) > 0
      AND plan_group_id_snapshot IS NOT NULL
      AND length(plan_group_id_snapshot) > 0
      AND plan_validity_days_snapshot IS NOT NULL
      AND plan_price_micros_snapshot IS NOT NULL
      AND plan_currency_snapshot IS NOT NULL
    )
    OR (
      order_type = 'balance'
      AND plan_id IS NULL
      AND plan_name_snapshot IS NULL
      AND plan_group_id_snapshot IS NULL
      AND plan_validity_days_snapshot IS NULL
      AND plan_price_micros_snapshot IS NULL
      AND plan_currency_snapshot IS NULL
      AND plan_daily_quota_micros_snapshot IS NULL
      AND plan_weekly_quota_micros_snapshot IS NULL
      AND plan_monthly_quota_micros_snapshot IS NULL
    )
  )
) STRICT;

CREATE INDEX idx_payment_orders_user_time
  ON payment_orders(user_id, created_at_ms DESC, id DESC);
CREATE INDEX idx_payment_orders_status_expiry
  ON payment_orders(status, expires_at_ms, id);
CREATE INDEX idx_payment_orders_provider_trade
  ON payment_orders(provider_instance_id, payment_trade_no)
  WHERE payment_trade_no IS NOT NULL;
CREATE UNIQUE INDEX idx_payment_orders_provider_order
  ON payment_orders(provider_instance_id, provider_order_id)
  WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX idx_payment_orders_payment_intent
  ON payment_orders(provider_instance_id, payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;

CREATE TRIGGER prevent_payment_order_snapshot_update
BEFORE UPDATE OF
  user_id, provider_instance_id, provider_key_snapshot, out_trade_no,
  idempotency_key_hash, request_hash,
  order_type, amount_micros, pay_amount_micros, fee_ppm_snapshot,
  currency, plan_id, plan_name_snapshot,
  plan_group_id_snapshot, plan_validity_days_snapshot,
  plan_price_micros_snapshot, plan_currency_snapshot,
  plan_daily_quota_micros_snapshot, plan_weekly_quota_micros_snapshot,
  plan_monthly_quota_micros_snapshot, created_at_ms
ON payment_orders
FOR EACH ROW
WHEN OLD.user_id IS NOT NEW.user_id
  OR OLD.provider_instance_id IS NOT NEW.provider_instance_id
  OR OLD.provider_key_snapshot IS NOT NEW.provider_key_snapshot
  OR OLD.out_trade_no IS NOT NEW.out_trade_no
  OR OLD.idempotency_key_hash IS NOT NEW.idempotency_key_hash
  OR OLD.request_hash IS NOT NEW.request_hash
  OR OLD.order_type IS NOT NEW.order_type
  OR OLD.amount_micros IS NOT NEW.amount_micros
  OR OLD.pay_amount_micros IS NOT NEW.pay_amount_micros
  OR OLD.fee_ppm_snapshot IS NOT NEW.fee_ppm_snapshot
  OR OLD.currency IS NOT NEW.currency
  OR OLD.plan_id IS NOT NEW.plan_id
  OR OLD.plan_name_snapshot IS NOT NEW.plan_name_snapshot
  OR OLD.plan_group_id_snapshot IS NOT NEW.plan_group_id_snapshot
  OR OLD.plan_validity_days_snapshot IS NOT NEW.plan_validity_days_snapshot
  OR OLD.plan_price_micros_snapshot IS NOT NEW.plan_price_micros_snapshot
  OR OLD.plan_currency_snapshot IS NOT NEW.plan_currency_snapshot
  OR OLD.plan_daily_quota_micros_snapshot IS NOT NEW.plan_daily_quota_micros_snapshot
  OR OLD.plan_weekly_quota_micros_snapshot IS NOT NEW.plan_weekly_quota_micros_snapshot
  OR OLD.plan_monthly_quota_micros_snapshot IS NOT NEW.plan_monthly_quota_micros_snapshot
  OR OLD.created_at_ms IS NOT NEW.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'payment_order_snapshot_immutable');
END;

-- Only hashes and an R2 object key are retained in D1; the raw provider body is
-- never written to a queryable D1 column.
CREATE TABLE payment_webhook_inbox (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  provider_key TEXT NOT NULL
    REFERENCES payment_provider_instances(provider_key) ON DELETE RESTRICT ON UPDATE RESTRICT,
  provider_event_id TEXT NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 255),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 200),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  payload_r2_key TEXT NOT NULL CHECK (length(payload_r2_key) > 0),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'processed', 'ignored', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (attempts >= 0 AND attempts <= 9007199254740991),
  available_at_ms INTEGER NOT NULL
    CHECK (available_at_ms >= 0 AND available_at_ms <= 8640000000000000),
  lease_owner TEXT,
  lease_expires_at_ms INTEGER CHECK (
    lease_expires_at_ms IS NULL OR (lease_expires_at_ms >= 0 AND lease_expires_at_ms <= 8640000000000000)
  ),
  last_error TEXT,
  received_at_ms INTEGER NOT NULL
    CHECK (received_at_ms >= 0 AND received_at_ms <= 8640000000000000),
  processed_at_ms INTEGER CHECK (
    processed_at_ms IS NULL OR (processed_at_ms >= received_at_ms AND processed_at_ms <= 8640000000000000)
  ),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= received_at_ms AND updated_at_ms <= 8640000000000000),
  UNIQUE(provider_key, provider_event_id),
  CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND length(lease_owner) > 0 AND lease_expires_at_ms IS NOT NULL)
    OR (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at_ms IS NULL)
  )
) STRICT;

CREATE INDEX idx_payment_webhook_inbox_pending
  ON payment_webhook_inbox(status, available_at_ms, received_at_ms, id)
  WHERE status IN ('received', 'failed');

CREATE TABLE payment_fulfillments (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  order_id TEXT NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'applied', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (attempts >= 0 AND attempts <= 9007199254740991),
  available_at_ms INTEGER NOT NULL
    CHECK (available_at_ms >= 0 AND available_at_ms <= 8640000000000000),
  lease_owner TEXT,
  lease_expires_at_ms INTEGER CHECK (
    lease_expires_at_ms IS NULL OR (lease_expires_at_ms >= 0 AND lease_expires_at_ms <= 8640000000000000)
  ),
  result_resource_type TEXT,
  result_resource_id TEXT,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= created_at_ms AND updated_at_ms <= 8640000000000000),
  applied_at_ms INTEGER CHECK (
    applied_at_ms IS NULL OR (applied_at_ms >= created_at_ms AND applied_at_ms <= 8640000000000000)
  ),
  UNIQUE(order_id, action),
  CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND length(lease_owner) > 0 AND lease_expires_at_ms IS NOT NULL)
    OR (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at_ms IS NULL)
  )
) STRICT;

CREATE INDEX idx_payment_fulfillments_pending
  ON payment_fulfillments(status, available_at_ms, lease_expires_at_ms, id)
  WHERE status IN ('pending', 'processing', 'failed');

CREATE TABLE payment_refunds (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  order_id TEXT NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
  request_key_hash TEXT NOT NULL CHECK (length(request_key_hash) = 64),
  provider_key TEXT NOT NULL
    REFERENCES payment_provider_instances(provider_key) ON DELETE RESTRICT ON UPDATE RESTRICT,
  provider_refund_id TEXT,
  amount_micros INTEGER NOT NULL
    CHECK (amount_micros > 0 AND amount_micros <= 9007199254740991),
  settled_amount_micros INTEGER NOT NULL DEFAULT 0
    CHECK (
      settled_amount_micros >= 0
      AND settled_amount_micros <= amount_micros
      AND settled_amount_micros <= 9007199254740991
    ),
  currency TEXT NOT NULL CHECK (
    length(currency) = 3 AND currency = upper(currency) AND currency NOT GLOB '*[^A-Z]*'
  ),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (
    status IN ('requested', 'processing', 'pending', 'partially_refunded', 'refunded', 'failed', 'cancelled')
  ),
  reason TEXT NOT NULL DEFAULT '',
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= created_at_ms AND updated_at_ms <= 8640000000000000),
  completed_at_ms INTEGER CHECK (
    completed_at_ms IS NULL OR (completed_at_ms >= created_at_ms AND completed_at_ms <= 8640000000000000)
  ),
  UNIQUE(order_id, request_key_hash)
) STRICT;

CREATE UNIQUE INDEX idx_payment_refunds_provider_id
  ON payment_refunds(provider_key, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
CREATE INDEX idx_payment_refunds_order_time
  ON payment_refunds(order_id, created_at_ms DESC, id DESC);
CREATE INDEX idx_payment_refunds_status_time
  ON payment_refunds(status, updated_at_ms, id);

CREATE TRIGGER prevent_payment_refund_request_update
BEFORE UPDATE OF order_id, request_key_hash, provider_key, amount_micros, currency, created_at_ms
ON payment_refunds
FOR EACH ROW
WHEN OLD.order_id IS NOT NEW.order_id
  OR OLD.request_key_hash IS NOT NEW.request_key_hash
  OR OLD.provider_key IS NOT NEW.provider_key
  OR OLD.amount_micros IS NOT NEW.amount_micros
  OR OLD.currency IS NOT NEW.currency
  OR OLD.created_at_ms IS NOT NEW.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'payment_refund_request_immutable');
END;

CREATE TABLE payment_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  order_id TEXT NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  source_type TEXT NOT NULL CHECK (
    source_type IN ('api', 'webhook', 'queue', 'cron', 'admin', 'provider', 'system')
  ),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 255),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  occurred_at_ms INTEGER NOT NULL
    CHECK (occurred_at_ms >= 0 AND occurred_at_ms <= 8640000000000000),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= occurred_at_ms AND created_at_ms <= 8640000000000000),
  UNIQUE(order_id, event_type, source_id)
) STRICT;

CREATE INDEX idx_payment_events_order_time
  ON payment_events(order_id, occurred_at_ms DESC, id DESC);
CREATE INDEX idx_payment_events_type_time
  ON payment_events(event_type, occurred_at_ms DESC, id DESC);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (16, 'payment_core', CAST(unixepoch('subsec') * 1000 AS INTEGER));
