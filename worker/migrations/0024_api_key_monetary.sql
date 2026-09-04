PRAGMA foreign_keys = ON;

-- Money is stored as integer micro-USD throughout the Worker. This avoids the
-- rounding and non-finite-number edge cases of the legacy float contract.
ALTER TABLE api_keys ADD COLUMN quota_micros INTEGER NOT NULL DEFAULT 0
  CHECK (quota_micros >= 0 AND quota_micros <= 9007199254740991);
ALTER TABLE api_keys ADD COLUMN quota_used_micros INTEGER NOT NULL DEFAULT 0
  CHECK (quota_used_micros >= 0 AND quota_used_micros <= 9007199254740991);

ALTER TABLE api_keys ADD COLUMN rate_limit_5h_micros INTEGER NOT NULL DEFAULT 0
  CHECK (rate_limit_5h_micros >= 0 AND rate_limit_5h_micros <= 9007199254740991);
ALTER TABLE api_keys ADD COLUMN rate_limit_1d_micros INTEGER NOT NULL DEFAULT 0
  CHECK (rate_limit_1d_micros >= 0 AND rate_limit_1d_micros <= 9007199254740991);
ALTER TABLE api_keys ADD COLUMN rate_limit_7d_micros INTEGER NOT NULL DEFAULT 0
  CHECK (rate_limit_7d_micros >= 0 AND rate_limit_7d_micros <= 9007199254740991);

ALTER TABLE api_keys ADD COLUMN usage_5h_micros INTEGER NOT NULL DEFAULT 0
  CHECK (usage_5h_micros >= 0 AND usage_5h_micros <= 9007199254740991);
ALTER TABLE api_keys ADD COLUMN usage_1d_micros INTEGER NOT NULL DEFAULT 0
  CHECK (usage_1d_micros >= 0 AND usage_1d_micros <= 9007199254740991);
ALTER TABLE api_keys ADD COLUMN usage_7d_micros INTEGER NOT NULL DEFAULT 0
  CHECK (usage_7d_micros >= 0 AND usage_7d_micros <= 9007199254740991);

ALTER TABLE api_keys ADD COLUMN window_5h_start_ms INTEGER
  CHECK (window_5h_start_ms IS NULL OR (window_5h_start_ms >= 0 AND window_5h_start_ms <= 9007199254740991));
ALTER TABLE api_keys ADD COLUMN window_1d_start_ms INTEGER
  CHECK (window_1d_start_ms IS NULL OR (window_1d_start_ms >= 0 AND window_1d_start_ms <= 9007199254740991));
ALTER TABLE api_keys ADD COLUMN window_7d_start_ms INTEGER
  CHECK (window_7d_start_ms IS NULL OR (window_7d_start_ms >= 0 AND window_7d_start_ms <= 9007199254740991));

-- Epochs let asynchronous state projection discard charges that were emitted
-- before an administrator/user explicitly reset the corresponding counters.
ALTER TABLE api_keys ADD COLUMN quota_reset_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (quota_reset_epoch >= 0 AND quota_reset_epoch <= 9007199254740991);
ALTER TABLE api_keys ADD COLUMN rate_limit_reset_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (rate_limit_reset_epoch >= 0 AND rate_limit_reset_epoch <= 9007199254740991);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (24, 'api_key_monetary', CAST(unixepoch('subsec') * 1000 AS INTEGER));
