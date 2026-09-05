PRAGMA foreign_keys = ON;

-- Ordinary asynchronous Images tasks are deliberately separate from the
-- Gemini batch schema. D1 contains lifecycle metadata only; request bodies and
-- generated image bytes live under private, server-generated R2 keys.
CREATE TABLE image_tasks (
  id TEXT PRIMARY KEY CHECK (id GLOB 'imgtask_*' AND length(id) BETWEEN 24 AND 64),
  user_id TEXT NOT NULL REFERENCES users(id),
  api_key_id TEXT NOT NULL REFERENCES api_keys(id),
  group_id TEXT NOT NULL REFERENCES "groups"(id),
  operation TEXT NOT NULL CHECK (operation IN ('generations', 'edits')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'deleting')),
  input_object_key TEXT NOT NULL UNIQUE CHECK (length(input_object_key) BETWEEN 16 AND 512),
  input_content_type TEXT NOT NULL CHECK (length(input_content_type) BETWEEN 1 AND 255),
  principal_json TEXT NOT NULL CHECK (json_valid(principal_json)),
  result_object_key TEXT UNIQUE CHECK (result_object_key IS NULL OR length(result_object_key) BETWEEN 16 AND 512),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  attempt_token TEXT CHECK (attempt_token IS NULL OR length(attempt_token) BETWEEN 16 AND 64),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX idx_image_tasks_owner
  ON image_tasks(user_id, api_key_id, created_at_ms DESC, id DESC);
CREATE INDEX idx_image_tasks_recovery
  ON image_tasks(status, updated_at_ms, id)
  WHERE status IN ('queued', 'running');

CREATE TABLE image_task_outputs (
  task_id TEXT NOT NULL REFERENCES image_tasks(id) ON DELETE CASCADE,
  image_index INTEGER NOT NULL CHECK (image_index BETWEEN 0 AND 99),
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 16 AND 512),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 33554432),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (task_id, image_index)
) STRICT;

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (47, 'image_tasks', CAST(unixepoch('subsec') * 1000 AS INTEGER));
