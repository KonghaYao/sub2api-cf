PRAGMA foreign_keys = ON;

-- Provider acquisition-cost adjustment.  PPM keeps the authoritative value
-- exact and matches the rest of the Worker billing boundary.
ALTER TABLE accounts
  ADD COLUMN billing_rate_multiplier_ppm INTEGER NOT NULL DEFAULT 1000000
    CHECK (
      billing_rate_multiplier_ppm BETWEEN 0 AND 9007199254740991
    );

-- Ordered channel rules are intentionally separate from customer-facing
-- channel pricing.  They affect operational account-cost statistics only.
CREATE TABLE channel_account_stats_pricing_rules (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 128),
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT ''
    CHECK (length(name) <= 100),
  sort_order INTEGER NOT NULL DEFAULT 0
    CHECK (sort_order BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991)
) STRICT;

CREATE INDEX idx_account_stats_rules_channel_order
  ON channel_account_stats_pricing_rules(channel_id, sort_order, id);

-- Scope membership is normalized instead of storing identifier arrays in JSON.
-- Deleting an account/group removes only that scope edge; deleting a channel
-- removes the complete rule graph.
CREATE TABLE channel_account_stats_rule_groups (
  rule_id TEXT NOT NULL
    REFERENCES channel_account_stats_pricing_rules(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (rule_id, group_id)
) STRICT;

CREATE INDEX idx_account_stats_rule_groups_lookup
  ON channel_account_stats_rule_groups(group_id, rule_id);

CREATE TABLE channel_account_stats_rule_accounts (
  rule_id TEXT NOT NULL
    REFERENCES channel_account_stats_pricing_rules(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (rule_id, account_id)
) STRICT;

CREATE INDEX idx_account_stats_rule_accounts_lookup
  ON channel_account_stats_rule_accounts(account_id, rule_id);

-- These are the fields the original account-statistics calculator actually
-- consumed.  Empty platform means provider-agnostic.  Time pricing and the
-- unused fast/flex/image-input fields are deliberately outside this contract.
CREATE TABLE channel_account_stats_model_pricing (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 128),
  rule_id TEXT NOT NULL
    REFERENCES channel_account_stats_pricing_rules(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT ''
    CHECK (length(platform) <= 64 AND platform = trim(platform)),
  billing_mode TEXT NOT NULL DEFAULT 'token'
    CHECK (billing_mode IN ('token', 'per_request', 'image')),
  input_micros_per_million INTEGER
    CHECK (input_micros_per_million BETWEEN 0 AND 9007199254740991),
  output_micros_per_million INTEGER
    CHECK (output_micros_per_million BETWEEN 0 AND 9007199254740991),
  cache_write_micros_per_million INTEGER
    CHECK (cache_write_micros_per_million BETWEEN 0 AND 9007199254740991),
  cache_write_1h_micros_per_million INTEGER
    CHECK (cache_write_1h_micros_per_million BETWEEN 0 AND 9007199254740991),
  cache_read_micros_per_million INTEGER
    CHECK (cache_read_micros_per_million BETWEEN 0 AND 9007199254740991),
  image_output_micros_per_million INTEGER
    CHECK (image_output_micros_per_million BETWEEN 0 AND 9007199254740991),
  per_request_micros INTEGER
    CHECK (per_request_micros BETWEEN 0 AND 9007199254740991),
  sort_order INTEGER NOT NULL DEFAULT 0
    CHECK (sort_order BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991)
) STRICT;

CREATE INDEX idx_account_stats_pricing_rule_platform
  ON channel_account_stats_model_pricing(rule_id, platform, sort_order, id);

CREATE TABLE channel_account_stats_pricing_models (
  pricing_id TEXT NOT NULL
    REFERENCES channel_account_stats_model_pricing(id) ON DELETE CASCADE,
  model_pattern TEXT NOT NULL COLLATE NOCASE
    CHECK (length(trim(model_pattern)) BETWEEN 1 AND 256),
  is_wildcard INTEGER NOT NULL DEFAULT 0
    CHECK (is_wildcard IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
    CHECK (sort_order BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (pricing_id, model_pattern),
  CHECK (
    (is_wildcard = 0 AND instr(model_pattern, '*') = 0)
    OR (
      is_wildcard = 1
      AND substr(model_pattern, -1, 1) = '*'
      AND instr(substr(model_pattern, 1, length(model_pattern) - 1), '*') = 0
    )
  )
) STRICT;

CREATE INDEX idx_account_stats_pricing_models_read
  ON channel_account_stats_pricing_models(
    pricing_id, is_wildcard, sort_order, model_pattern
  );

CREATE TABLE channel_account_stats_pricing_intervals (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 128),
  pricing_id TEXT NOT NULL
    REFERENCES channel_account_stats_model_pricing(id) ON DELETE CASCADE,
  min_tokens INTEGER NOT NULL DEFAULT 0
    CHECK (min_tokens BETWEEN 0 AND 9007199254740991),
  max_tokens INTEGER
    CHECK (
      max_tokens IS NULL
      OR (max_tokens > min_tokens AND max_tokens <= 9007199254740991)
    ),
  tier_label TEXT NOT NULL DEFAULT ''
    CHECK (length(tier_label) <= 128),
  input_micros_per_million INTEGER
    CHECK (input_micros_per_million BETWEEN 0 AND 9007199254740991),
  output_micros_per_million INTEGER
    CHECK (output_micros_per_million BETWEEN 0 AND 9007199254740991),
  cache_write_micros_per_million INTEGER
    CHECK (cache_write_micros_per_million BETWEEN 0 AND 9007199254740991),
  cache_write_1h_micros_per_million INTEGER
    CHECK (cache_write_1h_micros_per_million BETWEEN 0 AND 9007199254740991),
  cache_read_micros_per_million INTEGER
    CHECK (cache_read_micros_per_million BETWEEN 0 AND 9007199254740991),
  per_request_micros INTEGER
    CHECK (per_request_micros BETWEEN 0 AND 9007199254740991),
  sort_order INTEGER NOT NULL DEFAULT 0
    CHECK (sort_order BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991)
) STRICT;

CREATE INDEX idx_account_stats_pricing_intervals_read
  ON channel_account_stats_pricing_intervals(pricing_id, sort_order, id);

-- Nullable columns keep rolling-deploy and historical writes from the previous
-- Worker distinguishable from deliberate zero-cost snapshots. Read paths use
-- amount_micros as the compatibility fallback; deliberately avoid a full-table
-- backfill because it can exhaust the Workers Free D1 rows-written allowance.
ALTER TABLE usage_projection ADD COLUMN standard_cost_micros INTEGER
  CHECK (
    standard_cost_micros IS NULL
    OR standard_cost_micros BETWEEN 0 AND 9007199254740991
  );
ALTER TABLE usage_projection ADD COLUMN account_stats_cost_micros INTEGER
  CHECK (
    account_stats_cost_micros IS NULL
    OR account_stats_cost_micros BETWEEN 0 AND 9007199254740991
  );
ALTER TABLE usage_projection ADD COLUMN account_rate_multiplier_ppm INTEGER
  CHECK (
    account_rate_multiplier_ppm IS NULL
    OR account_rate_multiplier_ppm BETWEEN 0 AND 9007199254740991
  );
ALTER TABLE usage_projection ADD COLUMN account_cost_micros INTEGER
  CHECK (
    account_cost_micros IS NULL
    OR account_cost_micros BETWEEN 0 AND 9007199254740991
  );
ALTER TABLE usage_projection ADD COLUMN account_stats_rollup_version INTEGER NOT NULL DEFAULT 0
  CHECK (account_stats_rollup_version IN (0, 1));

-- New projections maintain a sparse 15-minute operational rollup in the same
-- D1 transaction.  Fifteen minutes exactly covers modern IANA quarter-hour
-- offsets while collapsing high-volume request rows before admin reporting.
CREATE TABLE account_usage_15m_rollup (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  bucket_start_ms INTEGER NOT NULL
    CHECK (bucket_start_ms >= 0 AND bucket_start_ms % 900000 = 0),
  model TEXT NOT NULL,
  inbound_endpoint TEXT NOT NULL DEFAULT '',
  upstream_endpoint TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL CHECK (requests > 0),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  standard_cost_micros INTEGER NOT NULL CHECK (standard_cost_micros >= 0),
  account_cost_micros INTEGER NOT NULL CHECK (account_cost_micros >= 0),
  user_cost_micros INTEGER NOT NULL CHECK (user_cost_micros >= 0),
  duration_total_ms INTEGER NOT NULL CHECK (duration_total_ms >= 0),
  duration_count INTEGER NOT NULL CHECK (duration_count > 0),
  PRIMARY KEY (account_id, bucket_start_ms, model, inbound_endpoint, upstream_endpoint)
) STRICT;

CREATE INDEX idx_account_usage_15m_rollup_retention
  ON account_usage_15m_rollup(bucket_start_ms, account_id);

-- Do not add an index to the historical usage table here: D1 builds indexes
-- synchronously and would rewrite the entire existing projection during a
-- Free-plan migration. Scheduled recovery walks one account at a time through
-- the existing idx_usage_projection_account_time index instead.
CREATE TABLE account_stats_rollup_maintenance (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  migration_started_at_ms INTEGER NOT NULL CHECK (migration_started_at_ms >= 0),
  legacy_write_grace_until_ms INTEGER NOT NULL CHECK (legacy_write_grace_until_ms >= migration_started_at_ms),
  discovery_cursor TEXT NOT NULL DEFAULT '',
  active_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  backfill_complete INTEGER NOT NULL DEFAULT 0 CHECK (backfill_complete IN (0, 1)),
  backfill_budget_day INTEGER NOT NULL CHECK (backfill_budget_day >= 0),
  backfill_writes_used INTEGER NOT NULL DEFAULT 0 CHECK (backfill_writes_used >= 0),
  retention_budget_day INTEGER NOT NULL CHECK (retention_budget_day >= 0),
  retention_writes_used INTEGER NOT NULL DEFAULT 0 CHECK (retention_writes_used >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

INSERT INTO account_stats_rollup_maintenance (
  id, migration_started_at_ms, legacy_write_grace_until_ms,
  discovery_cursor, active_account_id, backfill_complete,
  backfill_budget_day, retention_budget_day, updated_at_ms
) VALUES (
  'global',
  CAST(unixepoch('subsec') * 1000 AS INTEGER),
  CAST(unixepoch('subsec') * 1000 AS INTEGER) + 86400000,
  '', NULL, 0,
  CAST(unixepoch() / 86400 AS INTEGER),
  CAST(unixepoch() / 86400 AS INTEGER),
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
);

CREATE TABLE account_stats_rollup_progress (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  cutoff_ms INTEGER NOT NULL CHECK (cutoff_ms >= 0),
  cursor_occurred_at_ms INTEGER NOT NULL CHECK (cursor_occurred_at_ms >= 0),
  cursor_event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'complete')),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

-- A projected event is an immutable historical pricing snapshot.  Retention may
-- delete the row, but no later configuration change may rewrite its economics.
CREATE TRIGGER usage_account_cost_immutable
BEFORE UPDATE OF standard_cost_micros, account_stats_cost_micros,
  account_rate_multiplier_ppm, account_cost_micros ON usage_projection
BEGIN
  SELECT RAISE(ABORT, 'usage_account_cost_immutable');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (
  53,
  'account_stats_pricing',
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
);
