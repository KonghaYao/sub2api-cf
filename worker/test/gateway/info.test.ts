import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'

type Row = Record<string, unknown>

class InfoStatement {
  values: unknown[] = []

  constructor(readonly query: string) {}

  bind(...values: unknown[]): InfoStatement {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes('FROM api_keys k')) {
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
        group_id: 'group-1',
        group_enabled: 1,
        platform: 'openai',
      } as T
    }
    if (this.query.includes('rate_multiplier_ppm') && this.query.includes('FROM "groups"')) {
      return { rate_multiplier_ppm: 1_250_000 } as T
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
        amount_micros: 1_250_000,
      }])
    }
    if (this.query.includes('GROUP BY day_start_ms')) {
      return result([{
        day_start_ms: 1_788_278_400_000,
        requests: 3,
        input_tokens: 40,
        output_tokens: 30,
        amount_micros: 1_250_000,
      }])
    }
    throw new Error(`Unexpected run query: ${this.query}`)
  }
}

class InfoDatabase {
  prepare(query: string): InfoStatement {
    return new InfoStatement(query)
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

function env(): Env {
  return {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: 'p'.repeat(32),
    ASSETS: {} as Fetcher,
    DB: new InfoDatabase() as unknown as D1Database,
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
      balance_micros: 12_500_000,
      usage: {
        today: { requests: 2, total_tokens: 50, cost: 0.75, amount_micros: 750_000 },
        total: { requests: 3, total_tokens: 70, cost: 1.25, amount_micros: 1_250_000 },
        average_duration_ms: 150,
      },
      model_stats: [{ model: 'public-model', requests: 3, cost: 1.25 }],
    })
    expect(JSON.stringify(payload)).not.toContain('upstream')
  })

  it('validates usage window input before querying statistics', async () => {
    const response = await createApp().request('/v1/usage?days=91', {
      headers: { authorization: 'Bearer sk-user-secret' },
    }, env())

    expect(response.status).toBe(400)
    expect(await body(response)).toMatchObject({ error: { type: 'invalid_request_error' } })
  })
})
