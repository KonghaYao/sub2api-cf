ALTER TABLE accounts ADD COLUMN billing_probe_claim_token TEXT;
ALTER TABLE accounts ADD COLUMN billing_probe_claim_until_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN billing_probe_next_at_ms INTEGER NOT NULL DEFAULT 0;
CREATE INDEX accounts_billing_probe_due ON accounts(billing_probe_next_at_ms,billing_probe_claim_until_ms)
 WHERE enabled=1 AND credential_kind='api_key';

-- Manual and batch rate edits cannot race the explicitly opted-in automatic sync.
CREATE TRIGGER accounts_upstream_billing_rate_sync_guard
BEFORE UPDATE OF billing_rate_multiplier_ppm ON accounts
WHEN OLD.billing_rate_multiplier_ppm<>NEW.billing_rate_multiplier_ppm
 AND json_extract(OLD.ui_config_json,'$.extra.upstream_billing_probe_enabled')=1
 AND json_extract(OLD.ui_config_json,'$.extra.upstream_billing_rate_sync_enabled')=1
 AND json_extract(NEW.ui_config_json,'$.extra.upstream_billing_probe_enabled')=1
 AND json_extract(NEW.ui_config_json,'$.extra.upstream_billing_rate_sync_enabled')=1
 AND (OLD.billing_probe_claim_token IS NULL OR NEW.billing_probe_claim_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'upstream_billing_rate_sync_conflict'); END;
INSERT INTO schema_migrations(version,name,applied_at_ms)
VALUES(88,'upstream_billing_probe',CAST(unixepoch('subsec')*1000 AS INTEGER));
