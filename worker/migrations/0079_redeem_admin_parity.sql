-- Restore the redeem-code variants and disabled lifecycle exposed by the
-- original administrator UI.  Keep legacy invitation codes in this table:
-- they are registration-only and are intentionally rejected by /redeem.
PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

ALTER TABLE redemptions RENAME TO redemptions_before_admin_parity;
ALTER TABLE redeem_codes RENAME TO redeem_codes_before_admin_parity;

CREATE TABLE redeem_codes (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  code_prefix TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('balance', 'concurrency', 'subscription', 'invitation')),
  value_micros INTEGER NOT NULL DEFAULT 0 CHECK (value_micros >= 0 AND value_micros <= 9007199254740991),
  group_id TEXT REFERENCES "groups"(id) ON DELETE RESTRICT,
  validity_days INTEGER CHECK (validity_days IS NULL OR (validity_days > 0 AND validity_days <= 36500)),
  status TEXT NOT NULL DEFAULT 'unused'
    CHECK (status IN ('unused', 'processing', 'used', 'expired', 'disabled')),
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
    (type = 'concurrency' AND value_micros > 0 AND group_id IS NULL AND validity_days IS NULL)
    OR
    (type = 'subscription' AND value_micros = 0 AND validity_days IS NOT NULL)
    OR
    (type = 'invitation' AND value_micros = 0 AND group_id IS NULL AND validity_days IS NULL)
  )
) STRICT;

CREATE TABLE redemptions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  code_id TEXT NOT NULL UNIQUE REFERENCES redeem_codes(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed')),
  type TEXT NOT NULL CHECK (type IN ('balance', 'concurrency', 'subscription')),
  value_micros INTEGER NOT NULL DEFAULT 0 CHECK (value_micros >= 0 AND value_micros <= 9007199254740991),
  subscription_id TEXT REFERENCES user_subscriptions(id) ON DELETE SET NULL,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  effect_started_at_ms INTEGER
    CHECK (effect_started_at_ms IS NULL OR (effect_started_at_ms >= created_at_ms AND effect_started_at_ms <= 8640000000000000)),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR (completed_at_ms >= created_at_ms AND completed_at_ms <= 8640000000000000)),
  UNIQUE(user_id, idempotency_key_hash)
) STRICT;

INSERT INTO redeem_codes (
  id, schema_version, code_hash, code_prefix, type, value_micros, group_id,
  validity_days, status, expires_at_ms, used_by_user_id, claimed_by_redemption_id,
  used_at_ms, notes, control_version, created_by_user_id, created_at_ms, updated_at_ms
)
SELECT id, schema_version, code_hash, code_prefix, type, value_micros, group_id,
       validity_days, status, expires_at_ms, used_by_user_id, claimed_by_redemption_id,
       used_at_ms, notes, control_version, created_by_user_id, created_at_ms, updated_at_ms
  FROM redeem_codes_before_admin_parity;

INSERT INTO redemptions (
  id, schema_version, code_id, user_id, idempotency_key_hash, status, type,
  value_micros, subscription_id, result_json, created_at_ms,
  effect_started_at_ms, completed_at_ms
)
SELECT id, schema_version, code_id, user_id, idempotency_key_hash, status, type,
       value_micros, subscription_id, result_json, created_at_ms,
       effect_started_at_ms, completed_at_ms
  FROM redemptions_before_admin_parity;

DROP TABLE redemptions_before_admin_parity;
DROP TABLE redeem_codes_before_admin_parity;

CREATE INDEX idx_redeem_codes_status_expiry
  ON redeem_codes(status, expires_at_ms, created_at_ms DESC);

CREATE TABLE redeem_code_secrets (
  redeem_code_id TEXT PRIMARY KEY REFERENCES redeem_codes(id) ON DELETE CASCADE,
  secret_key_version INTEGER NOT NULL CHECK (secret_key_version > 0),
  secret_nonce_b64 TEXT NOT NULL CHECK (length(secret_nonce_b64) BETWEEN 16 AND 64),
  secret_ciphertext_b64 TEXT NOT NULL CHECK (length(secret_ciphertext_b64) BETWEEN 16 AND 1024),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX idx_redemptions_user_time
  ON redemptions(user_id, created_at_ms DESC, id);

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

CREATE TRIGGER validate_subscription_redeem_code_group_insert
BEFORE INSERT ON redeem_codes
FOR EACH ROW
WHEN NEW.type = 'subscription' AND NEW.group_id IS NOT NULL
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
WHEN NEW.type = 'subscription' AND NEW.group_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM "groups"
    WHERE id = NEW.group_id AND group_type = 'subscription'
 )
BEGIN
  SELECT RAISE(ABORT, 'subscription_redeem_code_requires_subscription_group');
END;

-- Legacy invitation redeem codes are backed by the commercial invitation
-- table so registration consumes them through the same atomic claim flow.
CREATE TRIGGER sync_legacy_invitation_redeem_usage
AFTER INSERT ON invitation_code_usages
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM redeem_codes
   WHERE id = NEW.invitation_code_id AND type = 'invitation' AND status = 'unused'
)
BEGIN
  UPDATE redeem_codes
     SET status = 'used', used_by_user_id = NEW.user_id, used_at_ms = NEW.used_at_ms,
         control_version = control_version + 1, updated_at_ms = NEW.used_at_ms
   WHERE id = NEW.invitation_code_id AND type = 'invitation' AND status = 'unused';
END;

PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;

INSERT INTO schema_migrations (version, name, applied_at_ms)
VALUES (79, 'redeem_admin_parity', unixepoch() * 1000);
