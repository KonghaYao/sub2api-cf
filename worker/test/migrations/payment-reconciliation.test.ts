import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('payment reconciliation migration', () => {
  it('adds receipt metadata plus cursor-indexed reconciliation state without copying order facts', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)

    expect(raw.prepare(
      `SELECT version, name FROM schema_migrations WHERE version = 33`,
    ).get()).toEqual({ version: 33, name: 'payment_reconciliation' })

    const receiptColumns = raw.prepare(
      `SELECT name FROM pragma_table_info('payment_receipts') ORDER BY cid`,
    ).all().map((row: { name: string }) => row.name)
    expect(receiptColumns).toEqual([
      'id', 'schema_version', 'order_id', 'order_version', 'status',
      'content_type', 'content_sha256', 'content_length', 'r2_key',
      'attempts', 'last_error_code', 'created_at_ms', 'updated_at_ms',
      'available_at_ms',
    ])
    expect(receiptColumns).not.toContain('amount_micros')
    expect(receiptColumns).not.toContain('currency')

    for (const table of [
      'payment_reconciliation_issues',
      'payment_reconciliation_actions',
      'payment_reconciliation_events',
      'payment_reconciliation_scan_state',
    ]) {
      expect(raw.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(table)).toEqual({ name: table })
    }

    const indexes = raw.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'idx_payment_reconciliation_%'
        ORDER BY name`,
    ).all().map((row: { name: string }) => row.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_payment_reconciliation_issues_filter',
      'idx_payment_reconciliation_issues_order',
      'idx_payment_reconciliation_webhook_scan',
      'idx_payment_reconciliation_fulfillment_scan',
      'idx_payment_reconciliation_refund_scan',
      'idx_payment_reconciliation_order_scan',
    ]))
  })

  it('keeps finalized receipts and reconciliation audit history immutable', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)
    seedOrder(raw)

    raw.prepare(
      `INSERT INTO payment_receipts (
         id, order_id, order_version, status, content_type,
         content_sha256, content_length, r2_key, attempts,
         created_at_ms, updated_at_ms, available_at_ms
       ) VALUES (
         'receipt-00000001', 'order-1', 0, 'available', 'application/json',
         ?, 2, 'payment-receipts/v1/receipt-00000001/hash.json', 1, 10, 10, 10
       )`,
    ).run('a'.repeat(64))
    expect(() => raw.prepare(
      `UPDATE payment_receipts SET r2_key = 'changed' WHERE id = 'receipt-00000001'`,
    ).run()).toThrow(/payment_receipt_available_immutable/)

    raw.prepare(
      `INSERT INTO payment_reconciliation_issues (
         id, fingerprint, issue_type, severity, status, source_kind, source_id,
         summary, first_observed_at_ms, last_seen_at_ms, updated_at_ms
       ) VALUES (
         'issue-0000000001', ?, 'fulfillment_failed', 'error', 'open',
         'fulfillment', 'fulfillment-1', 'Fulfillment failed', 10, 10, 10
       )`,
    ).run('b'.repeat(64))
    raw.prepare(
      `INSERT INTO payment_reconciliation_actions (
         id, issue_id, actor_user_id, actor_session_id, action,
         expected_version, result_version, idempotency_key_hash,
         request_hash, response_json, occurred_at_ms
       ) VALUES (
         'action-000000001', 'issue-0000000001', 'admin', 'session-admin', 'acknowledge',
         0, 1, ?, ?, '{}', 10
       )`,
    ).run('c'.repeat(64), 'd'.repeat(64))
    raw.prepare(
      `INSERT INTO payment_reconciliation_events (
         id, issue_id, action_id, action, from_status, to_status,
         issue_version, actor_user_id, detail_json, occurred_at_ms
       ) VALUES (
         'event-0000000001', 'issue-0000000001', 'action-000000001', 'acknowledge', 'open',
         'acknowledged', 1, 'admin', '{}', 10
       )`,
    ).run()

    expect(() => raw.prepare(
      `UPDATE payment_reconciliation_actions SET response_json = '{"changed":true}'`,
    ).run()).toThrow(/payment_reconciliation_action_immutable/)
    expect(() => raw.prepare(
      `DELETE FROM payment_reconciliation_events`,
    ).run()).toThrow(/payment_reconciliation_event_immutable/)
  })
})

function seedOrder(raw: any): void {
  raw.prepare(
    `INSERT INTO users (id, email, display_name, role, created_at_ms, updated_at_ms)
     VALUES ('admin', 'admin@example.test', 'Admin', 'admin', 1, 1),
            ('buyer', 'buyer@example.test', 'Buyer', 'user', 1, 1)`,
  ).run()
  raw.prepare(
    `INSERT INTO payment_provider_instances (
       id, provider_key, provider_type, display_name, config_ciphertext,
       config_nonce, config_key_id, enabled, version, created_at_ms, updated_at_ms
     ) VALUES (
       'provider-1', 'stripe-primary', 'stripe', 'Stripe', 'cipher',
       'nonce', 'key', 1, 0, 1, 1
     )`,
  ).run()
  raw.prepare(
    `INSERT INTO payment_orders (
       id, user_id, provider_instance_id, provider_key_snapshot, out_trade_no,
       idempotency_key_hash, request_hash, order_type, status,
       amount_micros, pay_amount_micros, paid_amount_micros,
       refunded_amount_micros, currency, version, expires_at_ms,
       paid_at_ms, created_at_ms, updated_at_ms
     ) VALUES (
       'order-1', 'buyer', 'provider-1', 'stripe-primary', 'trade-1',
       ?, ?, 'balance', 'PAID', 1000000, 1000000, 1000000,
       0, 'USD', 0, 100, 10, 1, 10
     )`,
  ).run('e'.repeat(64), 'f'.repeat(64))
}
