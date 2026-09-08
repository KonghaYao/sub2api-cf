-- Track whether an account-model capability came from an administrator or a credential mapping.
-- Existing rows predate automatic mapping synchronization and are therefore explicit.
ALTER TABLE account_models ADD COLUMN source TEXT NOT NULL DEFAULT 'explicit'
  CHECK (source IN ('explicit', 'mapping'));

CREATE INDEX idx_account_models_source
  ON account_models(account_id, source, model_id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (122, 'account_model_source', CAST(unixepoch('subsec') * 1000 AS INTEGER));
