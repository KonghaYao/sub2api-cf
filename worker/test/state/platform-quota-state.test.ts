import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Node SQLite backs only this Durable Object public-contract fixture.
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { DatabaseSync } from 'node:sqlite'

import { ApiKeyLimitDO } from '../../src/state/api-key-limit-do'

const DAY_MS = 86_400_000

class TestSqlStorage {
  readonly database = new DatabaseSync(':memory:')
  alarm: number | null = null
  readonly sql = {
    exec: (query: string, ...params: unknown[]): object[] =>
      this.database.prepare(query).all(...params) as object[],
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
  async setAlarm(timestamp: number): Promise<void> { this.alarm = timestamp }
  async deleteAlarm(): Promise<void> { this.alarm = null }
}

function harness(storage = new TestSqlStorage()): { object: ApiKeyLimitDO; storage: TestSqlStorage } {
  const state = {
    storage,
    blockConcurrencyWhile: (callback: () => Promise<void>) => callback(),
  } as unknown as DurableObjectState
  return { object: new ApiKeyLimitDO(state), storage }
}

function post(
  object: ApiKeyLimitDO,
  path: '/platform-quota/configure' | '/platform-quota/reserve' |
    '/platform-quota/ensure' | '/platform-quota/renew' |
    '/platform-quota/settle' | '/platform-quota/cancel' | '/reclaim',
  body: Record<string, unknown>,
): Promise<Response> {
  return object.fetch(new Request(`https://api-key-limit.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schema_version: 1, ...body }),
  }))
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: 'user-1',
    platform: 'openai',
    enabled: true,
    control_version: 1,
    daily_limit_micros: 100,
    weekly_limit_micros: 100,
    monthly_limit_micros: 100,
    daily_used_micros: 0,
    weekly_used_micros: 0,
    monthly_used_micros: 0,
    daily_window_start_ms: null,
    weekly_window_start_ms: null,
    monthly_window_start_ms: null,
    daily_reset_epoch: 0,
    weekly_reset_epoch: 0,
    monthly_reset_epoch: 0,
    ...overrides,
  }
}

function reserve(
  object: ApiKeyLimitDO,
  requestId: string,
  amountMicros: number,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return post(object, '/platform-quota/reserve', {
    request_id: requestId,
    user_id: 'user-1',
    platform: 'openai',
    control_version: 1,
    amount_micros: amountMicros,
    reservation_ttl_ms: 60_000,
    ...overrides,
  })
}

function ensure(
  object: ApiKeyLimitDO,
  requestId: string,
  targetAmountMicros: number,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return post(object, '/platform-quota/ensure', {
    request_id: requestId,
    user_id: 'user-1',
    platform: 'openai',
    target_amount_micros: targetAmountMicros,
    ...overrides,
  })
}

describe('ApiKeyLimitDO platform quota contract', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-06T12:00:00.000Z')) // Sunday
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('pins a shard to one owner and keeps platforms isolated', async () => {
    const { object } = harness()
    expect((await post(object, '/platform-quota/configure', config())).status).toBe(200)
    expect((await post(object, '/platform-quota/configure', config({
      platform: 'anthropic',
    }))).status).toBe(200)

    const wrongOwner = await post(object, '/platform-quota/configure', config({
      user_id: 'user-2',
      platform: 'gemini',
    }))
    expect(wrongOwner.status).toBe(409)
    await expect(wrongOwner.json()).resolves.toMatchObject({
      error: { code: 'platform_quota_owner_conflict' },
    })

    await reserve(object, 'openai-spend', 100)
    expect((await reserve(object, 'openai-blocked', 1)).status).toBe(429)
    expect((await reserve(object, 'anthropic-independent', 100, {
      platform: 'anthropic',
    })).status).toBe(200)
  })

  it('atomically prevents concurrent oversell and settles exactly once', async () => {
    const { object } = harness()
    await post(object, '/platform-quota/configure', config())
    const [first, second] = await Promise.all([
      reserve(object, 'spend-1', 60),
      reserve(object, 'spend-2', 60),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 429])
    const acceptedId = first.status === 200 ? 'spend-1' : 'spend-2'

    const settled = await post(object, '/platform-quota/settle', {
      request_id: acceptedId,
      user_id: 'user-1',
      platform: 'openai',
      amount_micros: 50,
    })
    expect(settled.status).toBe(200)
    await expect(settled.json()).resolves.toMatchObject({
      idempotent: false,
      reservation: { status: 'settled', settled_micros: 50 },
      usage: {
        user_id: 'user-1',
        platform: 'openai',
        daily: { settled_micros: 50 },
        weekly: { settled_micros: 50 },
        monthly: { settled_micros: 50 },
      },
    })
    const replay = await post(object, '/platform-quota/settle', {
      request_id: acceptedId,
      user_id: 'user-1',
      platform: 'openai',
      amount_micros: 50,
    })
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true })

    const conflict = await post(object, '/platform-quota/settle', {
      request_id: acceptedId,
      user_id: 'user-1',
      platform: 'openai',
      amount_micros: 49,
    })
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'platform_quota_settlement_conflict' },
    })
  })

  it('commits a grown absolute target beyond every current platform window limit', async () => {
    const { object } = harness()
    await post(object, '/platform-quota/configure', config())
    await reserve(object, 'overdelivery', 40)

    const committed = await ensure(object, 'overdelivery', 120)

    expect(committed.status).toBe(200)
    await expect(committed.json()).resolves.toMatchObject({
      idempotent: false,
      reservation: {
        request_id: 'overdelivery',
        status: 'reserved',
        reserved_micros: 120,
        committed: 1,
      },
      usage: {
        daily: { active_reserved_micros: 120 },
        weekly: { active_reserved_micros: 120 },
        monthly: { active_reserved_micros: 120 },
      },
    })
    expect((await reserve(object, 'blocked-by-commit', 1)).status).toBe(429)
  })

  it('replays one platform target and rejects changed, cancelled, or settled conflicts', async () => {
    const { object } = harness()
    await post(object, '/platform-quota/configure', config())
    await reserve(object, 'ensure-replay', 40)
    expect((await ensure(object, 'ensure-replay', 80)).status).toBe(200)
    const replay = await ensure(object, 'ensure-replay', 80)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true })
    const changed = await ensure(object, 'ensure-replay', 79)
    expect(changed.status).toBe(409)
    await expect(changed.json()).resolves.toMatchObject({
      error: { code: 'platform_quota_ensure_conflict' },
    })

    await reserve(object, 'cancelled-ensure', 10)
    await post(object, '/platform-quota/cancel', {
      request_id: 'cancelled-ensure', user_id: 'user-1', platform: 'openai',
    })
    expect((await ensure(object, 'cancelled-ensure', 10)).status).toBe(409)

    await reserve(object, 'settled-ensure', 10)
    await post(object, '/platform-quota/settle', {
      request_id: 'settled-ensure', user_id: 'user-1', platform: 'openai', amount_micros: 7,
    })
    const settledReplay = await ensure(object, 'settled-ensure', 7)
    expect(settledReplay.status).toBe(200)
    await expect(settledReplay.json()).resolves.toMatchObject({ idempotent: true })
    const settledConflict = await ensure(object, 'settled-ensure', 8)
    expect(settledConflict.status).toBe(409)
    await expect(settledConflict.json()).resolves.toMatchObject({
      error: { code: 'platform_quota_ensure_conflict' },
    })

    await reserve(object, 'cannot-shrink', 10)
    const belowReservation = await ensure(object, 'cannot-shrink', 9)
    expect(belowReservation.status).toBe(409)
    await expect(belowReservation.json()).resolves.toMatchObject({
      error: { code: 'platform_quota_ensure_below_reservation' },
    })
  })

  it('commits an expired platform reservation and makes it non-cancellable', async () => {
    const { object } = harness()
    await post(object, '/platform-quota/configure', config())
    await reserve(object, 'expired-commit', 40, { reservation_ttl_ms: 1_000 })
    vi.advanceTimersByTime(1_001)
    await post(object, '/reclaim', {})

    const committed = await ensure(object, 'expired-commit', 120)
    expect(committed.status).toBe(200)
    await expect(committed.json()).resolves.toMatchObject({
      reservation: { status: 'expired', reserved_micros: 120, committed: 1 },
      usage: {
        daily: { active_reserved_micros: 120 },
        weekly: { active_reserved_micros: 120 },
        monthly: { active_reserved_micros: 120 },
      },
    })
    const cancelled = await post(object, '/platform-quota/cancel', {
      request_id: 'expired-commit', user_id: 'user-1', platform: 'openai',
    })
    expect(cancelled.status).toBe(409)
    await expect(cancelled.json()).resolves.toMatchObject({
      error: { code: 'platform_quota_invalid_transition' },
    })
  })

  it('settles a committed platform reservation only at its target and blocks new quota afterward', async () => {
    const { object } = harness()
    await post(object, '/platform-quota/configure', config())
    await reserve(object, 'exact-commit', 40)
    await ensure(object, 'exact-commit', 120)

    const wrongAmount = await post(object, '/platform-quota/settle', {
      request_id: 'exact-commit', user_id: 'user-1', platform: 'openai', amount_micros: 119,
    })
    expect(wrongAmount.status).toBe(409)
    await expect(wrongAmount.json()).resolves.toMatchObject({
      error: { code: 'platform_quota_settlement_conflict' },
    })

    const settled = await post(object, '/platform-quota/settle', {
      request_id: 'exact-commit', user_id: 'user-1', platform: 'openai', amount_micros: 120,
    })
    expect(settled.status).toBe(200)
    await expect(settled.json()).resolves.toMatchObject({
      reservation: { status: 'settled', settled_micros: 120, committed: 1 },
      usage: {
        daily: { settled_micros: 120, active_reserved_micros: 0 },
        weekly: { settled_micros: 120, active_reserved_micros: 0 },
        monthly: { settled_micros: 120, active_reserved_micros: 0 },
      },
    })
    expect((await reserve(object, 'blocked-after-overlimit', 0)).status).toBe(429)
  })

  it('retains a committed platform target permanently and keeps settlement in its captured windows', async () => {
    const { object } = harness()
    await post(object, '/platform-quota/configure', config())
    await reserve(object, 'permanent-commit', 40, { reservation_ttl_ms: 1_000 })
    await ensure(object, 'permanent-commit', 120)

    vi.advanceTimersByTime(31 * DAY_MS)
    const reclaimed = await post(object, '/reclaim', {})
    await expect(reclaimed.json()).resolves.toMatchObject({ platform_quota_reclaimed: 0 })

    const settled = await post(object, '/platform-quota/settle', {
      request_id: 'permanent-commit', user_id: 'user-1', platform: 'openai', amount_micros: 120,
    })
    expect(settled.status).toBe(200)
    await expect(settled.json()).resolves.toMatchObject({
      reservation: { status: 'settled', settled_micros: 120, committed: 1 },
      usage: {
        daily: { settled_micros: 0 },
        weekly: { settled_micros: 0 },
        monthly: { settled_micros: 0 },
      },
    })
    const replay = await ensure(object, 'permanent-commit', 120)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true })
  })

  it('keeps committed platform settlement attached to its captured reset epochs', async () => {
    const { object } = harness()
    await post(object, '/platform-quota/configure', config())
    await reserve(object, 'old-epoch-commit', 40)
    await ensure(object, 'old-epoch-commit', 120)

    await post(object, '/platform-quota/configure', config({
      control_version: 2,
      daily_reset_epoch: 1,
      weekly_reset_epoch: 1,
      monthly_reset_epoch: 1,
    }))
    expect((await reserve(object, 'new-epoch', 100, { control_version: 2 })).status).toBe(200)

    const oldSettlement = await post(object, '/platform-quota/settle', {
      request_id: 'old-epoch-commit', user_id: 'user-1', platform: 'openai', amount_micros: 120,
    })
    expect(oldSettlement.status).toBe(200)
    await expect(oldSettlement.json()).resolves.toMatchObject({
      usage: {
        daily: { reset_epoch: 1, settled_micros: 0, active_reserved_micros: 100 },
        weekly: { reset_epoch: 1, settled_micros: 0, active_reserved_micros: 100 },
        monthly: { reset_epoch: 1, settled_micros: 0, active_reserved_micros: 100 },
      },
    })
    expect((await post(object, '/platform-quota/settle', {
      request_id: 'new-epoch', user_id: 'user-1', platform: 'openai', amount_micros: 100,
    })).status).toBe(200)
  })

  it.each([
    ['daily', DAY_MS],
    ['weekly', 7 * DAY_MS],
    ['monthly', 30 * DAY_MS],
  ] as const)('opens a fresh %s window exactly at its boundary', async (kind, duration) => {
    const { object } = harness()
    const now = Date.now()
    const starts = kind === 'daily'
      ? Date.UTC(2026, 8, 6)
      : kind === 'weekly'
        ? Date.UTC(2026, 7, 31) // prior Monday; next boundary is Sep 7
        : now - duration + 1
    await post(object, '/platform-quota/configure', config({
      [`${kind}_used_micros`]: 100,
      [`${kind}_window_start_ms`]: starts,
      daily_limit_micros: kind === 'daily' ? 100 : null,
      weekly_limit_micros: kind === 'weekly' ? 100 : null,
      monthly_limit_micros: kind === 'monthly' ? 100 : null,
    }))
    expect((await reserve(object, `before-${kind}`, 1)).status).toBe(429)

    const boundary = kind === 'daily'
      ? starts + duration
      : kind === 'weekly'
        ? starts + duration
        : starts + duration
    vi.setSystemTime(boundary)
    expect((await reserve(object, `at-${kind}`, 100)).status).toBe(200)
  })

  it('makes cancellation replay-safe and returns reserved capacity immediately', async () => {
    const { object } = harness()
    await post(object, '/platform-quota/configure', config())
    await reserve(object, 'cancel-me', 100)
    const first = await post(object, '/platform-quota/cancel', {
      request_id: 'cancel-me', user_id: 'user-1', platform: 'openai',
    })
    const replay = await post(object, '/platform-quota/cancel', {
      request_id: 'cancel-me', user_id: 'user-1', platform: 'openai',
    })
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true })
    expect((await reserve(object, 'capacity-returned', 100)).status).toBe(200)
  })

  it('renews a reservation monotonically so long-running provider work keeps its hold', async () => {
    const { object } = harness()
    await post(object, '/platform-quota/configure', config())
    await reserve(object, 'long-running', 100)
    vi.advanceTimersByTime(30_000)
    const renewed = await post(object, '/platform-quota/renew', {
      request_id: 'long-running', user_id: 'user-1', platform: 'openai',
      renewal_sequence: 1, reservation_ttl_ms: 60_000,
    })
    expect(renewed.status).toBe(200)
    await expect(renewed.json()).resolves.toMatchObject({
      idempotent: false,
      reservation: { renewal_sequence: 1, reservation_expires_at_ms: Date.now() + 60_000 },
    })
    const replay = await post(object, '/platform-quota/renew', {
      request_id: 'long-running', user_id: 'user-1', platform: 'openai',
      renewal_sequence: 1, reservation_ttl_ms: 60_000,
    })
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true })
    const next = await post(object, '/platform-quota/renew', {
      request_id: 'long-running', user_id: 'user-1', platform: 'openai',
      renewal_sequence: 2, reservation_ttl_ms: 60_000,
    })
    expect(next.status).toBe(200)
    const delayedReplay = await post(object, '/platform-quota/renew', {
      request_id: 'long-running', user_id: 'user-1', platform: 'openai',
      renewal_sequence: 1, reservation_ttl_ms: 30_000,
    })
    expect(delayedReplay.status).toBe(200)
    await expect(delayedReplay.json()).resolves.toMatchObject({
      idempotent: true,
      reservation: { renewal_sequence: 2 },
    })
    const skipped = await post(object, '/platform-quota/renew', {
      request_id: 'long-running', user_id: 'user-1', platform: 'openai',
      renewal_sequence: 4, reservation_ttl_ms: 60_000,
    })
    expect(skipped.status).toBe(409)
    await expect(skipped.json()).resolves.toMatchObject({
      error: { code: 'platform_quota_renewal_out_of_order' },
    })
  })
})
