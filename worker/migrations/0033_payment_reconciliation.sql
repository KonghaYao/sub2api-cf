PRAGMA foreign_keys = ON;

-- Receipts keep only generation metadata in D1. The immutable document lives
-- in private R2 and all monetary facts continue to come from payment_orders.
CREATE TABLE payment_receipts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 128),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  order_id TEXT NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
  order_version INTEGER NOT NULL
    CHECK (order_version >= 0 AND order_version <= 9007199254740991),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'available', 'failed')),
  content_type TEXT CHECK (
    content_type IS NULL OR content_type IN ('application/json', 'text/html; charset=utf-8')
  ),
  content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
  content_length INTEGER CHECK (
    content_length IS NULL
    OR (content_length >= 0 AND content_length <= 1048576)
  ),
  r2_key TEXT CHECK (r2_key IS NULL OR length(r2_key) BETWEEN 1 AND 512),
  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (attempts >= 0 AND attempts <= 1000),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 100
  ),
  created_at_ms INTEGER NOT NULL
    CHECK (created_at_ms >= 0 AND created_at_ms <= 8640000000000000),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= created_at_ms AND updated_at_ms <= 8640000000000000),
  available_at_ms INTEGER CHECK (
    available_at_ms IS NULL
    OR (available_at_ms >= created_at_ms AND available_at_ms <= 8640000000000000)
  ),
  UNIQUE(order_id, order_version),
  CHECK (
    (status = 'available'
      AND content_type IS NOT NULL
      AND content_sha256 IS NOT NULL
      AND content_length IS NOT NULL
      AND r2_key IS NOT NULL
      AND available_at_ms IS NOT NULL
      AND last_error_code IS NULL)
    OR
    (status <> 'available'
      AND content_sha256 IS NULL
      AND content_length IS NULL
      AND r2_key IS NULL
      AND available_at_ms IS NULL)
  )
) STRICT;

CREATE INDEX idx_payment_receipts_order
  ON payment_receipts(order_id, order_version DESC, id);

CREATE TRIGGER prevent_payment_receipt_identity_update
BEFORE UPDATE OF id, order_id, order_version, created_at_ms ON payment_receipts
FOR EACH ROW
WHEN OLD.id IS NOT NEW.id
  OR OLD.order_id IS NOT NEW.order_id
  OR OLD.order_version IS NOT NEW.order_version
  OR OLD.created_at_ms IS NOT NEW.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'payment_receipt_identity_immutable');
END;

CREATE TRIGGER prevent_available_payment_receipt_update
BEFORE UPDATE ON payment_receipts
FOR EACH ROW
WHEN OLD.status = 'available'
BEGIN
  SELECT RAISE(ABORT, 'payment_receipt_available_immutable');
END;

CREATE TABLE payment_reconciliation_issues (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 128),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  fingerprint TEXT NOT NULL UNIQUE CHECK (length(fingerprint) = 64),
  issue_type TEXT NOT NULL CHECK (
    issue_type IN (
      'late_paid_refund_required',
      'webhook_pending', 'webhook_failed',
      'fulfillment_pending', 'fulfillment_failed',
      'refund_pending', 'refund_failed',
      'provider_amount_mismatch', 'provider_status_mismatch'
    )
  ),
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'error', 'critical')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved')),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('order', 'webhook', 'fulfillment', 'refund')),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 255),
  order_id TEXT REFERENCES payment_orders(id) ON DELETE RESTRICT,
  provider_instance_id TEXT
    REFERENCES payment_provider_instances(id) ON DELETE RESTRICT,
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  evidence_r2_key TEXT CHECK (
    evidence_r2_key IS NULL OR length(evidence_r2_key) BETWEEN 1 AND 512
  ),
  evidence_sha256 TEXT CHECK (
    evidence_sha256 IS NULL OR length(evidence_sha256) = 64
  ),
  evidence_content_length INTEGER CHECK (
    evidence_content_length IS NULL
    OR (evidence_content_length >= 0 AND evidence_content_length <= 1048576)
  ),
  version INTEGER NOT NULL DEFAULT 0
    CHECK (version >= 0 AND version <= 9007199254740991),
  acknowledged_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  acknowledged_at_ms INTEGER CHECK (
    acknowledged_at_ms IS NULL
    OR (acknowledged_at_ms >= 0 AND acknowledged_at_ms <= 8640000000000000)
  ),
  resolution_code TEXT CHECK (
    resolution_code IS NULL OR length(resolution_code) BETWEEN 1 AND 100
  ),
  resolution_note TEXT CHECK (
    resolution_note IS NULL OR length(resolution_note) BETWEEN 1 AND 2000
  ),
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  resolved_at_ms INTEGER CHECK (
    resolved_at_ms IS NULL
    OR (resolved_at_ms >= 0 AND resolved_at_ms <= 8640000000000000)
  ),
  first_observed_at_ms INTEGER NOT NULL
    CHECK (first_observed_at_ms >= 0 AND first_observed_at_ms <= 8640000000000000),
  last_seen_at_ms INTEGER NOT NULL
    CHECK (
      last_seen_at_ms >= first_observed_at_ms
      AND last_seen_at_ms <= 8640000000000000
    ),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= first_observed_at_ms AND updated_at_ms <= 8640000000000000),
  CHECK (
    (evidence_r2_key IS NULL AND evidence_sha256 IS NULL AND evidence_content_length IS NULL)
    OR
    (evidence_r2_key IS NOT NULL AND evidence_sha256 IS NOT NULL
      AND evidence_content_length IS NOT NULL)
  ),
  CHECK (
    status <> 'acknowledged'
    OR (acknowledged_by_user_id IS NOT NULL AND acknowledged_at_ms IS NOT NULL)
  ),
  CHECK (
    status <> 'resolved'
    OR (resolution_code IS NOT NULL AND resolution_note IS NOT NULL
      AND resolved_by_user_id IS NOT NULL AND resolved_at_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_payment_reconciliation_issues_filter
  ON payment_reconciliation_issues(status, issue_type, severity, last_seen_at_ms DESC, id DESC);
CREATE INDEX idx_payment_reconciliation_issues_order
  ON payment_reconciliation_issues(order_id, last_seen_at_ms DESC, id DESC)
  WHERE order_id IS NOT NULL;
CREATE INDEX idx_payment_reconciliation_issues_source
  ON payment_reconciliation_issues(source_kind, source_id, issue_type);

CREATE TRIGGER prevent_payment_reconciliation_issue_identity_update
BEFORE UPDATE OF
  id, fingerprint, issue_type, source_kind, source_id, order_id,
  provider_instance_id, first_observed_at_ms
ON payment_reconciliation_issues
FOR EACH ROW
WHEN OLD.id IS NOT NEW.id
  OR OLD.fingerprint IS NOT NEW.fingerprint
  OR OLD.issue_type IS NOT NEW.issue_type
  OR OLD.source_kind IS NOT NEW.source_kind
  OR OLD.source_id IS NOT NEW.source_id
  OR OLD.order_id IS NOT NEW.order_id
  OR OLD.provider_instance_id IS NOT NEW.provider_instance_id
  OR OLD.first_observed_at_ms IS NOT NEW.first_observed_at_ms
BEGIN
  SELECT RAISE(ABORT, 'payment_reconciliation_issue_identity_immutable');
END;

CREATE TABLE payment_reconciliation_actions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 128),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  issue_id TEXT NOT NULL
    REFERENCES payment_reconciliation_issues(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_session_id TEXT NOT NULL CHECK (length(actor_session_id) BETWEEN 1 AND 255),
  action TEXT NOT NULL CHECK (action IN ('acknowledge', 'resolve', 'reopen')),
  expected_version INTEGER NOT NULL
    CHECK (expected_version >= 0 AND expected_version <= 9007199254740991),
  result_version INTEGER NOT NULL
    CHECK (result_version = expected_version + 1),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  occurred_at_ms INTEGER NOT NULL
    CHECK (occurred_at_ms >= 0 AND occurred_at_ms <= 8640000000000000),
  UNIQUE(issue_id, idempotency_key_hash)
) STRICT;

CREATE INDEX idx_payment_reconciliation_actions_issue
  ON payment_reconciliation_actions(issue_id, occurred_at_ms DESC, id DESC);

CREATE TRIGGER prevent_payment_reconciliation_action_update
BEFORE UPDATE ON payment_reconciliation_actions
BEGIN
  SELECT RAISE(ABORT, 'payment_reconciliation_action_immutable');
END;
CREATE TRIGGER prevent_payment_reconciliation_action_delete
BEFORE DELETE ON payment_reconciliation_actions
BEGIN
  SELECT RAISE(ABORT, 'payment_reconciliation_action_immutable');
END;

CREATE TABLE payment_reconciliation_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 128),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  issue_id TEXT NOT NULL
    REFERENCES payment_reconciliation_issues(id) ON DELETE RESTRICT,
  action_id TEXT NOT NULL UNIQUE
    REFERENCES payment_reconciliation_actions(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('acknowledge', 'resolve', 'reopen')),
  from_status TEXT NOT NULL CHECK (from_status IN ('open', 'acknowledged', 'resolved')),
  to_status TEXT NOT NULL CHECK (to_status IN ('open', 'acknowledged', 'resolved')),
  issue_version INTEGER NOT NULL
    CHECK (issue_version > 0 AND issue_version <= 9007199254740991),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  occurred_at_ms INTEGER NOT NULL
    CHECK (occurred_at_ms >= 0 AND occurred_at_ms <= 8640000000000000)
) STRICT;

CREATE INDEX idx_payment_reconciliation_events_issue
  ON payment_reconciliation_events(issue_id, occurred_at_ms DESC, id DESC);

CREATE TRIGGER prevent_payment_reconciliation_event_update
BEFORE UPDATE ON payment_reconciliation_events
BEGIN
  SELECT RAISE(ABORT, 'payment_reconciliation_event_immutable');
END;
CREATE TRIGGER prevent_payment_reconciliation_event_delete
BEFORE DELETE ON payment_reconciliation_events
BEGIN
  SELECT RAISE(ABORT, 'payment_reconciliation_event_immutable');
END;

-- Cron owns a single durable cursor. The scanner advances it with CAS and
-- wraps to the beginning only after a bounded page reaches the end.
CREATE TABLE payment_reconciliation_scan_state (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  cursor TEXT NOT NULL DEFAULT '' CHECK (length(cursor) <= 512),
  version INTEGER NOT NULL DEFAULT 0
    CHECK (version >= 0 AND version <= 9007199254740991),
  last_started_at_ms INTEGER,
  last_completed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= 0 AND updated_at_ms <= 8640000000000000)
) STRICT;

INSERT INTO payment_reconciliation_scan_state (id, updated_at_ms)
VALUES ('global', CAST(unixepoch('subsec') * 1000 AS INTEGER));

-- Dedicated partial indexes keep every UNION branch in the Cron scanner
-- bounded and avoid turning reconciliation into a periodic full-table scan.
CREATE INDEX idx_payment_reconciliation_webhook_scan
  ON payment_webhook_inbox(status, updated_at_ms, id)
  WHERE status IN ('received', 'processing', 'failed', 'dead_letter');
CREATE INDEX idx_payment_reconciliation_fulfillment_scan
  ON payment_fulfillments(status, updated_at_ms, id)
  WHERE status IN ('pending', 'processing', 'failed', 'dead_letter');
CREATE INDEX idx_payment_reconciliation_refund_scan
  ON payment_refunds(status, updated_at_ms, id)
  WHERE status IN ('requested', 'processing', 'pending', 'failed');
CREATE INDEX idx_payment_reconciliation_order_scan
  ON payment_orders(status, updated_at_ms, id)
  WHERE status IN (
    'PENDING', 'PAID', 'RECHARGING', 'COMPLETED', 'EXPIRED', 'CANCELLED',
    'FAILED', 'REFUND_REQUESTED', 'REFUNDING', 'REFUND_PENDING',
    'PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_FAILED'
  );

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (33, 'payment_reconciliation', CAST(unixepoch('subsec') * 1000 AS INTEGER));
