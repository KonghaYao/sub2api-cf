import { describe, expect, it, vi } from 'vitest'
import type { Env, UsageSettledPayload } from '../../src/env'
import { consumeEvents, createUsageEvent, createUserStateEvent } from '../../src/gateway/queue'

class QueueStatement {
  values: unknown[] = []

  constructor(
    readonly query: string,
    private readonly inbox: { result_digest: string | null } | null,
  ) {}

  bind(...values: unknown[]): QueueStatement {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
    return this.inbox as T | null
  }
}

class QueueDatabase {
  readonly statements: QueueStatement[] = []
  readonly batches: QueueStatement[][] = []

  constructor(readonly inbox: { result_digest: string | null } | null = null) {}

  prepare(query: string): QueueStatement {
    const statement = new QueueStatement(query, query.includes('FROM inbox') ? this.inbox : null)
    this.statements.push(statement)
    return statement
  }

  async batch(statements: QueueStatement[]): Promise<D1Result<unknown>[]> {
    this.batches.push(statements)
    return statements.map(() => ({
      success: true,
      results: [],
      meta: {} as D1Meta & Record<string, unknown>,
    }))
  }
}

const payload: UsageSettledPayload = {
  request_id: 'request-1',
  user_id: 'user-1',
  api_key_id: 'key-1',
  group_id: 'group-1',
  account_id: 'account-1',
  price_id: 'price-1',
  requested_model: 'gpt-public',
  upstream_model: 'gpt-upstream',
  input_tokens: 10,
  output_tokens: 5,
  cache_read_tokens: 2,
  input_amount_micros: 16,
  output_amount_micros: 20,
  cache_amount_micros: 1,
  base_amount_micros: 3,
  amount_micros: 40,
  outcome: 'completed',
  stream: false,
  duration_ms: 123,
  estimated: false,
}

function message(body: unknown) {
  return {
    id: 'message-1',
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  }
}

function env(database: QueueDatabase): Env {
  return { DB: database as unknown as D1Database } as Env
}

describe('usage queue projection', () => {
  it('projects a valid event and acknowledges only after the D1 batch', async () => {
    const database = new QueueDatabase()
    const item = message(createUsageEvent(payload, 1_000))

    await consumeEvents({ queue: 'events', messages: [item] } as unknown as MessageBatch<unknown>, env(database))

    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
    expect(database.batches).toHaveLength(1)
    expect(database.batches[0][0].query).toContain('INSERT INTO usage_projection')
    expect(database.batches[0][0].query).toContain('base_amount_micros')
    expect(database.batches[0][1].query).toContain('INSERT INTO inbox')
  })

  it('rejects an event whose aggregate or cost components do not match', async () => {
    const database = new QueueDatabase()
    const event = createUsageEvent({ ...payload, amount_micros: 41 }, 1_000)
    event.aggregate_id = 'another-user'
    const item = message(event)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await consumeEvents({ queue: 'events', messages: [item] } as unknown as MessageBatch<unknown>, env(database))

    expect(item.ack).not.toHaveBeenCalled()
    expect(item.retry).toHaveBeenCalledOnce()
    expect(database.batches).toHaveLength(0)
  })

  it('projects a monotonic user-state event so old deliveries cannot roll back D1', async () => {
    const database = new QueueDatabase()
    const item = message(createUserStateEvent({
      mutation_id: 'admin-balance:mutation-1',
      user_id: 'user-1',
      state_version: 7,
      balance_micros: 900_000,
      enabled: false,
      updated_at_ms: 2_000,
    }))

    await consumeEvents({ queue: 'events', messages: [item] } as unknown as MessageBatch<unknown>, env(database))

    expect(item.ack).toHaveBeenCalledOnce()
    expect(database.batches).toHaveLength(1)
    expect(database.batches[0][0].query).toContain('UPDATE users')
    expect(database.batches[0][0].query).toContain('state_version < ?')
    expect(database.batches[0][0].values).toEqual([
      900_000,
      'disabled',
      7,
      2_000,
      'user-1',
      7,
    ])
    expect(database.batches[0][1].query).toContain('INSERT INTO inbox')
  })
})
