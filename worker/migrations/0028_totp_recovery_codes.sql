PRAGMA foreign_keys = ON;

-- Recovery codes are generated with 80 bits of randomness and are returned to
-- the owner exactly once. Only an environment-bound HMAC digest is persisted.
-- A separate set row gives rotations a CAS boundary so concurrent regenerations
-- cannot both publish apparently-valid code lists.
CREATE TABLE user_totp_recovery_code_sets (
  user_id TEXT PRIMARY KEY REFERENCES user_totp_credentials(user_id) ON DELETE CASCADE,
  set_id TEXT NOT NULL UNIQUE CHECK (length(set_id) = 36),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  UNIQUE (user_id, set_id)
) STRICT;

CREATE TABLE user_totp_recovery_codes (
  user_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms),
  consume_nonce TEXT UNIQUE,
  PRIMARY KEY (user_id, set_id, position),
  FOREIGN KEY (user_id, set_id)
    REFERENCES user_totp_recovery_code_sets(user_id, set_id) ON DELETE CASCADE,
  CHECK (
    (consumed_at_ms IS NULL AND consume_nonce IS NULL)
    OR
    (consumed_at_ms IS NOT NULL AND consume_nonce IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_user_totp_recovery_codes_available
  ON user_totp_recovery_codes(user_id, code_hash)
  WHERE consumed_at_ms IS NULL;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (28, 'totp_recovery_codes', CAST(unixepoch('subsec') * 1000 AS INTEGER));
