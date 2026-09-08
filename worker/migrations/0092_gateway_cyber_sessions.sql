CREATE TABLE gateway_cyber_sessions (
 key_hash TEXT PRIMARY KEY,
 expires_at_ms INTEGER NOT NULL,
 request_id TEXT NOT NULL
) STRICT;
CREATE INDEX gateway_cyber_sessions_expiry ON gateway_cyber_sessions(expires_at_ms);
CREATE TABLE gateway_risk_events (
 request_id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 api_key_id TEXT NOT NULL,
 model TEXT NOT NULL,
 code TEXT NOT NULL CHECK(code='cyber_policy'),
 created_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX gateway_risk_events_user ON gateway_risk_events(user_id,created_at_ms);
INSERT INTO schema_migrations(version,name,applied_at_ms) VALUES(92,'gateway_cyber_sessions',CAST(unixepoch('subsec')*1000 AS INTEGER));
