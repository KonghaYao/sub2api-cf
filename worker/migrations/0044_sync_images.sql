PRAGMA foreign_keys = ON;

ALTER TABLE models
  ADD COLUMN image_generation INTEGER NOT NULL DEFAULT 0
  CHECK (image_generation IN (0, 1));

ALTER TABLE account_models
  ADD COLUMN image_generation INTEGER NOT NULL DEFAULT 0
  CHECK (image_generation IN (0, 1));

DROP INDEX idx_account_models_capability;
CREATE INDEX idx_account_models_capability
  ON account_models(
    model_id, chat_completions, responses, embeddings, image_generation, account_id
  );

DROP TRIGGER bump_gateway_revision_model_update;
CREATE TRIGGER bump_gateway_revision_model_update
AFTER UPDATE OF platform, public_name, upstream_name, endpoint, embeddings,
  image_generation, enabled ON models
BEGIN
  UPDATE gateway_config_revision
     SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms
   WHERE singleton = 1;
END;

DROP TRIGGER bump_gateway_revision_account_model_update;
CREATE TRIGGER bump_gateway_revision_account_model_update
AFTER UPDATE OF account_id, model_id, chat_completions, responses, embeddings,
  image_generation ON account_models
BEGIN
  UPDATE gateway_config_revision
     SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms
   WHERE singleton = 1;
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (44, 'sync_images', CAST(unixepoch('subsec') * 1000 AS INTEGER));
