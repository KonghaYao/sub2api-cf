PRAGMA foreign_keys = ON;

CREATE TABLE user_attribute_definitions (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64 AND key GLOB '[A-Za-z][A-Za-z0-9_]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  description TEXT CHECK (description IS NULL OR length(description) <= 1024),
  type TEXT NOT NULL CHECK (type IN ('text','textarea','number','email','url','date','select','multi_select')),
  options_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options_json) AND json_type(options_json) = 'array' AND json_array_length(options_json) <= 100 AND length(options_json) <= 16384),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  validation_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(validation_json) AND json_type(validation_json) = 'object' AND length(validation_json) <= 4096),
  placeholder TEXT CHECK (placeholder IS NULL OR length(placeholder) <= 256),
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order BETWEEN 0 AND 1000000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  deleted_at_ms INTEGER CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= created_at_ms)
) STRICT;
CREATE UNIQUE INDEX idx_user_attribute_definitions_live_key
  ON user_attribute_definitions(key) WHERE deleted_at_ms IS NULL;
CREATE INDEX idx_user_attribute_definitions_live_order
  ON user_attribute_definitions(deleted_at_ms, enabled, display_order, id);

CREATE TABLE user_attribute_values (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attribute_id INTEGER NOT NULL REFERENCES user_attribute_definitions(id) ON DELETE RESTRICT,
  value TEXT NOT NULL CHECK (length(value) <= 16384),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  UNIQUE(user_id, attribute_id)
) STRICT;
CREATE INDEX idx_user_attribute_values_user ON user_attribute_values(user_id, attribute_id);

CREATE TABLE user_attribute_configuration (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;
INSERT INTO user_attribute_configuration(singleton, control_version, updated_at_ms) VALUES (1, 0, 0);

CREATE TABLE user_attribute_audit_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  resource_type TEXT NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 64),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
  control_version INTEGER CHECK (control_version IS NULL OR control_version >= 0),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object' AND length(metadata_json) <= 4096),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0)
) STRICT;
CREATE INDEX idx_user_attribute_audit_events_resource ON user_attribute_audit_events(resource_type, resource_id, occurred_at_ms DESC);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (62, 'user_attributes', CAST(unixepoch('subsec') * 1000 AS INTEGER));
