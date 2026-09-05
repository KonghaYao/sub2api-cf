PRAGMA foreign_keys = ON;

-- A provider refund is final even when an already-transferred commission can no
-- longer be removed from UserStateDO. Keep that shortfall as an explicit D1
-- liability and consume later commissions before they become withdrawable.
ALTER TABLE affiliate_profiles
  ADD COLUMN debt_micros INTEGER NOT NULL DEFAULT 0 CHECK (debt_micros >= 0);

DROP INDEX idx_affiliate_rebate_adjustments_rebate;
DROP INDEX idx_affiliate_rebate_adjustments_processing;
DROP TRIGGER affiliate_rebate_adjustment_economics_immutable;
DROP TRIGGER affiliate_rebate_adjustment_delete_immutable;
DROP TRIGGER affiliate_rebate_adjustment_reserve;
DROP TRIGGER affiliate_rebate_adjustment_complete;

ALTER TABLE affiliate_rebate_adjustments RENAME TO affiliate_rebate_adjustments_v1;

CREATE TABLE affiliate_rebate_adjustments (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  rebate_id TEXT NOT NULL REFERENCES affiliate_rebates(id) ON DELETE RESTRICT,
  refund_id TEXT NOT NULL UNIQUE REFERENCES payment_refunds(id) ON DELETE RESTRICT,
  adjustment_kind TEXT NOT NULL CHECK (adjustment_kind IN ('partial_clawback', 'full_void')),
  quota_bucket TEXT NOT NULL CHECK (quota_bucket IN ('none', 'available', 'frozen')),
  refund_amount_micros INTEGER NOT NULL CHECK (refund_amount_micros > 0),
  cumulative_refunded_micros INTEGER NOT NULL CHECK (cumulative_refunded_micros > 0),
  adjustment_micros INTEGER NOT NULL CHECK (adjustment_micros >= 0),
  quota_clawback_micros INTEGER NOT NULL CHECK (quota_clawback_micros >= 0),
  balance_clawback_micros INTEGER NOT NULL CHECK (balance_clawback_micros >= 0),
  balance_recovery_target_micros INTEGER
    CHECK (balance_recovery_target_micros IS NULL OR balance_recovery_target_micros >= 0),
  balance_recovered_micros INTEGER NOT NULL DEFAULT 0 CHECK (balance_recovered_micros >= 0),
  debt_incurred_micros INTEGER NOT NULL DEFAULT 0 CHECK (debt_incurred_micros >= 0),
  debt_reopened_micros INTEGER NOT NULL DEFAULT 0 CHECK (debt_reopened_micros >= 0),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  balance_after_micros INTEGER CHECK (balance_after_micros IS NULL OR balance_after_micros >= 0),
  state_version INTEGER CHECK (state_version IS NULL OR state_version >= 0),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (quota_clawback_micros + balance_clawback_micros + debt_reopened_micros = adjustment_micros),
  CHECK ((quota_clawback_micros = 0) = (quota_bucket = 'none')),
  CHECK (balance_recovery_target_micros IS NULL OR balance_recovery_target_micros <= balance_clawback_micros),
  CHECK (balance_recovered_micros <= COALESCE(balance_recovery_target_micros, 0)),
  CHECK (
    (status = 'processing' AND completed_at_ms IS NULL)
    OR (status = 'completed' AND completed_at_ms IS NOT NULL
      AND balance_recovered_micros + debt_incurred_micros = balance_clawback_micros)
  )
) STRICT;

-- The preceding release always attempted the entire balance clawback using the
-- same deterministic mutation id. Preserve that target for processing rows so
-- an upgrade can replay a response-lost mutation instead of misclassifying it
-- as debt. Completed rows are known to have recovered the full amount.
INSERT INTO affiliate_rebate_adjustments (
  id, schema_version, rebate_id, refund_id, adjustment_kind, quota_bucket,
  refund_amount_micros, cumulative_refunded_micros, adjustment_micros,
  quota_clawback_micros, balance_clawback_micros,
  balance_recovery_target_micros, balance_recovered_micros,
  debt_incurred_micros, debt_reopened_micros, status,
  balance_after_micros, state_version, control_version,
  created_at_ms, completed_at_ms, updated_at_ms
)
SELECT id, schema_version, rebate_id, refund_id, adjustment_kind, quota_bucket,
       refund_amount_micros, cumulative_refunded_micros, adjustment_micros,
       quota_clawback_micros, balance_clawback_micros,
       balance_clawback_micros,
       CASE WHEN status = 'completed' THEN balance_clawback_micros ELSE 0 END,
       0, 0, status, balance_after_micros, state_version, control_version,
       created_at_ms, completed_at_ms, updated_at_ms
  FROM affiliate_rebate_adjustments_v1;

DROP TABLE affiliate_rebate_adjustments_v1;

CREATE INDEX idx_affiliate_rebate_adjustments_rebate
  ON affiliate_rebate_adjustments(rebate_id, created_at_ms, id);
CREATE INDEX idx_affiliate_rebate_adjustments_processing
  ON affiliate_rebate_adjustments(status, updated_at_ms, id)
  WHERE status = 'processing';

CREATE TRIGGER affiliate_rebate_adjustment_economics_immutable
BEFORE UPDATE OF rebate_id, refund_id, adjustment_kind, quota_bucket,
  refund_amount_micros, cumulative_refunded_micros, adjustment_micros,
  quota_clawback_micros, balance_clawback_micros, debt_reopened_micros,
  created_at_ms ON affiliate_rebate_adjustments
BEGIN
  SELECT RAISE(ABORT, 'affiliate_rebate_adjustment_immutable');
END;

CREATE TRIGGER affiliate_rebate_adjustment_delete_immutable
BEFORE DELETE ON affiliate_rebate_adjustments
BEGIN
  SELECT RAISE(ABORT, 'affiliate_rebate_adjustment_immutable');
END;

CREATE INDEX idx_affiliate_profiles_debt
  ON affiliate_profiles(debt_micros DESC, user_id)
  WHERE debt_micros > 0;

CREATE TABLE affiliate_debt_repayments (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source_rebate_id TEXT NOT NULL UNIQUE REFERENCES affiliate_rebates(id) ON DELETE RESTRICT,
  amount_micros INTEGER NOT NULL CHECK (amount_micros > 0),
  debt_before_micros INTEGER NOT NULL CHECK (debt_before_micros >= amount_micros),
  debt_after_micros INTEGER NOT NULL CHECK (
    debt_after_micros = debt_before_micros - amount_micros
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

CREATE INDEX idx_affiliate_debt_repayments_user_time
  ON affiliate_debt_repayments(user_id, created_at_ms DESC, id DESC);

CREATE TRIGGER affiliate_debt_repayment_immutable_update
BEFORE UPDATE ON affiliate_debt_repayments
BEGIN
  SELECT RAISE(ABORT, 'affiliate_debt_repayment_immutable');
END;

CREATE TRIGGER affiliate_debt_repayment_immutable_delete
BEFORE DELETE ON affiliate_debt_repayments
BEGIN
  SELECT RAISE(ABORT, 'affiliate_debt_repayment_immutable');
END;

CREATE TRIGGER affiliate_adjustment_recovery_validate
BEFORE UPDATE OF balance_recovery_target_micros, balance_recovered_micros,
  debt_incurred_micros, debt_reopened_micros, status
ON affiliate_rebate_adjustments
BEGIN
  SELECT CASE
    WHEN OLD.status = 'completed' AND (
      NEW.balance_recovery_target_micros IS NOT OLD.balance_recovery_target_micros
      OR NEW.balance_recovered_micros <> OLD.balance_recovered_micros
      OR NEW.debt_incurred_micros <> OLD.debt_incurred_micros
      OR NEW.debt_reopened_micros <> OLD.debt_reopened_micros
    ) THEN RAISE(ABORT, 'affiliate_rebate_adjustment_immutable')
    WHEN OLD.balance_recovery_target_micros IS NOT NULL
      AND NEW.balance_recovery_target_micros IS NOT OLD.balance_recovery_target_micros
      THEN RAISE(ABORT, 'affiliate_recovery_target_immutable')
    WHEN NEW.balance_recovery_target_micros > NEW.balance_clawback_micros
      OR NEW.balance_recovered_micros > NEW.balance_recovery_target_micros
      OR NEW.debt_reopened_micros > NEW.adjustment_micros
      THEN RAISE(ABORT, 'affiliate_recovery_amount_invalid')
    WHEN NEW.status = 'completed'
      AND NEW.balance_recovered_micros + NEW.debt_incurred_micros
        <> NEW.balance_clawback_micros
      THEN RAISE(ABORT, 'affiliate_recovery_incomplete')
  END;
END;

-- Replace the original projections with debt-aware variants. A later rebate
-- first writes an immutable debt repayment row, then exposes only its net part.
DROP TRIGGER affiliate_rebate_project_insert;

CREATE TRIGGER affiliate_rebate_project_insert
AFTER INSERT ON affiliate_rebates
WHEN NEW.status IN ('frozen', 'available')
BEGIN
  INSERT INTO affiliate_debt_repayments (
    id, user_id, source_rebate_id, amount_micros,
    debt_before_micros, debt_after_micros, created_at_ms
  )
  SELECT NEW.id || ':debt-repayment', NEW.inviter_user_id, NEW.id,
         MIN(debt_micros, NEW.rebate_micros), debt_micros,
         debt_micros - MIN(debt_micros, NEW.rebate_micros), NEW.created_at_ms
    FROM affiliate_profiles
   WHERE user_id = NEW.inviter_user_id AND debt_micros > 0;

  UPDATE affiliate_profiles
     SET available_micros = available_micros +
           CASE WHEN NEW.status = 'available' THEN NEW.rebate_micros - COALESCE((
             SELECT amount_micros FROM affiliate_debt_repayments
              WHERE source_rebate_id = NEW.id
           ), 0) ELSE 0 END,
         frozen_micros = frozen_micros +
           CASE WHEN NEW.status = 'frozen' THEN NEW.rebate_micros - COALESCE((
             SELECT amount_micros FROM affiliate_debt_repayments
              WHERE source_rebate_id = NEW.id
           ), 0) ELSE 0 END,
         history_micros = history_micros + NEW.rebate_micros,
         debt_micros = debt_micros - COALESCE((
           SELECT amount_micros FROM affiliate_debt_repayments
            WHERE source_rebate_id = NEW.id
         ), 0),
         control_version = control_version + 1,
         updated_at_ms = NEW.created_at_ms
   WHERE user_id = NEW.inviter_user_id;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'affiliate_inviter_missing') END;

  INSERT INTO affiliate_ledger (
    id, user_id, entry_type, amount_delta_micros, source_type, source_id,
    available_after_micros, frozen_after_micros, history_after_micros, created_at_ms
  )
  SELECT NEW.id || ':accrual', NEW.inviter_user_id,
         CASE WHEN NEW.status = 'frozen' THEN 'rebate_frozen' ELSE 'rebate_available' END,
         NEW.rebate_micros - COALESCE((
           SELECT amount_micros FROM affiliate_debt_repayments
            WHERE source_rebate_id = NEW.id
         ), 0),
         'rebate', NEW.id, available_micros, frozen_micros, history_micros,
         NEW.created_at_ms
    FROM affiliate_profiles WHERE user_id = NEW.inviter_user_id;
END;

CREATE TRIGGER affiliate_rebate_adjustment_reserve
AFTER INSERT ON affiliate_rebate_adjustments
BEGIN
  SELECT CASE WHEN
    NEW.quota_clawback_micros + NEW.balance_clawback_micros + NEW.debt_reopened_micros
      <> NEW.adjustment_micros
    THEN RAISE(ABORT, 'affiliate_recovery_amount_invalid') END;
  UPDATE affiliate_profiles
     SET available_micros = available_micros -
           CASE WHEN NEW.quota_bucket = 'available' THEN NEW.quota_clawback_micros ELSE 0 END,
         frozen_micros = frozen_micros -
           CASE WHEN NEW.quota_bucket = 'frozen' THEN NEW.quota_clawback_micros ELSE 0 END,
         history_micros = history_micros - NEW.adjustment_micros,
         control_version = control_version + 1,
         updated_at_ms = NEW.created_at_ms
   WHERE user_id = (SELECT inviter_user_id FROM affiliate_rebates WHERE id = NEW.rebate_id)
     AND history_micros >= NEW.adjustment_micros
     AND (NEW.quota_bucket <> 'available' OR available_micros >= NEW.quota_clawback_micros)
     AND (NEW.quota_bucket <> 'frozen' OR frozen_micros >= NEW.quota_clawback_micros)
     AND (
       NEW.quota_bucket = 'none'
       OR NEW.quota_bucket = (SELECT status FROM affiliate_rebates WHERE id = NEW.rebate_id)
     );
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'affiliate_clawback_projection_conflict') END;
  INSERT INTO affiliate_ledger (
    id, user_id, entry_type, amount_delta_micros, source_type, source_id,
    available_after_micros, frozen_after_micros, history_after_micros, created_at_ms
  )
  SELECT NEW.id || ':reserved', rebate.inviter_user_id, 'rebate_clawback_reserved',
         -NEW.adjustment_micros, 'adjustment', NEW.id,
         profile.available_micros, profile.frozen_micros, profile.history_micros,
         NEW.created_at_ms
    FROM affiliate_rebates rebate
    JOIN affiliate_profiles profile ON profile.user_id = rebate.inviter_user_id
   WHERE rebate.id = NEW.rebate_id;
END;

CREATE TRIGGER affiliate_rebate_adjustment_complete
AFTER UPDATE OF status ON affiliate_rebate_adjustments
WHEN OLD.status = 'processing' AND NEW.status = 'completed'
BEGIN
  INSERT INTO affiliate_ledger (
    id, user_id, entry_type, amount_delta_micros, source_type, source_id,
    available_after_micros, frozen_after_micros, history_after_micros,
    balance_after_micros, created_at_ms
  )
  SELECT NEW.id || ':completed', rebate.inviter_user_id, 'rebate_clawback_completed',
         0, 'adjustment', NEW.id, profile.available_micros,
         profile.frozen_micros, profile.history_micros, NEW.balance_after_micros,
         NEW.completed_at_ms
    FROM affiliate_rebates rebate
    JOIN affiliate_profiles profile ON profile.user_id = rebate.inviter_user_id
   WHERE rebate.id = NEW.rebate_id;
END;

CREATE TRIGGER affiliate_rebate_adjustment_debt_complete
AFTER UPDATE OF status ON affiliate_rebate_adjustments
WHEN OLD.status = 'processing' AND NEW.status = 'completed'
BEGIN
  UPDATE affiliate_profiles
     SET debt_micros = debt_micros + NEW.debt_incurred_micros + NEW.debt_reopened_micros,
         control_version = control_version + 1,
         updated_at_ms = NEW.completed_at_ms
   WHERE user_id = (SELECT inviter_user_id FROM affiliate_rebates WHERE id = NEW.rebate_id);
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'affiliate_inviter_missing') END;
END;

DROP TRIGGER affiliate_rebate_project_thaw;

CREATE TRIGGER affiliate_rebate_project_thaw
AFTER UPDATE OF status ON affiliate_rebates
WHEN OLD.status = 'frozen' AND NEW.status = 'available'
BEGIN
  UPDATE affiliate_profiles
     SET available_micros = available_micros + NEW.rebate_micros
           - COALESCE((SELECT amount_micros FROM affiliate_debt_repayments
                        WHERE source_rebate_id = NEW.id), 0)
           - COALESCE((SELECT SUM(adjustment_micros - debt_reopened_micros)
                         FROM affiliate_rebate_adjustments
                        WHERE rebate_id = NEW.id), 0),
         frozen_micros = frozen_micros - NEW.rebate_micros
           + COALESCE((SELECT amount_micros FROM affiliate_debt_repayments
                        WHERE source_rebate_id = NEW.id), 0)
           + COALESCE((SELECT SUM(adjustment_micros - debt_reopened_micros)
                         FROM affiliate_rebate_adjustments
                        WHERE rebate_id = NEW.id), 0),
         control_version = control_version + 1,
         updated_at_ms = NEW.updated_at_ms
   WHERE user_id = NEW.inviter_user_id
     AND frozen_micros >= NEW.rebate_micros
       - COALESCE((SELECT amount_micros FROM affiliate_debt_repayments
                    WHERE source_rebate_id = NEW.id), 0)
       - COALESCE((SELECT SUM(adjustment_micros - debt_reopened_micros)
                     FROM affiliate_rebate_adjustments
                    WHERE rebate_id = NEW.id), 0);
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'affiliate_projection_conflict') END;
  INSERT INTO affiliate_ledger (
    id, user_id, entry_type, amount_delta_micros, source_type, source_id,
    available_after_micros, frozen_after_micros, history_after_micros, created_at_ms
  )
  SELECT NEW.id || ':thaw', NEW.inviter_user_id, 'rebate_thawed',
         NEW.rebate_micros
           - COALESCE((SELECT amount_micros FROM affiliate_debt_repayments
                        WHERE source_rebate_id = NEW.id), 0)
           - COALESCE((SELECT SUM(adjustment_micros - debt_reopened_micros)
                         FROM affiliate_rebate_adjustments
                        WHERE rebate_id = NEW.id), 0),
         'rebate', NEW.id, available_micros, frozen_micros, history_micros,
         NEW.updated_at_ms
    FROM affiliate_profiles WHERE user_id = NEW.inviter_user_id;
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (35, 'affiliate_refund_debt', CAST(unixepoch('subsec') * 1000 AS INTEGER));
