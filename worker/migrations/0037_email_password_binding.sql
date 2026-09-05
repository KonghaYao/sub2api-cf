PRAGMA foreign_keys = ON;

-- This generated value is the cross-flow authority for an email inbox. It is
-- built over every pre-0037 users row, so password registration, OAuth
-- registration, authenticated binding, and administrative email changes all
-- share one atomic uniqueness boundary without requiring each writer to keep a
-- side table in sync. Migration intentionally fails when legacy aliases already
-- collide; operators must resolve those ambiguous owners before retrying 0037.
-- Keeping the canonical value as an indexed virtual column also gives read paths
-- an exact lookup that does not wrap users.email in functions or scan aliases.
ALTER TABLE users ADD COLUMN canonical_email_inbox TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN lower(rtrim(substr(trim(email), instr(trim(email), '@') + 1), '.'))
           IN ('gmail.com', 'googlemail.com')
      THEN
        CASE
          WHEN replace(
            CASE
              WHEN instr(
                substr(lower(trim(email)), 1, instr(trim(email), '@') - 1), '+'
              ) > 1
              THEN substr(
                substr(lower(trim(email)), 1, instr(trim(email), '@') - 1),
                1,
                instr(substr(lower(trim(email)), 1, instr(trim(email), '@') - 1), '+') - 1
              )
              ELSE substr(lower(trim(email)), 1, instr(trim(email), '@') - 1)
            END,
            '.',
            ''
          ) <> ''
          THEN replace(
            CASE
              WHEN instr(
                substr(lower(trim(email)), 1, instr(trim(email), '@') - 1), '+'
              ) > 1
              THEN substr(
                substr(lower(trim(email)), 1, instr(trim(email), '@') - 1),
                1,
                instr(substr(lower(trim(email)), 1, instr(trim(email), '@') - 1), '+') - 1
              )
              ELSE substr(lower(trim(email)), 1, instr(trim(email), '@') - 1)
            END,
            '.',
            ''
          )
          ELSE
            CASE
              WHEN instr(
                substr(lower(trim(email)), 1, instr(trim(email), '@') - 1), '+'
              ) > 1
              THEN substr(
                substr(lower(trim(email)), 1, instr(trim(email), '@') - 1),
                1,
                instr(substr(lower(trim(email)), 1, instr(trim(email), '@') - 1), '+') - 1
              )
              ELSE substr(lower(trim(email)), 1, instr(trim(email), '@') - 1)
            END
        END || '@gmail.com'
      ELSE
        CASE
          WHEN instr(
            substr(lower(trim(email)), 1, instr(trim(email), '@') - 1), '+'
          ) > 1
          THEN substr(
            substr(lower(trim(email)), 1, instr(trim(email), '@') - 1),
            1,
            instr(substr(lower(trim(email)), 1, instr(trim(email), '@') - 1), '+') - 1
          )
          ELSE substr(lower(trim(email)), 1, instr(trim(email), '@') - 1)
        END || '@' || lower(rtrim(substr(trim(email), instr(trim(email), '@') + 1), '.'))
    END
  ) VIRTUAL;

CREATE UNIQUE INDEX uq_users_canonical_email_inbox
  ON users (canonical_email_inbox);

-- Authenticated email/password binding is a separate challenge lifecycle from
-- ordinary mailbox verification. Keeping it separate lets every code be bound
-- to the exact user session and auth_version that requested the credential
-- change without weakening the older email_challenges contract.
CREATE TABLE email_binding_challenges (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
  auth_version INTEGER NOT NULL CHECK (auth_version > 0),
  purpose TEXT NOT NULL DEFAULT 'email_binding' CHECK (purpose = 'email_binding'),
  email_hash TEXT NOT NULL UNIQUE CHECK (length(email_hash) = 64),
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
  UNIQUE(user_id),
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

CREATE INDEX idx_email_binding_challenges_delivery_recovery
  ON email_binding_challenges(delivery_state, delivery_lease_expires_at_ms, updated_at_ms)
  WHERE status = 'pending' AND delivery_state IN ('queued', 'delivering', 'failed');

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (37, 'email_password_binding', CAST(unixepoch('subsec') * 1000 AS INTEGER));
