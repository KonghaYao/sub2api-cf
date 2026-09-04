PRAGMA foreign_keys = ON;

-- A permanent per-order claim makes concurrent requests with different
-- idempotency keys converge on one refund saga without assuming that a prior
-- conditional UPDATE in the same batch changed a row.
CREATE TABLE payment_refund_claims (
  order_id TEXT PRIMARY KEY REFERENCES payment_orders(id) ON DELETE CASCADE,
  refund_id TEXT NOT NULL UNIQUE,
  claimed_at_ms INTEGER NOT NULL
    CHECK (claimed_at_ms >= 0 AND claimed_at_ms <= 8640000000000000)
);

INSERT INTO payment_refund_claims(order_id, refund_id, claimed_at_ms)
SELECT refund.order_id, refund.id, refund.created_at_ms
  FROM payment_refunds AS refund
 WHERE refund.id = (
   SELECT selected.id
     FROM payment_refunds AS selected
    WHERE selected.order_id = refund.order_id
    ORDER BY selected.created_at_ms DESC, selected.id DESC
    LIMIT 1
 );

-- A refund and its commercial clawback form one durable saga. The immutable
-- intent prevents an idempotent retry from changing a courtesy refund into an
-- entitlement deduction (or vice versa), while the mutable status/snapshot
-- columns make provider-pending rollback and final re-application recoverable.
ALTER TABLE payment_refunds ADD COLUMN clawback_kind TEXT NOT NULL DEFAULT 'none'
  CHECK (clawback_kind IN ('none', 'balance', 'subscription'));
ALTER TABLE payment_refunds ADD COLUMN clawback_status TEXT NOT NULL DEFAULT 'not_required'
  CHECK (
    clawback_status IN (
      'not_required', 'pending', 'applied', 'rollback_pending', 'rolled_back', 'skipped'
    )
  );
ALTER TABLE payment_refunds ADD COLUMN clawback_resource_id TEXT;
ALTER TABLE payment_refunds ADD COLUMN clawback_amount_micros INTEGER NOT NULL DEFAULT 0
  CHECK (clawback_amount_micros >= 0 AND clawback_amount_micros <= 9007199254740991);
ALTER TABLE payment_refunds ADD COLUMN clawback_days INTEGER NOT NULL DEFAULT 0
  CHECK (clawback_days >= 0 AND clawback_days <= 36500);
ALTER TABLE payment_refunds ADD COLUMN clawback_forced INTEGER NOT NULL DEFAULT 0
  CHECK (clawback_forced IN (0, 1));
ALTER TABLE payment_refunds ADD COLUMN clawback_previous_status TEXT
  CHECK (clawback_previous_status IS NULL OR clawback_previous_status IN ('active', 'suspended', 'revoked', 'expired'));
ALTER TABLE payment_refunds ADD COLUMN clawback_previous_expires_at_ms INTEGER
  CHECK (
    clawback_previous_expires_at_ms IS NULL
    OR (
      clawback_previous_expires_at_ms >= 0
      AND clawback_previous_expires_at_ms <= 8640000000000000
    )
  );
ALTER TABLE payment_refunds ADD COLUMN clawback_applied_control_version INTEGER
  CHECK (
    clawback_applied_control_version IS NULL
    OR (
      clawback_applied_control_version >= 0
      AND clawback_applied_control_version <= 9007199254740991
    )
  );
ALTER TABLE payment_refunds ADD COLUMN clawback_applied_at_ms INTEGER
  CHECK (
    clawback_applied_at_ms IS NULL
    OR (clawback_applied_at_ms >= created_at_ms AND clawback_applied_at_ms <= 8640000000000000)
  );
ALTER TABLE payment_refunds ADD COLUMN clawback_rolled_back_at_ms INTEGER
  CHECK (
    clawback_rolled_back_at_ms IS NULL
    OR (clawback_rolled_back_at_ms >= created_at_ms AND clawback_rolled_back_at_ms <= 8640000000000000)
  );
ALTER TABLE payment_refunds ADD COLUMN clawback_recovery_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (clawback_recovery_attempts >= 0 AND clawback_recovery_attempts <= 1000);
ALTER TABLE payment_refunds ADD COLUMN clawback_recovery_after_ms INTEGER
  CHECK (
    clawback_recovery_after_ms IS NULL
    OR (clawback_recovery_after_ms >= 0 AND clawback_recovery_after_ms <= 8640000000000000)
  );
ALTER TABLE payment_refunds ADD COLUMN clawback_last_error TEXT;

CREATE INDEX idx_payment_refunds_clawback_recovery
  ON payment_refunds(clawback_status, clawback_recovery_after_ms, id)
  WHERE clawback_status = 'rollback_pending';

CREATE TRIGGER prevent_payment_refund_clawback_intent_update
BEFORE UPDATE OF
  clawback_kind, clawback_resource_id, clawback_amount_micros, clawback_days, clawback_forced
ON payment_refunds
FOR EACH ROW
WHEN OLD.clawback_kind IS NOT NEW.clawback_kind
  OR OLD.clawback_resource_id IS NOT NEW.clawback_resource_id
  OR OLD.clawback_amount_micros IS NOT NEW.clawback_amount_micros
  OR OLD.clawback_days IS NOT NEW.clawback_days
  OR OLD.clawback_forced IS NOT NEW.clawback_forced
BEGIN
  SELECT RAISE(ABORT, 'payment_refund_clawback_intent_immutable');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (19, 'payment_refund_clawback', CAST(unixepoch('subsec') * 1000 AS INTEGER));
