CREATE TABLE upstream_billing_probe_settings (
  id TEXT PRIMARY KEY CHECK(id='global'),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  interval_minutes INTEGER NOT NULL DEFAULT 30 CHECK(interval_minutes BETWEEN 5 AND 1440),
  lease_token TEXT,
  lease_expires_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
) STRICT;
INSERT INTO upstream_billing_probe_settings(id,updated_at_ms) VALUES('global',0);
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(85,'upstream_billing_probe_settings',CAST(unixepoch('subsec')*1000 AS INTEGER));
