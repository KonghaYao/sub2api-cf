PRAGMA foreign_keys = ON;

-- Each paid subscription order contributes one immutable term.  The mutable
-- refunded duration is the exact portion of that contribution that has been
-- withdrawn; it is never inferred from the subscription's current tail.
CREATE TABLE payment_subscription_terms (
  order_id TEXT PRIMARY KEY REFERENCES payment_orders(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES user_subscriptions(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE RESTRICT,
  term_kind TEXT NOT NULL CHECK (term_kind IN ('initial', 'extended', 'restarted', 'legacy')),
  previous_status TEXT CHECK (
    previous_status IS NULL OR previous_status IN ('active', 'suspended', 'revoked', 'expired')
  ),
  previous_starts_at_ms INTEGER CHECK (
    previous_starts_at_ms IS NULL
    OR (previous_starts_at_ms >= 0 AND previous_starts_at_ms <= 8640000000000000)
  ),
  previous_expires_at_ms INTEGER CHECK (
    previous_expires_at_ms IS NULL
    OR (previous_expires_at_ms >= 0 AND previous_expires_at_ms <= 8640000000000000)
  ),
  starts_at_ms INTEGER NOT NULL
    CHECK (starts_at_ms >= 0 AND starts_at_ms <= 8640000000000000),
  expires_at_ms INTEGER NOT NULL
    CHECK (expires_at_ms > starts_at_ms AND expires_at_ms <= 8640000000000000),
  granted_duration_ms INTEGER NOT NULL
    CHECK (granted_duration_ms > 0 AND granted_duration_ms <= 3153600000000),
  refunded_duration_ms INTEGER NOT NULL DEFAULT 0
    CHECK (refunded_duration_ms >= 0 AND refunded_duration_ms <= granted_duration_ms),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= created_at_ms AND updated_at_ms <= 8640000000000000),
  CHECK (
    (term_kind IN ('initial', 'legacy') AND previous_status IS NULL
      AND previous_starts_at_ms IS NULL AND previous_expires_at_ms IS NULL)
    OR
    (term_kind IN ('extended', 'restarted') AND previous_status IS NOT NULL
      AND previous_starts_at_ms IS NOT NULL AND previous_expires_at_ms IS NOT NULL)
  ),
  CHECK (
    (term_kind = 'extended' AND expires_at_ms - previous_expires_at_ms = granted_duration_ms)
    OR (term_kind <> 'extended' AND expires_at_ms - starts_at_ms = granted_duration_ms)
  )
) STRICT;

CREATE INDEX idx_payment_subscription_terms_subscription
  ON payment_subscription_terms(subscription_id, created_at_ms, order_id);

-- Older Workers already wrote one immutable subscription event per paid order.
-- Although their before/after snapshots cannot be reconstructed, that event
-- still proves the exact granted duration and target entitlement needed by the
-- new proportional refund path.
INSERT INTO payment_subscription_terms (
  order_id, subscription_id, user_id, group_id, term_kind,
  previous_status, previous_starts_at_ms, previous_expires_at_ms,
  starts_at_ms, expires_at_ms, granted_duration_ms,
  refunded_duration_ms, created_at_ms, updated_at_ms
)
SELECT payment_order.id, event.subscription_id, event.user_id, event.group_id, 'legacy',
       NULL, NULL, NULL,
       event.occurred_at_ms,
       event.occurred_at_ms + event.validity_days * 86400000,
       event.validity_days * 86400000,
       0, event.occurred_at_ms, event.occurred_at_ms
  FROM payment_orders payment_order
  JOIN subscription_events event
    ON event.source_type = 'payment' AND event.source_id = payment_order.id
   AND event.event_type IN ('assigned', 'extended')
 WHERE payment_order.order_type = 'subscription'
   AND event.validity_days IS NOT NULL
   AND event.validity_days BETWEEN 1 AND 36500
   AND event.occurred_at_ms <= 8640000000000000 - event.validity_days * 86400000
ON CONFLICT(order_id) DO NOTHING;

CREATE TRIGGER prevent_payment_subscription_term_grant_update
BEFORE UPDATE OF
  order_id, subscription_id, user_id, group_id, term_kind,
  previous_status, previous_starts_at_ms, previous_expires_at_ms,
  starts_at_ms, expires_at_ms, granted_duration_ms, created_at_ms
ON payment_subscription_terms
FOR EACH ROW
WHEN OLD.order_id IS NOT NEW.order_id
  OR OLD.subscription_id IS NOT NEW.subscription_id
  OR OLD.user_id IS NOT NEW.user_id
  OR OLD.group_id IS NOT NEW.group_id
  OR OLD.term_kind IS NOT NEW.term_kind
  OR OLD.previous_status IS NOT NEW.previous_status
  OR OLD.previous_starts_at_ms IS NOT NEW.previous_starts_at_ms
  OR OLD.previous_expires_at_ms IS NOT NEW.previous_expires_at_ms
  OR OLD.starts_at_ms IS NOT NEW.starts_at_ms
  OR OLD.expires_at_ms IS NOT NEW.expires_at_ms
  OR OLD.granted_duration_ms IS NOT NEW.granted_duration_ms
  OR OLD.created_at_ms IS NOT NEW.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'payment_subscription_term_grant_immutable');
END;

CREATE TRIGGER prevent_payment_subscription_term_delete
BEFORE DELETE ON payment_subscription_terms
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'payment_subscription_term_delete_forbidden');
END;

ALTER TABLE payment_refunds ADD COLUMN clawback_duration_ms INTEGER NOT NULL DEFAULT 0
  CHECK (clawback_duration_ms >= 0 AND clawback_duration_ms <= 3153600000000);
ALTER TABLE payment_refunds ADD COLUMN clawback_term_refunded_before_ms INTEGER NOT NULL DEFAULT 0
  CHECK (
    clawback_term_refunded_before_ms >= 0
    AND clawback_term_refunded_before_ms <= 3153600000000
  );
ALTER TABLE payment_refunds ADD COLUMN provider_idempotency_key_version INTEGER NOT NULL DEFAULT 0
  CHECK (provider_idempotency_key_version IN (0, 1));

-- Preserve in-flight and completed legacy clawbacks.  The old implementation
-- always withdrew the whole snapshotted day count, even for a partial provider
-- refund, so its already-applied side effect must be represented as-is.
UPDATE payment_refunds
   SET clawback_duration_ms = clawback_days * 86400000
 WHERE clawback_kind = 'subscription' AND clawback_days > 0;

UPDATE payment_subscription_terms
   SET refunded_duration_ms = MIN(
         granted_duration_ms,
         COALESCE((
           SELECT refund.clawback_duration_ms
             FROM payment_refunds refund
            WHERE refund.order_id = payment_subscription_terms.order_id
              AND refund.clawback_kind = 'subscription'
              AND refund.clawback_status IN ('applied', 'rollback_pending')
            LIMIT 1
         ), 0)
       ),
       updated_at_ms = MAX(
         updated_at_ms,
         COALESCE((
           SELECT refund.updated_at_ms
             FROM payment_refunds refund
            WHERE refund.order_id = payment_subscription_terms.order_id
              AND refund.clawback_kind = 'subscription'
              AND refund.clawback_status IN ('applied', 'rollback_pending')
            LIMIT 1
         ), updated_at_ms)
       )
 WHERE EXISTS (
   SELECT 1 FROM payment_refunds refund
    WHERE refund.order_id = payment_subscription_terms.order_id
      AND refund.clawback_kind = 'subscription'
      AND refund.clawback_status IN ('applied', 'rollback_pending')
 );

CREATE TRIGGER prevent_payment_refund_clawback_duration_update
BEFORE UPDATE OF
  clawback_duration_ms, clawback_term_refunded_before_ms, provider_idempotency_key_version
ON payment_refunds
FOR EACH ROW
WHEN OLD.clawback_duration_ms IS NOT NEW.clawback_duration_ms
  OR OLD.clawback_term_refunded_before_ms IS NOT NEW.clawback_term_refunded_before_ms
  OR OLD.provider_idempotency_key_version IS NOT NEW.provider_idempotency_key_version
BEGIN
  SELECT RAISE(ABORT, 'payment_refund_clawback_duration_immutable');
END;

CREATE TRIGGER validate_payment_subscription_term_refund_update
BEFORE UPDATE OF refunded_duration_ms ON payment_subscription_terms
FOR EACH ROW
WHEN OLD.refunded_duration_ms IS NOT NEW.refunded_duration_ms
 AND NOT EXISTS (
   SELECT 1 FROM payment_refunds refund
    WHERE refund.order_id = OLD.order_id
      AND refund.clawback_kind = 'subscription'
      AND refund.clawback_resource_id = OLD.subscription_id
      AND refund.clawback_duration_ms = ABS(NEW.refunded_duration_ms - OLD.refunded_duration_ms)
      AND (
        (
          refund.clawback_status = 'pending'
          AND OLD.refunded_duration_ms = refund.clawback_term_refunded_before_ms
          AND NEW.refunded_duration_ms =
            refund.clawback_term_refunded_before_ms + refund.clawback_duration_ms
        )
        OR
        (
          refund.clawback_status IN ('applied', 'rollback_pending')
          AND OLD.refunded_duration_ms =
            refund.clawback_term_refunded_before_ms + refund.clawback_duration_ms
          AND NEW.refunded_duration_ms = refund.clawback_term_refunded_before_ms
        )
      )
 )
BEGIN
  SELECT RAISE(ABORT, 'payment_subscription_term_refund_invalid');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (36, 'payment_subscription_terms', CAST(unixepoch('subsec') * 1000 AS INTEGER));
