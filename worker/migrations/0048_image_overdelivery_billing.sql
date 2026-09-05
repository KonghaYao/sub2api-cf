PRAGMA foreign_keys = ON;

-- A provider can return more completed Images outputs than the client asked
-- for. The final cost is authoritative, so a balance-backed user may carry a
-- bounded, explicit debt when the originally funded hold cannot cover every
-- paid output. Positive balance adjustments repay this debt before becoming
-- newly spendable balance.
ALTER TABLE users ADD COLUMN spend_debt_micros INTEGER NOT NULL DEFAULT 0
  CHECK (spend_debt_micros >= 0 AND spend_debt_micros <= 9007199254740991);

-- Existing rows and old-Worker inserts already reserved their final amount and
-- therefore default to a completed ensure barrier. New settlement.command.v2
-- rows explicitly record the initial hold and set this to zero only when the
-- final amount is larger. Recovery must commit all authorities before it may
-- settle any of them.
ALTER TABLE settlement_recovery ADD COLUMN initial_reserved_micros INTEGER
  CHECK (
    initial_reserved_micros IS NULL OR
    (initial_reserved_micros >= 0 AND initial_reserved_micros <= 9007199254740991)
  );
ALTER TABLE settlement_recovery ADD COLUMN reservations_ensured INTEGER NOT NULL DEFAULT 1
  CHECK (reservations_ensured IN (0, 1));

CREATE INDEX idx_settlement_recovery_ensure_barrier
  ON settlement_recovery(available_at_ms, reservations_ensured, request_id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (48, 'image_overdelivery_billing', CAST(unixepoch('subsec') * 1000 AS INTEGER));
