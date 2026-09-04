import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const ORDER_STATUSES = [
  'PENDING',
  'PAID',
  'RECHARGING',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
  'REFUND_REQUESTED',
  'REFUNDING',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'REFUND_FAILED',
] as const

const PAYMENT_TABLES = [
  'payment_config',
  'payment_provider_instances',
  'payment_orders',
  'payment_webhook_inbox',
  'payment_fulfillments',
  'payment_refunds',
  'payment_events',
] as const

describe('payment core migration', () => {
  it('is additive over commerce data and creates the encrypted payment ledger schema', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 15)
    seedCommerce(raw)

    applyMigrations(raw, 16)

    const tables = raw.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'payment_%'
        ORDER BY name`,
    ).all().map((row: { name: string }) => row.name)
    expect(tables).toEqual([...PAYMENT_TABLES].sort())
    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 16').get()).toEqual({
      name: 'payment_core',
    })
    expect(raw.prepare('SELECT name, price_micros FROM subscription_plans WHERE id = ?').get('plan-1'))
      .toEqual({ name: 'Pro', price_micros: 12_500_000 })

    const providerColumns = raw.prepare('PRAGMA table_info(payment_provider_instances)').all()
      .map((row: { name: string }) => row.name)
    expect(providerColumns).toEqual(expect.arrayContaining([
      'provider_key',
      'config_ciphertext',
      'config_nonce',
      'config_key_id',
      'enabled',
      'version',
    ]))
    expect(providerColumns).not.toEqual(expect.arrayContaining([
      'api_key',
      'secret_key',
      'private_key',
      'webhook_secret',
      'config_json',
    ]))

    const orderColumns = raw.prepare('PRAGMA table_info(payment_orders)').all()
      .map((row: { name: string }) => row.name)
    expect(orderColumns).toEqual(expect.arrayContaining([
      'idempotency_key_hash',
      'request_hash',
      'pay_amount_micros',
      'fee_ppm_snapshot',
      'provider_order_id',
      'payment_intent_id',
      'pay_url',
      'fulfillment_started_at_ms',
      'subscription_id',
      'subscription_fulfilled_at_ms',
      'refund_requested_at_ms',
      'refund_completed_at_ms',
      'source_url',
      'last_error',
    ]))
    raw.close()
  })

  it('installs a safe disabled payment configuration with integer micros and ppm controls', () => {
    const { raw } = migratedDatabase()
    expect(raw.prepare(`
      SELECT id, enabled, min_amount_micros, max_amount_micros, daily_limit_micros,
             order_timeout_minutes, max_pending_orders, balance_disabled,
             balance_recharge_multiplier_ppm, subscription_usd_to_cny_rate_ppm,
             recharge_fee_ppm, product_name_prefix, product_name_suffix,
             help_url, help_text, version
        FROM payment_config WHERE id = 'global'
    `).get()).toEqual({
      id: 'global',
      enabled: 0,
      min_amount_micros: 0,
      max_amount_micros: 0,
      daily_limit_micros: 0,
      order_timeout_minutes: 30,
      max_pending_orders: 3,
      balance_disabled: 0,
      balance_recharge_multiplier_ppm: 1_000_000,
      subscription_usd_to_cny_rate_ppm: 0,
      recharge_fee_ppm: 0,
      product_name_prefix: '',
      product_name_suffix: '',
      help_url: '',
      help_text: '',
      version: 0,
    })

    expect(() => raw.prepare(
      `UPDATE payment_config SET min_amount_micros = 1.5 WHERE id = 'global'`,
    ).run()).toThrow()
    expect(() => raw.prepare(
      `UPDATE payment_config SET recharge_fee_ppm = 1.5 WHERE id = 'global'`,
    ).run()).toThrow()
    expect(() => raw.prepare(
      `UPDATE payment_config SET min_amount_micros = 200, max_amount_micros = 100 WHERE id = 'global'`,
    ).run()).toThrow()
    expect(() => raw.prepare(`
      INSERT INTO payment_config (
        id, created_at_ms, updated_at_ms
      ) VALUES ('secondary', 1, 1)
    `).run()).toThrow()
    raw.close()
  })

  it('enforces provider identity, encrypted configuration, and optimistic version fields', () => {
    const { raw } = migratedDatabase()
    insertProvider(raw)

    expect(() => insertProvider(raw, { id: 'provider-2' })).toThrow()
    expect(() => insertProvider(raw, {
      id: 'provider-3',
      providerKey: 'stripe-secondary',
      ciphertext: '',
    })).toThrow()
    expect(() => raw.prepare(
      'UPDATE payment_provider_instances SET enabled = 2 WHERE id = ?',
    ).run('provider-1')).toThrow()
    expect(() => raw.prepare(
      'UPDATE payment_provider_instances SET version = -1 WHERE id = ?',
    ).run('provider-1')).toThrow()
    raw.close()
  })

  it('accepts the complete legacy order state set and rejects unknown states', () => {
    const { raw } = migratedDatabase()
    seedCommerce(raw)
    insertProvider(raw)

    for (const [index, status] of ORDER_STATUSES.entries()) {
      insertOrder(raw, {
        id: `order-${index}`,
        outTradeNo: `sub2-${index}`,
        status,
        idempotencyKeyHash: (index + 1).toString(16).padStart(64, '0'),
      })
    }
    expect(raw.prepare('SELECT COUNT(*) AS count FROM payment_orders').get()).toEqual({
      count: ORDER_STATUSES.length,
    })
    expect(() => insertOrder(raw, {
      id: 'order-invalid',
      outTradeNo: 'sub2-invalid',
      status: 'UNKNOWN',
    })).toThrow()
    raw.close()
  })

  it('keeps order price, currency, and plan terms as immutable integer snapshots', () => {
    const { raw } = migratedDatabase()
    seedCommerce(raw)
    insertProvider(raw)
    insertOrder(raw)

    for (const [column, value] of [
      ['amount_micros', 13_000_000],
      ['pay_amount_micros', 13_000_000],
      ['fee_ppm_snapshot', 25_000],
      ['currency', 'EUR'],
      ['plan_id', 'plan-other'],
      ['plan_name_snapshot', 'Changed'],
      ['plan_group_id_snapshot', 'group-other'],
      ['plan_validity_days_snapshot', 60],
      ['plan_price_micros_snapshot', 13_000_000],
      ['plan_currency_snapshot', 'EUR'],
      ['plan_daily_quota_micros_snapshot', 9_000_000],
    ] as const) {
      expect(() => raw.prepare(`UPDATE payment_orders SET ${column} = ? WHERE id = ?`)
        .run(value, 'order-1')).toThrow()
    }

    expect(() => insertOrder(raw, {
      id: 'order-negative',
      outTradeNo: 'sub2-negative',
      amountMicros: -1,
    })).toThrow()
    expect(() => insertOrder(raw, {
      id: 'order-real',
      outTradeNo: 'sub2-real',
      amountMicros: 12.5,
    })).toThrow()
    expect(() => raw.prepare(
      'UPDATE payment_orders SET paid_amount_micros = ? WHERE id = ?',
    ).run(12.5, 'order-1')).toThrow()
    raw.close()
  })

  it('enforces payment idempotency keys and financial foreign keys', () => {
    const { raw } = migratedDatabase()
    seedCommerce(raw)
    insertProvider(raw)
    insertOrder(raw)

    expect(() => insertOrder(raw, { id: 'order-duplicate', outTradeNo: 'sub2-order-1' })).toThrow()
    expect(() => insertOrder(raw, {
      id: 'order-duplicate-idempotency',
      outTradeNo: 'sub2-other',
    })).toThrow()
    expect(() => insertOrder(raw, {
      id: 'order-missing-user',
      userId: 'missing-user',
      outTradeNo: 'sub2-missing-user',
    })).toThrow()
    expect(() => insertOrder(raw, {
      id: 'order-missing-provider',
      providerId: 'missing-provider',
      outTradeNo: 'sub2-missing-provider',
    })).toThrow()

    insertWebhook(raw)
    expect(() => insertWebhook(raw, { id: 'webhook-duplicate' })).toThrow()
    expect(() => insertWebhook(raw, {
      id: 'webhook-missing-provider',
      providerKey: 'missing-provider',
      eventId: 'evt-missing',
    })).toThrow()

    insertFulfillment(raw)
    expect(() => insertFulfillment(raw, { id: 'fulfillment-duplicate' })).toThrow()
    expect(() => insertFulfillment(raw, {
      id: 'fulfillment-missing-order',
      orderId: 'missing-order',
    })).toThrow()

    insertRefund(raw)
    expect(() => insertRefund(raw, { id: 'refund-duplicate' })).toThrow()
    expect(() => insertRefund(raw, {
      id: 'refund-missing-order',
      orderId: 'missing-order',
      requestKeyHash: 'b'.repeat(64),
    })).toThrow()

    insertEvent(raw)
    expect(() => insertEvent(raw, { id: 'event-duplicate' })).toThrow()
    expect(() => insertEvent(raw, {
      id: 'event-missing-order',
      orderId: 'missing-order',
      sourceId: 'evt-missing',
    })).toThrow()
    raw.close()
  })

  it('constrains webhook recovery, fulfillment leases, refunds, and query indexes', () => {
    const { raw } = migratedDatabase()
    seedCommerce(raw)
    insertProvider(raw)
    insertOrder(raw)

    insertWebhook(raw)
    expect(() => raw.prepare(
      'UPDATE payment_webhook_inbox SET attempts = -1 WHERE id = ?',
    ).run('webhook-1')).toThrow()
    expect(() => raw.prepare(
      `UPDATE payment_webhook_inbox SET status = 'unknown' WHERE id = ?`,
    ).run('webhook-1')).toThrow()

    expect(() => insertFulfillment(raw, {
      status: 'processing',
      leaseOwner: null,
      leaseExpiresAtMs: null,
    })).toThrow()
    insertFulfillment(raw, {
      status: 'processing',
      leaseOwner: 'worker-a',
      leaseExpiresAtMs: 10_000,
    })

    insertRefund(raw)
    expect(() => insertRefund(raw, {
      id: 'refund-negative',
      requestKeyHash: 'b'.repeat(64),
      amountMicros: -1,
    })).toThrow()
    expect(() => insertRefund(raw, {
      id: 'refund-real',
      requestKeyHash: 'c'.repeat(64),
      amountMicros: 1.5,
    })).toThrow()
    expect(() => raw.prepare(
      'UPDATE payment_refunds SET settled_amount_micros = ? WHERE id = ?',
    ).run(1.5, 'refund-1')).toThrow()
    expect(() => raw.prepare(
      `UPDATE payment_refunds SET status = 'unknown' WHERE id = ?`,
    ).run('refund-1')).toThrow()

    const indexes = raw.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'idx_payment_%'
        ORDER BY name`,
    ).all().map((row: { name: string }) => row.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_payment_orders_user_time',
      'idx_payment_orders_status_expiry',
      'idx_payment_webhook_inbox_pending',
      'idx_payment_fulfillments_pending',
      'idx_payment_refunds_order_time',
      'idx_payment_events_order_time',
    ]))
    raw.close()
  })
})

function migratedDatabase(): { raw: any } {
  const database = createSqliteD1()
  applyMigrations(database.raw)
  return database
}

function seedCommerce(raw: any): void {
  raw.exec(`
    INSERT INTO users (id, email, created_at_ms, updated_at_ms)
    VALUES ('user-1', 'buyer@example.com', 1, 1);
    INSERT INTO "groups" (
      id, name, platform, group_type, created_at_ms, updated_at_ms
    ) VALUES ('group-1', 'Subscribers', 'openai', 'subscription', 1, 1);
    INSERT INTO subscription_plans (
      id, group_id, name, description, validity_days, price_micros, currency,
      daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
      enabled, sort_order, created_at_ms, updated_at_ms
    ) VALUES (
      'plan-1', 'group-1', 'Pro', 'Pro plan', 30, 12500000, 'USD',
      5000000, 20000000, 60000000, 1, 0, 1, 1
    );
  `)
}

function insertProvider(
  raw: any,
  override: {
    id?: string
    providerKey?: string
    ciphertext?: string
  } = {},
): void {
  raw.prepare(`
    INSERT INTO payment_provider_instances (
      id, provider_key, provider_type, display_name,
      config_ciphertext, config_nonce, config_key_id,
      enabled, version, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'stripe', 'Stripe', ?, 'nonce-base64', 'payment-key-v1', 1, 0, 2, 2)
  `).run(
    override.id ?? 'provider-1',
    override.providerKey ?? 'stripe-primary',
    override.ciphertext ?? 'encrypted-envelope',
  )
}

function insertOrder(
  raw: any,
  override: {
    id?: string
    userId?: string
    providerId?: string
    outTradeNo?: string
    status?: string
    amountMicros?: number
    idempotencyKeyHash?: string
  } = {},
): void {
  raw.prepare(`
    INSERT INTO payment_orders (
      id, user_id, provider_instance_id, provider_key_snapshot, out_trade_no,
      idempotency_key_hash, request_hash,
      order_type, status, amount_micros, pay_amount_micros, fee_ppm_snapshot,
      paid_amount_micros, refunded_amount_micros,
      currency, plan_id, plan_name_snapshot, plan_group_id_snapshot,
      plan_validity_days_snapshot, plan_price_micros_snapshot, plan_currency_snapshot,
      plan_daily_quota_micros_snapshot, plan_weekly_quota_micros_snapshot,
      plan_monthly_quota_micros_snapshot, version, expires_at_ms,
      created_at_ms, updated_at_ms
    ) VALUES (
      ?, ?, ?, 'stripe-primary', ?, ?, ?, 'subscription', ?, ?, ?, 0, 0, 0,
      'USD', 'plan-1', 'Pro', 'group-1', 30, 12500000, 'USD',
      5000000, 20000000, 60000000, 0, 100000, 3, 3
    )
  `).run(
    override.id ?? 'order-1',
    override.userId ?? 'user-1',
    override.providerId ?? 'provider-1',
    override.outTradeNo ?? 'sub2-order-1',
    override.idempotencyKeyHash ?? 'a'.repeat(64),
    'f'.repeat(64),
    override.status ?? 'PENDING',
    override.amountMicros ?? 12_500_000,
    override.amountMicros ?? 12_500_000,
  )
}

function insertWebhook(
  raw: any,
  override: {
    id?: string
    providerKey?: string
    eventId?: string
  } = {},
): void {
  raw.prepare(`
    INSERT INTO payment_webhook_inbox (
      id, provider_key, provider_event_id, event_type, payload_sha256,
      payload_r2_key, status, attempts, available_at_ms, received_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 'payment.succeeded', ?, 'payment-webhooks/evt-1', 'received', 0, 4, 4, 4)
  `).run(
    override.id ?? 'webhook-1',
    override.providerKey ?? 'stripe-primary',
    override.eventId ?? 'evt-1',
    'a'.repeat(64),
  )
}

function insertFulfillment(
  raw: any,
  override: {
    id?: string
    orderId?: string
    status?: string
    leaseOwner?: string | null
    leaseExpiresAtMs?: number | null
  } = {},
): void {
  raw.prepare(`
    INSERT INTO payment_fulfillments (
      id, order_id, action, status, attempts, available_at_ms,
      lease_owner, lease_expires_at_ms, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 'subscription_grant', ?, 0, 5, ?, ?, 5, 5)
  `).run(
    override.id ?? 'fulfillment-1',
    override.orderId ?? 'order-1',
    override.status ?? 'pending',
    override.leaseOwner ?? null,
    override.leaseExpiresAtMs ?? null,
  )
}

function insertRefund(
  raw: any,
  override: {
    id?: string
    orderId?: string
    requestKeyHash?: string
    amountMicros?: number
  } = {},
): void {
  raw.prepare(`
    INSERT INTO payment_refunds (
      id, order_id, request_key_hash, provider_key, amount_micros, currency,
      status, reason, requested_by_user_id, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 'stripe-primary', ?, 'USD', 'requested', 'customer request', 'user-1', 6, 6)
  `).run(
    override.id ?? 'refund-1',
    override.orderId ?? 'order-1',
    override.requestKeyHash ?? 'a'.repeat(64),
    override.amountMicros ?? 1_000_000,
  )
}

function insertEvent(
  raw: any,
  override: {
    id?: string
    orderId?: string
    sourceId?: string
  } = {},
): void {
  raw.prepare(`
    INSERT INTO payment_events (
      id, order_id, event_type, source_type, source_id,
      payload_json, occurred_at_ms, created_at_ms
    ) VALUES (?, ?, 'ORDER_CREATED', 'api', ?, '{}', 7, 7)
  `).run(
    override.id ?? 'event-1',
    override.orderId ?? 'order-1',
    override.sourceId ?? 'request-1',
  )
}
