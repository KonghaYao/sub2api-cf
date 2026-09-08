CREATE TABLE system_notification_settings (
  id TEXT PRIMARY KEY CHECK(id='global'),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  control_version INTEGER NOT NULL DEFAULT 0 CHECK(control_version>=0),
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE system_notification_scan (
  id TEXT PRIMARY KEY CHECK(id='global'),
  lease_id TEXT,
  lease_expires_at_ms INTEGER NOT NULL DEFAULT 0,
  users_cursor TEXT NOT NULL DEFAULT '',
  subscriptions_cursor TEXT NOT NULL DEFAULT '',
  accounts_cursor TEXT NOT NULL DEFAULT ''
);
INSERT INTO system_notification_scan(id) VALUES('global');
CREATE TABLE system_notification_conditions (
  id TEXT PRIMARY KEY,
  active INTEGER NOT NULL CHECK(active IN(0,1)),
  generation INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE system_notification_deliveries (
  id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  event TEXT NOT NULL,
  recipient TEXT NOT NULL,
  variables_json TEXT NOT NULL CHECK(json_valid(variables_json)),
  status TEXT NOT NULL CHECK(status IN('pending','sent')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER
);
CREATE INDEX idx_system_notification_pending ON system_notification_deliveries(status,next_attempt_at_ms,created_at_ms);

INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES (85,'notification_delivery',CAST(unixepoch('subsec')*1000 AS INTEGER));
