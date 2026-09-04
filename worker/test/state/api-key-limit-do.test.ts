import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Node SQLite backs only this Durable Object contract fixture.
// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { DatabaseSync } from 'node:sqlite'

import { ApiKeyLimitDO } from '../../src/state/api-key-limit-do'

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

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null
  }
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
  path:
    | '/admit'
    | '/renew'
    | '/release'
    | '/reclaim'
    | '/monetary/configure'
    | '/monetary/reserve'
    | '/monetary/settle'
    | '/monetary/cancel',
  body: Record<string, unknown>,
): Promise<Response> {
  return object.fetch(new Request(`https://api-key-limit.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schema_version: 1, ...body }),
  }))
}

function monetaryConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api_key_id: 'key-1',
    control_version: 1,
    total_limit_micros: 100,
    limit_5h_micros: 0,
    limit_1d_micros: 0,
    limit_7d_micros: 0,
    total_used_micros: 0,
    usage_5h_micros: 0,
    usage_1d_micros: 0,
    usage_7d_micros: 0,
    window_5h_start_ms: null,
    window_1d_start_ms: null,
    window_7d_start_ms: null,
    ...overrides,
  }
}

function monetaryReserve(
  object: ApiKeyLimitDO,
  requestId: string,
  amountMicros: number,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return post(object, '/monetary/reserve', {
    request_id: requestId,
    api_key_id: 'key-1',
    control_version: 1,
    amount_micros: amountMicros,
    reservation_ttl_ms: 60_000,
    ...overrides,
  })
}

function monetarySettle(
  object: ApiKeyLimitDO,
  requestId: string,
  amountMicros: number,
  apiKeyId = 'key-1',
): Promise<Response> {
  return post(object, '/monetary/settle', {
    request_id: requestId,
    api_key_id: apiKeyId,
    amount_micros: amountMicros,
  })
}

function monetaryCancel(
  object: ApiKeyLimitDO,
  requestId: string,
  apiKeyId = 'key-1',
): Promise<Response> {
  return post(object, '/monetary/cancel', {
    request_id: requestId,
    api_key_id: apiKeyId,
  })
}

function admission(
  object: ApiKeyLimitDO,
  requestId: string,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return post(object, '/admit', {
    request_id: requestId,
    api_key_id: 'key-1',
    group_id: 'group-1',
    user_rpm_limit: 0,
    group_rpm_limit: 0,
    concurrency_limit: 0,
    lease_ttl_ms: 60_000,
    ...overrides,
  })
}

describe('ApiKeyLimitDO admission contract', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T12:34:30.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('atomically admits no more than the fixed-minute RPM budget under concurrency', async () => {
    const { object } = harness()

    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      admission(object, `request-${index}`, { user_rpm_limit: 7 }),
    ))

    expect(responses.filter((response) => response.status === 200)).toHaveLength(7)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(13)
    const rejected = responses.find((response) => response.status === 429)!
    expect(rejected.headers.get('retry-after')).toBe('30')
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: 'user_rpm_limit_exceeded' },
      retry_after_seconds: 30,
    })
  })

  it('enforces the user ceiling and the override-or-group window independently', async () => {
    const { object } = harness()

    expect((await admission(object, 'first', {
      user_rpm_limit: 2,
      group_rpm_limit: 1,
    })).status).toBe(200)
    const groupBlocked = await admission(object, 'second', {
      user_rpm_limit: 2,
      group_rpm_limit: 1,
    })
    expect(groupBlocked.status).toBe(429)
    await expect(groupBlocked.json()).resolves.toMatchObject({
      error: { code: 'group_rpm_limit_exceeded' },
    })

    // rpm_override=0 is projected as group_rpm_limit=0: group exempt, user ceiling remains.
    expect((await admission(object, 'second', {
      user_rpm_limit: 2,
      group_rpm_limit: 0,
    })).status).toBe(200)
    const userBlocked = await admission(object, 'third', {
      user_rpm_limit: 2,
      group_rpm_limit: 0,
    })
    expect(userBlocked.status).toBe(429)
    await expect(userBlocked.json()).resolves.toMatchObject({
      error: { code: 'user_rpm_limit_exceeded' },
    })
  })

  it('shares user-wide ceilings across distinct API keys and groups', async () => {
    const concurrency = harness().object
    expect((await admission(concurrency, 'key-one-active', {
      api_key_id: 'key-1',
      group_id: 'group-1',
      concurrency_limit: 1,
    })).status).toBe(200)
    const otherKeyBlocked = await admission(concurrency, 'key-two-blocked', {
      api_key_id: 'key-2',
      group_id: 'group-2',
      concurrency_limit: 1,
    })
    expect(otherKeyBlocked.status).toBe(429)
    await expect(otherKeyBlocked.json()).resolves.toMatchObject({
      error: { code: 'user_concurrency_limit_exceeded' },
    })

    const rpm = harness().object
    expect((await admission(rpm, 'key-one-rpm', {
      api_key_id: 'key-1',
      group_id: 'group-1',
      user_rpm_limit: 1,
    })).status).toBe(200)
    const otherGroupBlocked = await admission(rpm, 'key-two-rpm', {
      api_key_id: 'key-2',
      group_id: 'group-2',
      user_rpm_limit: 1,
    })
    expect(otherGroupBlocked.status).toBe(429)
    await expect(otherGroupBlocked.json()).resolves.toMatchObject({
      error: { code: 'user_rpm_limit_exceeded' },
    })
  })

  it('makes admission and release replay-safe without reopening a completed lease', async () => {
    const { object } = harness()

    const first = await admission(object, 'same-request', {
      user_rpm_limit: 1,
      concurrency_limit: 1,
    })
    const replay = await admission(object, 'same-request', {
      user_rpm_limit: 1,
      concurrency_limit: 1,
    })
    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      idempotent: true,
      admitted: true,
      lease: { request_id: 'same-request', status: 'active' },
    })

    expect((await post(object, '/release', { request_id: 'same-request' })).status).toBe(200)
    const repeatedRelease = await post(object, '/release', { request_id: 'same-request' })
    expect(repeatedRelease.status).toBe(200)
    await expect(repeatedRelease.json()).resolves.toMatchObject({ idempotent: true })

    const completedReplay = await admission(object, 'same-request', {
      user_rpm_limit: 1,
      concurrency_limit: 1,
    })
    expect(completedReplay.status).toBe(409)
    await expect(completedReplay.json()).resolves.toMatchObject({
      error: { code: 'admission_already_released' },
    })
  })

  it('returns released capacity immediately and reclaims a crashed lease at expiry', async () => {
    const { object } = harness()

    expect((await admission(object, 'active', {
      concurrency_limit: 1,
      lease_ttl_ms: 1_000,
    })).status).toBe(200)
    const blocked = await admission(object, 'blocked', { concurrency_limit: 1 })
    expect(blocked.status).toBe(429)
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: 'user_concurrency_limit_exceeded' },
    })

    expect((await post(object, '/release', { request_id: 'active' })).status).toBe(200)
    expect((await admission(object, 'after-release', { concurrency_limit: 1 })).status).toBe(200)
    expect((await post(object, '/release', { request_id: 'after-release' })).status).toBe(200)

    expect((await admission(object, 'crashed', {
      concurrency_limit: 1,
      lease_ttl_ms: 1_000,
    })).status).toBe(200)
    vi.advanceTimersByTime(1_001)
    expect((await admission(object, 'after-expiry', { concurrency_limit: 1 })).status).toBe(200)

    const snapshot = await object.fetch(new Request('https://api-key-limit.test/snapshot'))
    await expect(snapshot.json()).resolves.toMatchObject({
      active_concurrency: 1,
      leases: expect.arrayContaining([
        expect.objectContaining({ request_id: 'crashed', status: 'expired' }),
        expect.objectContaining({ request_id: 'after-expiry', status: 'active' }),
      ]),
    })
  })

  it('reclaims an expired lease while reconstructing after an isolate restart', async () => {
    const first = harness()
    expect((await admission(first.object, 'crashed-before-restart', {
      concurrency_limit: 1,
      lease_ttl_ms: 1_000,
    })).status).toBe(200)

    vi.advanceTimersByTime(1_001)
    const restarted = harness(first.storage)
    expect((await admission(restarted.object, 'after-restart', {
      concurrency_limit: 1,
    })).status).toBe(200)
    const snapshot = await restarted.object.fetch(new Request('https://api-key-limit.test/snapshot'))
    await expect(snapshot.json()).resolves.toMatchObject({
      active_concurrency: 1,
      leases: expect.arrayContaining([
        expect.objectContaining({ request_id: 'crashed-before-restart', status: 'expired' }),
      ]),
    })
  })

  it('renews an active lease with an ordered idempotency sequence', async () => {
    const { object } = harness()
    expect((await admission(object, 'stream', {
      concurrency_limit: 1,
      lease_ttl_ms: 1_000,
    })).status).toBe(200)

    vi.advanceTimersByTime(500)
    const renewed = await post(object, '/renew', {
      request_id: 'stream',
      renewal_sequence: 1,
      lease_ttl_ms: 1_000,
    })
    expect(renewed.status).toBe(200)
    const replay = await post(object, '/renew', {
      request_id: 'stream',
      renewal_sequence: 1,
      lease_ttl_ms: 1_000,
    })
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true })

    const conflictingReplay = await post(object, '/renew', {
      request_id: 'stream',
      renewal_sequence: 1,
      lease_ttl_ms: 2_000,
    })
    expect(conflictingReplay.status).toBe(409)
    await expect(conflictingReplay.json()).resolves.toMatchObject({
      error: { code: 'renewal_conflict' },
    })
  })

  it('starts a fresh fixed window exactly at the next minute boundary', async () => {
    const { object } = harness()
    expect((await admission(object, 'minute-one', { user_rpm_limit: 1 })).status).toBe(200)
    expect((await admission(object, 'same-minute', { user_rpm_limit: 1 })).status).toBe(429)

    vi.setSystemTime(new Date('2026-09-04T12:35:00.000Z'))
    expect((await admission(object, 'minute-two', { user_rpm_limit: 1 })).status).toBe(200)
  })
})

describe('ApiKeyLimitDO monetary quota contract', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T12:34:30.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('atomically prevents concurrent reservations from overselling a key total', async () => {
    const { object } = harness()
    expect((await post(object, '/monetary/configure', monetaryConfig())).status).toBe(200)

    const [first, second] = await Promise.all([
      monetaryReserve(object, 'spend-1', 60),
      monetaryReserve(object, 'spend-2', 60),
    ])

    expect([first.status, second.status].sort()).toEqual([200, 429])
    const rejected = first.status === 429 ? first : second
    await expect(rejected.json()).resolves.toMatchObject({
      reserved: false,
      error: { code: 'api_key_quota_exceeded' },
    })
  })

  it('settles a reservation exactly once and rejects a conflicting replay', async () => {
    const { object } = harness()
    await post(object, '/monetary/configure', monetaryConfig())
    await monetaryReserve(object, 'settled-request', 80)

    const settled = await monetarySettle(object, 'settled-request', 50)
    expect(settled.status).toBe(200)
    await expect(settled.json()).resolves.toMatchObject({
      idempotent: false,
      reservation: { status: 'settled', settled_micros: 50 },
      usage: { total_settled_micros: 50 },
    })
    const replay = await monetarySettle(object, 'settled-request', 50)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true })

    const conflictingReplay = await monetarySettle(object, 'settled-request', 49)
    expect(conflictingReplay.status).toBe(409)
    await expect(conflictingReplay.json()).resolves.toMatchObject({
      error: { code: 'api_key_monetary_settlement_conflict' },
    })
    expect((await monetaryReserve(object, 'over-remaining', 51)).status).toBe(429)
  })

  it('idempotently cancels a reservation and immediately returns its capacity', async () => {
    const { object } = harness()
    await post(object, '/monetary/configure', monetaryConfig())
    await monetaryReserve(object, 'cancelled-request', 80)

    const cancelled = await monetaryCancel(object, 'cancelled-request')
    expect(cancelled.status).toBe(200)
    await expect(cancelled.json()).resolves.toMatchObject({
      idempotent: false,
      reservation: { status: 'cancelled', settled_micros: null },
    })
    const replay = await monetaryCancel(object, 'cancelled-request')
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({ idempotent: true })

    const lateSettlement = await monetarySettle(object, 'cancelled-request', 80)
    expect(lateSettlement.status).toBe(409)
    await expect(lateSettlement.json()).resolves.toMatchObject({
      error: { code: 'api_key_monetary_invalid_transition' },
    })
    expect((await monetaryReserve(object, 'capacity-returned', 100)).status).toBe(200)
  })

  it.each([
    ['5h', 5 * 60 * 60_000, 'api_key_rate_limit_5h_exceeded'],
    ['1d', 24 * 60 * 60_000, 'api_key_rate_limit_1d_exceeded'],
    ['7d', 7 * 24 * 60 * 60_000, 'api_key_rate_limit_7d_exceeded'],
  ] as const)(
    'imports and enforces an active %s rolling amount window',
    async (kind, durationMs, errorCode) => {
      const { object } = harness()
      const suffix = kind === '5h' ? '5h' : kind
      expect((await post(object, '/monetary/configure', monetaryConfig({
        total_limit_micros: 0,
        [`limit_${suffix}_micros`]: 100,
        [`usage_${suffix}_micros`]: 90,
        [`window_${suffix}_start_ms`]: Date.now() - durationMs + 60 * 60_000,
      }))).status).toBe(200)

      const blocked = await monetaryReserve(object, `blocked-${kind}`, 11)
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toBe('3600')
      await expect(blocked.json()).resolves.toMatchObject({
        reserved: false,
        retry_after_seconds: 3600,
        error: { code: errorCode },
      })
    },
  )

  it('reclaims an expired monetary reservation across an isolate restart without reopening replay', async () => {
    const first = harness()
    await post(first.object, '/monetary/configure', monetaryConfig())
    expect((await monetaryReserve(first.object, 'crashed-spend', 100, {
      reservation_ttl_ms: 1_000,
    })).status).toBe(200)
    expect((await monetaryReserve(first.object, 'blocked-before-expiry', 1)).status).toBe(429)

    vi.advanceTimersByTime(1_001)
    const restarted = harness(first.storage)
    expect((await monetaryReserve(restarted.object, 'after-expiry', 100)).status).toBe(200)
    const expiredReplay = await monetaryReserve(restarted.object, 'crashed-spend', 100, {
      reservation_ttl_ms: 1_000,
    })
    expect(expiredReplay.status).toBe(409)
    await expect(expiredReplay.json()).resolves.toMatchObject({
      error: { code: 'api_key_monetary_invalid_transition' },
    })

    const snapshot = await restarted.object.fetch(new Request('https://api-key-limit.test/snapshot'))
    await expect(snapshot.json()).resolves.toMatchObject({
      monetary: {
        reservations: expect.arrayContaining([
          expect.objectContaining({ request_id: 'crashed-spend', status: 'expired' }),
          expect.objectContaining({ request_id: 'after-expiry', status: 'reserved' }),
        ]),
      },
    })
  })

  it('expires a rolling window exactly at its duration boundary and cleans it after restart', async () => {
    const first = harness()
    const startedAt = Date.now()
    await post(first.object, '/monetary/configure', monetaryConfig({
      total_limit_micros: 0,
      limit_5h_micros: 100,
      usage_5h_micros: 100,
      window_5h_start_ms: startedAt,
    }))
    expect((await monetaryReserve(first.object, 'before-5h-boundary', 1)).status).toBe(429)

    vi.setSystemTime(startedAt + 5 * 60 * 60_000)
    const restarted = harness(first.storage)
    const beforeReuse = await restarted.object.fetch(new Request('https://api-key-limit.test/snapshot'))
    const snapshot = await beforeReuse.json() as {
      monetary: { windows: Array<{ api_key_id: string; kind: string }> }
    }
    expect(snapshot.monetary.windows).not.toContainEqual(expect.objectContaining({
      api_key_id: 'key-1',
      kind: '5h',
    }))
    expect((await monetaryReserve(restarted.object, 'at-5h-boundary', 100)).status).toBe(200)
  })

  it('settles actual cost into all rolling windows when any window limit is enabled', async () => {
    const { object } = harness()
    await post(object, '/monetary/configure', monetaryConfig({
      total_limit_micros: 0,
      limit_5h_micros: 100,
    }))
    await monetaryReserve(object, 'window-settlement', 80)
    const settled = await monetarySettle(object, 'window-settlement', 50)
    expect(settled.status).toBe(200)
    await expect(settled.json()).resolves.toMatchObject({
      usage: {
        total_settled_micros: 0,
        windows: expect.arrayContaining([
          expect.objectContaining({ kind: '5h', settled_micros: 50 }),
          expect.objectContaining({ kind: '1d', settled_micros: 50 }),
          expect.objectContaining({ kind: '7d', settled_micros: 50 }),
        ]),
      },
    })
    expect((await monetaryReserve(object, 'window-over-remaining', 51)).status).toBe(429)
  })

  it('versions monetary policy without letting stale projections reopen quota', async () => {
    const { object } = harness()
    await post(object, '/monetary/configure', monetaryConfig())
    await monetaryReserve(object, 'admitted-before-lower', 80)

    const lowered = await post(object, '/monetary/configure', monetaryConfig({
      control_version: 2,
      total_limit_micros: 50,
    }))
    expect(lowered.status).toBe(200)
    const admittedReplay = await monetaryReserve(object, 'admitted-before-lower', 80)
    expect(admittedReplay.status).toBe(200)
    await expect(admittedReplay.json()).resolves.toMatchObject({ idempotent: true })
    expect((await monetarySettle(object, 'admitted-before-lower', 80)).status).toBe(200)

    const stale = await post(object, '/monetary/configure', monetaryConfig())
    expect(stale.status).toBe(200)
    await expect(stale.json()).resolves.toMatchObject({
      idempotent: true,
      stale: true,
      profile: { control_version: 2, total_limit_micros: 50, total_settled_micros: 80 },
    })
    const staleReservation = await monetaryReserve(object, 'stale-policy-request', 1)
    expect(staleReservation.status).toBe(409)
    await expect(staleReservation.json()).resolves.toMatchObject({
      error: { code: 'api_key_monetary_control_version_conflict' },
    })

    const reusedVersion = await post(object, '/monetary/configure', monetaryConfig({
      control_version: 2,
      total_limit_micros: 51,
    }))
    expect(reusedVersion.status).toBe(409)
    await expect(reusedVersion.json()).resolves.toMatchObject({
      error: { code: 'api_key_monetary_configuration_conflict' },
    })
  })

  it('isolates monetary budgets by API key inside the user-sharded object', async () => {
    const { object } = harness()
    await post(object, '/monetary/configure', monetaryConfig())
    await post(object, '/monetary/configure', monetaryConfig({ api_key_id: 'key-2' }))

    expect((await monetaryReserve(object, 'key-1-full', 100)).status).toBe(200)
    expect((await monetaryReserve(object, 'key-2-full', 100, {
      api_key_id: 'key-2',
    })).status).toBe(200)
    expect((await monetaryReserve(object, 'key-1-over', 1)).status).toBe(429)
    expect((await monetaryReserve(object, 'key-2-over', 1, {
      api_key_id: 'key-2',
    })).status).toBe(429)

    const crossKeyReplay = await monetaryReserve(object, 'key-1-full', 100, {
      api_key_id: 'key-2',
    })
    expect(crossKeyReplay.status).toBe(409)
    await expect(crossKeyReplay.json()).resolves.toMatchObject({
      error: { code: 'api_key_monetary_reservation_conflict' },
    })
  })

  it('rejects unsafe or overflowing monetary amounts even when limits are unlimited', async () => {
    const invalid = harness().object
    const invalidConfig = await post(invalid, '/monetary/configure', monetaryConfig({
      total_limit_micros: 1.5,
    }))
    expect(invalidConfig.status).toBe(400)
    await expect(invalidConfig.json()).resolves.toMatchObject({
      error: { code: 'invalid_total_limit_micros' },
    })

    const unlimited = harness().object
    await post(unlimited, '/monetary/configure', monetaryConfig({ total_limit_micros: 0 }))
    expect((await monetaryReserve(unlimited, 'safe-max', Number.MAX_SAFE_INTEGER)).status).toBe(200)
    const overflow = await monetaryReserve(unlimited, 'overflow', 1)
    expect(overflow.status).toBe(409)
    await expect(overflow.json()).resolves.toMatchObject({
      error: { code: 'monetary_amount_overflow' },
    })
  })

  it('replays a reservation without consuming budget twice and rejects changed input', async () => {
    const { object } = harness()
    await post(object, '/monetary/configure', monetaryConfig())

    expect((await monetaryReserve(object, 'reserve-replay', 40)).status).toBe(200)
    const replay = await monetaryReserve(object, 'reserve-replay', 40)
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      reserved: true,
      idempotent: true,
      reservation: { reserved_micros: 40, status: 'reserved' },
    })
    expect((await monetaryReserve(object, 'remaining-budget', 60)).status).toBe(200)
    expect((await monetaryReserve(object, 'over-after-replay', 1)).status).toBe(429)

    const changedReplay = await monetaryReserve(object, 'reserve-replay', 41)
    expect(changedReplay.status).toBe(409)
    await expect(changedReplay.json()).resolves.toMatchObject({
      error: { code: 'api_key_monetary_reservation_conflict' },
    })
  })

  it('atomically reserves a shared rolling-window budget under a request race', async () => {
    const { object } = harness()
    await post(object, '/monetary/configure', monetaryConfig({
      total_limit_micros: 0,
      limit_1d_micros: 100,
    }))

    const responses = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      monetaryReserve(object, `window-race-${index}`, 15),
    ))
    expect(responses.filter((response) => response.status === 200)).toHaveLength(6)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(4)
  })

  it('treats usage without a window start as stale, matching the original Go contract', async () => {
    const { object } = harness()
    await post(object, '/monetary/configure', monetaryConfig({
      total_limit_micros: 0,
      limit_5h_micros: 100,
      usage_5h_micros: 100,
      window_5h_start_ms: null,
    }))

    expect((await monetaryReserve(object, 'after-stale-usage', 100)).status).toBe(200)
  })

  it('fails closed instead of discarding usage projected with a future window start', async () => {
    const { object } = harness()
    const response = await post(object, '/monetary/configure', monetaryConfig({
      total_limit_micros: 0,
      limit_5h_micros: 100,
      usage_5h_micros: 100,
      window_5h_start_ms: Date.now() + 1,
    }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_window_5h_start_ms' },
    })
  })

  it('reports monetary reservation expiry through the existing reclaim operation', async () => {
    const { object } = harness()
    await post(object, '/monetary/configure', monetaryConfig())
    await monetaryReserve(object, 'reclaim-spend', 100, { reservation_ttl_ms: 1_000 })
    vi.advanceTimersByTime(1_001)

    const reclaimed = await post(object, '/reclaim', {})
    expect(reclaimed.status).toBe(200)
    await expect(reclaimed.json()).resolves.toMatchObject({
      reclaimed: 0,
      monetary_reclaimed: 1,
    })
    expect((await monetaryReserve(object, 'after-reclaim', 100)).status).toBe(200)
  })
})
