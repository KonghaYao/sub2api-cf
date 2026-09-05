PRAGMA foreign_keys = ON;

-- Searchable request/error metadata stays in D1. Potentially large, redacted
-- diagnostic payloads live only in R2 and are referenced by an opaque key.
CREATE TABLE request_observations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 32 AND 64),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  client_request_id TEXT CHECK (client_request_id IS NULL OR length(client_request_id) <= 128),
  bucket_day INTEGER NOT NULL CHECK (bucket_day BETWEEN 19700101 AND 99991231),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms BETWEEN 0 AND 8640000000000000),
  completed_at_ms INTEGER CHECK (
    completed_at_ms IS NULL OR completed_at_ms BETWEEN occurred_at_ms AND 8640000000000000
  ),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('started', 'completed', 'failed', 'cancelled')),
  user_id TEXT,
  api_key_id TEXT,
  account_id TEXT,
  group_id TEXT,
  method TEXT NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD')),
  request_path TEXT NOT NULL CHECK (length(request_path) BETWEEN 1 AND 512),
  inbound_endpoint TEXT NOT NULL DEFAULT '' CHECK (length(inbound_endpoint) <= 128),
  platform TEXT NOT NULL DEFAULT '' CHECK (length(platform) <= 64),
  requested_model TEXT NOT NULL DEFAULT '' CHECK (length(requested_model) <= 200),
  upstream_model TEXT NOT NULL DEFAULT '' CHECK (length(upstream_model) <= 200),
  request_type INTEGER CHECK (request_type IS NULL OR request_type BETWEEN 0 AND 32767),
  stream INTEGER NOT NULL DEFAULT 0 CHECK (stream IN (0, 1)),
  status_code INTEGER CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'failed', 'cancelled')),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens BETWEEN 0 AND 9007199254740991),
  amount_micros INTEGER NOT NULL DEFAULT 0 CHECK (amount_micros BETWEEN 0 AND 9007199254740991),
  error_phase TEXT NOT NULL DEFAULT '' CHECK (length(error_phase) <= 32),
  error_type TEXT NOT NULL DEFAULT '' CHECK (length(error_type) <= 100),
  error_owner TEXT NOT NULL DEFAULT '' CHECK (length(error_owner) <= 32),
  error_source TEXT NOT NULL DEFAULT '' CHECK (length(error_source) <= 32),
  severity TEXT NOT NULL DEFAULT '' CHECK (length(severity) <= 24),
  error_message TEXT NOT NULL DEFAULT '' CHECK (length(error_message) <= 1000),
  upstream_status_code INTEGER CHECK (
    upstream_status_code IS NULL OR upstream_status_code BETWEEN 100 AND 599
  ),
  is_business_limited INTEGER NOT NULL DEFAULT 0 CHECK (is_business_limited IN (0, 1)),
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  resolved_at_ms INTEGER CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= occurred_at_ms),
  resolved_by_user_id TEXT,
  payload_state TEXT NOT NULL DEFAULT 'none'
    CHECK (payload_state IN ('none', 'pending', 'stored', 'retry', 'deleted')),
  payload_object_key TEXT UNIQUE CHECK (
    payload_object_key IS NULL OR length(payload_object_key) BETWEEN 32 AND 512
  ),
  payload_sha256 TEXT CHECK (payload_sha256 IS NULL OR length(payload_sha256) = 64),
  payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK (payload_bytes BETWEEN 0 AND 98304),
  payload_content_type TEXT CHECK (
    payload_content_type IS NULL OR payload_content_type = 'application/json'
  ),
  payload_attempts INTEGER NOT NULL DEFAULT 0 CHECK (payload_attempts BETWEEN 0 AND 20),
  payload_retry_after_ms INTEGER CHECK (payload_retry_after_ms IS NULL OR payload_retry_after_ms >= 0),
  payload_lease_id TEXT,
  payload_lease_expires_at_ms INTEGER CHECK (
    payload_lease_expires_at_ms IS NULL OR payload_lease_expires_at_ms >= 0
  ),
  payload_last_error TEXT CHECK (payload_last_error IS NULL OR length(payload_last_error) <= 500),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN occurred_at_ms AND 8640000000000000),
  CHECK (
    (lifecycle = 'started' AND completed_at_ms IS NULL AND status_code IS NULL AND outcome IS NULL)
    OR
    (lifecycle <> 'started' AND completed_at_ms IS NOT NULL AND status_code IS NOT NULL AND outcome IS NOT NULL)
  ),
  CHECK (
    (payload_state = 'none' AND payload_object_key IS NULL AND payload_sha256 IS NULL
      AND payload_content_type IS NULL AND payload_bytes = 0)
    OR
    (payload_state <> 'none' AND payload_object_key IS NOT NULL AND payload_sha256 IS NOT NULL
      AND payload_content_type = 'application/json' AND payload_bytes > 0)
  ),
  CHECK (
    (payload_lease_id IS NULL AND payload_lease_expires_at_ms IS NULL)
    OR (payload_lease_id IS NOT NULL AND payload_lease_expires_at_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_request_observations_owner_seek
  ON request_observations(user_id, occurred_at_ms DESC, id DESC);
CREATE INDEX idx_request_observations_admin_seek
  ON request_observations(occurred_at_ms DESC, id DESC);
CREATE INDEX idx_request_observations_error_seek
  ON request_observations(lifecycle, occurred_at_ms DESC, id DESC)
  WHERE lifecycle = 'failed';
CREATE INDEX idx_request_observations_platform_seek
  ON request_observations(platform, occurred_at_ms DESC, id DESC);
CREATE INDEX idx_request_observations_model_seek
  ON request_observations(requested_model, occurred_at_ms DESC, id DESC);
CREATE INDEX idx_request_observations_status_seek
  ON request_observations(status_code, occurred_at_ms DESC, id DESC);
CREATE INDEX idx_request_observations_api_key_seek
  ON request_observations(api_key_id, occurred_at_ms DESC, id DESC);
CREATE INDEX idx_request_observations_account_seek
  ON request_observations(account_id, occurred_at_ms DESC, id DESC);
CREATE INDEX idx_request_observations_group_seek
  ON request_observations(group_id, occurred_at_ms DESC, id DESC);
CREATE INDEX idx_request_observations_request_correlation
  ON request_observations(request_id, occurred_at_ms DESC, id DESC);
CREATE INDEX idx_request_observations_client_request_correlation
  ON request_observations(client_request_id, occurred_at_ms DESC, id DESC)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX idx_request_observations_payload_retry
  ON request_observations(payload_state, payload_retry_after_ms, occurred_at_ms, id)
  WHERE payload_state = 'retry';
CREATE INDEX idx_request_observations_retention
  ON request_observations(occurred_at_ms, id);

-- A hard per-day cap makes accidental retention misconfiguration bounded.
CREATE TABLE request_observation_buckets (
  bucket_day INTEGER PRIMARY KEY CHECK (bucket_day BETWEEN 19700101 AND 99991231),
  row_count INTEGER NOT NULL CHECK (row_count BETWEEN 0 AND 100000),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 8640000000000000)
) STRICT;

CREATE TRIGGER limit_request_observation_bucket
BEFORE INSERT ON request_observations
WHEN COALESCE((SELECT row_count FROM request_observation_buckets WHERE bucket_day = NEW.bucket_day), 0) >= 100000
BEGIN
  SELECT RAISE(ABORT, 'request_observation_bucket_limit');
END;

CREATE TRIGGER count_request_observation_bucket
AFTER INSERT ON request_observations
BEGIN
  INSERT INTO request_observation_buckets(bucket_day, row_count, updated_at_ms)
  VALUES (NEW.bucket_day, 1, NEW.occurred_at_ms)
  ON CONFLICT(bucket_day) DO UPDATE SET
    row_count = row_count + 1,
    updated_at_ms = MAX(updated_at_ms, NEW.occurred_at_ms);
END;

CREATE TRIGGER uncount_request_observation_bucket
AFTER DELETE ON request_observations
BEGIN
  UPDATE request_observation_buckets
     SET row_count = row_count - 1, updated_at_ms = MAX(updated_at_ms, CAST(unixepoch('subsec') * 1000 AS INTEGER))
   WHERE bucket_day = OLD.bucket_day;
  DELETE FROM request_observation_buckets WHERE bucket_day = OLD.bucket_day AND row_count = 0;
END;

CREATE TABLE request_observation_resolution_audit (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  resolved INTEGER NOT NULL CHECK (resolved IN (0, 1)),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms BETWEEN 0 AND 8640000000000000)
) STRICT;

CREATE INDEX idx_request_observation_resolution_audit
  ON request_observation_resolution_audit(observation_id, occurred_at_ms DESC, id DESC);

CREATE TRIGGER prevent_request_observation_resolution_audit_update
BEFORE UPDATE ON request_observation_resolution_audit
BEGIN
  SELECT RAISE(ABORT, 'request_observation_resolution_audit_immutable');
END;

CREATE TRIGGER prevent_request_observation_resolution_audit_delete
BEFORE DELETE ON request_observation_resolution_audit
BEGIN
  SELECT RAISE(ABORT, 'request_observation_resolution_audit_immutable');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (40, 'request_observability', CAST(unixepoch('subsec') * 1000 AS INTEGER));
