import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { settleRecoveryRequest } from '../../src/gateway/recovery'

class RecoveryStatement {
  values: unknown[] = []

  constructor(
    readonly query: string,
    private readonly database: RecoveryDatabase,
  ) {}

  bind(...values: unknown[]): RecoveryStatement {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
    return this.database.row as T
  }

  async run(): Promise<D1Result<unknown>> {
    this.database.executed.push(this)
    return { success: true, results: [], meta: {} as D1Meta & Record<string, unknown> }
  }
}

class RecoveryDatabase {
  readonly executed: RecoveryStatement[] = []

  constructor(readonly row: {
    request_id: string
    user_id: string
    billing_type: 'balance' | 'subscription'
    subscription_id: string | null
    amount_micros: number
    usage_event_json: string
    attempts: number
  } = {
    request_id: 'request-1',
    user_id: 'user-1',
    billing_type: 'balance',
    subscription_id: null as string | null,
    amount_micros: 10,
    usage_event_json: '{}',
    attempts: 19,
  }) {}

  prepare(query: string): RecoveryStatement {
    return new RecoveryStatement(query, this)
  }
}

describe('settlement recovery', () => {
  it('parks a permanently failing command after bounded automatic retries', async () => {
    const database = new RecoveryDatabase()
    const stub = {
      fetch: async () =>
        Response.json(
          { error: { code: 'temporary_failure', message: 'retry' } },
          { status: 503 },
        ),
    }
    const env = {
      DB: database as unknown as D1Database,
      USER_STATE: {
        idFromName: (name: string) => name,
        get: () => stub,
      } as unknown as DurableObjectNamespace,
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

  it('replays a subscription settlement against its subscription Durable Object', async () => {
    const database = new RecoveryDatabase({
      request_id: 'request-subscription',
      user_id: 'user-1',
      billing_type: 'subscription',
      subscription_id: 'subscription-1',
      amount_micros: 25,
      usage_event_json: '{}',
      attempts: 0,
    })
    const subscriptionFetch = vi.fn(async () => Response.json({ settled_micros: 25 }))
    const userFetch = vi.fn(async () => {
      throw new Error('balance state must not be used')
    })
    const subscriptionNames: string[] = []
    const env = {
      DB: database as unknown as D1Database,
      USER_STATE: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: userFetch }),
      } as unknown as DurableObjectNamespace,
      SUBSCRIPTION_STATE: {
        idFromName: (name: string) => {
          subscriptionNames.push(name)
          return name
        },
        get: () => ({ fetch: subscriptionFetch }),
      } as unknown as DurableObjectNamespace,
    } as Env

    await expect(settleRecoveryRequest(env, 'request-subscription')).resolves.toBe(true)

    expect(subscriptionNames).toEqual(['subscription-1'])
    expect(subscriptionFetch).toHaveBeenCalledOnce()
    expect(userFetch).not.toHaveBeenCalled()
    expect(database.executed.at(-1)?.query).toContain('DELETE FROM settlement_recovery')
  })
})
