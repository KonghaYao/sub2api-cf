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
  standard_cost_micros: 50,
  account_stats_cost_micros: 32,
  account_rate_multiplier_ppm: 1_250_000,
  account_cost_micros: 40,
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
  it('includes cache creation money in projection and rejects an inconsistent total', async () => {
    const database = new QueueDatabase()
    const valid = message(createUsageEvent({ ...payload, cache_write_amount_micros: 7, amount_micros: 47 }, 1000))
    const invalid = message(createUsageEvent({ ...payload, cache_write_amount_micros: 7 }, 1000))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await consumeEvents({ queue: 'events', messages: [valid, invalid] } as unknown as MessageBatch<unknown>, env(database))
      expect(valid.ack).toHaveBeenCalledOnce()
      expect(invalid.retry).toHaveBeenCalledOnce()
      expect(database.batches).toHaveLength(1)
      expect(database.batches[0][0].values.at(-1)).toBe(7)
    } finally { error.mockRestore() }
  })

  it('persists TTL evidence and rejects changed TTL under the same event ID',async()=>{
    const original=createUsageEvent({...payload,cache_write_tokens:3,cache_write_5m_tokens:1,cache_write_1h_tokens:2},1000)
    const database=new QueueDatabase(), first=message(original)
    await consumeEvents({queue:'events',messages:[first]} as unknown as MessageBatch<unknown>,env(database))
    expect(first.ack).toHaveBeenCalledOnce()
    expect(database.batches[0][0].values.slice(-4, -1)).toEqual([3,1,2])
    expect(database.batches[0][3].values.slice(-3)).toEqual([3,1,2])
    const replayDatabase=new QueueDatabase({result_digest:database.batches[0][1].values[3] as string})
    const same=message(original),changed=message(createUsageEvent({...payload,cache_write_tokens:3,cache_write_5m_tokens:2,cache_write_1h_tokens:1},1000))
    const error=vi.spyOn(console,'error').mockImplementation(()=>undefined)
    try{
      await consumeEvents({queue:'events',messages:[same,changed]} as unknown as MessageBatch<unknown>,env(replayDatabase))
      expect(same.ack).toHaveBeenCalledOnce();expect(changed.retry).toHaveBeenCalledOnce();expect(replayDatabase.batches).toHaveLength(0)
    }finally{error.mockRestore()}
  })
  it('preserves cache writes and treats changed cache evidence as a conflicting replay', async () => {
    const event = createUsageEvent({ ...payload, cache_write_tokens: 3 }, 1_000)
    const database = new QueueDatabase(), item = message(event)
    await consumeEvents({ queue: 'events', messages: [item] } as unknown as MessageBatch<unknown>, env(database))
    expect(item.ack).toHaveBeenCalledOnce()
    expect(database.batches[0][0].values.at(-4)).toBe(3)
    expect(database.batches[0][3].values.at(-3)).toBe(3)
    const replayDatabase = new QueueDatabase({ result_digest: database.batches[0][1].values[3] as string })
    const same = message(event), changed = message(createUsageEvent({ ...payload, cache_write_tokens: 4 }, 1_000))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await consumeEvents({ queue: 'events', messages: [same, changed] } as unknown as MessageBatch<unknown>, env(replayDatabase))
      expect(same.ack).toHaveBeenCalledOnce()
      expect(changed.retry).toHaveBeenCalledOnce()
      expect(replayDatabase.batches).toHaveLength(0)
    } finally { error.mockRestore() }
  })

  it('projects a valid event and acknowledges only after the D1 batch', async () => {
    const database = new QueueDatabase()
    const item = message(createUsageEvent(payload, 1_000))

    await consumeEvents({ queue: 'events', messages: [item] } as unknown as MessageBatch<unknown>, env(database))

    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
    expect(database.batches).toHaveLength(1)
    expect(database.batches[0]).toHaveLength(4)
    expect(database.batches[0][0].query).toContain('INSERT INTO usage_projection')
    expect(database.batches[0][0].query).toContain('base_amount_micros')
    expect(database.batches[0][0].query).toContain('standard_cost_micros')
    expect(database.batches[0][0].query).toContain('inbound_endpoint')
    expect(database.batches[0][0].values.slice(9, 13)).toEqual([50, 32, 1_250_000, 40])
    expect(database.batches[0][0].values.slice(-18, -10)).toEqual([
      'openai', 'group-1', 1, '/v1/chat/completions', '/v1/responses', 'token', 0, 1,
    ])
    expect(database.batches[0][1].query).toContain('INSERT INTO inbox')
    expect(database.batches[0][3].query).toContain('INSERT INTO account_usage_15m_rollup')
    expect(database.batches[0][3].query).toContain('ON CONFLICT')
    expect(database.batches[0][3].values).toEqual([
      'account-1', 0, 'gpt-public', '/v1/chat/completions', '/v1/responses',
      10, 5, 2, 50, 40, 40, 123, 0, 0, 0,
    ])
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
    expect(projection.values.slice(-10, -4)).toEqual([
      2, '4K', '2048x2048', '3840x2160', 'output', '{"1K":1,"4K":1}',
    ])
  })

  it('projects a customer pricing snapshot and defaults legacy events to null', async () => {
    const snapshot = JSON.stringify({ version: 1, source: 'channel', pricing_id: 'pricing-1' })
    const currentDatabase = new QueueDatabase()
    const current = message(createUsageEvent({
      ...payload,
      customer_pricing_snapshot_json: snapshot,
    }, 1_000))

    await consumeEvents(
      { queue: 'events', messages: [current] } as unknown as MessageBatch<unknown>,
      env(currentDatabase),
    )

    const currentProjection = currentDatabase.batches[0][0]
    expect(currentProjection.query).toContain('customer_pricing_snapshot_json')
    expect(currentProjection.values).toContain(snapshot)

    const legacyDatabase = new QueueDatabase()
    const legacy = message(createUsageEvent({ ...payload }, 1_000))

    await consumeEvents(
      { queue: 'events', messages: [legacy] } as unknown as MessageBatch<unknown>,
      env(legacyDatabase),
    )

    const snapshotIndex = currentProjection.values.indexOf(snapshot)
    expect(snapshotIndex).toBeGreaterThan(-1)
    expect(legacyDatabase.batches[0][0].values[snapshotIndex]).toBeNull()
  })

  it('acknowledges an exact image customer-pricing replay without projecting or charging twice', async () => {
    const snapshot = JSON.stringify({
      version: 1,
      source: 'channel',
      pricing_id: 'channel-image-price',
      billing_model: 'image',
      tier_prices_micros: { '1K': 125_000, '2K': 275_000, '4K': 650_000 },
      output_tier_counts: { '1K': 1, '2K': 0, '4K': 0 },
    })
    const event = createUsageEvent({
      ...payload,
      billing_mode: 'image',
      input_tokens: 0,
      output_tokens: 0,
      input_amount_micros: 0,
      output_amount_micros: 0,
      cache_amount_micros: 0,
      base_amount_micros: 125_000,
      amount_micros: 125_000,
      image_count: 1,
      image_size: '1K',
      image_input_size: '1024x1024',
      image_output_size: '1024x1024',
      image_size_source: 'output',
      image_size_breakdown: { '1K': 1 },
      customer_pricing_snapshot_json: snapshot,
    }, 1_000)
    const firstDatabase = new QueueDatabase()
    const first = message(event)
    await consumeEvents(
      { queue: 'events', messages: [first] } as unknown as MessageBatch<unknown>,
      env(firstDatabase),
    )
    const storedDigest = firstDatabase.batches[0][1].values[3]

    const replayDatabase = new QueueDatabase({ result_digest: storedDigest as string })
    const replay = message(event)
    await consumeEvents(
      { queue: 'events', messages: [replay] } as unknown as MessageBatch<unknown>,
      env(replayDatabase),
    )

    expect(replay.ack).toHaveBeenCalledOnce()
    expect(replay.retry).not.toHaveBeenCalled()
    expect(replayDatabase.batches).toHaveLength(0)
  })

  it('rejects malformed, non-object, and oversized customer pricing snapshots', async () => {
    const invalidSnapshots: unknown[] = [
      42,
      '{',
      '[]',
      'null',
      JSON.stringify({ value: '😀'.repeat(16_383) }),
    ]
    const items = invalidSnapshots.map((customerPricingSnapshot) => {
      const event = createUsageEvent({ ...payload }, 1_000)
      Reflect.set(event.payload, 'customer_pricing_snapshot_json', customerPricingSnapshot)
      return message(event)
    })
    const database = new QueueDatabase()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await consumeEvents(
      { queue: 'events', messages: items } as unknown as MessageBatch<unknown>,
      env(database),
    )

    for (const item of items) {
      expect(item.ack).not.toHaveBeenCalled()
      expect(item.retry).toHaveBeenCalledOnce()
    }
    expect(database.batches).toHaveLength(0)
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
    delete (legacyEvent.payload as Partial<UsageSettledPayload>).standard_cost_micros
    delete (legacyEvent.payload as Partial<UsageSettledPayload>).account_stats_cost_micros
    delete (legacyEvent.payload as Partial<UsageSettledPayload>).account_rate_multiplier_ppm
    delete (legacyEvent.payload as Partial<UsageSettledPayload>).account_cost_micros
    const database = new QueueDatabase()
    const item = message(legacyEvent)

    await consumeEvents({ queue: 'events', messages: [item] } as unknown as MessageBatch<unknown>, env(database))

    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
    expect(database.batches[0][0].values.slice(9, 13)).toEqual([40, null, 1_000_000, 40])
    expect(database.batches[0][0].values.slice(-20, -10)).toEqual([
      'balance', null, '', 'group-1', 1, '', '', 'token', 0, 1,
    ])
    const wireDigest = database.batches[0][1].values[3]
    expect(wireDigest).toBe(await sha256Hex(JSON.stringify(legacyEvent)))

    const replayDatabase = new QueueDatabase({ result_digest: wireDigest as string })
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

  it('rejects partial or arithmetically inconsistent account-cost snapshots', async () => {
    const partialEvent = createUsageEvent({ ...payload }, 1_000)
    delete (partialEvent.payload as Partial<UsageSettledPayload>).account_cost_micros
    const inconsistentEvent = createUsageEvent({ ...payload, account_cost_micros: 41 }, 1_000)
    const partial = message(partialEvent)
    const inconsistent = message(inconsistentEvent)
    const database = new QueueDatabase()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await consumeEvents(
      { queue: 'events', messages: [partial, inconsistent] } as unknown as MessageBatch<unknown>,
      env(database),
    )

    expect(partial.retry).toHaveBeenCalledOnce()
    expect(inconsistent.retry).toHaveBeenCalledOnce()
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
      spend_debt_micros: 25_000,
      enabled: false,
      updated_at_ms: 2_000,
    }))

    await consumeEvents({ queue: 'events', messages: [item] } as unknown as MessageBatch<unknown>, env(database))

    expect(item.ack).toHaveBeenCalledOnce()
    expect(database.batches).toHaveLength(1)
    expect(database.batches[0][0].query).toContain('UPDATE users')
    expect(database.batches[0][0].query).toContain('state_version <= ?')
    expect(database.batches[0][0].query).toContain('COALESCE(?, spend_debt_micros)')
    expect(database.batches[0][0].values).toEqual([
      900_000,
      25_000,
      'disabled',
      7,
      2_000,
      'user-1',
      7,
    ])
    expect(database.batches[0][1].query).toContain('INSERT INTO inbox')
  })
})
