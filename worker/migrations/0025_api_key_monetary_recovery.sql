PRAGMA foreign_keys = ON;

-- Settlement is a three-stage command: primary user/subscription authority,
-- API-key monetary authority, then monotonic D1 usage projection. Persisting
-- each stage independently makes a replay safe across isolate termination.
ALTER TABLE settlement_recovery ADD COLUMN api_key_id TEXT
  REFERENCES api_keys(id) ON DELETE RESTRICT;
ALTER TABLE settlement_recovery ADD COLUMN billing_settled INTEGER NOT NULL DEFAULT 0
  CHECK (billing_settled IN (0, 1));
-- Defaults stay legacy-safe for old Workers that may still INSERT during a
-- rolling deploy. The new Worker explicitly writes zero for real key stages.
ALTER TABLE settlement_recovery ADD COLUMN api_key_settled INTEGER NOT NULL DEFAULT 1
  CHECK (api_key_settled IN (0, 1));
ALTER TABLE settlement_recovery ADD COLUMN api_key_usage_json TEXT
  CHECK (api_key_usage_json IS NULL OR json_valid(api_key_usage_json));
ALTER TABLE settlement_recovery ADD COLUMN api_key_projected INTEGER NOT NULL DEFAULT 1
  CHECK (api_key_projected IN (0, 1));

-- Rows created by the pre-0025 Worker never created an API-key reservation.
-- Keep their primary billing stage pending, but make recovery skip the two new
-- stages after that legacy settlement succeeds.
UPDATE settlement_recovery
   SET api_key_settled = 1,
       api_key_projected = 1;

-- Leave api_key_id NULL on legacy rows. Besides making the legacy shape
-- unambiguous, this avoids turning a historical usage payload into a new
-- foreign-key requirement during deployment.

CREATE INDEX idx_settlement_recovery_stages
  ON settlement_recovery(available_at_ms, billing_settled, api_key_settled, api_key_projected);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (25, 'api_key_monetary_recovery', CAST(unixepoch('subsec') * 1000 AS INTEGER));
