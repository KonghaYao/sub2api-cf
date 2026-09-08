ALTER TABLE media_provider_jobs ADD COLUMN provider_model TEXT;
-- Existing jobs were submitted using the immutable task model, before account
-- mappings participated in media execution. Preserve that exact name.
UPDATE media_provider_jobs SET provider_model = (
  SELECT upstream_model FROM media_tasks WHERE media_tasks.id = media_provider_jobs.task_id
);
CREATE TRIGGER media_provider_model_immutable
BEFORE UPDATE OF provider_model ON media_provider_jobs
WHEN NEW.provider_model IS NOT OLD.provider_model
BEGIN
  SELECT RAISE(ABORT, 'media_provider_model_immutable');
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (83, 'media_provider_model_snapshot', CAST(unixepoch('subsec') * 1000 AS INTEGER));
