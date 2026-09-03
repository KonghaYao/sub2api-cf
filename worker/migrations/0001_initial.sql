PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  balance_micros INTEGER NOT NULL DEFAULT 0 CHECK (balance_micros >= 0),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE INDEX idx_users_status_created
  ON users(status, created_at_ms DESC);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= 0),
  last_used_at_ms INTEGER CHECK (last_used_at_ms IS NULL OR last_used_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE INDEX idx_api_keys_user_enabled
  ON api_keys(user_id, enabled, created_at_ms DESC);

CREATE TABLE "groups" (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  name TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

CREATE INDEX idx_groups_platform_enabled
  ON "groups"(platform, enabled, name);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  UNIQUE(platform, name)
) STRICT;

CREATE INDEX idx_accounts_platform_enabled
  ON accounts(platform, enabled, updated_at_ms DESC);

CREATE TABLE account_groups (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (account_id, group_id)
) STRICT;

CREATE INDEX idx_account_groups_group_priority
  ON account_groups(group_id, priority DESC, account_id);

CREATE TABLE settings (
  scope TEXT NOT NULL DEFAULT 'global',
  key TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (scope, key)
) STRICT;

CREATE TABLE usage_projection (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  projected_at_ms INTEGER NOT NULL CHECK (projected_at_ms >= 0),
  UNIQUE(user_id, request_id)
) STRICT;

CREATE INDEX idx_usage_projection_user_time
  ON usage_projection(user_id, occurred_at_ms DESC, event_id DESC);

CREATE INDEX idx_usage_projection_account_time
  ON usage_projection(account_id, occurred_at_ms DESC, event_id DESC);

CREATE TABLE outbox (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at_ms INTEGER NOT NULL CHECK (available_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  published_at_ms INTEGER CHECK (published_at_ms IS NULL OR published_at_ms >= 0),
  last_error TEXT
) STRICT;

CREATE INDEX idx_outbox_pending_available
  ON outbox(available_at_ms, created_at_ms)
  WHERE status = 'pending';

INSERT INTO schema_migrations (version, name, applied_at_ms)
VALUES (1, 'initial', CAST(unixepoch('subsec') * 1000 AS INTEGER));
