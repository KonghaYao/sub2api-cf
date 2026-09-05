PRAGMA foreign_keys = ON;

-- Private commercial policy. Public feature flags intentionally live in the
-- existing system_settings.public_json projection and are published through KV.
CREATE TABLE commercial_config (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  affiliate_rebate_rate_ppm INTEGER NOT NULL DEFAULT 200000
    CHECK (affiliate_rebate_rate_ppm BETWEEN 0 AND 1000000),
  affiliate_rebate_freeze_hours INTEGER NOT NULL DEFAULT 0
    CHECK (affiliate_rebate_freeze_hours BETWEEN 0 AND 720),
  affiliate_rebate_duration_days INTEGER NOT NULL DEFAULT 0
    CHECK (affiliate_rebate_duration_days BETWEEN 0 AND 3650),
  affiliate_rebate_per_invitee_cap_micros INTEGER NOT NULL DEFAULT 0
    CHECK (affiliate_rebate_per_invitee_cap_micros >= 0),
  affiliate_admin_recharge_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (affiliate_admin_recharge_enabled IN (0, 1)),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

INSERT INTO commercial_config (id, updated_at_ms)
VALUES ('global', CAST(unixepoch('subsec') * 1000 AS INTEGER));

-- Registration codes survive the third-party OAuth redirect without being
-- exposed in its state, callback URL, or plaintext D1 rows.
ALTER TABLE oauth_flows ADD COLUMN commercial_key_version INTEGER
  CHECK (commercial_key_version IS NULL OR commercial_key_version > 0);
ALTER TABLE oauth_flows ADD COLUMN commercial_nonce_b64 TEXT
  CHECK (commercial_nonce_b64 IS NULL OR length(commercial_nonce_b64) BETWEEN 16 AND 64);
ALTER TABLE oauth_flows ADD COLUMN commercial_ciphertext_b64 TEXT
  CHECK (commercial_ciphertext_b64 IS NULL OR length(commercial_ciphertext_b64) BETWEEN 16 AND 2048);

-- Codes are looked up only by a peppered HMAC. The AES-GCM fields allow an
-- authorized administrator to see/copy the code without retaining plaintext.
CREATE TABLE promotion_codes (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  code_prefix TEXT NOT NULL CHECK (length(code_prefix) BETWEEN 1 AND 8),
  secret_key_version INTEGER NOT NULL CHECK (secret_key_version > 0),
  secret_nonce_b64 TEXT NOT NULL CHECK (length(secret_nonce_b64) BETWEEN 16 AND 64),
  secret_ciphertext_b64 TEXT NOT NULL CHECK (length(secret_ciphertext_b64) BETWEEN 16 AND 1024),
  bonus_micros INTEGER NOT NULL CHECK (bonus_micros > 0),
  max_uses INTEGER NOT NULL DEFAULT 0 CHECK (max_uses >= 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (
    used_count >= 0 AND (max_uses = 0 OR used_count <= max_uses)
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= 0),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX idx_promotion_codes_list
  ON promotion_codes(status, created_at_ms DESC, id DESC);
CREATE INDEX idx_promotion_codes_expiry
  ON promotion_codes(expires_at_ms, id)
  WHERE status = 'active' AND expires_at_ms IS NOT NULL;

CREATE TABLE invitation_codes (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  code_prefix TEXT NOT NULL CHECK (length(code_prefix) BETWEEN 1 AND 8),
  secret_key_version INTEGER NOT NULL CHECK (secret_key_version > 0),
  secret_nonce_b64 TEXT NOT NULL CHECK (length(secret_nonce_b64) BETWEEN 16 AND 64),
  secret_ciphertext_b64 TEXT NOT NULL CHECK (length(secret_ciphertext_b64) BETWEEN 16 AND 1024),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count BETWEEN 0 AND max_uses),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= 0),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX idx_invitation_codes_list
  ON invitation_codes(status, created_at_ms DESC, id DESC);
CREATE INDEX idx_invitation_codes_expiry
  ON invitation_codes(expires_at_ms, id)
  WHERE status = 'active' AND expires_at_ms IS NOT NULL;

CREATE TABLE affiliate_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  code_prefix TEXT NOT NULL CHECK (length(code_prefix) BETWEEN 1 AND 8),
  code_custom INTEGER NOT NULL DEFAULT 0 CHECK (code_custom IN (0, 1)),
  code_key_version INTEGER NOT NULL CHECK (code_key_version > 0),
  code_nonce_b64 TEXT NOT NULL CHECK (length(code_nonce_b64) BETWEEN 16 AND 64),
  code_ciphertext_b64 TEXT NOT NULL CHECK (length(code_ciphertext_b64) BETWEEN 16 AND 1024),
  rebate_rate_ppm INTEGER CHECK (rebate_rate_ppm IS NULL OR rebate_rate_ppm BETWEEN 0 AND 1000000),
  invited_count INTEGER NOT NULL DEFAULT 0 CHECK (invited_count >= 0),
  available_micros INTEGER NOT NULL DEFAULT 0 CHECK (available_micros >= 0),
  frozen_micros INTEGER NOT NULL DEFAULT 0 CHECK (frozen_micros >= 0),
  history_micros INTEGER NOT NULL DEFAULT 0 CHECK (history_micros >= 0),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX idx_affiliate_profiles_custom
  ON affiliate_profiles(code_custom, rebate_rate_ppm, updated_at_ms DESC, user_id);

-- This row is prepared before the user INSERT. The deferred user FK guarantees
-- that a batch which fails to create the user cannot consume either code.
CREATE TABLE commercial_registration_claims (
  user_id TEXT PRIMARY KEY
    REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  promotion_code_id TEXT REFERENCES promotion_codes(id) ON DELETE RESTRICT,
  promotion_bonus_micros INTEGER NOT NULL DEFAULT 0 CHECK (promotion_bonus_micros >= 0),
  invitation_code_id TEXT REFERENCES invitation_codes(id) ON DELETE RESTRICT,
  inviter_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  affiliate_code_prefix TEXT,
  claimed_at_ms INTEGER NOT NULL CHECK (claimed_at_ms >= 0),
  CHECK (
    (promotion_code_id IS NULL AND promotion_bonus_micros = 0)
    OR (promotion_code_id IS NOT NULL AND promotion_bonus_micros > 0)
  ),
  CHECK (
    (inviter_user_id IS NULL AND affiliate_code_prefix IS NULL)
    OR (inviter_user_id IS NOT NULL AND length(affiliate_code_prefix) BETWEEN 1 AND 8)
  )
) STRICT;

CREATE TABLE promotion_code_usages (
  id TEXT PRIMARY KEY,
  promotion_code_id TEXT NOT NULL REFERENCES promotion_codes(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bonus_micros INTEGER NOT NULL CHECK (bonus_micros > 0),
  used_at_ms INTEGER NOT NULL CHECK (used_at_ms >= 0),
  UNIQUE(promotion_code_id, user_id)
) STRICT;

CREATE INDEX idx_promotion_code_usages_code_time
  ON promotion_code_usages(promotion_code_id, used_at_ms DESC, id DESC);
CREATE INDEX idx_promotion_code_usages_user
  ON promotion_code_usages(user_id, used_at_ms DESC, id DESC);

CREATE TRIGGER promotion_code_usage_immutable_update
BEFORE UPDATE ON promotion_code_usages
BEGIN
  SELECT RAISE(ABORT, 'promotion_usage_immutable');
END;

CREATE TRIGGER promotion_code_usage_immutable_delete
BEFORE DELETE ON promotion_code_usages
BEGIN
  SELECT RAISE(ABORT, 'promotion_usage_immutable');
END;

CREATE TABLE invitation_code_usages (
  id TEXT PRIMARY KEY,
  invitation_code_id TEXT NOT NULL REFERENCES invitation_codes(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  used_at_ms INTEGER NOT NULL CHECK (used_at_ms >= 0),
  UNIQUE(invitation_code_id, user_id)
) STRICT;

CREATE INDEX idx_invitation_code_usages_code_time
  ON invitation_code_usages(invitation_code_id, used_at_ms DESC, id DESC);

CREATE TRIGGER invitation_code_usage_immutable_update
BEFORE UPDATE ON invitation_code_usages
BEGIN
  SELECT RAISE(ABORT, 'invitation_usage_immutable');
END;

CREATE TRIGGER invitation_code_usage_immutable_delete
BEFORE DELETE ON invitation_code_usages
BEGIN
  SELECT RAISE(ABORT, 'invitation_usage_immutable');
END;

CREATE TABLE affiliate_referrals (
  invitee_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  inviter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  affiliate_code_prefix TEXT NOT NULL CHECK (length(affiliate_code_prefix) BETWEEN 1 AND 8),
  attributed_at_ms INTEGER NOT NULL CHECK (attributed_at_ms >= 0),
  CHECK (invitee_user_id <> inviter_user_id)
) STRICT;

CREATE INDEX idx_affiliate_referrals_inviter_time
  ON affiliate_referrals(inviter_user_id, attributed_at_ms DESC, invitee_user_id DESC);

CREATE TRIGGER affiliate_referral_attribution_immutable_update
BEFORE UPDATE ON affiliate_referrals
BEGIN
  SELECT RAISE(ABORT, 'affiliate_attribution_immutable');
END;

CREATE TRIGGER affiliate_referral_attribution_immutable_delete
BEFORE DELETE ON affiliate_referrals
BEGIN
  SELECT RAISE(ABORT, 'affiliate_attribution_immutable');
END;

-- Registration code capacity is reserved by the claim INSERT itself. D1/SQLite
-- serializes the write transaction, so concurrent final-slot claims cannot both pass.
CREATE TRIGGER commercial_claim_validate_promotion
BEFORE INSERT ON commercial_registration_claims
WHEN NEW.promotion_code_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM promotion_codes
     WHERE id = NEW.promotion_code_id
       AND status = 'active'
       AND (expires_at_ms IS NULL OR expires_at_ms > NEW.claimed_at_ms)
       AND (max_uses = 0 OR used_count < max_uses)
       AND bonus_micros = NEW.promotion_bonus_micros
  ) THEN RAISE(ABORT, 'promotion_code_unavailable') END;
END;

CREATE TRIGGER commercial_claim_reserve_promotion
AFTER INSERT ON commercial_registration_claims
WHEN NEW.promotion_code_id IS NOT NULL
BEGIN
  UPDATE promotion_codes
     SET used_count = used_count + 1,
         control_version = control_version + 1,
         updated_at_ms = NEW.claimed_at_ms
   WHERE id = NEW.promotion_code_id;
END;

CREATE TRIGGER commercial_claim_validate_invitation
BEFORE INSERT ON commercial_registration_claims
WHEN NEW.invitation_code_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM invitation_codes
     WHERE id = NEW.invitation_code_id
       AND status = 'active'
       AND (expires_at_ms IS NULL OR expires_at_ms > NEW.claimed_at_ms)
       AND used_count < max_uses
  ) THEN RAISE(ABORT, 'invitation_code_unavailable') END;
END;

CREATE TRIGGER commercial_claim_reserve_invitation
AFTER INSERT ON commercial_registration_claims
WHEN NEW.invitation_code_id IS NOT NULL
BEGIN
  UPDATE invitation_codes
     SET used_count = used_count + 1,
         control_version = control_version + 1,
         updated_at_ms = NEW.claimed_at_ms
   WHERE id = NEW.invitation_code_id;
END;

CREATE TRIGGER affiliate_referral_increment_count
AFTER INSERT ON affiliate_referrals
BEGIN
  UPDATE affiliate_profiles
     SET invited_count = invited_count + 1,
         control_version = control_version + 1,
         updated_at_ms = NEW.attributed_at_ms
   WHERE user_id = NEW.inviter_user_id;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'affiliate_inviter_missing') END;
END;

CREATE TABLE affiliate_rebates (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  source_order_id TEXT NOT NULL UNIQUE,
  out_trade_no TEXT NOT NULL DEFAULT '' CHECK (length(out_trade_no) <= 128),
  inviter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  invitee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  order_amount_micros INTEGER NOT NULL CHECK (order_amount_micros > 0),
  pay_amount_micros INTEGER NOT NULL CHECK (pay_amount_micros > 0),
  rebate_micros INTEGER NOT NULL CHECK (rebate_micros > 0),
  payment_type TEXT NOT NULL DEFAULT '' CHECK (length(payment_type) <= 64),
  order_status TEXT NOT NULL DEFAULT 'completed' CHECK (length(order_status) BETWEEN 1 AND 32),
  status TEXT NOT NULL CHECK (status IN ('frozen', 'available', 'void')),
  eligible_at_ms INTEGER NOT NULL CHECK (eligible_at_ms >= 0),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (inviter_user_id <> invitee_user_id)
) STRICT;

CREATE INDEX idx_affiliate_rebates_inviter_status
  ON affiliate_rebates(inviter_user_id, status, eligible_at_ms, id);
CREATE INDEX idx_affiliate_rebates_invitee_time
  ON affiliate_rebates(invitee_user_id, created_at_ms DESC, id DESC);

CREATE TRIGGER affiliate_rebate_economics_immutable
BEFORE UPDATE OF source_order_id, out_trade_no, inviter_user_id, invitee_user_id,
  order_amount_micros, pay_amount_micros, rebate_micros, payment_type,
  order_status, eligible_at_ms, created_at_ms ON affiliate_rebates
BEGIN
  SELECT RAISE(ABORT, 'affiliate_rebate_immutable');
END;

CREATE TRIGGER affiliate_rebate_delete_immutable
BEFORE DELETE ON affiliate_rebates
BEGIN
  SELECT RAISE(ABORT, 'affiliate_rebate_immutable');
END;

-- Refunds never rewrite an earned rebate or its immutable ledger. Each settled
-- refund owns one compensating adjustment which can resume an interrupted
-- UserStateDO balance clawback by replaying its deterministic mutation id.
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
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  balance_after_micros INTEGER CHECK (balance_after_micros IS NULL OR balance_after_micros >= 0),
  state_version INTEGER CHECK (state_version IS NULL OR state_version >= 0),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (quota_clawback_micros + balance_clawback_micros = adjustment_micros),
  CHECK ((quota_clawback_micros = 0) = (quota_bucket = 'none')),
  CHECK (
    (status = 'processing' AND completed_at_ms IS NULL)
    OR (status = 'completed' AND completed_at_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_affiliate_rebate_adjustments_rebate
  ON affiliate_rebate_adjustments(rebate_id, created_at_ms, id);
CREATE INDEX idx_affiliate_rebate_adjustments_processing
  ON affiliate_rebate_adjustments(status, updated_at_ms, id)
  WHERE status = 'processing';

CREATE TRIGGER affiliate_rebate_adjustment_economics_immutable
BEFORE UPDATE OF rebate_id, refund_id, adjustment_kind, quota_bucket,
  refund_amount_micros, cumulative_refunded_micros, adjustment_micros,
  quota_clawback_micros, balance_clawback_micros, created_at_ms
ON affiliate_rebate_adjustments
BEGIN
  SELECT RAISE(ABORT, 'affiliate_rebate_adjustment_immutable');
END;

CREATE TRIGGER affiliate_rebate_adjustment_delete_immutable
BEFORE DELETE ON affiliate_rebate_adjustments
BEGIN
  SELECT RAISE(ABORT, 'affiliate_rebate_adjustment_immutable');
END;

CREATE TABLE affiliate_transfer_operations (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  amount_micros INTEGER NOT NULL CHECK (amount_micros > 0),
  balance_after_micros INTEGER CHECK (balance_after_micros IS NULL OR balance_after_micros >= 0),
  state_version INTEGER CHECK (state_version IS NULL OR state_version >= 0),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  UNIQUE(user_id, idempotency_key_hash)
) STRICT;

CREATE UNIQUE INDEX idx_affiliate_transfer_one_processing_per_user
  ON affiliate_transfer_operations(user_id)
  WHERE status = 'processing';
CREATE INDEX idx_affiliate_transfer_status_time
  ON affiliate_transfer_operations(status, updated_at_ms, id);

CREATE TRIGGER affiliate_transfer_economics_immutable
BEFORE UPDATE OF user_id, idempotency_key_hash, request_hash, amount_micros,
  created_at_ms ON affiliate_transfer_operations
BEGIN
  SELECT RAISE(ABORT, 'affiliate_transfer_immutable');
END;

CREATE TRIGGER affiliate_transfer_delete_immutable
BEFORE DELETE ON affiliate_transfer_operations
BEGIN
  SELECT RAISE(ABORT, 'affiliate_transfer_immutable');
END;

-- Immutable event ledger. Projections are disposable and can be rebuilt from it.
CREATE TABLE affiliate_ledger (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  entry_type TEXT NOT NULL CHECK (
    entry_type IN ('rebate_frozen', 'rebate_available', 'rebate_thawed',
                   'transfer_reserved', 'transfer_completed', 'rebate_voided',
                   'rebate_clawback_reserved', 'rebate_clawback_completed')
  ),
  amount_delta_micros INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('rebate', 'transfer', 'adjustment')),
  source_id TEXT NOT NULL,
  available_after_micros INTEGER NOT NULL CHECK (available_after_micros >= 0),
  frozen_after_micros INTEGER NOT NULL CHECK (frozen_after_micros >= 0),
  history_after_micros INTEGER NOT NULL CHECK (history_after_micros >= 0),
  balance_after_micros INTEGER CHECK (balance_after_micros IS NULL OR balance_after_micros >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE(user_id, entry_type, source_type, source_id)
) STRICT;

CREATE INDEX idx_affiliate_ledger_user_time
  ON affiliate_ledger(user_id, created_at_ms DESC, id DESC);

CREATE TRIGGER affiliate_ledger_immutable_update
BEFORE UPDATE ON affiliate_ledger
BEGIN
  SELECT RAISE(ABORT, 'affiliate_ledger_immutable');
END;

CREATE TRIGGER affiliate_ledger_immutable_delete
BEFORE DELETE ON affiliate_ledger
BEGIN
  SELECT RAISE(ABORT, 'affiliate_ledger_immutable');
END;

CREATE TRIGGER affiliate_rebate_adjustment_reserve
AFTER INSERT ON affiliate_rebate_adjustments
BEGIN
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

CREATE TRIGGER affiliate_rebate_project_insert
AFTER INSERT ON affiliate_rebates
WHEN NEW.status IN ('frozen', 'available')
BEGIN
  UPDATE affiliate_profiles
     SET available_micros = available_micros + CASE WHEN NEW.status = 'available' THEN NEW.rebate_micros ELSE 0 END,
         frozen_micros = frozen_micros + CASE WHEN NEW.status = 'frozen' THEN NEW.rebate_micros ELSE 0 END,
         history_micros = history_micros + NEW.rebate_micros,
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
         NEW.rebate_micros, 'rebate', NEW.id,
         available_micros, frozen_micros, history_micros, NEW.created_at_ms
    FROM affiliate_profiles WHERE user_id = NEW.inviter_user_id;
END;

CREATE TRIGGER affiliate_rebate_project_thaw
AFTER UPDATE OF status ON affiliate_rebates
WHEN OLD.status = 'frozen' AND NEW.status = 'available'
BEGIN
  UPDATE affiliate_profiles
     SET available_micros = available_micros + NEW.rebate_micros - COALESCE((
           SELECT SUM(adjustment_micros) FROM affiliate_rebate_adjustments
            WHERE rebate_id = NEW.id
         ), 0),
         frozen_micros = frozen_micros - NEW.rebate_micros + COALESCE((
           SELECT SUM(adjustment_micros) FROM affiliate_rebate_adjustments
            WHERE rebate_id = NEW.id
         ), 0),
         control_version = control_version + 1,
         updated_at_ms = NEW.updated_at_ms
   WHERE user_id = NEW.inviter_user_id
     AND frozen_micros >= NEW.rebate_micros - COALESCE((
       SELECT SUM(adjustment_micros) FROM affiliate_rebate_adjustments
        WHERE rebate_id = NEW.id
     ), 0);
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'affiliate_projection_conflict') END;
  INSERT INTO affiliate_ledger (
    id, user_id, entry_type, amount_delta_micros, source_type, source_id,
    available_after_micros, frozen_after_micros, history_after_micros, created_at_ms
  )
  SELECT NEW.id || ':thaw', NEW.inviter_user_id, 'rebate_thawed',
         NEW.rebate_micros - COALESCE((
           SELECT SUM(adjustment_micros) FROM affiliate_rebate_adjustments
            WHERE rebate_id = NEW.id
         ), 0),
         'rebate', NEW.id, available_micros, frozen_micros, history_micros, NEW.updated_at_ms
    FROM affiliate_profiles WHERE user_id = NEW.inviter_user_id;
END;

CREATE TRIGGER affiliate_transfer_reserve
AFTER INSERT ON affiliate_transfer_operations
WHEN NEW.status = 'processing'
BEGIN
  UPDATE affiliate_profiles
     SET available_micros = available_micros - NEW.amount_micros,
         control_version = control_version + 1,
         updated_at_ms = NEW.created_at_ms
   WHERE user_id = NEW.user_id AND available_micros >= NEW.amount_micros;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'affiliate_quota_empty') END;
  INSERT INTO affiliate_ledger (
    id, user_id, entry_type, amount_delta_micros, source_type, source_id,
    available_after_micros, frozen_after_micros, history_after_micros, created_at_ms
  )
  SELECT NEW.id || ':reserved', NEW.user_id, 'transfer_reserved', -NEW.amount_micros,
         'transfer', NEW.id, available_micros, frozen_micros, history_micros, NEW.created_at_ms
    FROM affiliate_profiles WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER affiliate_transfer_complete
AFTER UPDATE OF status ON affiliate_transfer_operations
WHEN OLD.status = 'processing' AND NEW.status = 'completed'
BEGIN
  INSERT INTO affiliate_ledger (
    id, user_id, entry_type, amount_delta_micros, source_type, source_id,
    available_after_micros, frozen_after_micros, history_after_micros,
    balance_after_micros, created_at_ms
  )
  SELECT NEW.id || ':completed', NEW.user_id, 'transfer_completed', 0,
         'transfer', NEW.id, available_micros, frozen_micros, history_micros,
         NEW.balance_after_micros, NEW.completed_at_ms
    FROM affiliate_profiles WHERE user_id = NEW.user_id;
END;

CREATE TABLE commercial_admin_audit_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('promotion_code', 'invitation_code', 'affiliate_user', 'commercial_config')),
  resource_id TEXT NOT NULL,
  resource_version INTEGER,
  idempotency_key_hash TEXT CHECK (idempotency_key_hash IS NULL OR length(idempotency_key_hash) = 64),
  changed_fields_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_fields_json)),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;

CREATE INDEX idx_commercial_admin_audit_time
  ON commercial_admin_audit_events(occurred_at_ms DESC, id DESC);
CREATE INDEX idx_commercial_admin_audit_actor
  ON commercial_admin_audit_events(actor_user_id, occurred_at_ms DESC, id DESC);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (32, 'promotions_affiliate', CAST(unixepoch('subsec') * 1000 AS INTEGER));
