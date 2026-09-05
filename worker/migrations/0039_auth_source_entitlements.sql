PRAGMA foreign_keys = ON;

-- Authentication-source defaults are private control-plane state. Keeping the
-- configuration normalized lets D1 enforce source, group and money invariants
-- before an authentication transaction can use it.
CREATE TABLE auth_source_defaults (
  source TEXT PRIMARY KEY CHECK (
    source IN ('email', 'linuxdo', 'oidc', 'wechat', 'dingtalk', 'github', 'google')
  ),
  balance_micros INTEGER NOT NULL DEFAULT 0
    CHECK (balance_micros >= 0 AND balance_micros <= 9007199254740991),
  concurrency INTEGER NOT NULL DEFAULT 5
    CHECK (concurrency > 0 AND concurrency <= 9007199254740991),
  grant_on_signup INTEGER NOT NULL DEFAULT 0 CHECK (grant_on_signup IN (0, 1)),
  grant_on_first_bind INTEGER NOT NULL DEFAULT 0 CHECK (grant_on_first_bind IN (0, 1)),
  updated_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (updated_at_ms >= 0 AND updated_at_ms <= 8640000000000000)
) STRICT;

INSERT INTO auth_source_defaults (source)
VALUES ('email'), ('linuxdo'), ('oidc'), ('wechat'), ('dingtalk'), ('github'), ('google');

CREATE TABLE auth_source_default_subscriptions (
  source TEXT NOT NULL REFERENCES auth_source_defaults(source) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE RESTRICT,
  validity_days INTEGER NOT NULL CHECK (validity_days > 0 AND validity_days <= 36500),
  PRIMARY KEY (source, group_id)
) STRICT;

CREATE INDEX idx_auth_source_default_subscriptions_group
  ON auth_source_default_subscriptions(group_id, source);

CREATE TRIGGER require_auth_source_subscription_group_insert
BEFORE INSERT ON auth_source_default_subscriptions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM "groups" WHERE id = NEW.group_id AND group_type = 'subscription'
)
BEGIN
  SELECT RAISE(ABORT, 'auth_source_subscription_group_required');
END;

CREATE TRIGGER require_auth_source_subscription_group_update
BEFORE UPDATE OF group_id ON auth_source_default_subscriptions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM "groups" WHERE id = NEW.group_id AND group_type = 'subscription'
)
BEGIN
  SELECT RAISE(ABORT, 'auth_source_subscription_group_required');
END;

CREATE TRIGGER prevent_configured_subscription_group_type_change
BEFORE UPDATE OF group_type ON "groups"
FOR EACH ROW
WHEN NEW.group_type <> 'subscription' AND EXISTS (
  SELECT 1 FROM auth_source_default_subscriptions WHERE group_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'auth_source_subscription_group_required');
END;

CREATE TABLE auth_source_default_platform_quotas (
  source TEXT NOT NULL REFERENCES auth_source_defaults(source) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (
    platform IN ('anthropic', 'openai', 'gemini', 'antigravity', 'grok')
  ),
  daily_limit_micros INTEGER
    CHECK (daily_limit_micros IS NULL OR (daily_limit_micros >= 0 AND daily_limit_micros <= 9007199254740991)),
  weekly_limit_micros INTEGER
    CHECK (weekly_limit_micros IS NULL OR (weekly_limit_micros >= 0 AND weekly_limit_micros <= 9007199254740991)),
  monthly_limit_micros INTEGER
    CHECK (monthly_limit_micros IS NULL OR (monthly_limit_micros >= 0 AND monthly_limit_micros <= 9007199254740991)),
  PRIMARY KEY (source, platform)
) STRICT;

-- The snapshot makes grants auditable even after defaults change. attempt_nonce
-- marks the transaction that won the unique user/source/reason claim; every
-- entitlement mutation is conditioned on that nonce.
CREATE TABLE auth_source_entitlement_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (
    source IN ('email', 'linuxdo', 'oidc', 'wechat', 'dingtalk', 'github', 'google')
  ),
  reason TEXT NOT NULL CHECK (reason IN ('signup', 'first_bind')),
  attempt_nonce TEXT NOT NULL UNIQUE,
  balance_micros INTEGER NOT NULL
    CHECK (balance_micros >= 0 AND balance_micros <= 9007199254740991),
  concurrency INTEGER NOT NULL
    CHECK (concurrency > 0 AND concurrency <= 9007199254740991),
  subscriptions_json TEXT NOT NULL CHECK (json_valid(subscriptions_json)),
  platform_quotas_json TEXT NOT NULL CHECK (json_valid(platform_quotas_json)),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  UNIQUE (user_id, source, reason)
) STRICT;

CREATE INDEX idx_auth_source_entitlement_grants_user_created
  ON auth_source_entitlement_grants(user_id, created_at_ms DESC, id);
CREATE INDEX idx_auth_source_entitlement_grants_source_reason_created
  ON auth_source_entitlement_grants(source, reason, created_at_ms DESC, id);

-- D1 cannot atomically commit with UserStateDO. First-bind balance grants are
-- therefore recorded as a durable, replayable effect beside the immutable
-- ledger. The stable grant id is also the DO mutation id.
CREATE TABLE auth_source_entitlement_balance_effects (
  grant_id TEXT PRIMARY KEY REFERENCES auth_source_entitlement_grants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied')),
  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (attempts >= 0 AND attempts <= 9007199254740991),
  balance_after_micros INTEGER
    CHECK (balance_after_micros IS NULL OR (balance_after_micros >= 0 AND balance_after_micros <= 9007199254740991)),
  state_version INTEGER
    CHECK (state_version IS NULL OR (state_version >= 0 AND state_version <= 9007199254740991)),
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= 0 AND updated_at_ms <= 8640000000000000),
  applied_at_ms INTEGER
    CHECK (applied_at_ms IS NULL OR (applied_at_ms >= 0 AND applied_at_ms <= 8640000000000000)),
  CHECK (
    (status = 'pending' AND balance_after_micros IS NULL AND state_version IS NULL AND applied_at_ms IS NULL)
    OR
    (status = 'applied' AND balance_after_micros IS NOT NULL AND state_version IS NOT NULL AND applied_at_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_auth_source_entitlement_balance_effects_pending
  ON auth_source_entitlement_balance_effects(status, updated_at_ms, grant_id);

CREATE TRIGGER prevent_auth_source_entitlement_grant_update
BEFORE UPDATE ON auth_source_entitlement_grants
BEGIN
  SELECT RAISE(ABORT, 'auth_source_entitlement_grant_immutable');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (39, 'auth_source_entitlements', CAST(unixepoch('subsec') * 1000 AS INTEGER));
