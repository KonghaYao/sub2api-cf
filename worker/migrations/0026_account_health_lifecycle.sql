PRAGMA foreign_keys = ON;

-- Scheduling state lives beside the account so a Cron invocation can claim due
-- work with a versioned compare-and-swap. Existing accounts are immediately due
-- after deployment; disabled accounts remain inert until explicitly enabled.
ALTER TABLE accounts
  ADD COLUMN health_probe_generation INTEGER NOT NULL DEFAULT 0
    CHECK (health_probe_generation >= 0);
ALTER TABLE accounts
  ADD COLUMN consecutive_health_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_health_failures >= 0);
ALTER TABLE accounts
  ADD COLUMN next_health_probe_at_ms INTEGER NOT NULL DEFAULT 0
    CHECK (next_health_probe_at_ms >= 0);
ALTER TABLE accounts
  ADD COLUMN health_probe_lease_until_ms INTEGER
    CHECK (health_probe_lease_until_ms IS NULL OR health_probe_lease_until_ms >= 0);
ALTER TABLE accounts
  ADD COLUMN health_revision INTEGER NOT NULL DEFAULT 0
    CHECK (health_revision >= 0);

CREATE INDEX idx_accounts_health_probe_due
  ON accounts(enabled, next_health_probe_at_ms, health_probe_lease_until_ms, id);

-- Health changes alter routable Pool membership just like credential/config
-- changes. Including the column here also makes the existing manual probe path
-- revision-safe; one account UPDATE produces exactly one global revision bump.
DROP TRIGGER bump_gateway_revision_account_update;
CREATE TRIGGER bump_gateway_revision_account_update
AFTER UPDATE OF platform, credential_ref, enabled, max_concurrency, protocol,
  base_url, auth_scheme, provider_config_json, config_version, health_status ON accounts
BEGIN
  UPDATE gateway_config_revision
     SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms
   WHERE singleton = 1;
END;

-- This is both the Queue payload authority and the durable Pool-sync outbox.
-- Credentials are intentionally absent: consumers re-read encrypted secrets by
-- an exact config_version/credential_ref snapshot before every provider probe.
CREATE TABLE account_health_probes (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  config_version INTEGER NOT NULL CHECK (config_version > 0),
  credential_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'probing', 'probed', 'completed', 'stale', 'failed')),
  processing_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (processing_attempts BETWEEN 0 AND 5),
  dispatch_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (dispatch_attempts BETWEEN 0 AND 8),
  next_dispatch_at_ms INTEGER NOT NULL CHECK (next_dispatch_at_ms >= 0),
  run_token TEXT,
  run_lease_until_ms INTEGER
    CHECK (run_lease_until_ms IS NULL OR run_lease_until_ms >= 0),
  health_status TEXT CHECK (health_status IN ('healthy', 'unhealthy')),
  checked_at_ms INTEGER CHECK (checked_at_ms IS NULL OR checked_at_ms >= 0),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  health_error TEXT CHECK (health_error IS NULL OR length(health_error) <= 512),
  account_health_revision INTEGER
    CHECK (account_health_revision IS NULL OR account_health_revision > 0),
  pool_revision INTEGER CHECK (pool_revision IS NULL OR pool_revision > 0),
  last_internal_error TEXT
    CHECK (last_internal_error IS NULL OR length(last_internal_error) <= 256),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  UNIQUE(account_id, generation),
  CHECK (
    (status = 'probing' AND run_token IS NOT NULL AND run_lease_until_ms IS NOT NULL)
    OR (status <> 'probing' AND run_token IS NULL AND run_lease_until_ms IS NULL)
  ),
  CHECK (
    (status IN ('probed', 'completed') AND health_status IS NOT NULL
      AND checked_at_ms IS NOT NULL AND latency_ms IS NOT NULL
      AND account_health_revision IS NOT NULL AND pool_revision IS NOT NULL)
    OR (status NOT IN ('probed', 'completed'))
  )
) STRICT;

CREATE INDEX idx_account_health_probes_dispatch
  ON account_health_probes(status, next_dispatch_at_ms, dispatch_attempts, created_at_ms, id);
CREATE INDEX idx_account_health_probes_account
  ON account_health_probes(account_id, generation DESC);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (26, 'account_health_lifecycle', CAST(unixepoch('subsec') * 1000 AS INTEGER));
