PRAGMA foreign_keys = ON;

-- D1 owns platform quota configuration and the durable usage projection. Live
-- reservation/settlement is serialized by the existing user-sharded
-- API_KEY_LIMIT_STATE Durable Object.
CREATE TABLE user_platform_quota_sets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  control_version INTEGER NOT NULL DEFAULT 0
    CHECK (control_version >= 0 AND control_version <= 9007199254740991),
  last_mutation_id TEXT,
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= 0 AND updated_at_ms <= 8640000000000000)
) STRICT;

CREATE TABLE user_platform_quotas (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (
    platform IN ('anthropic', 'openai', 'gemini', 'antigravity', 'grok')
  ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  daily_limit_micros INTEGER
    CHECK (daily_limit_micros IS NULL OR (daily_limit_micros >= 0 AND daily_limit_micros <= 9007199254740991)),
  weekly_limit_micros INTEGER
    CHECK (weekly_limit_micros IS NULL OR (weekly_limit_micros >= 0 AND weekly_limit_micros <= 9007199254740991)),
  monthly_limit_micros INTEGER
    CHECK (monthly_limit_micros IS NULL OR (monthly_limit_micros >= 0 AND monthly_limit_micros <= 9007199254740991)),
  daily_used_micros INTEGER NOT NULL DEFAULT 0
    CHECK (daily_used_micros >= 0 AND daily_used_micros <= 9007199254740991),
  weekly_used_micros INTEGER NOT NULL DEFAULT 0
    CHECK (weekly_used_micros >= 0 AND weekly_used_micros <= 9007199254740991),
  monthly_used_micros INTEGER NOT NULL DEFAULT 0
    CHECK (monthly_used_micros >= 0 AND monthly_used_micros <= 9007199254740991),
  daily_window_start_ms INTEGER
    CHECK (daily_window_start_ms IS NULL OR (daily_window_start_ms >= 0 AND daily_window_start_ms <= 8640000000000000)),
  weekly_window_start_ms INTEGER
    CHECK (weekly_window_start_ms IS NULL OR (weekly_window_start_ms >= 0 AND weekly_window_start_ms <= 8640000000000000)),
  monthly_window_start_ms INTEGER
    CHECK (monthly_window_start_ms IS NULL OR (monthly_window_start_ms >= 0 AND monthly_window_start_ms <= 8640000000000000)),
  daily_reset_epoch INTEGER NOT NULL DEFAULT 0
    CHECK (daily_reset_epoch >= 0 AND daily_reset_epoch <= 9007199254740991),
  weekly_reset_epoch INTEGER NOT NULL DEFAULT 0
    CHECK (weekly_reset_epoch >= 0 AND weekly_reset_epoch <= 9007199254740991),
  monthly_reset_epoch INTEGER NOT NULL DEFAULT 0
    CHECK (monthly_reset_epoch >= 0 AND monthly_reset_epoch <= 9007199254740991),
  control_version INTEGER NOT NULL DEFAULT 0
    CHECK (control_version >= 0 AND control_version <= 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= 0 AND updated_at_ms <= 8640000000000000),
  PRIMARY KEY (user_id, platform)
) STRICT;

CREATE INDEX idx_user_platform_quotas_owner_enabled
  ON user_platform_quotas(user_id, enabled, platform);

CREATE TRIGGER prevent_platform_quota_control_version_regression
BEFORE UPDATE OF control_version ON user_platform_quotas
FOR EACH ROW
WHEN NEW.control_version <= OLD.control_version
BEGIN
  SELECT RAISE(ABORT, 'platform_quota_control_version_regressed');
END;

CREATE TRIGGER prevent_platform_quota_set_control_version_regression
BEFORE UPDATE OF control_version ON user_platform_quota_sets
FOR EACH ROW
WHEN NEW.control_version <= OLD.control_version
BEGIN
  SELECT RAISE(ABORT, 'platform_quota_set_control_version_regressed');
END;

-- Private registration defaults. These never enter public settings/KV.
CREATE TABLE platform_quota_defaults (
  platform TEXT PRIMARY KEY CHECK (
    platform IN ('anthropic', 'openai', 'gemini', 'antigravity', 'grok')
  ),
  daily_limit_micros INTEGER
    CHECK (daily_limit_micros IS NULL OR (daily_limit_micros >= 0 AND daily_limit_micros <= 9007199254740991)),
  weekly_limit_micros INTEGER
    CHECK (weekly_limit_micros IS NULL OR (weekly_limit_micros >= 0 AND weekly_limit_micros <= 9007199254740991)),
  monthly_limit_micros INTEGER
    CHECK (monthly_limit_micros IS NULL OR (monthly_limit_micros >= 0 AND monthly_limit_micros <= 9007199254740991)),
  control_version INTEGER NOT NULL DEFAULT 0
    CHECK (control_version >= 0 AND control_version <= 9007199254740991),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= 0 AND updated_at_ms <= 8640000000000000)
) STRICT;

CREATE TABLE platform_quota_defaults_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  control_version INTEGER NOT NULL DEFAULT 0
    CHECK (control_version >= 0 AND control_version <= 9007199254740991),
  last_mutation_id TEXT,
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= 0 AND updated_at_ms <= 8640000000000000)
) STRICT;

INSERT INTO platform_quota_defaults_control (
  singleton, control_version, last_mutation_id, updated_at_ms
) VALUES (1, 0, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER));

CREATE TRIGGER prevent_platform_quota_defaults_version_regression
BEFORE UPDATE OF control_version ON platform_quota_defaults_control
FOR EACH ROW
WHEN NEW.control_version <= OLD.control_version
BEGIN
  SELECT RAISE(ABORT, 'platform_quota_defaults_control_version_regressed');
END;

CREATE TABLE admin_platform_quota_default_audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_session_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = 'platform_quota_defaults.replace'),
  resource_version INTEGER NOT NULL CHECK (resource_version > 0),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  occurred_at_ms INTEGER NOT NULL
    CHECK (occurred_at_ms >= 0 AND occurred_at_ms <= 8640000000000000)
) STRICT;

CREATE INDEX idx_admin_platform_quota_default_audit_actor_time
  ON admin_platform_quota_default_audit_events(actor_user_id, occurred_at_ms DESC, id);

CREATE TABLE admin_platform_quota_audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_session_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('platform_quotas.replace', 'platform_quota.reset')),
  resource_version INTEGER NOT NULL CHECK (resource_version > 0),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  occurred_at_ms INTEGER NOT NULL
    CHECK (occurred_at_ms >= 0 AND occurred_at_ms <= 8640000000000000)
) STRICT;

CREATE INDEX idx_admin_platform_quota_audit_target_time
  ON admin_platform_quota_audit_events(target_user_id, occurred_at_ms DESC, id);
CREATE INDEX idx_admin_platform_quota_audit_actor_time
  ON admin_platform_quota_audit_events(actor_user_id, occurred_at_ms DESC, id);

-- Expand the existing settlement state machine. Legacy rows and old Workers do
-- not have a platform quota reservation, so the new stages default to complete.
ALTER TABLE settlement_recovery ADD COLUMN platform_quota_platform TEXT
  CHECK (platform_quota_platform IS NULL OR platform_quota_platform IN ('anthropic', 'openai', 'gemini', 'antigravity', 'grok'));
ALTER TABLE settlement_recovery ADD COLUMN platform_quota_settled INTEGER NOT NULL DEFAULT 1
  CHECK (platform_quota_settled IN (0, 1));
ALTER TABLE settlement_recovery ADD COLUMN platform_quota_usage_json TEXT
  CHECK (platform_quota_usage_json IS NULL OR json_valid(platform_quota_usage_json));
ALTER TABLE settlement_recovery ADD COLUMN platform_quota_projected INTEGER NOT NULL DEFAULT 1
  CHECK (platform_quota_projected IN (0, 1));

CREATE INDEX idx_settlement_recovery_platform_quota_stages
  ON settlement_recovery(
    available_at_ms,
    platform_quota_settled,
    platform_quota_projected,
    request_id
  );

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (31, 'platform_quotas_model_plaza', CAST(unixepoch('subsec') * 1000 AS INTEGER));
