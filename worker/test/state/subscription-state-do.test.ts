import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Node SQLite backs only this Durable Object contract fixture.
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { DatabaseSync } from 'node:sqlite'

import type { Env } from '../../src/env'
import { SubscriptionStateDO } from '../../src/state/subscription-state-do'

const DAY_MS = 86_400_000

class TestSqlStorage {
  readonly database = new DatabaseSync(':memory:')
  alarm: number | null = null
  readonly alarmWrites: number[] = []

  readonly sql = {
    exec: (query: string, ...params: unknown[]): object[] => {
      const statement = this.database.prepare(query)
      return statement.all(...params) as object[]
    },
  }

  transactionSync<T>(callback: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp
    this.alarmWrites.push(timestamp)
  }
}

function harness(storage = new TestSqlStorage(), platform = 'openai'): {
  object: SubscriptionStateDO
  storage: TestSqlStorage
  queued: unknown[]
} {
  const queued: unknown[] = []
  const state = {
    storage,
    blockConcurrencyWhile: (callback: () => Promise<void>) => callback(),
  } as unknown as DurableObjectState
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            subscription_id: 'subscription-1',
            group_enabled: 1,
            platform,
          }),
        }),
      }),
    } as unknown as D1Database,
    EVENTS_QUEUE: {
      send: async (value: unknown) => void queued.push(value),
    } as unknown as Queue,
  } as Env
  return { object: new SubscriptionStateDO(state, env), storage, queued }
}

function post(
  object: SubscriptionStateDO,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return object.fetch(new Request(`https://subscription-state.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

function config(input: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const startsAt = typeof input.starts_at_ms === 'number'
    ? input.starts_at_ms
    : Date.UTC(2026, 8, 1)
  const expiresAt = typeof input.expires_at_ms === 'number'
    ? input.expires_at_ms
    : startsAt + 31 * DAY_MS
  return {
    schema_version: 1,
    subscription_id: 'subscription-1',
    user_id: 'user-1',
    group_id: 'group-1',
    starts_at_ms: startsAt,
    expires_at_ms: expiresAt,
    daily_quota_micros: 100,
    weekly_quota_micros: 1_000,
    monthly_quota_micros: 10_000,
    daily_used_micros: 0,
    weekly_used_micros: 0,
    monthly_used_micros: 0,
    daily_anchor_ms: expiresAt - startsAt <= DAY_MS ? startsAt : 0,
    daily_window_start_ms: null,
    weekly_window_start_ms: null,
    monthly_window_start_ms: null,
    control_version: 0,
    quota_reset_epoch: 0,
    quota_reset_generation: 0,
    ...input,
  }
}

async function authorize(object: SubscriptionStateDO, requestId: string): Promise<Response> {
  return post(object, '/authorize', {
    schema_version: 1,
    request_id: requestId,
    subscription_id: 'subscription-1',
    user_id: 'user-1',
    group_id: 'group-1',
    api_key_id: 'key-1',
    api_key_auth_version: 1,
  })
}

async function reserve(
  object: SubscriptionStateDO,
  requestId: string,
  amountMicros: number,
  ttlMs = 600_000,
): Promise<Response> {
  await authorize(object, requestId)
  return post(object, '/reserve', {
    schema_version: 1,
    request_id: requestId,
    amount_micros: amountMicros,
    reservation_ttl_ms: ttlMs,
  })
}

async function settle(
  object: SubscriptionStateDO,
  requestId: string,
  amountMicros: number,
): Promise<Response> {
  return post(object, '/settle', {
    schema_version: 1,
    request_id: requestId,
    amount_micros: amountMicros,
  })
}

async function ensure(
  object: SubscriptionStateDO,
  requestId: string,
  targetAmountMicros: number,
): Promise<Response> {
  return post(object, '/ensure', {
    schema_version: 1,
    request_id: requestId,
    target_amount_micros: targetAmountMicros,
  })
}

function usageEvent(requestId: string, amountMicros: number): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: `usage:${requestId}`,
    event_type: 'usage.settled.v1',
    occurred_at_ms: Date.now(),
    aggregate_type: 'user',
    aggregate_id: 'user-1',
    payload: {
      request_id: requestId,
      user_id: 'user-1',
      api_key_id: 'key-1',
      group_id: 'group-1',
      billing_type: 'subscription',
      subscription_id: 'subscription-1',
      account_id: 'account-1',
      price_id: 'price-1',
      requested_model: 'test-model',
      upstream_model: 'test-model',
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      input_amount_micros: 0,
      output_amount_micros: 0,
      cache_amount_micros: 0,
      base_amount_micros: amountMicros,
      amount_micros: amountMicros,
      outcome: 'completed',
      stream: false,
      duration_ms: 1,
      estimated: false,
    },
  }
}

describe('SubscriptionStateDO quota contract', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'))
  })

  it('authorizes supported Gemini subscription groups and rejects unknown platforms', async () => {
    const gemini = harness(new TestSqlStorage(), 'gemini')
    await post(gemini.object, '/configure', config())
    expect((await authorize(gemini.object, 'gemini-request')).status).toBe(200)

    const unsupported = harness(new TestSqlStorage(), 'unsupported')
    await post(unsupported.object, '/configure', config())
    const response = await authorize(unsupported.object, 'unsupported-request')
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'group_unavailable' },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('serializes concurrent worst-case reservations so a quota cannot be oversold', async () => {
    const { object } = harness()
    expect((await post(object, '/configure', config())).status).toBe(200)

    const [first, second] = await Promise.all([
      reserve(object, 'request-1', 60),
      reserve(object, 'request-2', 60),
    ])

    expect([first.status, second.status].sort()).toEqual([200, 429])
    const rejected = first.status === 429 ? first : second
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'subscription_daily_quota_exceeded' },
    })
  })

  it('upgrades legacy SQLite state online without reopening current quota', async () => {
    const storage = new TestSqlStorage()
    const startsAt = Date.UTC(2026, 8, 1)
    const expiresAt = startsAt + 31 * DAY_MS
    storage.database.exec(`
      CREATE TABLE subscription_profile (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        subscription_id TEXT NOT NULL, user_id TEXT NOT NULL, group_id TEXT NOT NULL,
        starts_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
        daily_quota_micros INTEGER, weekly_quota_micros INTEGER, monthly_quota_micros INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        weekly_anchor_ms INTEGER NOT NULL, monthly_anchor_ms INTEGER NOT NULL,
        control_version INTEGER NOT NULL, quota_reset_epoch INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO subscription_profile VALUES (
        1, 'subscription-1', 'user-1', 'group-1', ${startsAt}, ${expiresAt},
        100, 1000, 10000, 1, ${startsAt}, ${startsAt}, 3, 3, ${Date.now()}
      );
      CREATE TABLE subscription_windows (
        kind TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
        used_micros INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (kind, start_ms)
      ) STRICT;
      INSERT INTO subscription_windows VALUES (
        'daily', ${startsAt}, ${startsAt + DAY_MS}, 55, ${Date.now()}
      );
      CREATE TABLE subscription_requests (
        request_id TEXT PRIMARY KEY, status TEXT NOT NULL, reserved_micros INTEGER NOT NULL,
        settled_micros INTEGER, reservation_expires_at_ms INTEGER, reservation_ttl_ms INTEGER,
        renewal_sequence INTEGER NOT NULL DEFAULT 0, last_renewal_ttl_ms INTEGER,
        daily_window_start_ms INTEGER, weekly_window_start_ms INTEGER,
        monthly_window_start_ms INTEGER, authorized_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO subscription_requests VALUES (
        'legacy-current', 'reserved', 10, NULL, ${Date.now() + 60_000}, 60000,
        0, NULL, ${startsAt}, ${startsAt}, ${startsAt}, ${Date.now() - 1_000}, ${Date.now()}
      );
    `)

    const { object } = harness(storage)
    const snapshot = await object.fetch(new Request('https://subscription-state.test/snapshot'))
    expect(snapshot.status).toBe(200)
    await expect(snapshot.json()).resolves.toMatchObject({
      profile: { term_generation: 1, quota_reset_epoch: 3 },
      windows: expect.arrayContaining([
        expect.objectContaining({
          kind: 'daily',
          term_generation: 1,
          quota_reset_epoch: 3,
          used_micros: 55,
          reserved_micros: 10,
        }),
      ]),
      requests: expect.arrayContaining([
        expect.objectContaining({
          request_id: 'legacy-current',
          committed: 0,
          term_generation: 1,
          quota_reset_epoch: 3,
        }),
      ]),
    })
  })

  it('allows a zero-cost free subscription request without consuming zero quota', async () => {
    const { object } = harness()
    await post(object, '/configure', config({
      daily_quota_micros: 0,
      weekly_quota_micros: 0,
      monthly_quota_micros: 0,
    }))

    expect((await reserve(object, 'free', 0)).status).toBe(200)
    expect((await settle(object, 'free', 0)).status).toBe(200)
    expect((await reserve(object, 'paid', 1)).status).toBe(429)
  })

  it('resets a multi-day daily quota at UTC midnight but keeps a one-day card single-use', async () => {
    vi.setSystemTime(new Date('2026-09-01T23:50:00.000Z'))
    const startsAt = Date.now()

    const multiDay = harness().object
    await post(multiDay, '/configure', config({
      starts_at_ms: startsAt,
      expires_at_ms: startsAt + 2 * DAY_MS,
    }))
    const multiSnapshot = await multiDay.fetch(new Request('https://subscription-state.test/snapshot'))
    const multiState = await multiSnapshot.json() as {
      windows: Array<{ kind: string; start_ms: number; end_ms: number }>
    }
    expect(multiState.windows.find((window) => window.kind === 'daily')).toMatchObject({
      start_ms: Date.UTC(2026, 8, 1),
      end_ms: Date.UTC(2026, 8, 2),
    })
    expect((await reserve(multiDay, 'multi-1', 80)).status).toBe(200)
    expect((await settle(multiDay, 'multi-1', 80)).status).toBe(200)
    expect((await reserve(multiDay, 'multi-before-midnight', 30)).status).toBe(429)
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'))
    expect((await reserve(multiDay, 'multi-after-midnight', 30)).status).toBe(200)

    vi.setSystemTime(new Date('2026-09-01T23:50:00.000Z'))
    const oneDay = harness().object
    await post(oneDay, '/configure', config({
      starts_at_ms: startsAt,
      expires_at_ms: startsAt + DAY_MS,
    }))
    expect((await reserve(oneDay, 'one-day-1', 80)).status).toBe(200)
    expect((await settle(oneDay, 'one-day-1', 80)).status).toBe(200)
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'))
    expect((await reserve(oneDay, 'one-day-after-midnight', 30)).status).toBe(429)
  })

  it('does not reopen daily quota when an active one-day term is extended', async () => {
    vi.setSystemTime(new Date('2026-09-01T23:50:00.000Z'))
    const startsAt = Date.now()
    const { object } = harness()
    await post(object, '/configure', config({
      starts_at_ms: startsAt,
      expires_at_ms: startsAt + DAY_MS,
    }))
    expect((await reserve(object, 'before-extension', 80)).status).toBe(200)
    expect((await settle(object, 'before-extension', 80)).status).toBe(200)

    vi.setSystemTime(new Date('2026-09-02T00:05:00.000Z'))
    const extended = await post(object, '/configure', config({
      starts_at_ms: startsAt,
      expires_at_ms: startsAt + 2 * DAY_MS,
      daily_used_micros: 80,
      daily_anchor_ms: startsAt,
      daily_window_start_ms: startsAt,
      control_version: 1,
    }))
    expect(extended.status).toBe(200)
    expect((await reserve(object, 'after-extension', 30)).status).toBe(429)

    vi.setSystemTime(startsAt + DAY_MS)
    expect((await reserve(object, 'second-window', 100)).status).toBe(200)
    expect((await settle(object, 'second-window', 100)).status).toBe(200)
    vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'))
    expect((await reserve(object, 'overlapping-utc-window', 1)).status).toBe(429)
  })

  it('anchors weekly and 30-day windows to activation, including a partial final period', async () => {
    const startsAt = Date.now()
    const weekly = harness().object
    await post(weekly, '/configure', config({
      daily_quota_micros: null,
      weekly_quota_micros: 100,
      monthly_quota_micros: null,
      starts_at_ms: startsAt,
      expires_at_ms: startsAt + 45 * DAY_MS,
    }))
    await reserve(weekly, 'weekly-1', 100)
    await settle(weekly, 'weekly-1', 100)
    vi.setSystemTime(startsAt + 7 * DAY_MS - 1)
    expect((await reserve(weekly, 'weekly-before-reset', 1)).status).toBe(429)
    vi.setSystemTime(startsAt + 7 * DAY_MS)
    expect((await reserve(weekly, 'weekly-after-reset', 100)).status).toBe(200)

    vi.setSystemTime(startsAt)
    const monthly = harness().object
    await post(monthly, '/configure', config({
      daily_quota_micros: null,
      weekly_quota_micros: null,
      monthly_quota_micros: 100,
      starts_at_ms: startsAt,
      expires_at_ms: startsAt + 45 * DAY_MS,
    }))
    await reserve(monthly, 'monthly-1', 100)
    await settle(monthly, 'monthly-1', 100)
    vi.setSystemTime(startsAt + 30 * DAY_MS - 1)
    expect((await reserve(monthly, 'monthly-before-reset', 1)).status).toBe(429)
    vi.setSystemTime(startsAt + 30 * DAY_MS)
    expect((await reserve(monthly, 'monthly-final-period', 100)).status).toBe(200)
  })

  it('starts weekly and monthly periods on delayed first use, not on purchase time', async () => {
    const startsAt = Date.UTC(2026, 8, 1, 9)
    const activatedAt = startsAt + 10 * DAY_MS
    vi.setSystemTime(activatedAt)
    const { object } = harness()
    await post(object, '/configure', config({
      starts_at_ms: startsAt,
      expires_at_ms: startsAt + 45 * DAY_MS,
      daily_quota_micros: null,
      weekly_quota_micros: null,
      monthly_quota_micros: 100,
      weekly_window_start_ms: null,
      monthly_window_start_ms: null,
    }))
    await reserve(object, 'activated', 100)
    await settle(object, 'activated', 100)

    vi.setSystemTime(startsAt + 30 * DAY_MS)
    expect((await reserve(object, 'purchase-plus-30d', 1)).status).toBe(429)
    vi.setSystemTime(activatedAt + 30 * DAY_MS)
    expect((await reserve(object, 'activation-plus-30d', 100)).status).toBe(200)
  })

  it('corrects a legacy midnight periodic anchor back to the activation timestamp', async () => {
    const startsAt = Date.UTC(2026, 8, 1, 13, 37, 6)
    vi.setSystemTime(startsAt + 1_000)
    const { object } = harness()
    await post(object, '/configure', config({
      starts_at_ms: startsAt,
      expires_at_ms: startsAt + 31 * DAY_MS,
      daily_quota_micros: null,
      weekly_quota_micros: null,
      monthly_quota_micros: 100,
      monthly_used_micros: 100,
      monthly_window_start_ms: Math.floor(startsAt / DAY_MS) * DAY_MS,
    }))

    vi.setSystemTime(startsAt + 30 * DAY_MS - 1)
    expect((await reserve(object, 'before-corrected-reset', 1)).status).toBe(429)
    vi.setSystemTime(startsAt + 30 * DAY_MS)
    expect((await reserve(object, 'after-corrected-reset', 100)).status).toBe(200)
  })

  it('does not create a new 30-day window at the exact expiry boundary', async () => {
    const startsAt = Date.now()
    const { object } = harness()
    await post(object, '/configure', config({
      daily_quota_micros: null,
      weekly_quota_micros: null,
      monthly_quota_micros: 100,
      starts_at_ms: startsAt,
      expires_at_ms: startsAt + 30 * DAY_MS,
    }))
    await reserve(object, 'request-1', 100)
    await settle(object, 'request-1', 100)

    vi.setSystemTime(startsAt + 30 * DAY_MS - 1)
    expect((await reserve(object, 'before-expiry', 1)).status).toBe(429)
    vi.setSystemTime(startsAt + 30 * DAY_MS)
    const expired = await reserve(object, 'at-expiry', 1)
    expect(expired.status).toBe(403)
    await expect(expired.json()).resolves.toMatchObject({
      error: { code: 'subscription_expired' },
    })
  })

  it.each([31, 45])('opens one final monthly window for a %i-day entitlement', async (validityDays) => {
    const startsAt = Date.now()
    const { object } = harness()
    await post(object, '/configure', config({
      daily_quota_micros: null,
      weekly_quota_micros: null,
      monthly_quota_micros: 100,
      starts_at_ms: startsAt,
      expires_at_ms: startsAt + validityDays * DAY_MS,
    }))
    await reserve(object, 'initial', 100)
    await settle(object, 'initial', 100)
    vi.setSystemTime(startsAt + 30 * DAY_MS)
    expect((await reserve(object, 'final-window', 100)).status).toBe(200)
  })

  it('conservatively imports unanchored legacy usage into the current window', async () => {
    const { object } = harness()
    await post(object, '/configure', config({
      daily_used_micros: 90,
      daily_window_start_ms: null,
    }))

    const response = await reserve(object, 'request-1', 11)
    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'subscription_daily_quota_exceeded' },
    })
  })

  it('honors an admitted reservation if an administrator lowers quota before settlement', async () => {
    const { object } = harness()
    await post(object, '/configure', config())
    await reserve(object, 'admitted', 100)
    expect((await post(object, '/configure', config({
      control_version: 1,
      daily_quota_micros: 50,
    }))).status).toBe(200)

    expect((await settle(object, 'admitted', 80)).status).toBe(200)
    expect((await reserve(object, 'after-lower', 1)).status).toBe(429)
  })

  it('fails closed after an administrative disable and ignores a stale in-flight configure', async () => {
    const { object } = harness()
    await post(object, '/configure', config())
    expect((await post(object, '/configure', config({
      enabled: false,
      control_version: 1,
    }))).status).toBe(200)
    const stale = await post(object, '/configure', config())
    await expect(stale.json()).resolves.toMatchObject({ stale: true, profile: { enabled: 0 } })

    const blocked = await reserve(object, 'after-disable', 1)
    expect(blocked.status).toBe(403)
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: 'subscription_disabled' },
    })
  })

  it('idempotently resets the targeted live window without wiping usage accrued after the reset', async () => {
    const { object, queued } = harness()
    await post(object, '/configure', config())
    await reserve(object, 'before-reset', 100)
    await settle(object, 'before-reset', 100)
    expect((await reserve(object, 'exhausted', 1)).status).toBe(429)

    const resetBody = {
      schema_version: 1,
      mutation_id: '00000000-0000-4000-8000-000000000099',
      subscription_id: 'subscription-1',
      control_version: 1,
      windows: {
        daily: Date.UTC(2026, 8, 1),
        weekly: null,
        monthly: null,
      },
    }
    const command = {
      configuration: config({
        control_version: 1,
        daily_used_micros: 0,
        quota_reset_epoch: 1,
        quota_reset_generation: 1,
      }),
      reset: resetBody,
    }
    const reset = await post(object, '/configure-reset', command)
    expect(reset.status).toBe(200)
    await expect(reset.json()).resolves.toMatchObject({ reset: { idempotent: false } })

    expect((await reserve(object, 'after-reset', 100)).status).toBe(200)
    expect((await settle(object, 'after-reset', 100)).status).toBe(200)
    expect(queued.find((value) => (
      value as { event_id?: string }
    ).event_id === 'subscription-usage:after-reset')).toMatchObject({
      payload: { quota_reset_epoch: 1 },
    })

    const replay = await post(object, '/configure-reset', command)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ reset: { idempotent: true } })
    expect((await reserve(object, 'after-replay', 1)).status).toBe(429)
  })

  it('atomically configures and resets quota, and a retry cannot wipe newly accrued usage', async () => {
    const { object } = harness()
    await post(object, '/configure', config())
    await reserve(object, 'before-atomic-reset', 100)
    await settle(object, 'before-atomic-reset', 100)
    expect((await reserve(object, 'atomic-reset-exhausted', 1)).status).toBe(429)

    const command = {
      configuration: config({
        control_version: 1,
        daily_used_micros: 0,
        quota_reset_epoch: 1,
        quota_reset_generation: 1,
      }),
      reset: {
        schema_version: 1,
        mutation_id: '00000000-0000-4000-8000-000000000199',
        subscription_id: 'subscription-1',
        control_version: 1,
        windows: {
          daily: Date.UTC(2026, 8, 1),
          weekly: null,
          monthly: null,
        },
      },
    }
    const reset = await post(object, '/configure-reset', command)
    expect(reset.status).toBe(200)
    await expect(reset.json()).resolves.toMatchObject({
      configuration: { idempotent: false },
      reset: { idempotent: false },
      profile: { control_version: 1, quota_reset_epoch: 1 },
    })

    expect((await reserve(object, 'after-atomic-reset', 100)).status).toBe(200)
    expect((await settle(object, 'after-atomic-reset', 100)).status).toBe(200)

    const replay = await post(object, '/configure-reset', command)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      configuration: { idempotent: true },
      reset: { idempotent: true },
    })
    expect((await reserve(object, 'after-atomic-replay', 1)).status).toBe(429)
  })

  it('fails closed when an ordinary configure tries to expose a pending quota-reset epoch', async () => {
    const { object } = harness()
    await post(object, '/configure', config())
    await reserve(object, 'before-pending-reset', 100)
    await settle(object, 'before-pending-reset', 100)

    const premature = await post(object, '/configure', config({
      control_version: 1,
      daily_used_micros: 0,
      quota_reset_epoch: 1,
      quota_reset_generation: 1,
    }))
    expect(premature.status).toBe(409)
    await expect(premature.json()).resolves.toMatchObject({
      error: { code: 'subscription_quota_reset_requires_atomic_command' },
    })
    expect((await reserve(object, 'during-pending-reset', 1)).status).toBe(429)
  })

  it('fails closed when a pending reset races the first configuration of an empty object', async () => {
    const { object } = harness()
    const resetConfiguration = config({
      control_version: 1,
      daily_used_micros: 0,
      quota_reset_epoch: 1,
      quota_reset_generation: 1,
    })
    const resetCommand = {
      schema_version: 1,
      mutation_id: '00000000-0000-4000-8000-000000000249',
      subscription_id: 'subscription-1',
      control_version: 1,
      windows: {
        daily: Date.UTC(2026, 8, 1),
        weekly: null,
        monthly: null,
      },
    }

    const premature = await post(object, '/configure', resetConfiguration)
    expect(premature.status).toBe(409)
    await expect(premature.json()).resolves.toMatchObject({
      error: { code: 'subscription_quota_reset_requires_atomic_command' },
    })

    const applied = await post(object, '/configure-reset', {
      configuration: resetConfiguration,
      reset: resetCommand,
    })
    expect(applied.status).toBe(200)
    expect((await reserve(object, 'after-empty-object-reset', 100)).status).toBe(200)
    expect((await settle(object, 'after-empty-object-reset', 100)).status).toBe(200)

    const replay = await post(object, '/configure-reset', {
      configuration: resetConfiguration,
      reset: resetCommand,
    })
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ reset: { idempotent: true } })
    expect((await reserve(object, 'after-empty-object-replay', 1)).status).toBe(429)
  })

  it('fails closed when an ordinary configure tries to expose a pending periodic-only reset', async () => {
    const { object } = harness()
    await post(object, '/configure', config({ daily_quota_micros: 10_000 }))
    await reserve(object, 'before-pending-weekly-reset', 1_000)
    await settle(object, 'before-pending-weekly-reset', 1_000)
    expect((await reserve(object, 'weekly-reset-exhausted', 1)).status).toBe(429)

    const resetAt = Date.now()
    for (const invalidGeneration of [0, 2]) {
      const invalid = await post(object, '/configure-reset', {
        configuration: config({
          daily_quota_micros: 10_000,
          control_version: 1,
          weekly_used_micros: 0,
          weekly_window_start_ms: resetAt,
          quota_reset_generation: invalidGeneration,
        }),
        reset: {
          schema_version: 1,
          mutation_id: `invalid-periodic-reset-${invalidGeneration}`,
          subscription_id: 'subscription-1',
          control_version: 1,
          windows: { daily: null, weekly: resetAt, monthly: null },
        },
      })
      expect(invalid.status).toBe(409)
      await expect(invalid.json()).resolves.toMatchObject({
        error: { code: 'subscription_quota_reset_generation_conflict' },
      })
    }
    const pendingConfiguration = config({
      daily_quota_micros: 10_000,
      control_version: 1,
      weekly_used_micros: 0,
      weekly_window_start_ms: resetAt,
      quota_reset_generation: 1,
    })
    const premature = await post(object, '/configure', pendingConfiguration)
    expect(premature.status).toBe(409)
    await expect(premature.json()).resolves.toMatchObject({
      error: { code: 'subscription_quota_reset_requires_atomic_command' },
    })
    expect((await reserve(object, 'during-pending-weekly-reset', 1)).status).toBe(429)

    const applied = await post(object, '/configure-reset', {
      configuration: pendingConfiguration,
      reset: {
        schema_version: 1,
        mutation_id: '00000000-0000-4000-8000-000000000299',
        subscription_id: 'subscription-1',
        control_version: 1,
        windows: { daily: null, weekly: resetAt, monthly: null },
      },
    })
    expect(applied.status).toBe(200)
    expect((await reserve(object, 'after-weekly-reset', 1)).status).toBe(200)

    const second = await post(object, '/configure-reset', {
      configuration: config({
        daily_quota_micros: 10_000,
        control_version: 2,
        weekly_used_micros: 0,
        weekly_window_start_ms: resetAt,
        quota_reset_generation: 2,
      }),
      reset: {
        schema_version: 1,
        mutation_id: '00000000-0000-4000-8000-000000000399',
        subscription_id: 'subscription-1',
        control_version: 2,
        windows: { daily: null, weekly: resetAt, monthly: null },
      },
    })
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toMatchObject({
      profile: { quota_reset_generation: 2 },
    })
  })

  it('makes reserve, renew, cancel, and settle retries idempotent and rejects conflicts', async () => {
    const { object } = harness()
    await post(object, '/configure', config())

    expect((await reserve(object, 'cancelled', 40)).status).toBe(200)
    const reserveRetry = await post(object, '/reserve', {
      schema_version: 1,
      request_id: 'cancelled',
      amount_micros: 40,
      reservation_ttl_ms: 600_000,
    })
    await expect(reserveRetry.json()).resolves.toMatchObject({ idempotent: true })
    expect((await post(object, '/renew', {
      schema_version: 1,
      request_id: 'cancelled',
      renewal_sequence: 1,
      reservation_ttl_ms: 600_000,
    })).status).toBe(200)
    const renewRetry = await post(object, '/renew', {
      schema_version: 1,
      request_id: 'cancelled',
      renewal_sequence: 1,
      reservation_ttl_ms: 600_000,
    })
    await expect(renewRetry.json()).resolves.toMatchObject({ idempotent: true })
    expect((await post(object, '/cancel', { schema_version: 1, request_id: 'cancelled' })).status).toBe(200)
    const cancelRetry = await post(object, '/cancel', { schema_version: 1, request_id: 'cancelled' })
    await expect(cancelRetry.json()).resolves.toMatchObject({ idempotent: true })

    await reserve(object, 'settled', 40)
    expect((await settle(object, 'settled', 25)).status).toBe(200)
    const settleRetry = await settle(object, 'settled', 25)
    await expect(settleRetry.json()).resolves.toMatchObject({ idempotent: true })
    const settleConflict = await settle(object, 'settled', 24)
    expect(settleConflict.status).toBe(409)
    await expect(settleConflict.json()).resolves.toMatchObject({
      error: { code: 'settlement_conflict' },
    })
  })

  it('commits a grown absolute reservation target and holds the full quota', async () => {
    const { object } = harness()
    await post(object, '/configure', config())
    expect((await reserve(object, 'overdelivery', 40)).status).toBe(200)

    const committed = await ensure(object, 'overdelivery', 100)

    expect(committed.status).toBe(200)
    await expect(committed.json()).resolves.toMatchObject({
      idempotent: false,
      request: { reserved_micros: 100, committed: 1 },
    })
    expect((await reserve(object, 'blocked-by-commit', 1)).status).toBe(429)
  })

  it('recovers an expired reservation as committed liability in its original windows', async () => {
    const { object } = harness()
    await post(object, '/configure', config())
    expect((await reserve(object, 'expired-overdelivery', 40, 1_000)).status).toBe(200)
    vi.advanceTimersByTime(1_000)
    await object.alarm()

    const committed = await ensure(object, 'expired-overdelivery', 100)

    expect(committed.status).toBe(200)
    await expect(committed.json()).resolves.toMatchObject({
      idempotent: false,
      request: { status: 'expired', committed: 1, reserved_micros: 100 },
    })
    expect((await reserve(object, 'blocked-by-expired-commit', 1)).status).toBe(429)
  })

  it('does not expire, cancel, or tombstone a committed reservation', async () => {
    const { object, storage } = harness()
    await post(object, '/configure', config())
    expect((await reserve(object, 'durable-commit', 40, 1_000)).status).toBe(200)
    expect((await ensure(object, 'durable-commit', 100)).status).toBe(200)

    vi.advanceTimersByTime(1_000)
    await object.alarm()
    expect(storage.alarmWrites).toHaveLength(1)
    const cancellation = await post(object, '/cancel', {
      schema_version: 1,
      request_id: 'durable-commit',
    })
    expect(cancellation.status).toBe(409)

    vi.advanceTimersByTime(8 * DAY_MS)
    await object.alarm()
    const snapshot = await object.fetch(new Request('https://subscription-state.test/snapshot'))
    await expect(snapshot.json()).resolves.toMatchObject({
      requests: expect.arrayContaining([
        expect.objectContaining({ request_id: 'durable-commit', status: 'reserved', committed: 1 }),
      ]),
    })
  })

  it('makes commitment retries exact and preserves terminal request decisions', async () => {
    const { object } = harness()
    await post(object, '/configure', config({ daily_quota_micros: 1_000 }))

    await reserve(object, 'committed-retry', 40)
    expect((await ensure(object, 'committed-retry', 100)).status).toBe(200)
    await expect((await ensure(object, 'committed-retry', 100)).json()).resolves.toMatchObject({
      idempotent: true,
      request: { committed: 1, reserved_micros: 100 },
    })
    const conflictingCommit = await ensure(object, 'committed-retry', 101)
    expect(conflictingCommit.status).toBe(409)
    await expect(conflictingCommit.json()).resolves.toMatchObject({
      error: { code: 'reservation_commitment_conflict' },
    })

    await reserve(object, 'commit-cannot-shrink', 40)
    const shrinkingCommit = await ensure(object, 'commit-cannot-shrink', 39)
    expect(shrinkingCommit.status).toBe(409)
    await expect(shrinkingCommit.json()).resolves.toMatchObject({
      error: { code: 'reservation_commitment_decrease' },
    })

    await reserve(object, 'already-settled', 50)
    expect((await settle(object, 'already-settled', 30)).status).toBe(200)
    await expect((await ensure(object, 'already-settled', 30)).json()).resolves.toMatchObject({
      idempotent: true,
      request: { status: 'settled', settled_micros: 30 },
    })
    expect((await ensure(object, 'already-settled', 31)).status).toBe(409)

    await reserve(object, 'already-cancelled', 10)
    expect((await post(object, '/cancel', {
      schema_version: 1,
      request_id: 'already-cancelled',
    })).status).toBe(200)
    expect((await ensure(object, 'already-cancelled', 10)).status).toBe(409)
  })

  it('settles exactly the committed target after a quota reduction and preserves overage debt', async () => {
    const { object } = harness()
    await post(object, '/configure', config())
    await reserve(object, 'committed-overage', 40)
    expect((await ensure(object, 'committed-overage', 150)).status).toBe(200)

    const underSettlement = await settle(object, 'committed-overage', 149)
    expect(underSettlement.status).toBe(409)
    await expect(underSettlement.json()).resolves.toMatchObject({
      error: { code: 'settlement_commitment_conflict' },
    })

    expect((await post(object, '/configure', config({
      daily_quota_micros: 50,
      weekly_quota_micros: 50,
      monthly_quota_micros: 50,
      control_version: 1,
    }))).status).toBe(200)
    expect((await settle(object, 'committed-overage', 150)).status).toBe(200)

    const snapshot = await object.fetch(new Request('https://subscription-state.test/snapshot'))
    await expect(snapshot.json()).resolves.toMatchObject({
      windows: expect.arrayContaining([
        expect.objectContaining({ kind: 'daily', used_micros: 150, reserved_micros: 0 }),
        expect.objectContaining({ kind: 'weekly', used_micros: 150, reserved_micros: 0 }),
        expect.objectContaining({ kind: 'monthly', used_micros: 150, reserved_micros: 0 }),
      ]),
    })
    expect((await reserve(object, 'blocked-by-settled-overage', 1)).status).toBe(429)
  })

  it('settles a committed request against its captured windows after expiry and a new term', async () => {
    const { object } = harness()
    const oldExpiresAt = Date.now() + 1_000
    const oldStartsAt = oldExpiresAt - DAY_MS
    await post(object, '/configure', config({
      starts_at_ms: oldStartsAt,
      expires_at_ms: oldExpiresAt,
      daily_anchor_ms: oldStartsAt,
      daily_window_start_ms: oldStartsAt,
      weekly_window_start_ms: oldStartsAt,
      monthly_window_start_ms: oldStartsAt,
    }))
    await reserve(object, 'old-term-commit', 40, 1_000)
    expect((await ensure(object, 'old-term-commit', 150)).status).toBe(200)

    vi.advanceTimersByTime(1_000)
    await object.alarm()
    const newStartsAt = Date.now()
    expect((await post(object, '/configure', config({
      starts_at_ms: newStartsAt,
      expires_at_ms: newStartsAt + 31 * DAY_MS,
      control_version: 1,
      quota_reset_epoch: 1,
    }))).status).toBe(200)

    const settlement = await settle(object, 'old-term-commit', 150)
    expect(settlement.status).toBe(200)
    await expect(settlement.json()).resolves.toMatchObject({
      request: {
        status: 'settled',
        committed: 1,
        settled_micros: 150,
        term_generation: 1,
        quota_reset_epoch: 0,
      },
    })
    const snapshot = await object.fetch(new Request('https://subscription-state.test/snapshot'))
    await expect(snapshot.json()).resolves.toMatchObject({
      profile: { term_generation: 2, quota_reset_epoch: 1 },
      windows: expect.arrayContaining([
        expect.objectContaining({ kind: 'daily', used_micros: 0, reserved_micros: 0 }),
      ]),
    })
  })

  it('reclaims expired reservations by alarm and releases all quota dimensions', async () => {
    const { object, storage } = harness()
    await post(object, '/configure', config({
      daily_quota_micros: 100,
      weekly_quota_micros: 100,
      monthly_quota_micros: 100,
    }))
    expect((await reserve(object, 'abandoned', 100, 1_000)).status).toBe(200)
    expect(storage.alarm).toBe(Date.now() + 1_000)
    vi.advanceTimersByTime(1_000)
    await object.alarm()
    expect((await reserve(object, 'replacement', 100)).status).toBe(200)
  })

  it('settles an expired reservation after recovery delay and keeps the replay exactly once', async () => {
    const { object, queued } = harness()
    await post(object, '/configure', config())
    expect((await reserve(object, 'delayed-settlement', 100, 1_000)).status).toBe(200)

    vi.advanceTimersByTime(1_000)
    await object.alarm()

    const event = usageEvent('delayed-settlement', 40)
    const delayed = await post(object, '/settle', {
      schema_version: 1,
      request_id: 'delayed-settlement',
      amount_micros: 40,
      usage_event: event,
    })
    expect(delayed.status).toBe(200)
    await expect(delayed.json()).resolves.toMatchObject({
      idempotent: false,
      request: { status: 'settled', settled_micros: 40 },
    })

    const snapshot = await object.fetch(new Request('https://subscription-state.test/snapshot'))
    await expect(snapshot.json()).resolves.toMatchObject({
      windows: expect.arrayContaining([
        expect.objectContaining({ kind: 'daily', used_micros: 40 }),
        expect.objectContaining({ kind: 'weekly', used_micros: 40 }),
        expect.objectContaining({ kind: 'monthly', used_micros: 40 }),
      ]),
    })

    const replay = await post(object, '/settle', {
      schema_version: 1,
      request_id: 'delayed-settlement',
      amount_micros: 40,
      usage_event: event,
    })
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true })
    expect(queued).toHaveLength(2)
    expect(queued).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: 'usage:delayed-settlement' }),
      expect.objectContaining({
        event_id: 'subscription-usage:delayed-settlement',
        payload: expect.objectContaining({ amount_micros: 40 }),
      }),
    ]))
  })

  it('keeps a same-day expired-term late settlement in the old term and replays it exactly once', async () => {
    const { object, storage, queued } = harness()
    const oldExpiresAt = Date.now() + 1_000
    const oldStartsAt = oldExpiresAt - 31 * DAY_MS
    await post(object, '/configure', config({
      starts_at_ms: oldStartsAt,
      expires_at_ms: oldExpiresAt,
      daily_window_start_ms: Date.UTC(2026, 8, 1),
      weekly_window_start_ms: oldStartsAt + 28 * DAY_MS,
      monthly_window_start_ms: oldStartsAt + 30 * DAY_MS,
    }))
    expect((await reserve(object, 'old-term-late', 100, 1_000)).status).toBe(200)

    vi.advanceTimersByTime(1_000)
    await object.alarm()
    const newStartsAt = Date.now()
    expect((await post(object, '/configure', config({
      starts_at_ms: newStartsAt,
      expires_at_ms: newStartsAt + 31 * DAY_MS,
      daily_window_start_ms: Date.UTC(2026, 8, 1),
      weekly_window_start_ms: newStartsAt,
      monthly_window_start_ms: newStartsAt,
      control_version: 1,
      quota_reset_epoch: 1,
    }))).status).toBe(200)

    const event = usageEvent('old-term-late', 40)
    const late = await post(object, '/settle', {
      schema_version: 1,
      request_id: 'old-term-late',
      amount_micros: 40,
      usage_event: event,
    })
    expect(late.status).toBe(200)
    await expect(late.json()).resolves.toMatchObject({ idempotent: false })

    const snapshot = await object.fetch(new Request('https://subscription-state.test/snapshot'))
    await expect(snapshot.json()).resolves.toMatchObject({
      profile: { starts_at_ms: newStartsAt, term_generation: 2, quota_reset_epoch: 1 },
      windows: expect.arrayContaining([
        expect.objectContaining({ kind: 'daily', start_ms: Date.UTC(2026, 8, 1), used_micros: 0 }),
      ]),
      requests: expect.arrayContaining([
        expect.objectContaining({
          request_id: 'old-term-late',
          status: 'settled',
          settled_micros: 40,
          term_generation: 1,
          quota_reset_epoch: 0,
        }),
      ]),
    })
    expect(storage.database.prepare(
      `SELECT used_micros FROM subscription_term_windows
        WHERE kind = 'daily' AND start_ms = ? ORDER BY term_generation`,
    ).all(Date.UTC(2026, 8, 1))).toEqual([
      { used_micros: 40 },
      { used_micros: 0 },
    ])
    expect(queued).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: 'usage:old-term-late' }),
      expect.objectContaining({
        event_id: 'subscription-usage:old-term-late',
        payload: expect.objectContaining({ quota_reset_epoch: 0 }),
      }),
    ]))

    const replay = await post(object, '/settle', {
      schema_version: 1,
      request_id: 'old-term-late',
      amount_micros: 40,
      usage_event: event,
    })
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true })
    expect(queued).toHaveLength(2)
  })

  it('settles actual cost, releases the remainder, and emits one idempotent projection event', async () => {
    const { object, queued } = harness()
    await post(object, '/configure', config())
    await reserve(object, 'request-1', 100)
    expect((await settle(object, 'request-1', 40)).status).toBe(200)
    expect((await reserve(object, 'request-2', 60)).status).toBe(200)
    await settle(object, 'request-1', 40)

    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({
      event_id: 'subscription-usage:request-1',
      event_type: 'subscription.usage.settled.v1',
      payload: {
        request_id: 'request-1',
        subscription_id: 'subscription-1',
        amount_micros: 40,
      },
    })
  })

  it('rejects a usage event attributed to a different billing ledger without settling', async () => {
    const { object } = harness()
    await post(object, '/configure', config())
    await reserve(object, 'request-1', 40)
    const mismatched = await post(object, '/settle', {
      schema_version: 1,
      request_id: 'request-1',
      amount_micros: 40,
      usage_event: {
        schema_version: 1,
        event_id: 'usage:request-1',
        event_type: 'usage.settled.v1',
        occurred_at_ms: Date.now(),
        aggregate_type: 'user',
        aggregate_id: 'user-1',
        payload: {
          request_id: 'request-1',
          user_id: 'user-1',
          group_id: 'group-1',
          billing_type: 'subscription',
          subscription_id: 'another-subscription',
          amount_micros: 40,
        },
      },
    })
    expect(mismatched.status).toBe(400)
    await expect(mismatched.json()).resolves.toMatchObject({
      error: { code: 'usage_event_billing_mismatch' },
    })
    expect((await settle(object, 'request-1', 40)).status).toBe(200)
  })
})
