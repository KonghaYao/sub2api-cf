import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'

type Row = Record<string, unknown>

interface InfoFixture {
  subscription?: {
    starts_at_ms: number
    expires_at_ms: number
    daily_quota_micros: number | null
    weekly_quota_micros: number | null
    monthly_quota_micros: number | null
    daily_used_micros: number
    weekly_used_micros: number
    monthly_used_micros: number
    daily_anchor_ms?: number
    daily_window_start_ms: number | null
    weekly_window_start_ms: number | null
    monthly_window_start_ms: number | null
  }
}

class InfoStatement {
  values: unknown[] = []

  constructor(
    readonly query: string,
    private readonly fixture: InfoFixture,
  ) {}

  bind(...values: unknown[]): InfoStatement {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes('FROM api_keys k')) {
      const subscription = this.fixture.subscription
      return {
        api_key_id: 'key-1',
        api_key_auth_version: 1,
        api_key_enabled: 1,
        expires_at_ms: null,
        revoked_at_ms: null,
        user_id: 'user-1',
        user_status: 'active',
        balance_micros: 12_500_000,
        user_state_version: 3,
        limit_config_version: 1,
        concurrency_limit: 0,
        user_rpm_limit: 0,
        group_rpm_limit: 0,
        api_key_control_version: 0,
        quota_micros: 0,
        quota_used_micros: 0,
        rate_limit_5h_micros: 0,
        rate_limit_1d_micros: 0,
        rate_limit_7d_micros: 0,
        usage_5h_micros: 0,
        usage_1d_micros: 0,
        usage_7d_micros: 0,
        window_5h_start_ms: null,
        window_1d_start_ms: null,
        window_7d_start_ms: null,
        api_key_quota_reset_epoch: 0,
        api_key_rate_limit_reset_epoch: 0,
        group_id: 'group-1',
        group_enabled: 1,
        group_accessible: 1,
        platform: 'openai',
        group_type: subscription === undefined ? 'standard' : 'subscription',
        subscription_id: subscription === undefined ? null : 'subscription-1',
        subscription_starts_at_ms: subscription?.starts_at_ms ?? null,
        subscription_expires_at_ms: subscription?.expires_at_ms ?? null,
        daily_quota_micros: subscription?.daily_quota_micros ?? null,
        weekly_quota_micros: subscription?.weekly_quota_micros ?? null,
        monthly_quota_micros: subscription?.monthly_quota_micros ?? null,
        daily_used_micros: subscription?.daily_used_micros ?? null,
        weekly_used_micros: subscription?.weekly_used_micros ?? null,
        monthly_used_micros: subscription?.monthly_used_micros ?? null,
        daily_anchor_ms: subscription === undefined ? null : subscription.daily_anchor_ms ?? 0,
        daily_window_start_ms: subscription?.daily_window_start_ms ?? null,
        weekly_window_start_ms: subscription?.weekly_window_start_ms ?? null,
        monthly_window_start_ms: subscription?.monthly_window_start_ms ?? null,
        quota_reset_epoch: subscription === undefined ? null : 0,
        quota_reset_generation: subscription === undefined ? null : 0,
        subscription_control_version: subscription === undefined ? null : 4,
      } as T
    }
    if (this.query.includes('SELECT name FROM "groups"')) {
      return { name: 'Pro subscription' } as T
    }
    if (this.query.includes('rate_multiplier_ppm') && this.query.includes('FROM "groups"')) {
      return {
        group_rate_multiplier_ppm: 1_250_000,
        user_rate_multiplier_ppm: null,
      } as T
    }
    throw new Error(`Unexpected first query: ${this.query}`)
  }

  async all<T>(): Promise<D1Result<T>> {
    return result([] as T[])
  }

  async run(): Promise<D1Result<unknown>> {
    if (this.query.includes('SUM(CASE WHEN occurred_at_ms >= ?')) {
      return result([{
        today_requests: 2,
        today_input_tokens: 30,
        today_output_tokens: 20,
        today_cache_read_tokens: 5,
        today_amount_micros: 750_000,
        total_requests: 3,
        total_input_tokens: 40,
        total_output_tokens: 30,
        total_cache_read_tokens: 5,
        total_amount_micros: 1_250_000,
        average_duration_ms: 150,
      }])
    }
    if (this.query.includes('GROUP BY requested_model')) {
      return result([{
        model: 'public-model',
        requests: 3,
        input_tokens: 40,
        output_tokens: 30,
        cache_read_tokens: 5,
        amount_micros: 1_250_000,
      }])
    }
    if (this.query.includes('GROUP BY local_date')) {
      return result([{
        local_date: '2026-09-01',
        requests: 3,
        input_tokens: 40,
        output_tokens: 30,
        cache_read_tokens: 5,
        amount_micros: 1_250_000,
      }])
    }
    throw new Error(`Unexpected run query: ${this.query}`)
  }
}

class InfoDatabase {
  readonly statements: InfoStatement[] = []

  constructor(private readonly fixture: InfoFixture = {}) {}

  prepare(query: string): InfoStatement {
    const statement = new InfoStatement(query, this.fixture)
    this.statements.push(statement)
    return statement
  }

  async batch(statements: InfoStatement[]): Promise<D1Result<unknown>[]> {
    return Promise.all(statements.map((statement) => statement.run()))
  }
}

function result<T>(results: T[]): D1Result<T> {
  return {
    success: true,
    results,
    meta: { changes: 0 } as D1Meta & Record<string, unknown>,
  }
}

function env(fixture: InfoFixture = {}): Env {
  return envWithDatabase(new InfoDatabase(fixture))
}

function envWithDatabase(database: InfoDatabase): Env {
  return {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: 'p'.repeat(32),
    ASSETS: {} as Fetcher,
    DB: database as unknown as D1Database,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  }
}

async function body(response: Response): Promise<Row> {
  return response.json() as Promise<Row>
}

describe('gateway account information', () => {
  afterEach(() => vi.useRealTimers())

  it('reports the exact integer-backed billing multiplier for an authenticated key', async () => {
    const response = await createApp().request('/v1/sub2api/billing', {
      headers: { 'x-api-key': 'sk-user-secret' },
    }, env())

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await body(response)).toMatchObject({
      object: 'sub2api.key_billing',
      schema_version: 1,
      billing_scope: 'token',
      group_rate_multiplier: 1.25,
      resolved_rate_multiplier: 1.25,
      peak_rate_enabled: false,
      effective_rate_multiplier: 1.25,
      group_rate_multiplier_ppm: 1_250_000,
    })
  })

  it('returns wallet balance and API-key usage aggregates without exposing upstream names', async () => {
    const response = await createApp().request('/v1/usage?days=30', {
      headers: { authorization: 'Bearer sk-user-secret' },
    }, env())

    expect(response.status).toBe(200)
    const payload = await body(response)
    expect(payload).toMatchObject({
      mode: 'unrestricted',
      isValid: true,
      planName: '钱包余额',
      remaining: 12.5,
      unit: 'USD',
      billing_type: 'balance',
      balance_micros: 12_500_000,
      usage: {
        today: { requests: 2, total_tokens: 50, cost: 0.75, amount_micros: 750_000 },
        total: { requests: 3, total_tokens: 70, cost: 1.25, amount_micros: 1_250_000 },
        average_duration_ms: 150,
      },
      model_stats: [{ model: 'public-model', requests: 3, cost: 1.25 }],
      daily_usage: [{
        date: '2026-09-01',
        cache_read_tokens: 5,
        cache_write_tokens: 0,
        actual_cost: 1.25,
      }],
    })
    expect((payload.model_stats as Row[])[0]).toMatchObject({
      cache_creation_tokens: 0,
      cache_read_tokens: 5,
      actual_cost: 1.25,
    })
    expect(JSON.stringify(payload)).not.toContain('upstream')
  })

  it('uses the requested IANA timezone and inclusive local calendar range', async () => {
    const database = new InfoDatabase()
    const response = await createApp().request(
      '/v1/usage?start_date=2026-09-01&end_date=2026-09-02&days=7&timezone=Asia%2FShanghai',
      { headers: { authorization: 'Bearer sk-user-secret' } },
      envWithDatabase(database),
    )

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await body(response)).toMatchObject({ timezone: 'Asia/Shanghai' })
    const modelQuery = database.statements.find((statement) => statement.query.includes('GROUP BY requested_model'))
    expect(modelQuery?.values).toEqual([
      'key-1',
      Date.UTC(2026, 7, 31, 16),
      Date.UTC(2026, 8, 2, 16),
    ])
    const dailyQuery = database.statements.find((statement) => statement.query.includes('GROUP BY local_date'))
    expect(dailyQuery?.query).toContain('CASE WHEN occurred_at_ms >= ? AND occurred_at_ms < ? THEN ?')
  })

  it('chunks the public 90-day view below the D1 per-statement bind limit', async () => {
    const database = new InfoDatabase()
    const response = await createApp().request(
      '/v1/usage?days=90&timezone=Asia%2FShanghai',
      { headers: { authorization: 'Bearer sk-user-secret' } },
      envWithDatabase(database),
    )

    expect(response.status, await response.clone().text()).toBe(200)
    const dailyQueries = database.statements.filter((statement) => (
      statement.query.includes('GROUP BY local_date')
    ))
    expect(dailyQueries).toHaveLength(3)
    expect(dailyQueries.every((statement) => statement.values.length <= 100)).toBe(true)
    expect(dailyQueries.map((statement) => statement.values.length)).toEqual([93, 93, 93])
  })

  it('uses daylight-saving calendar boundaries instead of fixed UTC offsets', async () => {
    const database = new InfoDatabase()
    const response = await createApp().request(
      '/v1/usage?start_date=2026-03-29&end_date=2026-03-29&days=7&timezone=Europe%2FBerlin',
      { headers: { authorization: 'Bearer sk-user-secret' } },
      envWithDatabase(database),
    )

    expect(response.status, await response.clone().text()).toBe(200)
    const modelQuery = database.statements.find((statement) => statement.query.includes('GROUP BY requested_model'))
    expect(modelQuery?.values).toEqual([
      'key-1',
      Date.UTC(2026, 2, 28, 23),
      Date.UTC(2026, 2, 29, 22),
    ])
  })

  it('rejects incomplete, invalid, or excessive date ranges and timezones', async () => {
    for (const query of [
      'start_date=2026-09-01',
      'start_date=2026-09-02&end_date=2026-09-01',
      'start_date=2025-01-01&end_date=2026-09-01',
      'start_date=2026-02-30&end_date=2026-03-01',
      'timezone=Not%2FAZone',
    ]) {
      const response = await createApp().request(`/v1/usage?${query}`, {
        headers: { authorization: 'Bearer sk-user-secret' },
      }, env())
      expect(response.status, query).toBe(400)
    }
  })

  it('returns the active subscription windows instead of reporting the wallet balance', async () => {
    const startsAt = Date.UTC(2026, 8, 1)
    const expiresAt = Date.UTC(2026, 9, 1)
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 8, 1, 12))
    const response = await createApp().request('/v1/usage?days=30', {
      headers: { authorization: 'Bearer sk-user-secret' },
    }, env({
      subscription: {
        starts_at_ms: startsAt,
        expires_at_ms: expiresAt,
        daily_quota_micros: 10_000_000,
        weekly_quota_micros: 40_000_000,
        monthly_quota_micros: null,
        daily_used_micros: 2_000_000,
        weekly_used_micros: 35_000_000,
        monthly_used_micros: 50_000_000,
        daily_window_start_ms: startsAt,
        weekly_window_start_ms: startsAt,
        monthly_window_start_ms: startsAt,
      },
    }))

    expect(response.status, await response.clone().text()).toBe(200)
    const payload = await body(response)
    expect(payload).toMatchObject({
      mode: 'unrestricted',
      isValid: true,
      planName: 'Pro subscription',
      remaining: 5,
      unit: 'USD',
      billing_type: 'subscription',
      subscription: {
        id: 'subscription-1',
        daily_usage_usd: 2,
        daily_limit_usd: 10,
        weekly_usage_usd: 35,
        weekly_limit_usd: 40,
        monthly_usage_usd: 50,
        monthly_limit_usd: null,
        daily_window_start: new Date(startsAt).toISOString(),
        weekly_window_start: new Date(startsAt).toISOString(),
        monthly_window_start: new Date(startsAt).toISOString(),
        starts_at: new Date(startsAt).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
      },
      usage: {
        today: { amount_micros: 750_000 },
        total: { amount_micros: 1_250_000 },
      },
    })
    expect(payload).not.toHaveProperty('balance')
    expect(payload).not.toHaveProperty('balance_micros')
  })

  it('reports naturally rolled subscription windows as unused before their first settlement', async () => {
    const startsAt = Date.UTC(2026, 7, 1, 12)
    const now = startsAt + 31 * 86_400_000
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const response = await createApp().request('/v1/usage?days=30', {
      headers: { authorization: 'Bearer sk-user-secret' },
    }, env({
      subscription: {
        starts_at_ms: startsAt,
        expires_at_ms: startsAt + 120 * 86_400_000,
        daily_quota_micros: 10_000_000,
        weekly_quota_micros: 40_000_000,
        monthly_quota_micros: 100_000_000,
        daily_used_micros: 10_000_000,
        weekly_used_micros: 40_000_000,
        monthly_used_micros: 100_000_000,
        daily_window_start_ms: Date.UTC(2026, 7, 1),
        weekly_window_start_ms: startsAt,
        monthly_window_start_ms: startsAt,
      },
    }))

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await body(response)).toMatchObject({
      remaining: 10,
      subscription: {
        daily_usage_usd: 0,
        weekly_usage_usd: 0,
        monthly_usage_usd: 0,
      },
    })
  })

  it('validates usage window input before querying statistics', async () => {
    const response = await createApp().request('/v1/usage?days=91', {
      headers: { authorization: 'Bearer sk-user-secret' },
    }, env())

    expect(response.status).toBe(400)
    expect(await body(response)).toMatchObject({ error: { type: 'invalid_request_error' } })
  })
})
