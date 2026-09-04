PRAGMA foreign_keys = ON;

-- Existing Worker-created accounts are OpenAI bearer accounts. Fail closed if
-- data was inserted out of band with a contract this release cannot execute.
CREATE TABLE migration_0023_preflight (
  ok INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

INSERT INTO migration_0023_preflight (ok)
SELECT 0
WHERE EXISTS (
  SELECT 1
   FROM accounts
   WHERE platform <> 'openai'
      OR protocol <> 'openai'
      OR auth_scheme <> 'bearer'
);

DROP TABLE migration_0023_preflight;

-- Migration 0002 intentionally locked these columns to the first OpenAI-only
-- release. Modern SQLite/D1 can drop the two isolated columns, allowing strict
-- CHECK constraints without rebuilding the referenced accounts table.
DROP TRIGGER bump_gateway_revision_account_update;
ALTER TABLE accounts DROP COLUMN protocol;
ALTER TABLE accounts DROP COLUMN auth_scheme;

ALTER TABLE accounts
  ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai'
    CHECK (
      (platform = 'openai' AND protocol = 'openai')
      OR (platform = 'anthropic' AND protocol = 'anthropic')
      OR (platform = 'gemini' AND protocol = 'gemini')
      OR (platform = 'codex' AND protocol = 'codex')
    );

ALTER TABLE accounts
  ADD COLUMN auth_scheme TEXT NOT NULL DEFAULT 'bearer'
    CHECK (
      (platform IN ('openai', 'codex') AND auth_scheme = 'bearer')
      OR (platform = 'anthropic' AND auth_scheme = 'x-api-key')
      OR (platform = 'gemini' AND auth_scheme = 'x-goog-api-key')
    );

-- Non-secret provider metadata is separate from the encrypted account_secrets
-- payload. The only retained provider-specific field is the Codex workspace ID;
-- authentication tokens always remain AES-GCM ciphertext in account_secrets.
ALTER TABLE accounts
  ADD COLUMN provider_config_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      length(provider_config_json) BETWEEN 2 AND 2048
      AND CASE
        WHEN json_valid(provider_config_json)
          THEN json_type(provider_config_json) = 'object'
        ELSE 0
      END
    );

CREATE TRIGGER validate_account_provider_insert
BEFORE INSERT ON accounts
FOR EACH ROW
WHEN NOT (
  (NEW.platform = 'openai' AND NEW.protocol = 'openai' AND NEW.auth_scheme = 'bearer')
  OR (NEW.platform = 'anthropic' AND NEW.protocol = 'anthropic' AND NEW.auth_scheme = 'x-api-key')
  OR (NEW.platform = 'gemini' AND NEW.protocol = 'gemini' AND NEW.auth_scheme = 'x-goog-api-key')
  OR (NEW.platform = 'codex' AND NEW.protocol = 'codex' AND NEW.auth_scheme = 'bearer')
)
OR EXISTS (
  SELECT 1 FROM json_each(NEW.provider_config_json)
   WHERE key <> 'account_id'
)
OR (
  NEW.platform <> 'codex'
  AND json_type(NEW.provider_config_json, '$.account_id') IS NOT NULL
)
OR (
  json_type(NEW.provider_config_json, '$.account_id') IS NOT NULL
  AND (
    json_type(NEW.provider_config_json, '$.account_id') <> 'text'
    OR length(json_extract(NEW.provider_config_json, '$.account_id')) NOT BETWEEN 1 AND 256
    OR json_extract(NEW.provider_config_json, '$.account_id')
       <> trim(json_extract(NEW.provider_config_json, '$.account_id'))
    OR substr(json_extract(NEW.provider_config_json, '$.account_id'), 1, 1)
       NOT GLOB '[A-Za-z0-9]'
    OR json_extract(NEW.provider_config_json, '$.account_id')
       GLOB '*[^-A-Za-z0-9._:]*'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_provider');
END;

CREATE TRIGGER validate_account_provider_update
BEFORE UPDATE OF platform, protocol, auth_scheme, provider_config_json ON accounts
FOR EACH ROW
WHEN NOT (
  (NEW.platform = 'openai' AND NEW.protocol = 'openai' AND NEW.auth_scheme = 'bearer')
  OR (NEW.platform = 'anthropic' AND NEW.protocol = 'anthropic' AND NEW.auth_scheme = 'x-api-key')
  OR (NEW.platform = 'gemini' AND NEW.protocol = 'gemini' AND NEW.auth_scheme = 'x-goog-api-key')
  OR (NEW.platform = 'codex' AND NEW.protocol = 'codex' AND NEW.auth_scheme = 'bearer')
)
OR EXISTS (
  SELECT 1 FROM json_each(NEW.provider_config_json)
   WHERE key <> 'account_id'
)
OR (
  NEW.platform <> 'codex'
  AND json_type(NEW.provider_config_json, '$.account_id') IS NOT NULL
)
OR (
  json_type(NEW.provider_config_json, '$.account_id') IS NOT NULL
  AND (
    json_type(NEW.provider_config_json, '$.account_id') <> 'text'
    OR length(json_extract(NEW.provider_config_json, '$.account_id')) NOT BETWEEN 1 AND 256
    OR json_extract(NEW.provider_config_json, '$.account_id')
       <> trim(json_extract(NEW.provider_config_json, '$.account_id'))
    OR substr(json_extract(NEW.provider_config_json, '$.account_id'), 1, 1)
       NOT GLOB '[A-Za-z0-9]'
    OR json_extract(NEW.provider_config_json, '$.account_id')
       GLOB '*[^-A-Za-z0-9._:]*'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_provider');
END;

CREATE TRIGGER bump_gateway_revision_account_update
AFTER UPDATE OF platform, credential_ref, enabled, max_concurrency, protocol,
  base_url, auth_scheme, provider_config_json, config_version ON accounts
BEGIN
  UPDATE gateway_config_revision
     SET revision = revision + 1, updated_at_ms = NEW.updated_at_ms
   WHERE singleton = 1;
END;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (23, 'provider_accounts', CAST(unixepoch('subsec') * 1000 AS INTEGER));
