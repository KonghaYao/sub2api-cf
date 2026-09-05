PRAGMA foreign_keys = ON;

-- Resolution history is immutable while its observation is retained. Once
-- the parent reaches the bounded 30-day retention path, the orphaned audit
-- rows may be removed by the same cursorized maintenance job.
DROP TRIGGER prevent_request_observation_resolution_audit_delete;

CREATE TRIGGER prevent_request_observation_resolution_audit_delete
BEFORE DELETE ON request_observation_resolution_audit
WHEN EXISTS (
  SELECT 1 FROM request_observations
   WHERE id = OLD.observation_id
)
BEGIN
  SELECT RAISE(ABORT, 'request_observation_resolution_audit_immutable');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (42, 'observability_audit_retention', CAST(unixepoch('subsec') * 1000 AS INTEGER));
