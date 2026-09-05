PRAGMA foreign_keys = ON;

-- Rolling compatibility: old Workers omit this column and must continue to
-- execute each item inline until a new Worker explicitly selects provider jobs.
ALTER TABLE media_tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'inline_v1'
  CHECK (execution_mode IN ('inline_v1', 'provider_job_v1'));

-- Provider batch jobs outlive a Worker invocation. D1 owns the durable phase,
-- retry cursor, lease, and the two identities used to reconcile an ambiguous
-- submit without ever creating the same upstream job twice intentionally.
CREATE TABLE media_provider_jobs (
  task_id TEXT PRIMARY KEY REFERENCES media_tasks(id) ON DELETE CASCADE,
  provider_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  submission_key TEXT NOT NULL
    CHECK (length(submission_key) BETWEEN 8 AND 128),
  provider_job_id TEXT
    CHECK (provider_job_id IS NULL OR length(provider_job_id) BETWEEN 1 AND 512),
  phase TEXT NOT NULL DEFAULT 'input_pending' CHECK (phase IN (
    'input_pending', 'submit_pending', 'submit_unknown', 'poll_pending',
    'result_pending', 'materialize_pending', 'cancel_pending', 'attention',
    'cleanup_pending', 'done'
  )),
  provider_raw_state TEXT
    CHECK (provider_raw_state IS NULL OR length(provider_raw_state) BETWEEN 1 AND 256),
  next_action_at_ms INTEGER NOT NULL CHECK (next_action_at_ms >= 0),
  deadline_at_ms INTEGER NOT NULL CHECK (deadline_at_ms >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 2147483647),
  consecutive_errors INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_errors BETWEEN 0 AND 2147483647),
  poll_count INTEGER NOT NULL DEFAULT 0
    CHECK (poll_count BETWEEN 0 AND 2147483647),
  reservation_renewal_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (reservation_renewal_sequence BETWEEN 0 AND 2147483647),
  lease_token TEXT
    CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 16 AND 128),
  lease_expires_at_ms INTEGER
    CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
  result_manifest_object_key TEXT
    CHECK (
      result_manifest_object_key IS NULL
      OR length(result_manifest_object_key) BETWEEN 16 AND 512
    ),
  result_manifest_sha256 TEXT
    CHECK (result_manifest_sha256 IS NULL OR length(result_manifest_sha256) = 64),
  result_cursor_json TEXT CHECK (
    result_cursor_json IS NULL
    OR (
      length(result_cursor_json) BETWEEN 2 AND 65536
      AND CASE
        WHEN json_valid(result_cursor_json)
          THEN json_type(result_cursor_json) IN ('object', 'array')
        ELSE 0
      END
    )
  ),
  result_complete INTEGER NOT NULL DEFAULT 0
    CHECK (result_complete IN (0, 1)),
  cancel_requested_at_ms INTEGER
    CHECK (cancel_requested_at_ms IS NULL OR cancel_requested_at_ms >= 0),
  provider_terminal_at_ms INTEGER
    CHECK (provider_terminal_at_ms IS NULL OR provider_terminal_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  last_error_class TEXT
    CHECK (last_error_class IS NULL OR length(last_error_class) BETWEEN 1 AND 128),
  last_error_code TEXT
    CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128),
  UNIQUE (provider_account_id, submission_key),
  CHECK (deadline_at_ms >= created_at_ms),
  CHECK (
    (lease_token IS NULL AND lease_expires_at_ms IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
  ),
  CHECK (
    (result_manifest_object_key IS NULL AND result_manifest_sha256 IS NULL)
    OR (result_manifest_object_key IS NOT NULL AND result_manifest_sha256 IS NOT NULL)
  ),
  CHECK (
    result_complete = 0
    OR (
      result_manifest_object_key IS NOT NULL
      AND result_manifest_sha256 IS NOT NULL
    )
  )
) STRICT;

CREATE UNIQUE INDEX idx_media_provider_jobs_provider_identity
  ON media_provider_jobs(provider_account_id, provider_job_id)
  WHERE provider_job_id IS NOT NULL;

CREATE INDEX idx_media_provider_jobs_recovery
  ON media_provider_jobs(next_action_at_ms, phase, task_id)
  WHERE phase <> 'done';

CREATE INDEX idx_media_provider_jobs_lease
  ON media_provider_jobs(lease_expires_at_ms, phase, task_id)
  WHERE lease_token IS NOT NULL AND phase <> 'done';

-- Each provider result record is privately retained in R2 so result parsing is
-- restartable and a stable ordinal maps it back to exactly one client item.
ALTER TABLE media_task_items ADD COLUMN provider_record_object_key TEXT
  CHECK (
    provider_record_object_key IS NULL
    OR length(provider_record_object_key) BETWEEN 16 AND 512
  );
ALTER TABLE media_task_items ADD COLUMN provider_record_sha256 TEXT
  CHECK (provider_record_sha256 IS NULL OR length(provider_record_sha256) = 64);
ALTER TABLE media_task_items ADD COLUMN provider_record_ordinal INTEGER
  CHECK (
    provider_record_ordinal IS NULL
    OR provider_record_ordinal BETWEEN 0 AND 199
  );

CREATE UNIQUE INDEX idx_media_task_items_provider_record
  ON media_task_items(task_id, provider_record_ordinal)
  WHERE provider_record_ordinal IS NOT NULL;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (49, 'media_provider_jobs', CAST(unixepoch('subsec') * 1000 AS INTEGER));
