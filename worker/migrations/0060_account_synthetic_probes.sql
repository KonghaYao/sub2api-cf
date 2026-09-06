PRAGMA foreign_keys = ON;

-- One recurring monitor per exact routing capability. The composite foreign key
-- prevents a monitor from outliving its account/model relationship.
CREATE TABLE account_synthetic_probe_monitors (
  account_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  capability TEXT NOT NULL
    CHECK (capability IN ('chat_completions', 'responses', 'embeddings')),
  generation INTEGER NOT NULL DEFAULT 0
    CHECK (generation BETWEEN 0 AND 9007199254740991),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures BETWEEN 0 AND 9007199254740991),
  alert_state TEXT NOT NULL DEFAULT 'resolved'
    CHECK (alert_state IN ('resolved', 'firing')),
  next_probe_at_ms INTEGER NOT NULL
    CHECK (next_probe_at_ms BETWEEN 0 AND 9007199254740991),
  lease_until_ms INTEGER
    CHECK (lease_until_ms IS NULL OR lease_until_ms BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (account_id, model_id, capability),
  FOREIGN KEY (account_id, model_id)
    REFERENCES account_models(account_id, model_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_account_synthetic_monitors_due
  ON account_synthetic_probe_monitors(enabled, next_probe_at_ms, account_id, model_id, capability);

CREATE TRIGGER validate_account_synthetic_monitor_insert
BEFORE INSERT ON account_synthetic_probe_monitors
WHEN NOT EXISTS (
  SELECT 1
    FROM account_models relation
    JOIN accounts account ON account.id = relation.account_id
    JOIN models model ON model.id = relation.model_id
   WHERE relation.account_id = NEW.account_id AND relation.model_id = NEW.model_id
     AND account.enabled = 1 AND model.enabled = 1 AND model.platform = account.platform
     AND CASE NEW.capability
       WHEN 'chat_completions' THEN relation.chat_completions
       WHEN 'responses' THEN relation.responses
       WHEN 'embeddings' THEN relation.embeddings END = 1
)
BEGIN
  SELECT RAISE(ABORT, 'account_synthetic_probe_relation_invalid');
END;

CREATE TRIGGER validate_account_synthetic_monitor_requeue
BEFORE UPDATE OF generation, enabled ON account_synthetic_probe_monitors
WHEN NOT EXISTS (
  SELECT 1
    FROM account_models relation
    JOIN accounts account ON account.id = relation.account_id
    JOIN models model ON model.id = relation.model_id
   WHERE relation.account_id = NEW.account_id AND relation.model_id = NEW.model_id
     AND account.enabled = 1 AND model.enabled = 1 AND model.platform = account.platform
     AND CASE NEW.capability
       WHEN 'chat_completions' THEN relation.chat_completions
       WHEN 'responses' THEN relation.responses
       WHEN 'embeddings' THEN relation.embeddings END = 1
)
BEGIN
  SELECT RAISE(ABORT, 'account_synthetic_probe_relation_invalid');
END;

-- Durable outbox. Messages contain only this canonical identity; all provider
-- configuration and encrypted credentials are reloaded and snapshot-checked.
CREATE TABLE account_synthetic_probe_jobs (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 512),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 128),
  capability TEXT NOT NULL
    CHECK (capability IN ('chat_completions', 'responses', 'embeddings')),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  account_config_version INTEGER NOT NULL
    CHECK (account_config_version BETWEEN 1 AND 9007199254740991),
  account_control_version INTEGER NOT NULL
    CHECK (account_control_version BETWEEN 0 AND 9007199254740991),
  credential_ref TEXT NOT NULL CHECK (length(credential_ref) BETWEEN 1 AND 128),
  account_model_control_version INTEGER NOT NULL
    CHECK (account_model_control_version BETWEEN 0 AND 9007199254740991),
  model_updated_at_ms INTEGER NOT NULL
    CHECK (model_updated_at_ms BETWEEN 0 AND 9007199254740991),
  upstream_model TEXT NOT NULL CHECK (length(upstream_model) BETWEEN 1 AND 512),
  requested_by_user_id TEXT NOT NULL CHECK (length(requested_by_user_id) BETWEEN 1 AND 128),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'probing', 'completed', 'stale', 'failed')),
  dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempts BETWEEN 0 AND 8),
  processing_attempts INTEGER NOT NULL DEFAULT 0 CHECK (processing_attempts BETWEEN 0 AND 5),
  next_dispatch_at_ms INTEGER NOT NULL
    CHECK (next_dispatch_at_ms BETWEEN 0 AND 9007199254740991),
  run_token TEXT,
  run_lease_until_ms INTEGER
    CHECK (run_lease_until_ms IS NULL OR run_lease_until_ms BETWEEN 0 AND 9007199254740991),
  last_internal_error TEXT CHECK (last_internal_error IS NULL OR length(last_internal_error) <= 128),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (account_id, model_id, capability, generation)
) STRICT;

CREATE INDEX idx_account_synthetic_jobs_dispatch
  ON account_synthetic_probe_jobs(status, next_dispatch_at_ms, created_at_ms, id);

CREATE TABLE account_synthetic_probe_history (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 512),
  job_id TEXT NOT NULL UNIQUE CHECK (length(job_id) BETWEEN 1 AND 512),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 128),
  capability TEXT NOT NULL
    CHECK (capability IN ('chat_completions', 'responses', 'embeddings')),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN (
    'provider_configuration_unavailable', 'upstream_timeout',
    'upstream_transport_failed', 'upstream_http_error', 'upstream_invalid_response'
  )),
  upstream_status INTEGER CHECK (upstream_status IS NULL OR upstream_status BETWEEN 100 AND 599),
  latency_ms INTEGER NOT NULL CHECK (latency_ms BETWEEN 0 AND 9007199254740991),
  alert_transition TEXT CHECK (alert_transition IS NULL OR alert_transition IN ('firing', 'resolved')),
  checked_at_ms INTEGER NOT NULL
    CHECK (checked_at_ms BETWEEN 0 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE INDEX idx_account_synthetic_history_page
  ON account_synthetic_probe_history(checked_at_ms DESC, id DESC);
CREATE INDEX idx_account_synthetic_history_account_page
  ON account_synthetic_probe_history(account_id, checked_at_ms DESC, id DESC);

CREATE TRIGGER prevent_account_synthetic_history_update
BEFORE UPDATE ON account_synthetic_probe_history BEGIN
  SELECT RAISE(ABORT, 'account_synthetic_probe_history_immutable');
END;
CREATE TRIGGER prevent_account_synthetic_history_delete
BEFORE DELETE ON account_synthetic_probe_history BEGIN
  SELECT RAISE(ABORT, 'account_synthetic_probe_history_immutable');
END;

CREATE TABLE account_synthetic_alert_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 512),
  job_id TEXT NOT NULL UNIQUE CHECK (length(job_id) BETWEEN 1 AND 512),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 128),
  capability TEXT NOT NULL
    CHECK (capability IN ('chat_completions', 'responses', 'embeddings')),
  status TEXT NOT NULL CHECK (status IN ('firing', 'resolved')),
  consecutive_failures INTEGER NOT NULL
    CHECK (consecutive_failures BETWEEN 0 AND 9007199254740991),
  email_delivery_state TEXT NOT NULL DEFAULT 'unavailable'
    CHECK (email_delivery_state IN ('unavailable', 'sent', 'failed')),
  occurred_at_ms INTEGER NOT NULL
    CHECK (occurred_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE INDEX idx_account_synthetic_alert_page
  ON account_synthetic_alert_events(occurred_at_ms DESC, id DESC);

CREATE TRIGGER prevent_account_synthetic_alert_delete
BEFORE DELETE ON account_synthetic_alert_events BEGIN
  SELECT RAISE(ABORT, 'account_synthetic_alert_event_immutable');
END;

CREATE TABLE admin_account_synthetic_probe_audit_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 512),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_session_id TEXT NOT NULL CHECK (length(actor_session_id) BETWEEN 1 AND 512),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 128),
  capability TEXT NOT NULL
    CHECK (capability IN ('chat_completions', 'responses', 'embeddings')),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  job_id TEXT NOT NULL UNIQUE CHECK (length(job_id) BETWEEN 1 AND 512),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  occurred_at_ms INTEGER NOT NULL
    CHECK (occurred_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE INDEX idx_admin_account_synthetic_audit_time
  ON admin_account_synthetic_probe_audit_events(occurred_at_ms DESC, id DESC);

CREATE TRIGGER prevent_admin_account_synthetic_audit_update
BEFORE UPDATE ON admin_account_synthetic_probe_audit_events BEGIN
  SELECT RAISE(ABORT, 'admin_account_synthetic_probe_audit_immutable');
END;
CREATE TRIGGER prevent_admin_account_synthetic_audit_delete
BEFORE DELETE ON admin_account_synthetic_probe_audit_events BEGIN
  SELECT RAISE(ABORT, 'admin_account_synthetic_probe_audit_immutable');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (60, 'account_synthetic_probes', CAST(unixepoch('subsec') * 1000 AS INTEGER));
