PRAGMA foreign_keys = ON;

ALTER TABLE "groups"
  ADD COLUMN control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0);
ALTER TABLE "groups" ADD COLUMN description TEXT;
ALTER TABLE "groups"
  ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0);
ALTER TABLE "groups"
  ADD COLUMN rate_multiplier_ppm INTEGER NOT NULL DEFAULT 1000000
    CHECK (rate_multiplier_ppm >= 0);
ALTER TABLE "groups"
  ADD COLUMN catalog_mode TEXT NOT NULL DEFAULT 'all_routable'
    CHECK (catalog_mode IN ('all_routable', 'allowlist'));
ALTER TABLE models
  ADD COLUMN control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0);
ALTER TABLE accounts
  ADD COLUMN control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0);
ALTER TABLE group_models
  ADD COLUMN control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0);
ALTER TABLE group_models
  ADD COLUMN catalog_visible INTEGER NOT NULL DEFAULT 1 CHECK (catalog_visible IN (0, 1));
ALTER TABLE account_groups
  ADD COLUMN control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0);
ALTER TABLE account_models
  ADD COLUMN control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0);

ALTER TABLE accounts
  ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown', 'healthy', 'unhealthy'));
ALTER TABLE accounts
  ADD COLUMN last_checked_at_ms INTEGER
    CHECK (last_checked_at_ms IS NULL OR last_checked_at_ms >= 0);
ALTER TABLE accounts
  ADD COLUMN last_latency_ms INTEGER
    CHECK (last_latency_ms IS NULL OR last_latency_ms >= 0);
ALTER TABLE accounts ADD COLUMN last_health_error TEXT;

CREATE TABLE gateway_config_revision (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;

INSERT INTO gateway_config_revision (singleton, revision, updated_at_ms)
VALUES (1, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER));

CREATE TABLE migration_0007_preflight (
  ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

INSERT INTO migration_0007_preflight (ok)
SELECT 0
WHERE EXISTS (SELECT 1 FROM account_groups WHERE priority < 0)
   OR EXISTS (
     SELECT 1 FROM group_models gm
     JOIN "groups" g ON g.id = gm.group_id
     JOIN models m ON m.id = gm.model_id
     WHERE g.platform <> m.platform
        OR gm.default_max_output_tokens > gm.max_output_tokens
   )
   OR EXISTS (
     SELECT 1 FROM account_groups ag
     JOIN accounts a ON a.id = ag.account_id
     JOIN "groups" g ON g.id = ag.group_id
     WHERE a.platform <> g.platform
   )
   OR EXISTS (
     SELECT 1 FROM account_models am
     JOIN accounts a ON a.id = am.account_id
     JOIN models m ON m.id = am.model_id
     WHERE a.platform <> m.platform
   )
   OR EXISTS (
     SELECT 1 FROM model_prices
     WHERE (active = 1 AND retired_at_ms IS NOT NULL)
        OR (active = 0 AND retired_at_ms IS NULL)
   );

DROP TABLE migration_0007_preflight;

CREATE TRIGGER validate_group_model_insert
BEFORE INSERT ON group_models
FOR EACH ROW
WHEN (SELECT platform FROM "groups" WHERE id = NEW.group_id)
   <> (SELECT platform FROM models WHERE id = NEW.model_id)
  OR NEW.default_max_output_tokens > NEW.max_output_tokens
BEGIN
  SELECT RAISE(ABORT, 'invalid_group_model');
END;

CREATE TRIGGER validate_group_model_update
BEFORE UPDATE ON group_models
FOR EACH ROW
WHEN (SELECT platform FROM "groups" WHERE id = NEW.group_id)
   <> (SELECT platform FROM models WHERE id = NEW.model_id)
  OR NEW.default_max_output_tokens > NEW.max_output_tokens
BEGIN
  SELECT RAISE(ABORT, 'invalid_group_model');
END;

CREATE TRIGGER validate_account_group_insert
BEFORE INSERT ON account_groups
FOR EACH ROW
WHEN NEW.priority < 0
  OR (SELECT platform FROM accounts WHERE id = NEW.account_id)
   <> (SELECT platform FROM "groups" WHERE id = NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_group');
END;

CREATE TRIGGER validate_account_group_update
BEFORE UPDATE ON account_groups
FOR EACH ROW
WHEN NEW.priority < 0
  OR (SELECT platform FROM accounts WHERE id = NEW.account_id)
   <> (SELECT platform FROM "groups" WHERE id = NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_group');
END;

CREATE TRIGGER validate_account_model_insert
BEFORE INSERT ON account_models
FOR EACH ROW
WHEN (SELECT platform FROM accounts WHERE id = NEW.account_id)
   <> (SELECT platform FROM models WHERE id = NEW.model_id)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_model');
END;

CREATE TRIGGER validate_account_model_update
BEFORE UPDATE ON account_models
FOR EACH ROW
WHEN (SELECT platform FROM accounts WHERE id = NEW.account_id)
   <> (SELECT platform FROM models WHERE id = NEW.model_id)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_model');
END;

CREATE TRIGGER validate_group_platform_update
BEFORE UPDATE OF platform ON "groups"
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM group_models gm JOIN models m ON m.id = gm.model_id
  WHERE gm.group_id = NEW.id AND m.platform <> NEW.platform
) OR EXISTS (
  SELECT 1 FROM account_groups ag JOIN accounts a ON a.id = ag.account_id
  WHERE ag.group_id = NEW.id AND a.platform <> NEW.platform
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_group_platform');
END;

CREATE TRIGGER validate_model_platform_update
BEFORE UPDATE OF platform ON models
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM group_models gm JOIN "groups" g ON g.id = gm.group_id
  WHERE gm.model_id = NEW.id AND g.platform <> NEW.platform
) OR EXISTS (
  SELECT 1 FROM account_models am JOIN accounts a ON a.id = am.account_id
  WHERE am.model_id = NEW.id AND a.platform <> NEW.platform
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_model_platform');
END;

CREATE TRIGGER validate_account_platform_update
BEFORE UPDATE OF platform ON accounts
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM account_groups ag JOIN "groups" g ON g.id = ag.group_id
  WHERE ag.account_id = NEW.id AND g.platform <> NEW.platform
) OR EXISTS (
  SELECT 1 FROM account_models am JOIN models m ON m.id = am.model_id
  WHERE am.account_id = NEW.id AND m.platform <> NEW.platform
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_platform');
END;

CREATE TRIGGER validate_model_price_insert
BEFORE INSERT ON model_prices
FOR EACH ROW
WHEN (NEW.active = 1 AND NEW.retired_at_ms IS NOT NULL)
  OR (NEW.active = 0 AND NEW.retired_at_ms IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid_model_price_lifecycle');
END;

CREATE TRIGGER validate_model_price_update
BEFORE UPDATE OF active, retired_at_ms ON model_prices
FOR EACH ROW
WHEN (NEW.active = 1 AND NEW.retired_at_ms IS NOT NULL)
  OR (NEW.active = 0 AND NEW.retired_at_ms IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid_model_price_lifecycle');
END;

CREATE TRIGGER prevent_model_price_rewrite
BEFORE UPDATE OF group_id, model_id, version,
  input_micros_per_million, output_micros_per_million,
  cache_read_micros_per_million, per_request_micros,
  minimum_reservation_micros, effective_at_ms, created_at_ms
ON model_prices
BEGIN
  SELECT RAISE(ABORT, 'immutable_model_price');
END;

CREATE TRIGGER prevent_model_price_delete
BEFORE DELETE ON model_prices
BEGIN
  SELECT RAISE(ABORT, 'immutable_model_price');
END;

CREATE TRIGGER bump_gateway_revision_group_insert AFTER INSERT ON "groups"
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_group_update AFTER UPDATE OF platform, enabled, rate_multiplier_ppm, catalog_mode ON "groups"
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_group_delete AFTER DELETE ON "groups"
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_model_insert AFTER INSERT ON models
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_model_update AFTER UPDATE OF platform, public_name, upstream_name, endpoint, enabled ON models
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_model_delete AFTER DELETE ON models
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_group_model_insert AFTER INSERT ON group_models
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_group_model_update AFTER UPDATE OF group_id, model_id, upstream_name_override, enabled, catalog_visible, sort_order, max_output_tokens, default_max_output_tokens ON group_models
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_group_model_delete AFTER DELETE ON group_models
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_price_insert AFTER INSERT ON model_prices
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.created_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_price_retire AFTER UPDATE OF active, retired_at_ms ON model_prices
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.retired_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_account_insert AFTER INSERT ON accounts
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_account_update AFTER UPDATE OF platform, credential_ref, enabled, max_concurrency, protocol, base_url, auth_scheme, config_version ON accounts
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_account_delete AFTER DELETE ON accounts
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_account_group_insert AFTER INSERT ON account_groups
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_account_group_update AFTER UPDATE OF account_id, group_id, priority, weight ON account_groups
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_account_group_delete AFTER DELETE ON account_groups
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_account_model_insert AFTER INSERT ON account_models
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_account_model_update AFTER UPDATE OF account_id, model_id, chat_completions, responses ON account_models
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms WHERE singleton = 1; END;
CREATE TRIGGER bump_gateway_revision_account_model_delete AFTER DELETE ON account_models
BEGIN UPDATE gateway_config_revision SET revision = revision + 1, updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE singleton = 1; END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (7, 'routing_control', CAST(unixepoch('subsec') * 1000 AS INTEGER));
