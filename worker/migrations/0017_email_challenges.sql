PRAGMA foreign_keys = ON;

-- One current challenge per user and purpose. Raw challenge material is never
-- persisted: it exists only in the Queue delivery event and the recipient's
-- message. Rotating this row also makes delayed delivery events stale.
CREATE TABLE email_challenges (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL
    CHECK (purpose IN ('registration_email_verification', 'email_verification', 'password_reset')),
  email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed')),
  delivery_event_id TEXT NOT NULL UNIQUE,
  delivery_event_hash TEXT NOT NULL CHECK (length(delivery_event_hash) = 64),
  delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'queued', 'delivering', 'sent', 'failed')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  verification_attempts INTEGER NOT NULL DEFAULT 0 CHECK (verification_attempts >= 0),
  delivery_lease_id TEXT,
  delivery_lease_expires_at_ms INTEGER
    CHECK (delivery_lease_expires_at_ms IS NULL OR delivery_lease_expires_at_ms >= 0),
  last_delivery_error TEXT,
  requested_ip_hash TEXT NOT NULL CHECK (length(requested_ip_hash) = 64),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  delivered_at_ms INTEGER
    CHECK (delivered_at_ms IS NULL OR delivered_at_ms >= created_at_ms),
  consumed_at_ms INTEGER
    CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms),
  consume_nonce TEXT UNIQUE,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  UNIQUE(email_hash, purpose),
  CHECK (
    (purpose = 'registration_email_verification' AND user_id IS NULL)
    OR
    (purpose <> 'registration_email_verification' AND user_id IS NOT NULL)
  ),
  CHECK (
    (status = 'pending' AND consumed_at_ms IS NULL AND consume_nonce IS NULL)
    OR
    (status = 'consumed' AND consumed_at_ms IS NOT NULL AND consume_nonce IS NOT NULL)
  ),
  CHECK (
    (delivery_state = 'delivering' AND delivery_lease_id IS NOT NULL
      AND delivery_lease_expires_at_ms IS NOT NULL)
    OR
    (delivery_state <> 'delivering' AND delivery_lease_id IS NULL
      AND delivery_lease_expires_at_ms IS NULL)
  )
) STRICT;

CREATE INDEX idx_email_challenges_active_expiry
  ON email_challenges(purpose, expires_at_ms, email_hash)
  WHERE status = 'pending';

CREATE INDEX idx_email_challenges_delivery_recovery
  ON email_challenges(delivery_state, delivery_lease_expires_at_ms, updated_at_ms)
  WHERE status = 'pending' AND delivery_state IN ('queued', 'delivering', 'failed');

-- The registration batch inserts a claim after inserting the user. Its foreign
-- keys force D1 to roll the entire batch back when the preceding one-time
-- challenge consume did not succeed (including concurrent replay).
CREATE TABLE registration_email_challenge_claims (
  consume_nonce TEXT PRIMARY KEY
    REFERENCES email_challenges(consume_nonce) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
  claimed_at_ms INTEGER NOT NULL CHECK (claimed_at_ms >= 0)
) STRICT;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (17, 'email_challenges', CAST(unixepoch('subsec') * 1000 AS INTEGER));
