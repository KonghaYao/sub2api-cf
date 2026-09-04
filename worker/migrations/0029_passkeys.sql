PRAGMA foreign_keys = ON;

-- Stable opaque WebAuthn user handles must not expose application user IDs.
CREATE TABLE passkey_user_handles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  user_handle_b64 TEXT NOT NULL UNIQUE CHECK (length(user_handle_b64) = 43),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT;

-- Only verification material is persisted. Private keys remain in authenticators.
CREATE TABLE passkey_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id_b64 TEXT NOT NULL UNIQUE
    CHECK (length(credential_id_b64) BETWEEN 2 AND 1366),
  name TEXT NOT NULL DEFAULT 'Passkey' CHECK (length(name) BETWEEN 1 AND 100),
  public_key_jwk TEXT NOT NULL CHECK (json_valid(public_key_jwk)),
  algorithm INTEGER NOT NULL CHECK (algorithm = -7),
  sign_count INTEGER NOT NULL DEFAULT 0
    CHECK (sign_count BETWEEN 0 AND 4294967295),
  backup_eligible INTEGER NOT NULL DEFAULT 0 CHECK (backup_eligible IN (0, 1)),
  backup_state INTEGER NOT NULL DEFAULT 0 CHECK (backup_state IN (0, 1)),
  transports_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(transports_json)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  use_nonce TEXT UNIQUE,
  last_used_at_ms INTEGER CHECK (last_used_at_ms IS NULL OR last_used_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX idx_passkey_credentials_user_created
  ON passkey_credentials(user_id, created_at_ms DESC, id DESC);

-- Session tokens are 256-bit bearer values; D1 stores only their SHA-256 digests.
CREATE TABLE passkey_challenges (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'login')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  user_handle_b64 TEXT CHECK (user_handle_b64 IS NULL OR length(user_handle_b64) = 43),
  registration_session_id TEXT REFERENCES user_sessions(id) ON DELETE CASCADE,
  registration_auth_version INTEGER
    CHECK (registration_auth_version IS NULL OR registration_auth_version > 0),
  challenge_b64 TEXT NOT NULL CHECK (length(challenge_b64) = 43),
  rp_id TEXT NOT NULL CHECK (length(rp_id) BETWEEN 1 AND 253),
  origins_json TEXT NOT NULL CHECK (json_valid(origins_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed')),
  consume_nonce TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms INTEGER
    CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (kind = 'registration' AND user_id IS NOT NULL AND user_handle_b64 IS NOT NULL
      AND registration_session_id IS NOT NULL AND registration_auth_version IS NOT NULL)
    OR
    (kind = 'login' AND user_id IS NULL AND user_handle_b64 IS NULL
      AND registration_session_id IS NULL AND registration_auth_version IS NULL)
  ),
  CHECK (
    (status = 'pending' AND consumed_at_ms IS NULL AND consume_nonce IS NULL)
    OR
    (status = 'consumed' AND consumed_at_ms IS NOT NULL AND consume_nonce IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_passkey_challenges_expiry
  ON passkey_challenges(expires_at_ms, id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (29, 'passkeys', CAST(unixepoch('subsec') * 1000 AS INTEGER));
