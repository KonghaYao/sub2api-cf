import { describe, expect, it } from 'vitest'

import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('payment subscription renewal migration', () => {
  it('adds an immutable per-order subscription term ledger', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw)

    expect(raw.prepare(
      `SELECT version, name FROM schema_migrations WHERE version = 36`,
    ).get()).toEqual({ version: 36, name: 'payment_subscription_terms' })
    expect(raw.prepare(
      `SELECT name FROM pragma_table_info('payment_subscription_terms') ORDER BY cid`,
    ).all().map((row: { name: string }) => row.name)).toEqual([
      'order_id', 'subscription_id', 'user_id', 'group_id', 'term_kind',
      'previous_status', 'previous_starts_at_ms', 'previous_expires_at_ms',
      'starts_at_ms', 'expires_at_ms', 'granted_duration_ms',
      'refunded_duration_ms', 'created_at_ms', 'updated_at_ms',
    ])
    expect(raw.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND tbl_name = 'payment_subscription_terms'
        ORDER BY name`,
    ).all()).toEqual([
      { name: 'prevent_payment_subscription_term_delete' },
      { name: 'prevent_payment_subscription_term_grant_update' },
      { name: 'validate_payment_subscription_term_refund_update' },
    ])
    expect(raw.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
  })

  it('backfills completed legacy payment grants before exact partial refunds are enabled', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 35)
    seedLegacyPaidRenewal(raw)

    applyMigrations(raw, 36)

    expect(raw.prepare(
      `SELECT subscription_id, user_id, group_id, term_kind,
              starts_at_ms, expires_at_ms, granted_duration_ms, refunded_duration_ms
         FROM payment_subscription_terms WHERE order_id = 'legacy-renewal-order'`,
    ).get()).toEqual({
      subscription_id: 'legacy-subscription',
      user_id: 'legacy-user',
      group_id: 'legacy-group',
      term_kind: 'legacy',
      starts_at_ms: 2_000,
      expires_at_ms: 2_592_002_000,
      granted_duration_ms: 2_592_000_000,
      refunded_duration_ms: 2_592_000_000,
    })
    expect(raw.prepare(
      `SELECT clawback_duration_ms, clawback_term_refunded_before_ms,
              provider_idempotency_key_version
         FROM payment_refunds WHERE id = 'legacy-refund'`,
    ).get()).toEqual({
      clawback_duration_ms: 2_592_000_000,
      clawback_term_refunded_before_ms: 0,
      provider_idempotency_key_version: 0,
    })
    expect(() => raw.prepare(
      `UPDATE payment_subscription_terms SET granted_duration_ms = 1
        WHERE order_id = 'legacy-renewal-order'`,
    ).run()).toThrow(/payment_subscription_term_grant_immutable/)
    expect(() => raw.prepare(
      `UPDATE payment_subscription_terms SET refunded_duration_ms = 1
        WHERE order_id = 'legacy-renewal-order'`,
    ).run()).toThrow(/payment_subscription_term_refund_invalid/)
    expect(() => raw.prepare(
      `DELETE FROM payment_subscription_terms WHERE order_id = 'legacy-renewal-order'`,
    ).run()).toThrow(/payment_subscription_term_delete_forbidden/)
    expect(raw.prepare(`PRAGMA foreign_key_check`).all()).toEqual([])
  })
})

function seedLegacyPaidRenewal(raw: any): void {
  raw.prepare(
    `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
     VALUES ('legacy-user', 'legacy@example.test', 'Legacy', 1, 1)`,
  ).run()
  raw.prepare(
    `INSERT INTO "groups" (
       id, name, platform, enabled, group_type, created_at_ms, updated_at_ms
     ) VALUES ('legacy-group', 'Legacy group', 'openai', 1, 'subscription', 1, 1)`,
  ).run()
  raw.prepare(
    `INSERT INTO subscription_plans (
       id, group_id, name, validity_days, price_micros, currency,
       created_at_ms, updated_at_ms
     ) VALUES ('legacy-plan', 'legacy-group', 'Legacy 30', 30, 1000000, 'USD', 1, 1)`,
  ).run()
  raw.prepare(
    `INSERT INTO user_subscriptions (
       id, user_id, group_id, plan_id, status, starts_at_ms, expires_at_ms,
       source_type, source_id, created_at_ms, updated_at_ms
     ) VALUES (
       'legacy-subscription', 'legacy-user', 'legacy-group', 'legacy-plan',
       'active', 1000, 5184001000, 'payment', 'legacy-renewal-order', 1000, 2000
     )`,
  ).run()
  raw.prepare(
    `INSERT INTO payment_provider_instances (
       id, provider_key, provider_type, display_name,
       config_ciphertext, config_nonce, config_key_id, created_at_ms, updated_at_ms
     ) VALUES (
       'legacy-provider', 'stripe-legacy', 'stripe', 'Stripe',
       'cipher', 'nonce', 'key', 1, 1
     )`,
  ).run()
  raw.prepare(
    `INSERT INTO payment_orders (
       id, user_id, provider_instance_id, provider_key_snapshot, out_trade_no,
       idempotency_key_hash, request_hash, order_type, status,
       amount_micros, pay_amount_micros, paid_amount_micros, currency,
       plan_id, plan_name_snapshot, plan_group_id_snapshot,
       plan_validity_days_snapshot, plan_price_micros_snapshot, plan_currency_snapshot,
       subscription_id, subscription_fulfilled_at_ms,
       expires_at_ms, paid_at_ms, completed_at_ms, created_at_ms, updated_at_ms
     ) VALUES (
       'legacy-renewal-order', 'legacy-user', 'legacy-provider', 'stripe-legacy', 'legacy-trade',
       ?, ?, 'subscription', 'COMPLETED', 1000000, 1000000, 1000000, 'USD',
       'legacy-plan', 'Legacy 30', 'legacy-group', 30, 1000000, 'USD',
       'legacy-subscription', 2000, 10000, 2000, 2000, 1000, 2000
     )`,
  ).run('a'.repeat(64), 'b'.repeat(64))
  raw.prepare(
    `INSERT INTO subscription_events (
       id, subscription_id, user_id, group_id, event_type,
       source_type, source_id, validity_days, occurred_at_ms
     ) VALUES (
       'legacy-renewal-event', 'legacy-subscription', 'legacy-user', 'legacy-group',
       'extended', 'payment', 'legacy-renewal-order', 30, 2000
     )`,
  ).run()
  raw.prepare(
    `UPDATE payment_orders
        SET status = 'PARTIALLY_REFUNDED', refunded_amount_micros = 500000,
            refund_requested_at_ms = 3000, refund_completed_at_ms = 3000,
            version = 1, updated_at_ms = 3000
      WHERE id = 'legacy-renewal-order'`,
  ).run()
  raw.prepare(
    `INSERT INTO payment_refunds (
       id, order_id, request_key_hash, provider_key, provider_refund_id,
       amount_micros, settled_amount_micros, currency, status, reason,
       clawback_kind, clawback_status, clawback_resource_id,
       clawback_amount_micros, clawback_days, clawback_forced,
       clawback_previous_status, clawback_previous_expires_at_ms,
       clawback_applied_control_version, clawback_applied_at_ms,
       created_at_ms, updated_at_ms, completed_at_ms
     ) VALUES (
       'legacy-refund', 'legacy-renewal-order', ?, 'stripe-legacy', 're_legacy',
       500000, 500000, 'USD', 'partially_refunded', 'legacy partial',
       'subscription', 'applied', 'legacy-subscription',
       500000, 30, 0, 'active', 5184001000, 1, 2500, 2000, 3000, 3000
     )`,
  ).run('c'.repeat(64))
}
