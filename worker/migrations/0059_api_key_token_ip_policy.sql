ALTER TABLE api_keys ADD COLUMN ip_allowlist_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(ip_allowlist_json)
    AND json_type(ip_allowlist_json) = 'array'
    AND json_array_length(ip_allowlist_json) <= 64
    AND length(ip_allowlist_json) <= 8192
  );

ALTER TABLE api_keys ADD COLUMN ip_denylist_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(ip_denylist_json)
    AND json_type(ip_denylist_json) = 'array'
    AND json_array_length(ip_denylist_json) <= 64
    AND length(ip_denylist_json) <= 8192
  );

INSERT INTO schema_migrations (version, name, applied_at_ms)
VALUES (59, 'api_key_token_ip_policy', CAST(unixepoch('subsec') * 1000 AS INTEGER));
