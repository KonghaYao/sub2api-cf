PRAGMA foreign_keys = ON;

CREATE TABLE account_models (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  chat_completions INTEGER NOT NULL DEFAULT 1 CHECK (chat_completions IN (0, 1)),
  responses INTEGER NOT NULL DEFAULT 1 CHECK (responses IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (account_id, model_id)
) STRICT;

CREATE INDEX idx_account_models_capability
  ON account_models(model_id, chat_completions, responses, account_id);

ALTER TABLE usage_projection ADD COLUMN base_amount_micros INTEGER NOT NULL DEFAULT 0
  CHECK (base_amount_micros >= 0);

CREATE TABLE settlement_recovery (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  usage_event_json TEXT NOT NULL CHECK (json_valid(usage_event_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at_ms INTEGER NOT NULL CHECK (available_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  last_error TEXT
) STRICT;

CREATE INDEX idx_settlement_recovery_due
  ON settlement_recovery(available_at_ms, request_id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (3, 'gateway_recovery', CAST(unixepoch('subsec') * 1000 AS INTEGER));
