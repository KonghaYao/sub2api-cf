import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { deterministicUuid } from '../../src/control/http'
import type { Env } from '../../src/env'
import { sha256Hex } from '../../src/gateway/crypto'
import {
  getUserSubscriptionProgress,
  getUserSubscriptionSummary,
  listActiveUserSubscriptions,
  listUserSubscriptionProgress,
  listUserSubscriptions,
} from '../../src/user/subscriptions'
import {
  listUserRedemptions,
  redeemCode,
  redeemCodeDigest,
} from '../../src/user/redeem'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'commerce-test-pepper-value-at-least-32-bytes'
const DAY_MS = 86_400_000
const MAX_SAFE_INTEGER = 9_007_199_254_740_991
const MAX_DATE_MS = 8_640_000_000_000_000

interface Fixture {
  raw: any
  env: Env
  authorization: Record<'alice' | 'bob', string>
  balanceAdjustments: Map<string, number>
  subscriptionState: SubscriptionStateFake
}

class SubscriptionStateFake {
  calls: Array<{ subscriptionId: string; path: string; body: Record<string, unknown> }> = []
  failuresByPath = new Map<string, number>()

  namespace(): DurableObjectNamespace {
    return {
      idFromName: (name: string) => name,
      get: (subscriptionId: string) => ({
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname
          const body = await request.json() as Record<string, unknown>
          this.calls.push({ subscriptionId, path, body })
          const failures = this.failuresByPath.get(path) ?? 0
          if (failures > 0) {
            this.failuresByPath.set(path, failures - 1)
            throw new Error('simulated subscription state network failure')
          }
          return Response.json({ schema_version: 1, idempotent: false })
        },
      }),
    } as unknown as DurableObjectNamespace
  }
}

let now = Date.now()

beforeEach(() => {
  now = Date.now()
})

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  for (const [id, email, balance] of [
    ['alice', 'alice@example.test', 5_000_000],
    ['bob', 'bob@example.test', 7_000_000],
  ] as const) {
    raw.prepare(
      `INSERT INTO users (id, email, display_name, balance_micros, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, email, id, balance, now, now)
  }
  raw.prepare(
    `INSERT INTO "groups" (
       id, name, platform, enabled, group_type, is_exclusive, created_at_ms, updated_at_ms
     ) VALUES ('subscription-pro', 'Pro', 'openai', 1, 'subscription', 1, ?, ?)`,
  ).run(now, now)
  raw.prepare(
    `INSERT INTO "groups" (
       id, name, platform, enabled, group_type, is_exclusive, created_at_ms, updated_at_ms
     ) VALUES ('standard', 'Standard', 'openai', 1, 'standard', 0, ?, ?)`,
  ).run(now, now)
  raw.prepare(
    `INSERT INTO "groups" (
       id, name, platform, enabled, group_type, is_exclusive, created_at_ms, updated_at_ms
     ) VALUES ('subscription-old', 'Old plan', 'openai', 1, 'subscription', 1, ?, ?)`,
  ).run(now, now)

  const authorization = {} as Fixture['authorization']
  for (const userId of ['alice', 'bob'] as const) {
    const accessToken = createOpaqueToken('access')
    const refreshToken = createOpaqueToken('refresh')
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      `session-${userId}`,
      `family-${userId}`,
      userId,
      await tokenDigest(accessToken, PEPPER, 'access'),
      await tokenDigest(refreshToken, PEPPER, 'refresh'),
      now,
      now + DAY_MS,
      now + 30 * DAY_MS,
    )
    authorization[userId] = `Bearer ${accessToken}`
  }
  const balanceAdjustments = new Map<string, number>()
  const subscriptionState = new SubscriptionStateFake()
  return {
    raw,
    authorization,
    balanceAdjustments,
    subscriptionState,
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      ASSETS: {} as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      USER_STATE: fakeUserStateNamespace(raw, balanceAdjustments),
      SUBSCRIPTION_STATE: subscriptionState.namespace(),
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

function app(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  app.get('/subscriptions', listUserSubscriptions)
  app.get('/subscriptions/active', listActiveUserSubscriptions)
  app.get('/subscriptions/progress', listUserSubscriptionProgress)
  app.get('/subscriptions/summary', getUserSubscriptionSummary)
  app.get('/subscriptions/:id/progress', getUserSubscriptionProgress)
  app.post('/redeem', redeemCode)
  app.get('/redeem/history', listUserRedemptions)
  return app
}

function seedSubscription(
  raw: any,
  input: {
    id: string
    userId: string
    groupId?: string
    status?: string
    startsAt?: number
    expiresAt?: number
  },
): void {
  const startsAt = input.startsAt ?? now - DAY_MS
  const expiresAt = input.expiresAt ?? now + 10 * DAY_MS
  raw.prepare(
    `INSERT INTO user_subscriptions (
       id, user_id, group_id, status, starts_at_ms, expires_at_ms,
       daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
       daily_used_micros, weekly_used_micros, monthly_used_micros,
       daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
       source_type, source_id, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, 10000000, 50000000, NULL,
               2500000, 10000000, 12000000, ?, ?, ?, 'admin', ?, ?, ?)`,
  ).run(
    input.id,
    input.userId,
    input.groupId ?? 'subscription-pro',
    input.status ?? 'active',
    startsAt,
    expiresAt,
    Math.floor(now / DAY_MS) * DAY_MS,
    now - DAY_MS,
    now - 10 * DAY_MS,
    `seed-${input.id}`,
    startsAt,
    startsAt,
  )
}

describe('commerce migration rollout', () => {
  it('defaults groups to exclusive and preserves access already represented by API keys', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 10)
    raw.exec(`
      INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
      VALUES
        ('legacy-alice', 'legacy-alice@example.test', 'Alice', 1, 1),
        ('legacy-bob', 'legacy-bob@example.test', 'Bob', 1, 1);
      INSERT INTO "groups" (id, name, platform, created_at_ms, updated_at_ms)
      VALUES
        ('legacy-bound', 'Legacy bound', 'openai', 1, 1),
        ('legacy-unbound', 'Legacy unbound', 'openai', 1, 1);
      INSERT INTO api_keys (
        id, user_id, key_hash, group_id, created_at_ms, updated_at_ms
      ) VALUES
        ('alice-later', 'legacy-alice', '${'a'.repeat(64)}', 'legacy-bound', 300, 300),
        ('alice-earlier', 'legacy-alice', '${'b'.repeat(64)}', 'legacy-bound', 100, 100),
        ('bob-key', 'legacy-bob', '${'c'.repeat(64)}', 'legacy-bound', 200, 200);
    `)

    applyMigrations(raw)
    raw.prepare(
      `INSERT INTO "groups" (id, name, platform, created_at_ms, updated_at_ms)
       VALUES ('post-migration', 'Post migration', 'openai', 400, 400)`,
    ).run()

    expect(raw.prepare(
      `SELECT id, is_exclusive FROM "groups" ORDER BY id`,
    ).all()).toEqual([
      { id: 'legacy-bound', is_exclusive: 1 },
      { id: 'legacy-unbound', is_exclusive: 1 },
      { id: 'post-migration', is_exclusive: 1 },
    ])
    expect(raw.prepare(
      `SELECT user_id, group_id, created_at_ms
         FROM user_group_permissions ORDER BY user_id`,
    ).all()).toEqual([
      { user_id: 'legacy-alice', group_id: 'legacy-bound', created_at_ms: 100 },
      { user_id: 'legacy-bob', group_id: 'legacy-bound', created_at_ms: 200 },
    ])
  })

  it('keeps standard groups quota-free and prevents downgrading referenced subscription groups', async () => {
    const test = await fixture()

    expect(() => test.raw.prepare(
      `UPDATE "groups" SET daily_quota_micros = 1 WHERE id = 'standard'`,
    ).run()).toThrow(/invalid_group_standard_subscription_quota/)

    test.raw.prepare(
      `INSERT INTO subscription_plans (
         id, group_id, name, validity_days, created_at_ms, updated_at_ms
       ) VALUES ('pro-plan', 'subscription-pro', 'Pro plan', 30, ?, ?)`,
    ).run(now, now)
    await seedRedeemCode(test.raw, 'OLD-SUBSCRIPTION-CODE', {
      id: 'old-subscription-code',
      type: 'subscription',
      groupId: 'subscription-old',
    })
    test.raw.prepare(
      `INSERT INTO "groups" (
         id, name, platform, group_type, created_at_ms, updated_at_ms
       ) VALUES ('subscription-entitlement', 'Entitlement', 'openai', 'subscription', ?, ?)`,
    ).run(now, now)
    seedSubscription(test.raw, {
      id: 'referenced-entitlement',
      userId: 'alice',
      groupId: 'subscription-entitlement',
    })

    for (const groupId of [
      'subscription-pro',
      'subscription-old',
      'subscription-entitlement',
    ]) {
      expect(() => test.raw.prepare(
        `UPDATE "groups" SET group_type = 'standard' WHERE id = ?`,
      ).run(groupId)).toThrow(/invalid_group_has_subscription_relations/)
    }
  })

  it('keeps subscription plans and events aligned with their entitlement identity', async () => {
    const test = await fixture()
    test.raw.prepare(
      `INSERT INTO subscription_plans (
         id, group_id, name, validity_days, created_at_ms, updated_at_ms
       ) VALUES ('pro-plan', 'subscription-pro', 'Pro plan', 30, ?, ?)`,
    ).run(now, now)
    seedSubscription(test.raw, { id: 'alice-plan-subscription', userId: 'alice' })

    expect(() => test.raw.prepare(
      `UPDATE user_subscriptions
          SET plan_id = 'pro-plan', group_id = 'subscription-old'
        WHERE id = 'alice-plan-subscription'`,
    ).run()).toThrow(/user_subscription_plan_group_mismatch/)

    test.raw.prepare(
      `UPDATE user_subscriptions SET plan_id = 'pro-plan'
        WHERE id = 'alice-plan-subscription'`,
    ).run()
    expect(() => test.raw.prepare(
      `UPDATE subscription_plans SET group_id = 'subscription-old'
        WHERE id = 'pro-plan'`,
    ).run()).toThrow(/subscription_plan_group_in_use/)

    test.raw.prepare(
      `INSERT INTO subscription_events (
         id, subscription_id, user_id, group_id, event_type,
         source_type, source_id, occurred_at_ms
       ) VALUES ('valid-event', 'alice-plan-subscription', 'alice',
                 'subscription-pro', 'assigned', 'admin', 'seed-event', ?)`,
    ).run(now)
    expect(() => test.raw.prepare(
      `INSERT INTO subscription_events (
         id, subscription_id, user_id, group_id, event_type,
         source_type, source_id, occurred_at_ms
       ) VALUES ('wrong-event', 'alice-plan-subscription', 'bob',
                 'subscription-old', 'assigned', 'admin', 'wrong-event', ?)`,
    ).run(now)).toThrow(/subscription_event_identity_mismatch/)
    expect(() => test.raw.prepare(
      `UPDATE subscription_events SET user_id = 'bob' WHERE id = 'valid-event'`,
    ).run()).toThrow(/subscription_event_identity_mismatch/)
  })

  it('rejects commerce amounts outside JS safe integers and timestamps outside the Date range', async () => {
    const test = await fixture()
    const unsafeInteger = '9007199254740992'
    const invalidDate = '8640000000000001'

    expect(() => test.raw.exec(
      `UPDATE "groups" SET daily_quota_micros = ${unsafeInteger}
        WHERE id = 'subscription-pro'`,
    )).toThrow(/CHECK constraint failed/)
    expect(() => test.raw.exec(
      `INSERT INTO subscription_plans (
         id, group_id, name, validity_days, price_micros, created_at_ms, updated_at_ms
       ) VALUES ('unsafe-plan', 'subscription-pro', 'Unsafe', 30,
                 ${unsafeInteger}, ${now}, ${now})`,
    )).toThrow(/CHECK constraint failed/)

    seedSubscription(test.raw, { id: 'bounded-subscription', userId: 'alice' })
    expect(() => test.raw.exec(
      `UPDATE user_subscriptions SET monthly_used_micros = ${unsafeInteger}
        WHERE id = 'bounded-subscription'`,
    )).toThrow(/CHECK constraint failed/)
    expect(() => test.raw.exec(
      `UPDATE user_subscriptions SET expires_at_ms = ${invalidDate}
        WHERE id = 'bounded-subscription'`,
    )).toThrow(/invalid_subscription_timestamp/)

    expect(() => test.raw.exec(
      `INSERT INTO redeem_codes (
         id, code_hash, code_prefix, type, value_micros, status,
         created_at_ms, updated_at_ms
       ) VALUES ('unsafe-code', '${'d'.repeat(64)}', 'UNSA', 'balance',
                 ${unsafeInteger}, 'unused', ${now}, ${now})`,
    )).toThrow(/CHECK constraint failed/)
    expect(() => test.raw.exec(
      `INSERT INTO subscription_events (
         id, subscription_id, user_id, group_id, event_type,
         source_type, source_id, occurred_at_ms
       ) VALUES ('invalid-date-event', 'bounded-subscription', 'alice',
                 'subscription-pro', 'assigned', 'admin', 'invalid-date', ${invalidDate})`,
    )).toThrow(/CHECK constraint failed/)

    test.raw.prepare(
      `UPDATE "groups" SET daily_quota_micros = ? WHERE id = 'subscription-pro'`,
    ).run(MAX_SAFE_INTEGER)
    test.raw.prepare(
      `INSERT INTO subscription_events (
         id, subscription_id, user_id, group_id, event_type,
         source_type, source_id, occurred_at_ms
       ) VALUES ('boundary-event', 'bounded-subscription', 'alice',
                 'subscription-pro', 'assigned', 'admin', 'boundary-date', ?)`,
    ).run(MAX_DATE_MS)
    expect(test.raw.prepare(
      `SELECT daily_quota_micros FROM "groups" WHERE id = 'subscription-pro'`,
    ).get()).toEqual({ daily_quota_micros: MAX_SAFE_INTEGER })
    expect(test.raw.prepare(
      `SELECT occurred_at_ms FROM subscription_events WHERE id = 'boundary-event'`,
    ).get()).toEqual({ occurred_at_ms: MAX_DATE_MS })
  })

  it('requires both sides of a processing claim to exist before redemption closeout', async () => {
    const test = await fixture()
    await seedRedeemCode(test.raw, 'ORPHANED-CLOSEOUT', {
      id: 'orphaned-closeout-code',
      type: 'balance',
      valueMicros: 1_000_000,
    })
    test.raw.prepare(
      `UPDATE redeem_codes
          SET status = 'processing', used_by_user_id = 'alice',
              claimed_by_redemption_id = 'missing-redemption', used_at_ms = ?
        WHERE id = 'orphaned-closeout-code'`,
    ).run(now)
    expect(() => test.raw.prepare(
      `UPDATE redeem_codes SET status = 'used'
        WHERE id = 'orphaned-closeout-code'`,
    ).run()).toThrow(/redemption_claim_missing/)

    await seedRedeemCode(test.raw, 'EARLY-CLOSEOUT', {
      id: 'early-closeout-code',
      type: 'balance',
      valueMicros: 2_000_000,
    })
    test.raw.prepare(
      `UPDATE redeem_codes
          SET status = 'processing', used_by_user_id = 'alice',
              claimed_by_redemption_id = 'early-redemption', used_at_ms = ?
        WHERE id = 'early-closeout-code'`,
    ).run(now)
    test.raw.prepare(
      `INSERT INTO redemptions (
         id, code_id, user_id, idempotency_key_hash, status,
         type, value_micros, created_at_ms
       ) VALUES ('early-redemption', 'early-closeout-code', 'alice', ?,
                 'processing', 'balance', 2000000, ?)`,
    ).run('e'.repeat(64), now)
    expect(() => test.raw.prepare(
      `UPDATE redemptions
          SET status = 'completed', result_json = '{}', completed_at_ms = ?
        WHERE id = 'early-redemption'`,
    ).run(now)).toThrow(/redemption_code_not_used/)
  })
})

async function seedRedeemCode(
  raw: any,
  code: string,
  input: {
    id: string
    type: 'balance' | 'subscription'
    valueMicros?: number
    validityDays?: number
    groupId?: string
    status?: 'unused' | 'used' | 'expired'
    expiresAt?: number | null
  },
): Promise<void> {
  raw.prepare(
    `INSERT INTO redeem_codes (
       id, code_hash, code_prefix, type, value_micros, group_id, validity_days,
       status, expires_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    await redeemCodeDigest(code, PEPPER),
    code.slice(0, 4),
    input.type,
    input.valueMicros ?? 0,
    input.type === 'subscription' ? input.groupId ?? 'subscription-pro' : null,
    input.type === 'subscription' ? input.validityDays ?? 30 : null,
    input.status ?? 'unused',
    input.expiresAt ?? null,
    now,
    now,
  )
}

describe('user subscriptions', () => {
  it('requires auth, isolates users, and excludes expired entitlements from active results', async () => {
    const test = await fixture()
    seedSubscription(test.raw, { id: 'alice-active', userId: 'alice' })
    seedSubscription(test.raw, { id: 'bob-active', userId: 'bob' })
    seedSubscription(test.raw, {
      id: 'alice-expired',
      userId: 'alice',
      groupId: 'subscription-old',
      status: 'expired',
      startsAt: now - 10 * DAY_MS,
      expiresAt: now - DAY_MS,
    })

    expect((await app().request('/subscriptions', undefined, test.env)).status).toBe(401)
    const all = await app().request('/subscriptions', {
      headers: { authorization: test.authorization.alice },
    }, test.env)
    const active = await app().request('/subscriptions/active', {
      headers: { authorization: test.authorization.alice },
    }, test.env)

    const allBody = await all.json()
    await expect(Promise.resolve(allBody)).resolves.toMatchObject({
      data: [
        expect.objectContaining({ id: 'alice-active', user_id: 'alice', group_id: 'subscription-pro' }),
        expect.objectContaining({ id: 'alice-expired', status: 'expired' }),
      ],
    })
    await expect(active.json()).resolves.toMatchObject({
      data: [expect.objectContaining({ id: 'alice-active', status: 'active' })],
    })
    expect(JSON.stringify(allBody)).not.toContain('bob-active')
  })

  it('returns quota progress and a dashboard summary using immutable micro-unit values', async () => {
    const test = await fixture()
    seedSubscription(test.raw, { id: 'alice-active', userId: 'alice' })
    test.raw.prepare(
      `UPDATE "groups"
          SET rate_multiplier_ppm = 1250000,
              daily_quota_micros = 999000000,
              weekly_quota_micros = 999000000,
              monthly_quota_micros = 999000000
        WHERE id = 'subscription-pro'`,
    ).run()
    test.raw.prepare(
      `INSERT INTO user_group_rate_overrides (
         user_id, group_id, rate_multiplier_ppm, created_at_ms, updated_at_ms
       ) VALUES ('alice', 'subscription-pro', 750000, ?, ?)`,
    ).run(now, now)
    const headers = { authorization: test.authorization.alice }

    const listed = await app().request('/subscriptions', { headers }, test.env)
    const progress = await app().request('/subscriptions/alice-active/progress', { headers }, test.env)
    const summary = await app().request('/subscriptions/summary', { headers }, test.env)

    await expect(listed.json()).resolves.toMatchObject({
      data: [expect.objectContaining({
        id: 'alice-active',
        group: expect.objectContaining({
          rate_multiplier: 0.75,
          daily_limit_usd: 10,
          weekly_limit_usd: 50,
          monthly_limit_usd: null,
        }),
      })],
    })

    await expect(progress.json()).resolves.toMatchObject({
      data: {
        subscription_id: 'alice-active',
        daily: { used: 2.5, limit: 10, percentage: 25 },
        weekly: { used: 10, limit: 50, percentage: 20 },
        monthly: { used: 12, limit: null, percentage: 0 },
        days_remaining: 10,
      },
    })
    await expect(summary.json()).resolves.toMatchObject({
      data: {
        active_count: 1,
        total_used_usd: 12,
        subscriptions: [expect.objectContaining({
          id: 'alice-active',
          group_name: 'Pro',
          daily_used_usd: 2.5,
          monthly_used_usd: 12,
        })],
      },
    })
  })
})

describe('redeem codes', () => {
  it('atomically credits a balance code and replays the same idempotency key without a second credit', async () => {
    const test = await fixture()
    await seedRedeemCode(test.raw, 'BALANCE-10', {
      id: 'balance-code',
      type: 'balance',
      valueMicros: 10_000_000,
    })
    const request = {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': 'redeem-balance-alice-1',
      },
      body: JSON.stringify({ code: ' balance-10 ' }),
    }

    const first = await app().request('/redeem', request, test.env)
    const replay = await app().request('/redeem', request, test.env)

    expect(first.status).toBe(200)
    const firstBody = await first.json()
    const replayBody = await replay.json()
    await expect(Promise.resolve(firstBody)).resolves.toMatchObject({
      data: { type: 'balance', value: 10, new_balance: 15 },
    })
    expect(replayBody).toEqual(firstBody)
    expect(test.balanceAdjustments.size).toBe(1)
    expect(test.raw.prepare(
      `SELECT status, used_by_user_id FROM redeem_codes WHERE id = 'balance-code'`,
    ).get()).toEqual({ status: 'used', used_by_user_id: 'alice' })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM redemptions').get()).toEqual({ total: 1 })
    expect(JSON.stringify(test.raw.prepare('SELECT * FROM redeem_codes').get())).not.toContain('BALANCE-10')
  })

  it('keeps an uncertain external effect claimed and safely resumes it with the same idempotency key', async () => {
    const test = await fixture()
    await seedRedeemCode(test.raw, 'RETRY-BALANCE', {
      id: 'retry-balance-code',
      type: 'balance',
      valueMicros: 4_000_000,
    })
    const request = {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': 'retry-balance-effect',
      },
      body: JSON.stringify({ code: 'RETRY-BALANCE' }),
    }
    const originalUserState = test.env.USER_STATE
    test.env.USER_STATE = {
      idFromName: (name: string) => originalUserState.idFromName(name),
      get(id: DurableObjectId) {
        const originalStub = originalUserState.get(id)
        return {
          async fetch(request: Request) {
            if (new URL(request.url).pathname === '/balance/adjust') {
              return Response.json(
                { error: { code: 'state_temporarily_unavailable', message: 'retry later' } },
                { status: 503 },
              )
            }
            return originalStub.fetch(request)
          },
        } as DurableObjectStub
      },
    } as unknown as DurableObjectNamespace

    const uncertain = await app().request('/redeem', request, test.env)

    expect(uncertain.status).toBe(503)
    expect(test.raw.prepare(
      `SELECT status, effect_started_at_ms IS NOT NULL AS effect_started
         FROM redemptions WHERE code_id = 'retry-balance-code'`,
    ).get()).toEqual({ status: 'processing', effect_started: 1 })
    expect(() => test.raw.prepare(
      `DELETE FROM redemptions WHERE code_id = 'retry-balance-code'`,
    ).run()).toThrow(/redemption_effect_already_started/)
    expect(() => test.raw.prepare(
      `UPDATE redeem_codes
          SET status = 'unused', used_by_user_id = NULL, claimed_by_redemption_id = NULL
        WHERE id = 'retry-balance-code'`,
    ).run()).toThrow(/redemption_effect_already_started/)

    test.env.USER_STATE = originalUserState
    const resumed = await app().request('/redeem', request, test.env)

    expect(resumed.status).toBe(200)
    await expect(resumed.json()).resolves.toMatchObject({
      data: { type: 'balance', value: 4, new_balance: 9 },
    })
    expect(test.balanceAdjustments.size).toBe(1)
  })

  it('assigns then extends one subscription entitlement exactly once per code', async () => {
    const test = await fixture()
    seedSubscription(test.raw, {
      id: 'alice-subscription',
      userId: 'alice',
      startsAt: now - DAY_MS,
      expiresAt: now + 5 * DAY_MS,
    })
    await seedRedeemCode(test.raw, 'PRO-30-DAYS', {
      id: 'subscription-code',
      type: 'subscription',
      validityDays: 30,
    })
    const request = {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': 'redeem-subscription-alice-1',
      },
      body: JSON.stringify({ code: 'PRO-30-DAYS' }),
    }
    const expectedExpiry = now + 35 * DAY_MS

    const first = await app().request('/redeem', request, test.env)
    const replay = await app().request('/redeem', request, test.env)

    expect(first.status).toBe(200)
    const firstBody = await first.json()
    const replayBody = await replay.json()
    await expect(Promise.resolve(firstBody)).resolves.toMatchObject({
      data: {
        type: 'subscription',
        value: 30,
        subscription_id: 'alice-subscription',
        expires_at: new Date(expectedExpiry).toISOString(),
      },
    })
    expect((test.raw.prepare(
      `SELECT expires_at_ms FROM user_subscriptions WHERE id = 'alice-subscription'`,
    ).get() as { expires_at_ms: number }).expires_at_ms).toBe(expectedExpiry)
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM subscription_events').get()).toEqual({ total: 1 })
    expect(test.raw.prepare(
      `SELECT status, control_version FROM subscription_state_sync
        WHERE subscription_id = 'alice-subscription'`,
    ).get()).toEqual({ status: 'applied', control_version: 1 })
    expect(test.subscriptionState.calls.find((call) => call.path === '/configure')?.body)
      .toMatchObject({
        subscription_id: 'alice-subscription',
        user_id: 'alice',
        group_id: 'subscription-pro',
        enabled: true,
        control_version: 1,
        quota_reset_epoch: 0,
      })
    expect(replayBody).toEqual(firstBody)
  })

  it('uses the same UTC daily window in D1 and the DO for a new multi-day redemption', async () => {
    const test = await fixture()
    await seedRedeemCode(test.raw, 'NEW-PRO-30-DAYS', {
      id: 'new-subscription-code',
      type: 'subscription',
      validityDays: 30,
    })

    const response = await app().request('/redeem', {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': 'redeem-new-subscription-alice',
      },
      body: JSON.stringify({ code: 'NEW-PRO-30-DAYS' }),
    }, test.env)

    expect(response.status, await response.clone().text()).toBe(200)
    const expectedDailyStart = Math.floor(now / DAY_MS) * DAY_MS
    expect(test.raw.prepare(
      `SELECT daily_anchor_ms, daily_window_start_ms
         FROM user_subscriptions WHERE user_id = 'alice'`,
    ).get()).toEqual({ daily_anchor_ms: 0, daily_window_start_ms: expectedDailyStart })
    expect(test.subscriptionState.calls.find((call) => call.path === '/configure')?.body)
      .toMatchObject({ daily_anchor_ms: 0, daily_window_start_ms: expectedDailyStart })
  })

  it('commits a subscription sync intent before responding and resumes a failed DO acknowledgement', async () => {
    const test = await fixture()
    seedSubscription(test.raw, { id: 'alice-subscription', userId: 'alice' })
    await seedRedeemCode(test.raw, 'SYNC-RETRY-30', {
      id: 'sync-retry-code',
      type: 'subscription',
      validityDays: 30,
    })
    test.subscriptionState.failuresByPath.set('/configure', 1)
    const request = {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': 'redeem-subscription-sync-retry',
      },
      body: JSON.stringify({ code: 'SYNC-RETRY-30' }),
    }

    const uncertain = await app().request('/redeem', request, test.env)
    expect(uncertain.status).toBe(503)
    expect(test.raw.prepare(
      `SELECT redemption.status AS redemption_status, sync.status AS sync_status,
              sync.attempts, sync.control_version
         FROM redemptions redemption
         JOIN subscription_state_sync sync ON sync.request_id = redemption.id
        WHERE redemption.code_id = 'sync-retry-code'`,
    ).get()).toEqual({
      redemption_status: 'completed',
      sync_status: 'pending',
      attempts: 1,
      control_version: 1,
    })

    const resumed = await app().request('/redeem', request, test.env)
    expect(resumed.status).toBe(200)
    expect(test.raw.prepare(
      `SELECT status, attempts FROM subscription_state_sync
        WHERE subscription_id = 'alice-subscription'`,
    ).get()).toEqual({ status: 'applied', attempts: 1 })
    expect(test.subscriptionState.calls.filter((call) => call.path === '/configure')).toHaveLength(2)
  })

  it('applies an older pending reset before a redemption can advance the subscription version', async () => {
    const test = await fixture()
    seedSubscription(test.raw, { id: 'alice-subscription', userId: 'alice' })
    test.raw.prepare(
      `UPDATE user_subscriptions
          SET daily_used_micros = 0, quota_reset_epoch = 1, control_version = 1
        WHERE id = 'alice-subscription'`,
    ).run()
    const configuration = {
      schema_version: 1,
      subscription_id: 'alice-subscription',
      user_id: 'alice',
      group_id: 'subscription-pro',
      starts_at_ms: now - DAY_MS,
      expires_at_ms: now + 10 * DAY_MS,
      daily_quota_micros: 10_000_000,
      weekly_quota_micros: 50_000_000,
      monthly_quota_micros: null,
      daily_used_micros: 0,
      weekly_used_micros: 10_000_000,
      monthly_used_micros: 12_000_000,
      daily_window_start_ms: Math.floor(now / DAY_MS) * DAY_MS,
      weekly_window_start_ms: now - DAY_MS,
      monthly_window_start_ms: now - 10 * DAY_MS,
      quota_reset_epoch: 1,
      control_version: 1,
      enabled: true,
    }
    test.raw.prepare(
      `INSERT INTO subscription_state_sync (
         id, request_id, subscription_id, operation, control_version,
         payload_json, status, attempts, created_at_ms, updated_at_ms
       ) VALUES ('old-reset-intent', 'old-reset-request', 'alice-subscription',
                 'reset_quota', 1, ?, 'pending', 0, ?, ?)`,
    ).run(JSON.stringify({
      configuration,
      reset: {
        schema_version: 1,
        mutation_id: 'old-reset-intent',
        subscription_id: 'alice-subscription',
        control_version: 1,
        windows: {
          daily: configuration.daily_window_start_ms,
          weekly: null,
          monthly: null,
        },
      },
    }), now, now)
    await seedRedeemCode(test.raw, 'AFTER-RESET-30', {
      id: 'after-reset-code',
      type: 'subscription',
      validityDays: 30,
    })

    const response = await app().request('/redeem', {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': 'redeem-after-pending-reset',
      },
      body: JSON.stringify({ code: 'AFTER-RESET-30' }),
    }, test.env)

    expect(response.status).toBe(200)
    const calls = test.subscriptionState.calls.map((call) => ({
      path: call.path,
      control_version: call.path === '/configure-reset'
        ? (call.body.configuration as Record<string, unknown>).control_version
        : call.body.control_version,
    }))
    expect(calls).toEqual([
      { path: '/configure-reset', control_version: 1 },
      { path: '/configure', control_version: 2 },
    ])
    expect(test.raw.prepare(
      `SELECT control_version FROM user_subscriptions WHERE id = 'alice-subscription'`,
    ).get()).toEqual({ control_version: 2 })
    expect(test.raw.prepare(
      `SELECT control_version, status FROM subscription_state_sync
        WHERE subscription_id = 'alice-subscription' ORDER BY control_version`,
    ).all()).toEqual([
      { control_version: 1, status: 'applied' },
      { control_version: 2, status: 'applied' },
    ])
  })

  it('preserves both durations when different codes concurrently extend one entitlement', async () => {
    const test = await fixture()
    const initialExpiry = now + 5 * DAY_MS
    seedSubscription(test.raw, {
      id: 'alice-subscription',
      userId: 'alice',
      expiresAt: initialExpiry,
    })
    await seedRedeemCode(test.raw, 'PRO-FIRST-30', {
      id: 'subscription-code-first',
      type: 'subscription',
      validityDays: 30,
    })
    await seedRedeemCode(test.raw, 'PRO-SECOND-30', {
      id: 'subscription-code-second',
      type: 'subscription',
      validityDays: 30,
    })
    const redeem = (code: string, idempotencyKey: string) => app().request('/redeem', {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ code }),
    }, test.env)

    const responses = await Promise.all([
      redeem('PRO-FIRST-30', 'redeem-concurrent-first'),
      redeem('PRO-SECOND-30', 'redeem-concurrent-second'),
    ])

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect((test.raw.prepare(
      `SELECT expires_at_ms FROM user_subscriptions WHERE id = 'alice-subscription'`,
    ).get() as { expires_at_ms: number }).expires_at_ms).toBe(initialExpiry + 60 * DAY_MS)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM subscription_events WHERE subscription_id = 'alice-subscription'`,
    ).get()).toEqual({ total: 2 })
    expect(test.raw.prepare(
      `SELECT control_version, status FROM subscription_state_sync
        WHERE subscription_id = 'alice-subscription' ORDER BY control_version`,
    ).all()).toEqual([
      { control_version: 1, status: 'applied' },
      { control_version: 2, status: 'applied' },
    ])
    const configuredVersions = test.subscriptionState.calls
      .filter((call) => call.path === '/configure')
      .map((call) => call.body.control_version)
    expect(configuredVersions.indexOf(1)).toBeLessThan(configuredVersions.indexOf(2))
  })

  it('records the second concurrent first-time subscription redemption as an extension', async () => {
    const test = await fixture()
    await seedRedeemCode(test.raw, 'FIRST-TIME-ONE', {
      id: 'first-time-one',
      type: 'subscription',
      validityDays: 10,
    })
    await seedRedeemCode(test.raw, 'FIRST-TIME-TWO', {
      id: 'first-time-two',
      type: 'subscription',
      validityDays: 20,
    })
    const redeem = (code: string) => app().request('/redeem', {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': `concurrent-${code}`,
      },
      body: JSON.stringify({ code }),
    }, test.env)

    const responses = await Promise.all([
      redeem('FIRST-TIME-ONE'),
      redeem('FIRST-TIME-TWO'),
    ])

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(test.raw.prepare(
      `SELECT event_type, COUNT(*) AS total
         FROM subscription_events
        GROUP BY event_type ORDER BY event_type`,
    ).all()).toEqual([
      { event_type: 'assigned', total: 1 },
      { event_type: 'extended', total: 1 },
    ])
  })

  it('rolls back subscription side effects when the processing claim is lost before fulfillment', async () => {
    const test = await fixture()
    await seedRedeemCode(test.raw, 'LOST-CLAIM-30', {
      id: 'lost-claim-code',
      type: 'subscription',
      validityDays: 30,
    })
    const originalDb = test.env.DB
    let batchCount = 0
    test.env.DB = {
      prepare: (sql: string) => originalDb.prepare(sql),
      async batch(statements: D1PreparedStatement[]) {
        batchCount += 1
        if (batchCount === 2) {
          test.raw.prepare(
            `DELETE FROM redemptions WHERE code_id = 'lost-claim-code'`,
          ).run()
          test.raw.prepare(
            `UPDATE redeem_codes
                SET status = 'unused', used_by_user_id = NULL,
                    claimed_by_redemption_id = NULL, used_at_ms = NULL
              WHERE id = 'lost-claim-code'`,
          ).run()
        }
        return originalDb.batch(statements)
      },
    } as D1Database

    const response = await app().request('/redeem', {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': 'lost-claim-race',
      },
      body: JSON.stringify({ code: 'LOST-CLAIM-30' }),
    }, test.env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'redeem_code_unavailable' })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM user_subscriptions WHERE user_id = 'alice'`,
    ).get()).toEqual({ total: 0 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM subscription_events`,
    ).get()).toEqual({ total: 0 })
  })

  it('rejects suspended and revoked entitlements without consuming their codes', async () => {
    const test = await fixture()
    seedSubscription(test.raw, {
      id: 'alice-suspended',
      userId: 'alice',
      status: 'suspended',
    })
    seedSubscription(test.raw, {
      id: 'bob-revoked',
      userId: 'bob',
      status: 'revoked',
    })
    await seedRedeemCode(test.raw, 'SUSPENDED-30', {
      id: 'suspended-code',
      type: 'subscription',
      validityDays: 30,
    })
    await seedRedeemCode(test.raw, 'REVOKED-30', {
      id: 'revoked-code',
      type: 'subscription',
      validityDays: 30,
    })
    const redeem = (user: 'alice' | 'bob', code: string) => app().request('/redeem', {
      method: 'POST',
      headers: {
        authorization: test.authorization[user],
        'content-type': 'application/json',
        'idempotency-key': `redeem-${user}-blocked-entitlement`,
      },
      body: JSON.stringify({ code }),
    }, test.env)

    const suspended = await redeem('alice', 'SUSPENDED-30')
    const revoked = await redeem('bob', 'REVOKED-30')

    expect([suspended.status, revoked.status]).toEqual([409, 409])
    await expect(suspended.json()).resolves.toMatchObject({
      code: 'subscription_entitlement_not_redeemable',
    })
    await expect(revoked.json()).resolves.toMatchObject({
      code: 'subscription_entitlement_not_redeemable',
    })
    expect(test.raw.prepare(
      `SELECT id, status, used_by_user_id, claimed_by_redemption_id
         FROM redeem_codes ORDER BY id`,
    ).all()).toEqual([
      {
        id: 'revoked-code',
        status: 'unused',
        used_by_user_id: null,
        claimed_by_redemption_id: null,
      },
      {
        id: 'suspended-code',
        status: 'unused',
        used_by_user_id: null,
        claimed_by_redemption_id: null,
      },
    ])
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM redemptions').get()).toEqual({ total: 0 })
  })

  it('releases a processing claim when a resumed subscription is no longer redeemable', async () => {
    const test = await fixture()
    seedSubscription(test.raw, {
      id: 'alice-suspended-after-claim',
      userId: 'alice',
    })
    await seedRedeemCode(test.raw, 'CLAIMED-THEN-SUSPENDED', {
      id: 'claimed-code',
      type: 'subscription',
      validityDays: 30,
    })
    const idempotencyKey = 'redeem-claimed-before-suspension'
    const redemptionId = await deterministicUuid(
      'user.redeem.v1',
      `alice\0${idempotencyKey}`,
    )
    const idempotencyHash = await sha256Hex(
      `sub2api/redeem/idempotency/v1\0alice\0${idempotencyKey}`,
    )
    test.raw.prepare(
      `UPDATE redeem_codes
          SET status = 'processing', used_by_user_id = 'alice',
              claimed_by_redemption_id = ?, used_at_ms = ?
        WHERE id = 'claimed-code'`,
    ).run(redemptionId, now)
    test.raw.prepare(
      `INSERT INTO redemptions (
         id, code_id, user_id, idempotency_key_hash, status,
         type, value_micros, created_at_ms
       ) VALUES (?, 'claimed-code', 'alice', ?, 'processing', 'subscription', 0, ?)`,
    ).run(redemptionId, idempotencyHash, now)
    test.raw.prepare(
      `UPDATE user_subscriptions SET status = 'suspended'
        WHERE id = 'alice-suspended-after-claim'`,
    ).run()

    const response = await app().request('/redeem', {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ code: 'CLAIMED-THEN-SUSPENDED' }),
    }, test.env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: 'subscription_entitlement_not_redeemable',
    })
    expect(test.raw.prepare(
      `SELECT status, used_by_user_id, claimed_by_redemption_id, used_at_ms
         FROM redeem_codes WHERE id = 'claimed-code'`,
    ).get()).toEqual({
      status: 'unused',
      used_by_user_id: null,
      claimed_by_redemption_id: null,
      used_at_ms: null,
    })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM redemptions').get()).toEqual({ total: 0 })
  })

  it('releases a processing claim when extending the current expiry would exceed the Date range', async () => {
    const test = await fixture()
    seedSubscription(test.raw, {
      id: 'alice-max-expiry',
      userId: 'alice',
      startsAt: MAX_DATE_MS - 10 * DAY_MS,
      expiresAt: MAX_DATE_MS - DAY_MS,
    })
    await seedRedeemCode(test.raw, 'EXPIRY-OVERFLOW', {
      id: 'expiry-overflow-code',
      type: 'subscription',
      validityDays: 2,
    })
    const idempotencyKey = 'expiry-overflow-redemption'
    const redemptionId = await deterministicUuid(
      'user.redeem.v1',
      `alice\0${idempotencyKey}`,
    )
    const idempotencyHash = await sha256Hex(
      `sub2api/redeem/idempotency/v1\0alice\0${idempotencyKey}`,
    )
    test.raw.prepare(
      `UPDATE redeem_codes
          SET status = 'processing', used_by_user_id = 'alice',
              claimed_by_redemption_id = ?, used_at_ms = ?
        WHERE id = 'expiry-overflow-code'`,
    ).run(redemptionId, now)
    test.raw.prepare(
      `INSERT INTO redemptions (
         id, code_id, user_id, idempotency_key_hash, status,
         type, value_micros, created_at_ms
       ) VALUES (?, 'expiry-overflow-code', 'alice', ?,
                 'processing', 'subscription', 0, ?)`,
    ).run(redemptionId, idempotencyHash, now)

    const response = await app().request('/redeem', {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ code: 'EXPIRY-OVERFLOW' }),
    }, test.env)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_subscription_expiry' })
    expect(test.raw.prepare(
      `SELECT status, used_by_user_id, claimed_by_redemption_id
         FROM redeem_codes WHERE id = 'expiry-overflow-code'`,
    ).get()).toEqual({
      status: 'unused',
      used_by_user_id: null,
      claimed_by_redemption_id: null,
    })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM redemptions WHERE id = ?`,
    ).get(redemptionId)).toEqual({ total: 0 })
    expect(test.raw.prepare(
      `SELECT expires_at_ms FROM user_subscriptions WHERE id = 'alice-max-expiry'`,
    ).get()).toEqual({ expires_at_ms: MAX_DATE_MS - DAY_MS })
  })

  it('creates a new subscription entitlement with the group quota snapshot', async () => {
    const test = await fixture()
    test.raw.prepare(
      `UPDATE "groups"
          SET daily_quota_micros = 9000000,
              weekly_quota_micros = 45000000,
              monthly_quota_micros = 150000000
        WHERE id = 'subscription-pro'`,
    ).run()
    await seedRedeemCode(test.raw, 'NEW-PRO-30', {
      id: 'new-subscription-code',
      type: 'subscription',
      validityDays: 30,
    })

    const response = await app().request('/redeem', {
      method: 'POST',
      headers: {
        authorization: test.authorization.alice,
        'content-type': 'application/json',
        'idempotency-key': 'redeem-new-subscription-alice-1',
      },
      body: JSON.stringify({ code: 'NEW-PRO-30' }),
    }, test.env)

    expect(response.status).toBe(200)
    const body = await response.json() as { data: { subscription_id: string } }
    const entitlement = test.raw.prepare(
      `SELECT user_id, group_id, status, daily_quota_micros,
              weekly_quota_micros, monthly_quota_micros,
              daily_used_micros, weekly_used_micros, monthly_used_micros,
              source_type, source_id
         FROM user_subscriptions WHERE id = ?`,
    ).get(body.data.subscription_id)
    expect(entitlement).toEqual({
      user_id: 'alice',
      group_id: 'subscription-pro',
      status: 'active',
      daily_quota_micros: 9_000_000,
      weekly_quota_micros: 45_000_000,
      monthly_quota_micros: 150_000_000,
      daily_used_micros: 0,
      weekly_used_micros: 0,
      monthly_used_micros: 0,
      source_type: 'redeem',
      source_id: expect.any(String),
    })
    expect(test.raw.prepare(
      `SELECT event_type, source_type, validity_days
         FROM subscription_events WHERE subscription_id = ?`,
    ).get(body.data.subscription_id)).toEqual({
      event_type: 'assigned',
      source_type: 'redeem',
      validity_days: 30,
    })
  })

  it('rejects reuse of an idempotency key for a different code', async () => {
    const test = await fixture()
    await seedRedeemCode(test.raw, 'BALANCE-ONE', {
      id: 'balance-one',
      type: 'balance',
      valueMicros: 1_000_000,
    })
    await seedRedeemCode(test.raw, 'BALANCE-TWO', {
      id: 'balance-two',
      type: 'balance',
      valueMicros: 2_000_000,
    })
    const headers = {
      authorization: test.authorization.alice,
      'content-type': 'application/json',
      'idempotency-key': 'redeem-conflict-alice-1',
    }
    const first = await app().request('/redeem', {
      method: 'POST', headers, body: JSON.stringify({ code: 'BALANCE-ONE' }),
    }, test.env)
    const conflict = await app().request('/redeem', {
      method: 'POST', headers, body: JSON.stringify({ code: 'BALANCE-TWO' }),
    }, test.env)

    expect(first.status).toBe(200)
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ code: 'idempotency_conflict' })
    expect(test.balanceAdjustments.size).toBe(1)
    expect(test.raw.prepare(
      `SELECT status FROM redeem_codes WHERE id = 'balance-two'`,
    ).get()).toEqual({ status: 'unused' })
  })

  it('allows only one user to consume a code', async () => {
    const test = await fixture()
    await seedRedeemCode(test.raw, 'SINGLE-USE', {
      id: 'single-use',
      type: 'balance',
      valueMicros: 3_000_000,
    })
    const redeem = (user: 'alice' | 'bob') => app().request('/redeem', {
      method: 'POST',
      headers: {
        authorization: test.authorization[user],
        'content-type': 'application/json',
        'idempotency-key': `single-use-${user}`,
      },
      body: JSON.stringify({ code: 'SINGLE-USE' }),
    }, test.env)

    const winner = await redeem('alice')
    const loser = await redeem('bob')
    expect(winner.status).toBe(200)
    expect(loser.status).toBe(409)
    await expect(loser.json()).resolves.toMatchObject({ code: 'redeem_code_unavailable' })
    expect(test.raw.prepare(
      `SELECT status, used_by_user_id FROM redeem_codes WHERE id = 'single-use'`,
    ).get()).toEqual({ status: 'used', used_by_user_id: 'alice' })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM redemptions WHERE code_id = 'single-use'`,
    ).get()).toEqual({ total: 1 })
  })

  it('rejects expired or already-consumed codes without mutating user state', async () => {
    const test = await fixture()
    await seedRedeemCode(test.raw, 'EXPIRED-1', {
      id: 'expired-code',
      type: 'balance',
      valueMicros: 1_000_000,
      expiresAt: now - 1,
    })
    await seedRedeemCode(test.raw, 'USED-1', {
      id: 'used-code',
      type: 'balance',
      valueMicros: 1_000_000,
      status: 'used',
    })
    const headers = {
      authorization: test.authorization.alice,
      'content-type': 'application/json',
      'idempotency-key': 'redeem-rejected-alice-1',
    }
    const expired = await app().request('/redeem', {
      method: 'POST', headers, body: JSON.stringify({ code: 'EXPIRED-1' }),
    }, test.env)
    const used = await app().request('/redeem', {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'redeem-rejected-alice-2' },
      body: JSON.stringify({ code: 'USED-1' }),
    }, test.env)

    expect(expired.status).toBe(409)
    expect(used.status).toBe(409)
    expect(test.balanceAdjustments.size).toBe(0)
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM redemptions').get()).toEqual({ total: 0 })
  })

  it('constrains subscription entitlements and redeem codes to subscription groups', async () => {
    const test = await fixture()
    const standardCodeHash = await redeemCodeDigest('STANDARD-GROUP-30', PEPPER)

    expect(() => test.raw.prepare(
      `INSERT INTO redeem_codes (
         id, code_hash, code_prefix, type, value_micros, group_id, validity_days,
         status, created_at_ms, updated_at_ms
       ) VALUES ('invalid-group-code', ?, 'STAN', 'subscription', 0, 'standard', 30,
                 'unused', ?, ?)`,
    ).run(standardCodeHash, now, now)).toThrow(/subscription_redeem_code_requires_subscription_group/)
    expect(() => seedSubscription(test.raw, {
      id: 'invalid-group-entitlement',
      userId: 'alice',
      groupId: 'standard',
    })).toThrow(/user_subscription_requires_subscription_group/)

    await seedRedeemCode(test.raw, 'VALID-GROUP-30', {
      id: 'valid-group-code',
      type: 'subscription',
      validityDays: 30,
    })
    seedSubscription(test.raw, {
      id: 'valid-group-entitlement',
      userId: 'alice',
    })

    expect(() => test.raw.prepare(
      `UPDATE redeem_codes SET group_id = 'standard' WHERE id = 'valid-group-code'`,
    ).run()).toThrow(/subscription_redeem_code_requires_subscription_group/)
    expect(() => test.raw.prepare(
      `UPDATE user_subscriptions SET group_id = 'standard' WHERE id = 'valid-group-entitlement'`,
    ).run()).toThrow(/user_subscription_requires_subscription_group/)
  })
})

function fakeUserStateNamespace(
  raw: any,
  mutations: Map<string, number>,
): DurableObjectNamespace {
  const balances = new Map<string, number>()
  const versions = new Map<string, number>()
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId
    },
    get(id: DurableObjectId) {
      const userId = String(id)
      return {
        async fetch(request: Request) {
          const body = await request.json() as Record<string, unknown>
          const path = new URL(request.url).pathname
          if (path === '/configure') {
            if (!balances.has(userId)) {
              balances.set(userId, Number(body.balance_micros))
              versions.set(userId, Number(body.initial_state_version))
            }
            return Response.json({
              schema_version: 1,
              state_version: versions.get(userId),
              profile: profile(userId, balances, versions),
            })
          }
          if (path === '/balance/adjust') {
            const mutationId = String(body.mutation_id)
            const prior = mutations.get(mutationId)
            if (prior === undefined) {
              const next = (balances.get(userId) ?? 0) + Number(body.amount_delta_micros)
              balances.set(userId, next)
              versions.set(userId, (versions.get(userId) ?? 0) + 1)
              mutations.set(mutationId, next)
            }
            return Response.json({
              schema_version: 1,
              idempotent: prior !== undefined,
              state_version: versions.get(userId),
              profile: profile(userId, balances, versions),
            })
          }
          return Response.json({ error: { code: 'route_not_found' } }, { status: 404 })
        },
      } as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

function profile(
  userId: string,
  balances: Map<string, number>,
  _versions: Map<string, number>,
): Record<string, unknown> {
  return {
    schema_version: 1,
    user_id: userId,
    enabled: true,
    balance_micros: balances.get(userId) ?? 0,
    reserved_micros: 0,
    settled_micros: 0,
    updated_at_ms: now,
  }
}
