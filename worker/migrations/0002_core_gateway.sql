PRAGMA foreign_keys = ON;

ALTER TABLE api_keys ADD COLUMN group_id TEXT
  REFERENCES "groups"(id) ON DELETE RESTRICT;
ALTER TABLE api_keys ADD COLUMN key_prefix TEXT NOT NULL DEFAULT '';
ALTER TABLE api_keys ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1
  CHECK (auth_version > 0);
ALTER TABLE api_keys ADD COLUMN revoked_at_ms INTEGER
  CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= 0);

CREATE INDEX idx_api_keys_group_enabled
  ON api_keys(group_id, enabled, id);

ALTER TABLE accounts ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai'
  CHECK (protocol = 'openai');
ALTER TABLE accounts ADD COLUMN base_url TEXT;
ALTER TABLE accounts ADD COLUMN auth_scheme TEXT NOT NULL DEFAULT 'bearer'
  CHECK (auth_scheme = 'bearer');
ALTER TABLE accounts ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1
  CHECK (config_version > 0);

CREATE TABLE account_secrets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'upstream_auth'
    CHECK (purpose = 'upstream_auth'),
  algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM'
    CHECK (algorithm = 'AES-256-GCM'),
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
  nonce_b64 TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  UNIQUE(account_id, purpose)
) STRICT;

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  public_name TEXT NOT NULL,
  upstream_name TEXT NOT NULL,
  endpoint TEXT NOT NULL
    CHECK (endpoint IN ('chat_completions', 'responses', 'both')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  UNIQUE(platform, public_name)
) STRICT;

CREATE INDEX idx_models_platform_enabled
  ON models(platform, enabled, public_name);

CREATE TABLE group_models (
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  upstream_name_override TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  max_output_tokens INTEGER NOT NULL DEFAULT 16384 CHECK (max_output_tokens > 0),
  default_max_output_tokens INTEGER NOT NULL DEFAULT 4096 CHECK (default_max_output_tokens > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (group_id, model_id)
) STRICT;

CREATE INDEX idx_group_models_catalog
  ON group_models(group_id, enabled, sort_order, model_id);

CREATE TABLE model_prices (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  input_micros_per_million INTEGER NOT NULL CHECK (input_micros_per_million >= 0),
  output_micros_per_million INTEGER NOT NULL CHECK (output_micros_per_million >= 0),
  cache_read_micros_per_million INTEGER NOT NULL DEFAULT 0
    CHECK (cache_read_micros_per_million >= 0),
  per_request_micros INTEGER NOT NULL DEFAULT 0 CHECK (per_request_micros >= 0),
  minimum_reservation_micros INTEGER NOT NULL DEFAULT 1
    CHECK (minimum_reservation_micros > 0),
  effective_at_ms INTEGER NOT NULL CHECK (effective_at_ms >= 0),
  retired_at_ms INTEGER CHECK (retired_at_ms IS NULL OR retired_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE(group_id, model_id, version),
  FOREIGN KEY (group_id, model_id)
    REFERENCES group_models(group_id, model_id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX idx_model_prices_one_active
  ON model_prices(group_id, model_id)
  WHERE active = 1;

ALTER TABLE usage_projection ADD COLUMN group_id TEXT
  REFERENCES "groups"(id) ON DELETE SET NULL;
ALTER TABLE usage_projection ADD COLUMN price_id TEXT
  REFERENCES model_prices(id) ON DELETE SET NULL;
ALTER TABLE usage_projection ADD COLUMN requested_model TEXT;
ALTER TABLE usage_projection ADD COLUMN upstream_model TEXT;
ALTER TABLE usage_projection ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0
  CHECK (cache_read_tokens >= 0);
ALTER TABLE usage_projection ADD COLUMN input_amount_micros INTEGER NOT NULL DEFAULT 0
  CHECK (input_amount_micros >= 0);
ALTER TABLE usage_projection ADD COLUMN output_amount_micros INTEGER NOT NULL DEFAULT 0
  CHECK (output_amount_micros >= 0);
ALTER TABLE usage_projection ADD COLUMN cache_amount_micros INTEGER NOT NULL DEFAULT 0
  CHECK (cache_amount_micros >= 0);
ALTER TABLE usage_projection ADD COLUMN outcome TEXT NOT NULL DEFAULT 'completed'
  CHECK (outcome IN ('completed', 'failed', 'cancelled'));
ALTER TABLE usage_projection ADD COLUMN stream INTEGER NOT NULL DEFAULT 0
  CHECK (stream IN (0, 1));
ALTER TABLE usage_projection ADD COLUMN duration_ms INTEGER
  CHECK (duration_ms IS NULL OR duration_ms >= 0);

CREATE INDEX idx_usage_projection_api_key_time
  ON usage_projection(api_key_id, occurred_at_ms DESC, event_id DESC);
CREATE INDEX idx_usage_projection_group_time
  ON usage_projection(group_id, occurred_at_ms DESC, event_id DESC);

CREATE TABLE inbox (
  consumer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at_ms INTEGER NOT NULL CHECK (processed_at_ms >= 0),
  result_digest TEXT,
  PRIMARY KEY (consumer, event_id)
) STRICT;

DROP INDEX idx_account_groups_group_priority;
CREATE INDEX idx_account_groups_group_priority
  ON account_groups(group_id, priority ASC, account_id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (2, 'core_gateway', CAST(unixepoch('subsec') * 1000 AS INTEGER));
