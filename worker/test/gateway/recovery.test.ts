import { describe, expect, it, vi } from 'vitest'
import type { Env, PlatformEvent, UsageSettledPayload } from '../../src/env'
import { settleRecoveryRequest } from '../../src/gateway/recovery'

interface RecoveryRow {
  request_id: string
  user_id: string
  billing_type: 'balance' | 'subscription'
  subscription_id: string | null
  api_key_id: string | null
  amount_micros: number
  usage_event_json: string
  attempts: number
  billing_settled: number
  api_key_settled: number
  api_key_usage_json: string | null
  api_key_projected: number
}

class RecoveryStatement {
  values: unknown[] = []

  constructor(readonly query: string, private readonly database: RecoveryDatabase) {}

  bind(...values: unknown[]): RecoveryStatement {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
    return this.database.row as T | null
  }

  async all<T>(): Promise<D1Result<T>> {
    await this.run()
    return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
  }

  async run(): Promise<D1Result<unknown>> {
    this.database.executed.push(this)
    const row = this.database.row
    if (row !== null) {
      if (this.query.includes('SET billing_settled = 1')) row.billing_settled = 1
      if (this.query.includes('SET api_key_settled = 1')) {
        row.api_key_settled = 1
        row.api_key_usage_json = this.values[0] as string
      }
      if (this.query.includes('SET api_key_projected = 1')) row.api_key_projected = 1
      if (this.query.includes('SET attempts = attempts + 1')) row.attempts += 1
      if (this.query.includes('DELETE FROM settlement_recovery')) this.database.row = null
    }
    return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
  }
}

class RecoveryDatabase {
  readonly executed: RecoveryStatement[] = []

  constructor(public row: RecoveryRow | null = recoveryRow()) {}

  prepare(query: string): RecoveryStatement {
    return new RecoveryStatement(query, this)
  }

  async batch(statements: RecoveryStatement[]): Promise<D1Result<unknown>[]> {
    return Promise.all(statements.map((statement) => statement.all()))
  }
}

function usageEvent(requestId = 'request-1'): PlatformEvent<UsageSettledPayload> {
  return {
    schema_version: 1,
    event_id: `usage:${requestId}`,
    event_type: 'usage.settled.v1',
    occurred_at_ms: 100,
    aggregate_type: 'user',
    aggregate_id: 'user-1',
    payload: {
      request_id: requestId,
      user_id: 'user-1',
      api_key_id: 'key-1',
      group_id: 'group-1',
      billing_type: 'balance',
      subscription_id: null,
      account_id: 'account-1',
      price_id: 'price-1',
      requested_model: 'model',
      upstream_model: 'model',
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      input_amount_micros: 5,
      output_amount_micros: 5,
      cache_amount_micros: 0,
      base_amount_micros: 0,
      amount_micros: 10,
      outcome: 'completed',
      stream: false,
      platform: 'openai',
      request_type: 1,
      inbound_endpoint: '/v1/responses',
      upstream_endpoint: '/v1/responses',
      billing_mode: 'token',
      native_compaction_v2: false,
      duration_ms: 1,
      estimated: false,
    },
  }
}

function recoveryRow(overrides: Partial<RecoveryRow> = {}): RecoveryRow {
  const event = usageEvent(overrides.request_id ?? 'request-1')
  return {
    request_id: event.payload.request_id,
    user_id: 'user-1',
    billing_type: 'balance',
    subscription_id: null,
    api_key_id: 'key-1',
    amount_micros: 10,
    usage_event_json: JSON.stringify(event),
    attempts: 0,
    billing_settled: 0,
    api_key_settled: 0,
    api_key_usage_json: null,
    api_key_projected: 0,
    ...overrides,
  }
}

function monetaryUsage(apiKeyId = 'key-1'): Record<string, unknown> {
  return {
    api_key_id: apiKeyId,
    quota_reset_epoch: 0,
    rate_limit_reset_epoch: 0,
    total_settled_micros: 10,
    active_reserved_micros: 0,
    windows: (['5h', '1d', '7d'] as const).map((kind) => ({
      api_key_id: apiKeyId,
      kind,
      window_started_at_ms: 100,
      settled_micros: 10,
      updated_at_ms: 200,
    })),
  }
}

function namespace(fetch: (request: Request) => Promise<Response>): DurableObjectNamespace {
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({ fetch }),
  } as unknown as DurableObjectNamespace
}

describe('settlement recovery', () => {
  it('parks a permanently failing command after bounded automatic retries', async () => {
    const database = new RecoveryDatabase(recoveryRow({ attempts: 19 }))
    const env = {
      DB: database as unknown as D1Database,
      USER_STATE: namespace(async () => Response.json(
        { error: { code: 'temporary_failure', message: 'retry' } },
        { status: 503 },
      )),
    } as Env

    await expect(settleRecoveryRequest(env, 'request-1')).resolves.toBe(false)

    expect(database.executed).toHaveLength(1)
    expect(database.executed[0].query).toContain('UPDATE settlement_recovery')
    expect(database.executed[0].values).toEqual([
      Number.MAX_SAFE_INTEGER,
      'manual_review: GatewayError: retry',
      'request-1',
    ])
  })

  it('persists all three stages and skips primary billing after a key-state failure', async () => {
    const database = new RecoveryDatabase()
    const billingFetch = vi.fn(async () => Response.json({
      profile: { balance_micros: 990, settled_micros: 10 },
    }))
    let keyFailures = 1
    const keyFetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname !== '/monetary/settle') return Response.json({})
      if (keyFailures > 0) {
        keyFailures -= 1
        return Response.json(
          { error: { code: 'temporary_failure', message: 'retry key' } },
          { status: 503 },
        )
      }
      return Response.json({ usage: monetaryUsage() })
    })
    const env = {
      DB: database as unknown as D1Database,
      USER_STATE: namespace(billingFetch),
      API_KEY_LIMIT_STATE: namespace(keyFetch),
    } as Env

    await expect(settleRecoveryRequest(env, 'request-1', true)).resolves.toBe(false)
    expect(database.row).toMatchObject({
      billing_settled: 1,
      api_key_settled: 0,
      api_key_projected: 0,
    })
    await expect(settleRecoveryRequest(env, 'request-1', true)).resolves.toBe(true)

    expect(billingFetch).toHaveBeenCalledOnce()
    expect(keyFetch).toHaveBeenCalledTimes(2)
    expect(database.executed.map((statement) => statement.query)).toEqual(expect.arrayContaining([
      expect.stringContaining('SET billing_settled = 1'),
      expect.stringContaining('SET api_key_settled = 1'),
      expect.stringContaining('SET api_key_projected = 1'),
      expect.stringContaining('DELETE FROM settlement_recovery'),
    ]))
    expect(database.row).toBeNull()
  })

  it('replays subscription billing against its subscription object before key settlement', async () => {
    const requestId = 'request-subscription'
    const event = usageEvent(requestId)
    event.payload.billing_type = 'subscription'
    event.payload.subscription_id = 'subscription-1'
    const database = new RecoveryDatabase(recoveryRow({
      request_id: requestId,
      billing_type: 'subscription',
      subscription_id: 'subscription-1',
      amount_micros: 25,
      usage_event_json: JSON.stringify(event),
    }))
    const subscriptionFetch = vi.fn(async () => Response.json({ settled_micros: 25 }))
    const userFetch = vi.fn(async () => {
      throw new Error('balance state must not be used')
    })
    const env = {
      DB: database as unknown as D1Database,
      USER_STATE: namespace(userFetch),
      SUBSCRIPTION_STATE: namespace(subscriptionFetch),
      API_KEY_LIMIT_STATE: namespace(async () => Response.json({ usage: monetaryUsage() })),
    } as Env

    await expect(settleRecoveryRequest(env, requestId)).resolves.toBe(true)

    expect(subscriptionFetch).toHaveBeenCalledOnce()
    expect(userFetch).not.toHaveBeenCalled()
    expect(database.row).toBeNull()
  })
})
