PRAGMA foreign_keys = ON;

CREATE TABLE admin_compliance_acknowledgements (
  admin_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  document_zh TEXT NOT NULL CHECK (length(document_zh) BETWEEN 1 AND 512),
  document_en TEXT NOT NULL CHECK (length(document_en) BETWEEN 1 AND 512),
  language TEXT NOT NULL CHECK (language IN ('zh', 'en')),
  ip_address TEXT CHECK (ip_address IS NULL OR length(ip_address) BETWEEN 1 AND 128),
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) BETWEEN 1 AND 512),
  accepted_at_ms INTEGER NOT NULL CHECK (accepted_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (admin_user_id, version)
) STRICT;

CREATE INDEX idx_admin_compliance_acknowledgements_current
  ON admin_compliance_acknowledgements(version, admin_user_id);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (61, 'admin_compliance_acknowledgements', CAST(unixepoch('subsec') * 1000 AS INTEGER));
