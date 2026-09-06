-- Persist the administrator's explicit payment-method selection independently
-- from provider readiness. Public checkout capabilities are the intersection of
-- this selection and runnable providers.
ALTER TABLE payment_config
  ADD COLUMN enabled_payment_types_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(enabled_payment_types_json)
    AND json_type(enabled_payment_types_json) = 'array'
  );

-- Preserve the effective pre-migration Stripe selection for existing installs.
UPDATE payment_config
   SET enabled_payment_types_json = '["stripe"]'
 WHERE id = 'global'
   AND EXISTS (
     SELECT 1
       FROM payment_provider_instances
      WHERE enabled = 1 AND provider_type = 'stripe'
   );

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (75, 'payment_enabled_types', CAST(unixepoch('subsec') * 1000 AS INTEGER));
