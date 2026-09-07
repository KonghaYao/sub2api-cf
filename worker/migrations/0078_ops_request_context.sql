ALTER TABLE request_observations
  ADD COLUMN upstream_endpoint TEXT NOT NULL DEFAULT '' CHECK (length(upstream_endpoint) <= 128);

ALTER TABLE request_observations
  ADD COLUMN client_ip TEXT CHECK (client_ip IS NULL OR length(client_ip) <= 64);

ALTER TABLE request_observations
  ADD COLUMN user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 512);

INSERT INTO schema_migrations (version, name, applied_at_ms)
VALUES (78, 'ops_request_context', CAST(unixepoch('subsec') * 1000 AS INTEGER));
