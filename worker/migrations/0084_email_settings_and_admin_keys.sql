CREATE TABLE admin_automation_keys (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  user_id TEXT NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL UNIQUE,
  masked_key TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE email_delivery_settings (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  password_nonce_b64 TEXT,
  password_ciphertext_b64 TEXT,
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE email_template_overrides (
  event TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('en', 'zh')),
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (event, locale)
);

INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES (84,'email_settings_and_admin_keys',CAST(unixepoch('subsec')*1000 AS INTEGER));
