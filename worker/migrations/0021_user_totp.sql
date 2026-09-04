PRAGMA foreign_keys = ON;

-- A credential exists only while TOTP is enabled. Secrets are encrypted with
-- AES-256-GCM by the Worker; the key remains a Worker secret.
CREATE TABLE user_totp_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  secret_version INTEGER NOT NULL DEFAULT 1 CHECK (secret_version > 0),
  algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM' CHECK (algorithm = 'AES-256-GCM'),
  nonce_b64 TEXT NOT NULL CHECK (length(nonce_b64) = 16),
  ciphertext_b64 TEXT NOT NULL CHECK (length(ciphertext_b64) BETWEEN 24 AND 512),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  enabled_at_ms INTEGER NOT NULL CHECK (enabled_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

-- One rotating setup challenge per owner bounds storage and invalidates the
-- previous QR code when setup is restarted. The raw setup token is never stored.
CREATE TABLE user_totp_setup_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  secret_version INTEGER NOT NULL DEFAULT 1 CHECK (secret_version > 0),
  nonce_b64 TEXT NOT NULL CHECK (length(nonce_b64) = 16),
  ciphertext_b64 TEXT NOT NULL CHECK (length(ciphertext_b64) BETWEEN 24 AND 512),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed')),
  verification_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (verification_attempts BETWEEN 0 AND 5),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms),
  consume_nonce TEXT UNIQUE,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (status = 'pending' AND consumed_at_ms IS NULL AND consume_nonce IS NULL)
    OR
    (status = 'consumed' AND consumed_at_ms IS NOT NULL AND consume_nonce IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_user_totp_setup_expiry
  ON user_totp_setup_challenges(expires_at_ms, user_id)
  WHERE status = 'pending';

-- Password verification creates this pending state instead of an authenticated
-- session. A successful second factor consumes it in the same batch that creates
-- the real user session.
CREATE TABLE user_totp_login_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed')),
  verification_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (verification_attempts BETWEEN 0 AND 5),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms),
  consume_nonce TEXT UNIQUE,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (status = 'pending' AND consumed_at_ms IS NULL AND consume_nonce IS NULL)
    OR
    (status = 'consumed' AND consumed_at_ms IS NOT NULL AND consume_nonce IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_user_totp_login_expiry
  ON user_totp_login_challenges(expires_at_ms, user_id)
  WHERE status = 'pending';

-- This budget survives login-challenge rotation, preventing a caller who knows
-- the password from resetting the TOTP brute-force budget by logging in again.
CREATE TABLE user_totp_verification_budgets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  window_started_at_ms INTEGER NOT NULL CHECK (window_started_at_ms >= 0),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 1 AND 5),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= window_started_at_ms)
) STRICT;

-- Identity-verification emails use a dedicated owner-scoped challenge so they
-- cannot consume registration, reset, or notification-email challenges.
CREATE TABLE user_totp_email_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed')),
  verification_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (verification_attempts BETWEEN 0 AND 5),
  delivery_event_id TEXT NOT NULL UNIQUE,
  delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'queued', 'delivering', 'sent', 'failed')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivery_lease_id TEXT,
  delivery_lease_expires_at_ms INTEGER,
  last_delivery_error TEXT,
  delivered_at_ms INTEGER CHECK (delivered_at_ms IS NULL OR delivered_at_ms >= created_at_ms),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms),
  consume_nonce TEXT UNIQUE,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (status = 'pending' AND consumed_at_ms IS NULL AND consume_nonce IS NULL)
    OR
    (status = 'consumed' AND consumed_at_ms IS NOT NULL AND consume_nonce IS NOT NULL)
  ),
  CHECK (
    (delivery_state = 'delivering'
      AND delivery_lease_id IS NOT NULL
      AND delivery_lease_expires_at_ms IS NOT NULL)
    OR
    (delivery_state <> 'delivering'
      AND delivery_lease_id IS NULL
      AND delivery_lease_expires_at_ms IS NULL)
  )
) STRICT;

CREATE INDEX idx_user_totp_email_delivery_recovery
  ON user_totp_email_challenges(delivery_state, delivery_lease_expires_at_ms, updated_at_ms);

CREATE TABLE user_totp_email_rate_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  window_started_at_ms INTEGER NOT NULL CHECK (window_started_at_ms >= 0),
  send_count INTEGER NOT NULL CHECK (send_count BETWEEN 1 AND 5),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= window_started_at_ms)
) STRICT;

-- A grant belongs to exactly one authenticated session; another session for the
-- same user never inherits it.
ALTER TABLE user_sessions ADD COLUMN step_up_expires_at_ms INTEGER
  CHECK (step_up_expires_at_ms IS NULL OR step_up_expires_at_ms >= created_at_ms);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (21, 'user_totp', CAST(unixepoch('subsec') * 1000 AS INTEGER));
