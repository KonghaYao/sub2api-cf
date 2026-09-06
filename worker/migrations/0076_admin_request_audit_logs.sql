CREATE TABLE admin_request_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 16 AND 128),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 128),
  actor_email TEXT NOT NULL CHECK (length(actor_email) BETWEEN 1 AND 320),
  actor_role TEXT NOT NULL CHECK (length(actor_role) BETWEEN 1 AND 128),
  auth_method TEXT NOT NULL CHECK (auth_method IN ('jwt', 'admin_api_key')),
  credential_masked TEXT NOT NULL CHECK (length(credential_masked) <= 64),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 512),
  method TEXT NOT NULL CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 2048),
  route_template TEXT NOT NULL CHECK (length(route_template) BETWEEN 1 AND 512),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  client_ip TEXT NOT NULL DEFAULT '' CHECK (length(client_ip) <= 64),
  user_agent TEXT NOT NULL DEFAULT '' CHECK (length(user_agent) <= 1024),
  status_code INTEGER NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  latency_ms INTEGER NOT NULL CHECK (latency_ms BETWEEN 0 AND 86400000),
  request_body TEXT NOT NULL DEFAULT '[not_captured]' CHECK (length(request_body) <= 16384),
  extra_json TEXT NOT NULL DEFAULT '{}'
    CHECK (length(extra_json) <= 8192 AND json_valid(extra_json) AND json_type(extra_json) = 'object')
) STRICT;

CREATE INDEX idx_admin_request_audit_logs_time_id
  ON admin_request_audit_logs(created_at_ms DESC, id DESC);

CREATE INDEX idx_admin_request_audit_logs_actor_time
  ON admin_request_audit_logs(actor_user_id, created_at_ms DESC, id DESC);

CREATE INDEX idx_admin_request_audit_logs_client_ip_time
  ON admin_request_audit_logs(client_ip, created_at_ms DESC, id DESC);

CREATE INDEX idx_admin_request_audit_logs_auth_method_time
  ON admin_request_audit_logs(auth_method, created_at_ms DESC, id DESC);

CREATE INDEX idx_admin_request_audit_logs_method_time
  ON admin_request_audit_logs(method, created_at_ms DESC, id DESC);

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (76, 'admin_request_audit_logs', CAST(unixepoch('subsec') * 1000 AS INTEGER));
