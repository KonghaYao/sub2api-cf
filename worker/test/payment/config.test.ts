import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'

import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import {
  createPaymentProvider,
  deletePaymentProvider,
  getAdminPaymentConfig,
  getPaymentConfig,
  getPaymentCheckoutInfo,
  getPaymentLimits,
  isPaymentEnabled,
  listPaymentProviders,
  paymentProviderCredentialAad,
  requireActiveStripeProvider,
  requireStripeProviderForExistingOrder,
  updateAdminPaymentConfig,
  updatePaymentProvider,
} from '../../src/payment/config'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

interface Harness {
  app: Hono<{ Bindings: Env }>
  env: Env
  raw: any
  authorization: string
}

const PEPPER = 'payment-config-pepper-value-at-least-32-bytes'

async function harness(): Promise<Harness> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  const accessToken = createOpaqueToken('access')
  const refreshToken = createOpaqueToken('refresh')
  raw.prepare(
    `INSERT INTO users (id, email, created_at_ms, updated_at_ms) VALUES ('buyer', 'buyer@example.test', ?, ?)`,
  ).run(now, now)
  raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms
     ) VALUES ('buyer-session', 'buyer-family', 'buyer', 1, ?, ?, ?, ?, ?)`,
  ).run(
    await tokenDigest(accessToken, PEPPER, 'access'),
    await tokenDigest(refreshToken, PEPPER, 'refresh'),
    now,
    now + 86_400_000,
    now + 2 * 86_400_000,
  )
  const env: Env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: d1,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  }
  const app = new Hono<{ Bindings: Env }>()
  app.get('/payment/config', getPaymentConfig)
  app.get('/payment/checkout-info', getPaymentCheckoutInfo)
  app.get('/payment/limits', getPaymentLimits)
  app.get('/admin/payment/providers', listPaymentProviders)
  app.post('/admin/payment/providers', createPaymentProvider)
  app.put('/admin/payment/providers/:id', updatePaymentProvider)
  app.delete('/admin/payment/providers/:id', deletePaymentProvider)
  app.get('/admin/payment/config', getAdminPaymentConfig)
  app.put('/admin/payment/config', updateAdminPaymentConfig)
  return { app, env, raw, authorization: `Bearer ${accessToken}` }
}

async function json(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>
}

describe('payment configuration', () => {
  let subject: Harness

  beforeEach(async () => {
    subject = await harness()
  })

  it('returns the disabled D1 defaults using the legacy user contract', async () => {
    const unauthorized = await subject.app.request('/payment/config', {}, subject.env)
    expect(unauthorized.status).toBe(401)
    const response = await subject.app.request('/payment/config', {
      headers: { authorization: subject.authorization },
    }, subject.env)

    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({
      code: 0,
      data: {
        payment_enabled: false,
        enabled: false,
        min_amount: 0,
        max_amount: 0,
        daily_limit: 0,
        order_timeout_minutes: 30,
        max_pending_orders: 3,
        enabled_payment_types: [],
        balance_disabled: true,
        balance_recharge_multiplier: 1,
        subscription_usd_to_cny_rate: 0,
        recharge_fee_rate: 0,
        load_balance_strategy: 'round_robin',
        cancel_rate_limit_enabled: false,
        cancel_rate_limit_max: 10,
        cancel_rate_limit_window: 1,
        cancel_rate_limit_unit: 'day',
        cancel_rate_limit_window_mode: 'rolling',
        product_name_prefix: '',
        product_name_suffix: '',
        help_image_url: '',
        help_text: '',
        stripe_publishable_key: '',
      },
    })
    expect(subject.raw.prepare(
      `SELECT balance_disabled FROM payment_config WHERE id = 'global'`,
    ).get()).toEqual({ balance_disabled: 0 })
    const admin = await subject.app.request('/admin/payment/config', {}, subject.env)
    expect((await json(admin)).data).toMatchObject({
      balance_disabled: true,
      balance_disabled_configured: false,
      balance_checkout_available: false,
    })
  })

  it('advertises Stripe-compatible order expiry without overwriting the configured value', async () => {
    subject.raw.prepare(
      `UPDATE payment_config SET order_timeout_minutes = 1 WHERE id = 'global'`,
    ).run()
    const headers = { authorization: subject.authorization }
    const publicResponse = await subject.app.request('/payment/config', { headers }, subject.env)
    expect((await json(publicResponse)).data.order_timeout_minutes).toBe(30)
    const admin = await subject.app.request('/admin/payment/config', {}, subject.env)
    expect((await json(admin)).data).toMatchObject({
      order_timeout_minutes: 30,
      order_timeout_minutes_configured: 1,
    })
    expect(subject.raw.prepare(
      `SELECT order_timeout_minutes FROM payment_config WHERE id = 'global'`,
    ).get()).toEqual({ order_timeout_minutes: 1 })
  })

  it('creates and lists only encrypted, redacted Stripe provider configuration', async () => {
    const request = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'stripe-provider-create-0001',
      },
      body: JSON.stringify({
        provider_key: 'stripe',
        name: 'Stripe primary',
        enabled: true,
        supported_types: ['card', 'link'],
        payment_mode: 'embedded',
        limits: JSON.stringify({ stripe: { singleMin: 1, singleMax: 500, dailyLimit: 1_000 } }),
        refund_enabled: true,
        allow_user_refund: true,
        config: {
          secret_key: 'sk_test_private',
          webhook_secret: 'whsec_private',
          publishable_key: 'pk_test_public',
        },
      }),
    }

    const created = await subject.app.request('/admin/payment/providers', request, subject.env)
    const replay = await subject.app.request('/admin/payment/providers', request, subject.env)
    expect(created.status).toBe(201)
    expect(replay.status).toBe(200)
    expect(await json(replay)).toEqual(await json(created.clone()))

    const listed = await subject.app.request('/admin/payment/providers', {}, subject.env)
    const body = await json(listed)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      provider_key: 'stripe',
      provider_type: 'stripe',
      name: 'Stripe primary',
      supported_types: ['card', 'link'],
      enabled: true,
      payment_mode: 'embedded',
      refund_enabled: true,
      allow_user_refund: true,
      config: {
        secret_key_configured: true,
        webhook_secret_configured: true,
        publishable_key: 'pk_test_public',
      },
      version: 0,
    })
    expect(JSON.stringify(body)).not.toContain('sk_test_private')
    expect(JSON.stringify(body)).not.toContain('whsec_private')

    const runtime = await requireActiveStripeProvider(subject.env)
    expect(runtime).toMatchObject({
      provider_key: 'stripe',
      provider_type: 'stripe',
      secret_key: 'sk_test_private',
      webhook_secret: 'whsec_private',
      publishable_key: 'pk_test_public',
      refund_enabled: true,
      allow_user_refund: true,
      payment_mode: 'embedded',
      supported_types: ['card', 'link'],
    })
    expect(paymentProviderCredentialAad('test', runtime.id, 'primary', 0)).toBe(
      `sub2api/payment-provider/v1/test/${runtime.id}/primary/0`,
    )
  })

  it('updates the global config with idempotency and optimistic concurrency', async () => {
    const missingPrecondition = await subject.app.request('/admin/payment/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'payment-config-update-0001',
      },
      body: JSON.stringify({ enabled: true }),
    }, subject.env)
    expect(missingPrecondition.status).toBe(428)

    const request = {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'payment-config-update-0001',
        'if-match': '"0"',
      },
      body: JSON.stringify({
        enabled: true,
        min_amount: 1.25,
        max_amount: 500,
        daily_limit: 1_000,
        order_timeout_minutes: 45,
        max_pending_orders: 5,
        balance_disabled: true,
        balance_recharge_multiplier: 1.1,
        subscription_usd_to_cny_rate: 7.2,
        recharge_fee_rate: 2.5,
        product_name_prefix: 'Sub2API ',
        product_name_suffix: ' plan',
        help_image_url: 'https://example.com/help.png',
        help_text: 'Contact support',
      }),
    }
    const updated = await subject.app.request('/admin/payment/config', request, subject.env)
    const replay = await subject.app.request('/admin/payment/config', request, subject.env)
    expect(updated.status).toBe(200)
    expect(updated.headers.get('etag')).toBe('"1"')
    expect(await json(replay)).toEqual(await json(updated.clone()))

    const publicResponse = await subject.app.request('/payment/config', {
      headers: { authorization: subject.authorization },
    }, subject.env)
    expect((await json(publicResponse)).data).toMatchObject({
      payment_enabled: true,
      min_amount: 1.25,
      max_amount: 500,
      daily_limit: 1_000,
      balance_disabled: true,
      balance_recharge_multiplier: 1.1,
      subscription_usd_to_cny_rate: 7.2,
      recharge_fee_rate: 2.5,
      help_image_url: 'https://example.com/help.png',
    })

    const stale = await subject.app.request('/admin/payment/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'payment-config-update-0002',
        'if-match': '"0"',
      },
      body: JSON.stringify({ enabled: false }),
    }, subject.env)
    expect(stale.status).toBe(412)
    expect((await json(stale)).code).toBe('payment_config_version_conflict')
  })

  it('persists configured payment types with explicit empty, omit, typed validation, and CAS semantics', async () => {
    await subject.app.request('/admin/payment/providers', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'payment-types-provider-create',
      },
      body: JSON.stringify({
        provider_key: 'stripe',
        name: 'Stripe payment types',
        enabled: true,
        config: {
          secret_key: 'sk_test_types',
          webhook_secret: 'whsec_types',
          publishable_key: 'pk_test_types',
        },
      }),
    }, subject.env)

    const selectStripe = await subject.app.request('/admin/payment/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'payment-types-select-stripe',
        'if-match': '"0"',
      },
      body: JSON.stringify({ enabled_payment_types: ['stripe'] }),
    }, subject.env)
    expect(selectStripe.status).toBe(200)
    expect((await json(selectStripe)).data).toMatchObject({
      enabled_payment_types: ['stripe'],
      control_version: 1,
    })

    const enableWithoutTypes = await subject.app.request('/admin/payment/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'payment-types-enable-omit',
        'if-match': '"1"',
      },
      body: JSON.stringify({ enabled: true }),
    }, subject.env)
    expect(enableWithoutTypes.status).toBe(200)
    expect((await json(enableWithoutTypes)).data.enabled_payment_types).toEqual(['stripe'])

    const publicSelected = await subject.app.request('/payment/config', {
      headers: { authorization: subject.authorization },
    }, subject.env)
    expect((await json(publicSelected)).data).toMatchObject({
      payment_enabled: true,
      enabled_payment_types: ['stripe'],
      stripe_publishable_key: 'pk_test_types',
    })

    const clearTypes = await subject.app.request('/admin/payment/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'payment-types-clear',
        'if-match': '"2"',
      },
      body: JSON.stringify({ enabled_payment_types: [] }),
    }, subject.env)
    expect(clearTypes.status).toBe(200)
    expect((await json(clearTypes)).data).toMatchObject({
      enabled_payment_types: [],
      control_version: 3,
    })

    const updateWithoutTypes = await subject.app.request('/admin/payment/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'payment-types-update-omit',
        'if-match': '"3"',
      },
      body: JSON.stringify({ min_amount: 2 }),
    }, subject.env)
    expect(updateWithoutTypes.status).toBe(200)
    expect((await json(updateWithoutTypes)).data.enabled_payment_types).toEqual([])

    const adminReload = await subject.app.request('/admin/payment/config', {}, subject.env)
    expect((await json(adminReload)).data).toMatchObject({
      enabled_payment_types: [],
      min_amount: 2,
      control_version: 4,
    })
    expect(subject.raw.prepare(
      `SELECT enabled_payment_types_json FROM payment_config WHERE id = 'global'`,
    ).get()).toEqual({ enabled_payment_types_json: '[]' })

    const publicCleared = await subject.app.request('/payment/config', {
      headers: { authorization: subject.authorization },
    }, subject.env)
    expect((await json(publicCleared)).data).toMatchObject({
      payment_enabled: true,
      enabled_payment_types: [],
      stripe_publishable_key: '',
    })
    await expect(isPaymentEnabled(subject.env)).resolves.toBe(false)

    const limitsCleared = await subject.app.request('/payment/limits', {
      headers: { authorization: subject.authorization },
    }, subject.env)
    expect((await json(limitsCleared)).data).toMatchObject({
      methods: {},
      global_min: 0,
      global_max: 0,
    })

    const unsupported = await subject.app.request('/admin/payment/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'payment-types-unsupported',
        'if-match': '"4"',
      },
      body: JSON.stringify({ enabled_payment_types: ['stripe', 'airwallex'] }),
    }, subject.env)
    expect(unsupported.status).toBe(400)
    expect((await json(unsupported)).code).toBe('unsupported_payment_type')

    const stale = await subject.app.request('/admin/payment/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'payment-types-stale',
        'if-match': '"3"',
      },
      body: JSON.stringify({ enabled_payment_types: ['stripe'] }),
    }, subject.env)
    expect(stale.status).toBe(412)
    expect((await json(stale)).code).toBe('payment_config_version_conflict')

    const afterFailures = await subject.app.request('/admin/payment/config', {}, subject.env)
    expect((await json(afterFailures)).data).toMatchObject({
      enabled_payment_types: [],
      control_version: 4,
    })
  })

  it('preserves blank secrets, protects identities with orders, and safely disables on delete', async () => {
    const create = await subject.app.request('/admin/payment/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'provider-lifecycle-create' },
      body: JSON.stringify({
        provider_key: 'stripe',
        name: 'Stripe primary',
        enabled: true,
        config: {
          secretKey: 'sk_test_original',
          webhookSecret: 'whsec_original',
          publishableKey: 'pk_test_original',
        },
        supported_types: ['stripe'],
      }),
    }, subject.env)
    const provider = (await json(create)).data

    const update = await subject.app.request(`/admin/payment/providers/${provider.id}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'provider-lifecycle-update',
        'if-match': '"0"',
      },
      body: JSON.stringify({
        name: 'Stripe renamed',
        config: { secret_key: '', webhook_secret: '', publishable_key: 'pk_test_rotated' },
        refund_enabled: true,
      }),
    }, subject.env)
    expect(update.status).toBe(200)
    expect((await json(update)).data).toMatchObject({ name: 'Stripe renamed', version: 1 })
    expect(await requireActiveStripeProvider(subject.env, provider.id)).toMatchObject({
      secret_key: 'sk_test_original',
      webhook_secret: 'whsec_original',
      publishable_key: 'pk_test_rotated',
    })

    const now = Date.now()
    subject.raw.prepare(
      `INSERT INTO users (id, email, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)`,
    ).run('buyer-1', 'buyer@example.com', now, now)
    subject.raw.prepare(
      `INSERT INTO payment_orders (
         id, user_id, provider_instance_id, provider_key_snapshot, out_trade_no,
         idempotency_key_hash, request_hash, order_type, status, amount_micros,
         pay_amount_micros, fee_ppm_snapshot, paid_amount_micros, refunded_amount_micros, currency,
         expires_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 'stripe', ?, ?, ?, 'balance', 'PENDING', 1000000, 1000000, 0, 0, 0, 'USD', ?, ?, ?)`,
    ).run('order-1', 'buyer-1', provider.id, 'trade-1', 'a'.repeat(64), 'b'.repeat(64), now + 60_000, now, now)

    const rotateIdentity = await subject.app.request(`/admin/payment/providers/${provider.id}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'provider-lifecycle-rotate',
        'if-match': '"1"',
      },
      body: JSON.stringify({ config: { secret_key: 'sk_test_different' } }),
    }, subject.env)
    expect(rotateIdentity.status).toBe(409)
    expect((await json(rotateIdentity)).code).toBe('payment_provider_identity_in_use')

    const blockedDisable = await subject.app.request(`/admin/payment/providers/${provider.id}`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'provider-lifecycle-disable',
        'if-match': '"1"',
      },
      body: JSON.stringify({ expected_version: 1 }),
    }, subject.env)
    expect(blockedDisable.status).toBe(409)
    expect((await json(blockedDisable)).code).toBe('payment_provider_orders_in_progress')

    subject.raw.prepare(
      `UPDATE payment_orders SET status = 'COMPLETED', updated_at_ms = ? WHERE id = 'order-1'`,
    ).run(now + 1)
    const disabled = await subject.app.request(`/admin/payment/providers/${provider.id}`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'provider-lifecycle-disable-terminal',
        'if-match': '"1"',
      },
      body: JSON.stringify({ expected_version: 1 }),
    }, subject.env)
    expect(disabled.status).toBe(200)
    expect((await json(disabled)).data).toMatchObject({ enabled: false, version: 2 })
    await expect(requireActiveStripeProvider(subject.env, provider.id)).rejects.toMatchObject({
      code: 'stripe_provider_unavailable',
    })
    await expect(requireStripeProviderForExistingOrder(subject.env, provider.id)).resolves.toMatchObject({
      id: provider.id,
      provider_type: 'stripe',
      secret_key: 'sk_test_original',
      webhook_secret: 'whsec_original',
      publishable_key: 'pk_test_rotated',
    })
  })

  it('returns authenticated Stripe limits and checkout info with public plans', async () => {
    await subject.app.request('/admin/payment/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'checkout-provider-create' },
      body: JSON.stringify({
        provider_key: 'stripe',
        name: 'Stripe checkout',
        enabled: true,
        config: {
          secret_key: 'sk_test_checkout',
          webhook_secret: 'whsec_checkout',
          publishable_key: 'pk_test_checkout',
        },
        limits: { stripe: { singleMin: 2, singleMax: 250, dailyLimit: 400 } },
      }),
    }, subject.env)
    await subject.app.request('/admin/payment/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'checkout-config-enable',
        'if-match': '"0"',
      },
      body: JSON.stringify({
        enabled: true,
        enabled_payment_types: ['stripe'],
        balance_disabled: true,
        balance_recharge_multiplier: 1.2,
        subscription_usd_to_cny_rate: 7,
        recharge_fee_rate: 1.5,
        help_text: 'Pay securely',
      }),
    }, subject.env)

    const now = Date.now()
    subject.raw.prepare(
      `INSERT INTO "groups" (
         id, name, platform, enabled, group_type, is_exclusive, created_at_ms, updated_at_ms
       ) VALUES ('stripe-plan-group', 'Stripe Subscribers', 'openai', 1, 'subscription', 1, ?, ?)`,
    ).run(now, now)
    subject.raw.prepare(
      `INSERT INTO subscription_plans (
         id, group_id, name, description, validity_days, price_micros, currency,
         daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
         enabled, sort_order, created_at_ms, updated_at_ms
       ) VALUES (
         'stripe-plan-eur', 'stripe-plan-group', 'Stripe Euro', 'Unsupported currency',
         30, 12500000, 'EUR', 5000000, 20000000, 60000000, 1, 1, ?, ?
       )`,
    ).run(now, now)
    subject.raw.prepare(
      `INSERT INTO subscription_plans (
         id, group_id, name, description, validity_days, price_micros, currency,
         daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
         enabled, sort_order, created_at_ms, updated_at_ms
       ) VALUES (
         'stripe-plan', 'stripe-plan-group', 'Stripe Pro', 'Pro plan', 30, 12500000, 'USD',
         5000000, 20000000, 60000000, 1, 0, ?, ?
       )`,
    ).run(now, now)

    const headers = { authorization: subject.authorization }
    const limits = await subject.app.request('/payment/limits', { headers }, subject.env)
    expect(limits.status).toBe(200)
    expect((await json(limits)).data).toEqual({
      methods: {
        stripe: {
          currency: 'USD',
          display_name: 'Stripe checkout',
          daily_limit: 400,
          daily_used: 0,
          daily_remaining: 400,
          single_min: 2,
          single_max: 250,
          fee_rate: 1.5,
          available: true,
        },
      },
      global_min: 2,
      global_max: 250,
    })

    const checkout = await subject.app.request('/payment/checkout-info', { headers }, subject.env)
    expect(checkout.status).toBe(200)
    expect((await json(checkout)).data).toMatchObject({
      methods: { stripe: { available: true, currency: 'USD' } },
      global_min: 2,
      global_max: 250,
      balance_disabled: true,
      balance_recharge_multiplier: 1.2,
      subscription_usd_to_cny_rate: 7,
      recharge_fee_rate: 1.5,
      help_text: 'Pay securely',
      stripe_publishable_key: 'pk_test_checkout',
      plans: [{
        id: 'stripe-plan',
        group_id: 'stripe-plan-group',
        group_name: 'Stripe Subscribers',
        group_platform: 'openai',
        name: 'Stripe Pro',
        price: 12.5,
        price_micros: 12_500_000,
        currency: 'USD',
        validity_days: 30,
        validity_unit: 'days',
        features: [],
        for_sale: true,
      }],
    })

    expect(subject.raw.prepare(
      `SELECT balance_disabled FROM payment_config WHERE id = 'global'`,
    ).get()).toEqual({ balance_disabled: 1 })
  })

  it('reports payment enabled only when both the global switch and a Stripe provider are active', async () => {
    await expect(isPaymentEnabled(subject.env)).resolves.toBe(false)

    await subject.app.request('/admin/payment/config', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'effective-payment-config-enable',
        'if-match': '"0"',
      },
      body: JSON.stringify({ enabled: true, enabled_payment_types: ['stripe'] }),
    }, subject.env)
    await expect(isPaymentEnabled(subject.env)).resolves.toBe(false)

    const created = await subject.app.request('/admin/payment/providers', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'effective-payment-provider-create',
      },
      body: JSON.stringify({
        provider_key: 'stripe',
        name: 'Stripe standby',
        enabled: false,
        config: { secret_key: 'sk_test', webhook_secret: 'whsec_test' },
      }),
    }, subject.env)
    const provider = (await json(created)).data
    await expect(isPaymentEnabled(subject.env)).resolves.toBe(false)

    await subject.app.request(`/admin/payment/providers/${provider.id}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'effective-payment-provider-enable',
      },
      body: JSON.stringify({ enabled: true, expected_version: 0 }),
    }, subject.env)
    await expect(isPaymentEnabled(subject.env)).resolves.toBe(true)
  })
})
