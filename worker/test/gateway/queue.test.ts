import { describe, expect, it, vi } from 'vitest'
import type { Env, UsageSettledPayload } from '../../src/env'
import { consumeEvents, createUsageEvent, createUserStateEvent } from '../../src/gateway/queue'
import { sha256Hex } from '../../src/gateway/crypto'

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
  billing_type: 'balance',
  subscription_id: null,
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
  platform: 'openai',
  request_type: 1,
  inbound_endpoint: '/v1/chat/completions',
  upstream_endpoint: '/v1/responses',
  billing_mode: 'token',
  native_compaction_v2: false,
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
    expect(database.batches[0][0].query).toContain('inbound_endpoint')
    expect(database.batches[0][0].values.slice(-14, -6)).toEqual([
      'openai', 'group-1', 1, '/v1/chat/completions', '/v1/responses', 'token', 0, 1,
    ])
    expect(database.batches[0][1].query).toContain('INSERT INTO inbox')
  })

  it('persists image billing audit dimensions from the immutable usage event', async () => {
    const database = new QueueDatabase()
    const item = message(createUsageEvent({
      ...payload,
      billing_mode: 'image',
      image_count: 2,
      image_size: '4K',
      image_input_size: '2048x2048',
      image_output_size: '3840x2160',
      image_size_source: 'output',
      image_size_breakdown: { '1K': 1, '4K': 1 },
    }, 1_000))

    await consumeEvents({ queue: 'events', messages: [item] } as unknown as MessageBatch<unknown>, env(database))

    const projection = database.batches[0][0]
    expect(projection.query).toContain('image_size_breakdown')
    expect(projection.values.slice(-6)).toEqual([
      2, '4K', '2048x2048', '3840x2160', 'output', '{"1K":1,"4K":1}',
    ])
  })

  it('normalizes a v0.5 usage event while accepting its pre-v0.20 inbox digest', async () => {
    const legacyEvent = createUsageEvent({ ...payload }, 1_000)
    delete (legacyEvent.payload as Partial<UsageSettledPayload>).billing_type
    delete (legacyEvent.payload as Partial<UsageSettledPayload>).subscription_id
    delete (legacyEvent.payload as Partial<UsageSettledPayload>).platform
    delete (legacyEvent.payload as Partial<UsageSettledPayload>).request_type
    delete (legacyEvent.payload as Partial<UsageSettledPayload>).inbound_endpoint
    delete (legacyEvent.payload as Partial<UsageSettledPayload>).upstream_endpoint
    delete (legacyEvent.payload as Partial<UsageSettledPayload>).billing_mode
    delete (legacyEvent.payload as Partial<UsageSettledPayload>).native_compaction_v2
    const database = new QueueDatabase()
    const item = message(legacyEvent)

    await consumeEvents({ queue: 'events', messages: [item] } as unknown as MessageBatch<unknown>, env(database))

    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
    expect(database.batches[0][0].values.slice(-16, -6)).toEqual([
      'balance', null, '', 'group-1', 1, '', '', 'token', 0, 1,
    ])
    const normalizedDigest = database.batches[0][1].values[3]
    expect(typeof normalizedDigest).toBe('string')

    const replayDatabase = new QueueDatabase({ result_digest: normalizedDigest as string })
    const replay = message(legacyEvent)
    await consumeEvents(
      { queue: 'events', messages: [replay] } as unknown as MessageBatch<unknown>,
      env(replayDatabase),
    )

    expect(replay.ack).toHaveBeenCalledOnce()
    expect(replay.retry).not.toHaveBeenCalled()
    expect(replayDatabase.batches).toHaveLength(0)

    const {
      request_id,
      user_id,
      api_key_id,
      group_id,
      ...legacyFields
    } = legacyEvent.payload as Partial<UsageSettledPayload>
    const v019Digest = await sha256Hex(JSON.stringify({
      ...legacyEvent,
      payload: {
        request_id,
        user_id,
        api_key_id,
        group_id,
        billing_type: 'balance',
        subscription_id: null,
        ...legacyFields,
      },
    }))
    const deployedReplayDatabase = new QueueDatabase({ result_digest: v019Digest })
    const deployedReplay = message(legacyEvent)
    await consumeEvents(
      { queue: 'events', messages: [deployedReplay] } as unknown as MessageBatch<unknown>,
      env(deployedReplayDatabase),
    )

    expect(deployedReplay.ack).toHaveBeenCalledOnce()
    expect(deployedReplay.retry).not.toHaveBeenCalled()
    expect(deployedReplayDatabase.batches).toHaveLength(0)
  })

  it('rejects partially missing or explicitly contradictory billing references', async () => {
    const partialEvent = createUsageEvent({ ...payload }, 1_000)
    delete (partialEvent.payload as Partial<UsageSettledPayload>).subscription_id
    const contradictoryEvent = createUsageEvent({
      ...payload,
      subscription_id: 'subscription-1',
    }, 1_000)
    const partial = message(partialEvent)
    const contradictory = message(contradictoryEvent)
    const database = new QueueDatabase()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await consumeEvents(
      { queue: 'events', messages: [partial, contradictory] } as unknown as MessageBatch<unknown>,
      env(database),
    )

    expect(partial.ack).not.toHaveBeenCalled()
    expect(partial.retry).toHaveBeenCalledOnce()
    expect(contradictory.ack).not.toHaveBeenCalled()
    expect(contradictory.retry).toHaveBeenCalledOnce()
    expect(database.batches).toHaveLength(0)
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
