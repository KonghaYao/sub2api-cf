PRAGMA foreign_keys = ON;

-- Reconciliation advances each source independently by (updated_at_ms, id).
-- Keeping status out of the leading index columns lets SQLite seek directly
-- from the durable cursor instead of sorting or rescanning historical rows.
CREATE INDEX idx_payment_reconciliation_order_seek
  ON payment_orders(updated_at_ms, id)
  WHERE status IN (
    'PENDING', 'PAID', 'RECHARGING', 'COMPLETED', 'EXPIRED', 'CANCELLED',
    'FAILED', 'REFUND_REQUESTED', 'REFUNDING', 'REFUND_PENDING',
    'PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_FAILED'
  );

CREATE INDEX idx_payment_reconciliation_webhook_seek
  ON payment_webhook_inbox(updated_at_ms, id)
  WHERE status IN ('received', 'processing', 'failed', 'dead_letter');

CREATE INDEX idx_payment_reconciliation_fulfillment_seek
  ON payment_fulfillments(updated_at_ms, id)
  WHERE status IN ('pending', 'processing', 'failed', 'dead_letter');

CREATE INDEX idx_payment_reconciliation_refund_seek
  ON payment_refunds(updated_at_ms, id)
  WHERE status IN ('requested', 'processing', 'pending', 'failed');

INSERT INTO schema_migrations(version, name, applied_at_ms)
VALUES (
  34,
  'payment_reconciliation_seek_indexes',
  CAST(unixepoch('subsec') * 1000 AS INTEGER)
);
