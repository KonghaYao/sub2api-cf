-- Additive upgrade: preserve numeric IDs, creation keys, ciphertext and references.
-- Keyed digests support atomic original host/port/auth deduplication without storing passwords.
ALTER TABLE proxies ADD COLUMN identity_digest TEXT;
CREATE INDEX idx_proxies_identity_digest ON proxies(identity_digest);
ALTER TABLE proxy_creation_requests ADD COLUMN created INTEGER NOT NULL DEFAULT 1 CHECK(created IN (0,1));
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(115,'proxy_import_identity',CAST(unixepoch('subsec')*1000 AS INTEGER));
