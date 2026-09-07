ALTER TABLE system_settings
  ADD COLUMN audit_log_retention_days INTEGER NOT NULL DEFAULT 180
    CHECK (audit_log_retention_days BETWEEN 0 AND 3650);

CREATE INDEX idx_admin_request_audit_logs_latest_clear_trace
  ON admin_request_audit_logs(created_at_ms DESC, id DESC)
  WHERE action = 'POST /api/v1/admin/audit-logs/clear'
    AND json_extract(extra_json, '$.kind') = 'clear_trace';

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (77, 'audit_log_retention', CAST(unixepoch('subsec') * 1000 AS INTEGER));
