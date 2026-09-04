PRAGMA foreign_keys = ON;

-- Notification settings are intentionally kept out of users. The one-row
-- aggregate gives every owner an independent CAS version without making an
-- unrelated profile or billing write contend on users.control_version.
CREATE TABLE user_notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  balance_notify_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (balance_notify_enabled IN (0, 1)),
  balance_notify_threshold_micros INTEGER
    CHECK (
      balance_notify_threshold_micros IS NULL
      OR balance_notify_threshold_micros BETWEEN 0 AND 9007199254740991
    ),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

-- Fixed-size, per-user admission state prevents rotating-address spam without
-- an append-only hot table. The CHECK turns the sixth write in a one-hour
-- window into an atomic batch failure.
CREATE TABLE user_notification_email_rate_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  window_started_at_ms INTEGER NOT NULL CHECK (window_started_at_ms >= 0),
  send_count INTEGER NOT NULL CHECK (send_count BETWEEN 1 AND 5),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= window_started_at_ms)
) STRICT;

-- Only verified notification addresses are durable preferences. Pending
-- addresses live in the challenge table and therefore never leak into the
-- recipient projection.
CREATE TABLE user_notification_emails (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE
    CHECK (
      email COLLATE BINARY = lower(trim(email)) COLLATE BINARY
      AND length(email) BETWEEN 3 AND 320
      AND instr(email, '@') > 1
    ),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  verified_at_ms INTEGER NOT NULL CHECK (verified_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  PRIMARY KEY (user_id, email)
) STRICT;

CREATE INDEX idx_user_notification_emails_recipients
  ON user_notification_emails(user_id, disabled, email);

CREATE TRIGGER trg_user_notification_emails_limit
BEFORE INSERT ON user_notification_emails
WHEN (
  SELECT COUNT(*) FROM user_notification_emails WHERE user_id = NEW.user_id
) >= 3
BEGIN
  SELECT RAISE(ABORT, 'notification_email_limit_exceeded');
END;

-- Challenge secrets are hashed. The raw token may exist in a transient Queue
-- event, but it is never written to D1.
CREATE TABLE user_notification_email_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE
    CHECK (
      email COLLATE BINARY = lower(trim(email)) COLLATE BINARY
      AND length(email) BETWEEN 3 AND 320
      AND instr(email, '@') > 1
    ),
  email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed')),
  verification_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (verification_attempts BETWEEN 0 AND 5),
  delivery_event_id TEXT NOT NULL UNIQUE,
  delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'queued', 'delivering', 'sent', 'failed')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivery_lease_id TEXT,
  delivery_lease_expires_at_ms INTEGER,
  last_delivery_error TEXT,
  delivered_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms INTEGER
    CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms),
  consume_nonce TEXT UNIQUE,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  UNIQUE (user_id, email),
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

CREATE INDEX idx_user_notification_email_challenges_expiry
  ON user_notification_email_challenges(user_id, expires_at_ms, email);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (20, 'user_notification_preferences', CAST(unixepoch('subsec') * 1000 AS INTEGER));
