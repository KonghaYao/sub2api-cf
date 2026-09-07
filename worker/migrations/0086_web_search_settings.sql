CREATE TABLE web_search_settings (
 id TEXT PRIMARY KEY CHECK(id='global'),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 nonce_b64 TEXT NOT NULL,
 ciphertext_b64 TEXT NOT NULL,
 control_version INTEGER NOT NULL DEFAULT 1,
 updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE web_search_usage (
 provider TEXT NOT NULL,
 window_start_ms INTEGER NOT NULL,
 used INTEGER NOT NULL CHECK(used>=0),
 PRIMARY KEY(provider,window_start_ms)
) STRICT;

INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES (86,'web_search_settings',CAST(unixepoch('subsec')*1000 AS INTEGER));
