PRAGMA foreign_keys = ON;

-- New writes may retain the exact customer pricing decision next to the
-- already-projected economic columns. Historical rows deliberately remain
-- NULL: rewriting the projection would exceed the Free-plan D1 write budget.
ALTER TABLE usage_projection ADD COLUMN customer_pricing_snapshot_json TEXT
  CHECK (
    customer_pricing_snapshot_json IS NULL
    OR (
      length(customer_pricing_snapshot_json) BETWEEN 2 AND 65536
      AND CASE
        WHEN json_valid(customer_pricing_snapshot_json)
          THEN json_type(customer_pricing_snapshot_json) = 'object'
        ELSE 0
      END
    )
  );

-- Customer economics are immutable historical facts. price_id is omitted on
-- purpose: it remains the nullable catalog foreign key and is not the channel
-- pricing identifier (the latter is captured inside the JSON snapshot).
CREATE TRIGGER usage_customer_pricing_immutable
BEFORE UPDATE OF billing_mode, input_amount_micros, output_amount_micros,
  cache_amount_micros, base_amount_micros, amount_micros,
  customer_pricing_snapshot_json ON usage_projection
BEGIN
  SELECT RAISE(ABORT, 'usage_customer_pricing_immutable');
END;

-- Do not create a historical usage index for this sparse snapshot column.
INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (
  54,
  'customer_pricing',
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
);
