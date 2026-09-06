PRAGMA foreign_keys = ON;

-- Existing users remain conservatively incomplete. New Worker code writes 1
-- explicitly at creation, avoiding any migration/deployment timestamp race.
ALTER TABLE users ADD COLUMN financial_history_complete INTEGER NOT NULL DEFAULT 0
  CHECK (financial_history_complete IN (0, 1));

-- Durable Objects remain the balance authority. This table is the immutable,
-- query-optimized history projected from their transactional outbox events.
-- All monetary values use integer micros; no floating-point amount is stored.
CREATE TABLE user_financial_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('opening_balance', 'balance_adjustment', 'settlement')
  ),
  source_type TEXT NOT NULL CHECK (
    source_type IN (
      'opening_balance', 'admin_adjustment', 'redeem_code',
      'affiliate_transfer', 'affiliate_refund_clawback',
      'auth_source_entitlement', 'usage_settlement', 'other_adjustment'
    )
  ),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 256),
  request_id TEXT CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 256),
  actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  actor_session_id TEXT CHECK (
    actor_session_id IS NULL OR length(actor_session_id) BETWEEN 1 AND 128
  ),
  amount_delta_micros INTEGER NOT NULL CHECK (
    amount_delta_micros BETWEEN -9007199254740991 AND 9007199254740991
  ),
  gross_amount_micros INTEGER NOT NULL CHECK (
    gross_amount_micros BETWEEN -9007199254740991 AND 9007199254740991
  ),
  spend_debt_delta_micros INTEGER NOT NULL CHECK (
    spend_debt_delta_micros BETWEEN -9007199254740991 AND 9007199254740991
  ),
  balance_after_micros INTEGER NOT NULL CHECK (
    balance_after_micros BETWEEN 0 AND 9007199254740991
  ),
  spend_debt_after_micros INTEGER NOT NULL CHECK (
    spend_debt_after_micros BETWEEN 0 AND 9007199254740991
  ),
  occurred_at_ms INTEGER NOT NULL CHECK (
    occurred_at_ms BETWEEN 0 AND 8640000000000000
  ),
  projected_at_ms INTEGER NOT NULL CHECK (
    projected_at_ms BETWEEN 0 AND 8640000000000000
  ),
  UNIQUE (user_id, state_version),
  CHECK (
    (event_type = 'settlement' AND request_id IS NOT NULL AND gross_amount_micros >= 0)
    OR (event_type <> 'settlement' AND request_id IS NULL)
  ),
  CHECK (
    (actor_user_id IS NULL AND actor_session_id IS NULL)
    OR (actor_user_id IS NOT NULL AND actor_session_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_user_financial_events_user_cursor
  ON user_financial_events(user_id, occurred_at_ms DESC, event_id DESC);

CREATE TRIGGER user_financial_event_immutable_update
BEFORE UPDATE ON user_financial_events
BEGIN
  SELECT RAISE(ABORT, 'user_financial_event_immutable');
END;

CREATE TRIGGER user_financial_event_immutable_delete
BEFORE DELETE ON user_financial_events
BEGIN
  SELECT RAISE(ABORT, 'user_financial_event_immutable');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (
  55,
  'user_financial_events',
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
);
