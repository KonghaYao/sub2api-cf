import { env, exports } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

async function workerRequest(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`https://worker.e2e.invalid${path}`, init))
}

async function jsonRequest(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return workerRequest(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function responseData<T>(response: Response): Promise<T> {
  const body = await response.json() as { code: number; data: T }
  expect(body.code).toBe(0)
  return body.data
}

interface ChatStreamChunk {
  id: string
  object: string
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function: { name?: string; arguments: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

function sseData(source: string): string[] {
  return source
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()))
    .filter((data) => data !== '')
}

describe('Chat Completions to Responses binding bridge', () => {
  it('routes through a Responses-only account and settles usage and leases exactly once', async () => {
    const bootstrap = await jsonRequest('/api/v1/admin/bootstrap', {
      user: {
        email: 'bridge-admin@binding-e2e.test',
        display_name: 'Bridge Admin',
        balance_micros: 1_000_000,
      },
      group: { name: 'Bridge Group' },
      account: {
        name: 'Responses-only mock',
        base_url: 'https://upstream.e2e.invalid/v1',
        api_key: 'upstream-e2e-secret',
        max_concurrency: 2,
      },
      api_key: { name: 'Bridge key' },
      models: [{
        public_name: 'gpt-bridge',
        upstream_name: 'gpt-bridge-upstream',
        endpoint: 'both',
        input_micros_per_million: 1_000_000,
        output_micros_per_million: 2_000_000,
        per_request_micros: 7,
        minimum_reservation_micros: 100,
      }],
    }, {
      authorization: `Bearer ${env.ADMIN_TOKEN}`,
    })
    expect(bootstrap.status).toBe(201)
    const bootstrapped = await responseData<{
      user_id: string
      group_id: string
      account_id: string
      api_key_id: string
      api_key: string
    }>(bootstrap)

    const routeModel = await env.DB.prepare(
      'SELECT id FROM models WHERE public_name = ?',
    ).bind('gpt-bridge').first<{ id: string }>()
    expect(routeModel).not.toBeNull()
    await env.DB.prepare(
      `UPDATE account_models
          SET chat_completions = 0, responses = 1, updated_at_ms = ?
        WHERE account_id = ? AND model_id = ?`,
    ).bind(Date.now(), bootstrapped.account_id, routeModel!.id).run()
    await expect(env.DB.prepare(
      `SELECT chat_completions, responses
         FROM account_models
        WHERE account_id = ? AND model_id = ?`,
    ).bind(bootstrapped.account_id, routeModel!.id).first()).resolves.toEqual({
      chat_completions: 0,
      responses: 1,
    })

    const completion = await jsonRequest('/v1/chat/completions', {
      model: 'gpt-bridge',
      messages: [
        { role: 'system', content: 'Answer precisely.' },
        { role: 'user', content: 'Say bridge-ok.' },
      ],
      max_completion_tokens: 64,
      stream: false,
    }, {
      authorization: `Bearer ${bootstrapped.api_key}`,
    })

    expect(completion.status, JSON.stringify(await completion.clone().json())).toBe(200)
    expect(completion.headers.get('content-type')).toContain('application/json')
    await expect(completion.json()).resolves.toMatchObject({
      id: 'resp-binding-bridge',
      object: 'chat.completion',
      model: 'gpt-bridge',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'bridge-ok' },
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    })

    await expect.poll(async () => {
      const projections = await env.DB.prepare(
        `SELECT requested_model, upstream_model, input_tokens, output_tokens,
                amount_micros, outcome, stream
           FROM usage_projection
          WHERE api_key_id = ?`,
      ).bind(bootstrapped.api_key_id).all<{
        requested_model: string
        upstream_model: string
        input_tokens: number
        output_tokens: number
        amount_micros: number
        outcome: string
        stream: number
      }>()
      const user = await env.DB.prepare(
        'SELECT balance_micros FROM users WHERE id = ?',
      ).bind(bootstrapped.user_id).first<{ balance_micros: number }>()
      return { projections: projections.results, user }
    }, { timeout: 10_000, interval: 25 }).toEqual({
      projections: [{
        requested_model: 'gpt-bridge',
        upstream_model: 'gpt-bridge-upstream',
        input_tokens: 10,
        output_tokens: 5,
        amount_micros: 27,
        outcome: 'completed',
        stream: 0,
      }],
      user: { balance_micros: 999_973 },
    })

    await expect(env.DB.prepare(
      'SELECT COUNT(*) AS total FROM settlement_recovery',
    ).first()).resolves.toEqual({ total: 0 })

    const poolName = [
      `group:${bootstrapped.group_id}`,
      'platform:openai',
      `model:${routeModel!.id}`,
      // The logical request pool contains both Chat and Responses candidates.
      'endpoint:chat_completions',
      'shard:0',
    ].join(':')
    const pool = env.POOL_STATE.get(env.POOL_STATE.idFromName(poolName))
    const poolSnapshot = await pool.fetch('https://pool-state.invalid/snapshot')
    await expect(poolSnapshot.json()).resolves.toMatchObject({
      accounts: [{ account_id: bootstrapped.account_id, active_leases: 0 }],
      active_leases: [],
    })
    const leases = await runInDurableObject(pool, (_instance, state) =>
      Array.from(state.storage.sql.exec<{ status: string }>(
        'SELECT status FROM pool_leases',
      )))
    expect(leases).toEqual([{ status: 'released' }])
  })

  it('streams Chat chunks with stable interleaved tools and settles once through a Responses-only account', async () => {
    const bootstrap = await jsonRequest('/api/v1/admin/bootstrap', {
      user: {
        email: 'bridge-stream-admin@binding-e2e.test',
        display_name: 'Bridge Stream Admin',
        balance_micros: 1_000_000,
      },
      group: { name: 'Bridge Stream Group' },
      account: {
        name: 'Streaming Responses-only mock',
        base_url: 'https://upstream.e2e.invalid/v1',
        api_key: 'upstream-stream-e2e-secret',
        max_concurrency: 2,
      },
      api_key: { name: 'Bridge stream key' },
      models: [{
        public_name: 'gpt-bridge-stream',
        upstream_name: 'gpt-bridge-stream-upstream',
        endpoint: 'both',
        input_micros_per_million: 1_000_000,
        output_micros_per_million: 2_000_000,
        per_request_micros: 7,
        minimum_reservation_micros: 100,
      }],
    }, {
      authorization: `Bearer ${env.ADMIN_TOKEN}`,
    })
    expect(bootstrap.status).toBe(201)
    const bootstrapped = await responseData<{
      user_id: string
      group_id: string
      account_id: string
      api_key_id: string
      api_key: string
    }>(bootstrap)
    const routeModel = await env.DB.prepare(
      'SELECT id FROM models WHERE public_name = ?',
    ).bind('gpt-bridge-stream').first<{ id: string }>()
    expect(routeModel).not.toBeNull()
    await env.DB.prepare(
      `UPDATE account_models
          SET chat_completions = 0, responses = 1, updated_at_ms = ?
        WHERE account_id = ? AND model_id = ?`,
    ).bind(Date.now(), bootstrapped.account_id, routeModel!.id).run()
    await expect(env.DB.prepare(
      `SELECT chat_completions, responses
         FROM account_models
        WHERE account_id = ? AND model_id = ?`,
    ).bind(bootstrapped.account_id, routeModel!.id).first()).resolves.toEqual({
      chat_completions: 0,
      responses: 1,
    })

    const completion = await jsonRequest('/v1/chat/completions', {
      model: 'gpt-bridge-stream',
      messages: [{ role: 'user', content: 'Run both tools.' }],
      max_tokens: 64,
      stream: true,
    }, {
      authorization: `Bearer ${bootstrapped.api_key}`,
    })
    expect(completion.status).toBe(200)
    expect(completion.headers.get('content-type')).toContain('text/event-stream')
    const wire = await completion.text()
    const data = sseData(wire)
    expect(data.filter((value) => value === '[DONE]')).toHaveLength(1)
    expect(data.at(-1)).toBe('[DONE]')
    expect(wire).not.toContain('gpt-bridge-stream-upstream')

    const chunks = data
      .filter((value) => value !== '[DONE]')
      .map((value) => JSON.parse(value) as ChatStreamChunk)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk')).toBe(true)
    expect(chunks.every((chunk) => chunk.id === 'resp-binding-stream')).toBe(true)
    expect(chunks.every((chunk) => chunk.model === 'gpt-bridge-stream')).toBe(true)

    const deltas = chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.delta))
    expect(deltas.filter((delta) => delta.role === 'assistant')).toEqual([{ role: 'assistant' }])
    expect(deltas.filter((delta) => delta.reasoning_content !== undefined))
      .toEqual([{ reasoning_content: 'choose tools' }])
    expect(deltas.filter((delta) => delta.content === 'working'))
      .toEqual([{ content: 'working' }])

    const toolDeltas = deltas.flatMap((delta) => delta.tool_calls ?? [])
    expect(toolDeltas.filter((tool) => tool.id !== undefined)).toEqual([
      {
        index: 0,
        id: 'call_alpha',
        type: 'function',
        function: { name: 'alpha', arguments: '' },
      },
      {
        index: 1,
        id: 'call_beta',
        type: 'function',
        function: { name: 'beta', arguments: '' },
      },
    ])
    expect(toolDeltas.filter((tool) => tool.id === undefined)).toEqual([
      { index: 1, function: { arguments: '{"b":' } },
      { index: 0, function: { arguments: '{"a":' } },
      { index: 1, function: { arguments: '2}' } },
      { index: 0, function: { arguments: '1}' } },
    ])

    const terminal = chunks.flatMap((chunk) => chunk.choices)
      .filter((choice) => choice.finish_reason !== null)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ finish_reason: 'tool_calls' })
    const usageChunks = chunks.filter((chunk) => chunk.usage !== undefined)
    expect(usageChunks).toHaveLength(1)
    expect(usageChunks[0]).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    })

    await expect.poll(async () => {
      const projections = await env.DB.prepare(
        `SELECT requested_model, upstream_model, input_tokens, output_tokens,
                amount_micros, outcome, stream
           FROM usage_projection
          WHERE api_key_id = ?`,
      ).bind(bootstrapped.api_key_id).all()
      const user = await env.DB.prepare(
        'SELECT balance_micros FROM users WHERE id = ?',
      ).bind(bootstrapped.user_id).first()
      return { projections: projections.results, user }
    }, { timeout: 10_000, interval: 25 }).toEqual({
      projections: [{
        requested_model: 'gpt-bridge-stream',
        upstream_model: 'gpt-bridge-stream-upstream',
        input_tokens: 12,
        output_tokens: 6,
        amount_micros: 31,
        outcome: 'completed',
        stream: 1,
      }],
      user: { balance_micros: 999_969 },
    })
    await expect(env.DB.prepare(
      'SELECT COUNT(*) AS total FROM settlement_recovery',
    ).first()).resolves.toEqual({ total: 0 })

    const poolName = [
      `group:${bootstrapped.group_id}`,
      'platform:openai',
      `model:${routeModel!.id}`,
      // The logical request pool contains both Chat and Responses candidates.
      'endpoint:chat_completions',
      'shard:0',
    ].join(':')
    const pool = env.POOL_STATE.get(env.POOL_STATE.idFromName(poolName))
    const leases = await runInDurableObject(pool, (_instance, state) =>
      Array.from(state.storage.sql.exec<{ status: string }>(
        'SELECT status FROM pool_leases',
      )))
    expect(leases).toEqual([{ status: 'released' }])
  })

  it('fails over a pre-output Responses semantic failure through real D1, DO, and Queue bindings', async () => {
    const bootstrap = await jsonRequest('/api/v1/admin/bootstrap', {
      user: {
        email: 'bridge-failover-admin@binding-e2e.test',
        display_name: 'Bridge Failover Admin',
        balance_micros: 1_000_000,
      },
      group: { name: 'Bridge Failover Group' },
      account: {
        name: 'Failing Responses mock',
        base_url: 'https://upstream.e2e.invalid/v1',
        api_key: 'upstream-failing-e2e-secret',
        max_concurrency: 2,
      },
      api_key: { name: 'Bridge failover key' },
      models: [{
        public_name: 'gpt-bridge-failover',
        upstream_name: 'gpt-bridge-failover-upstream',
        endpoint: 'both',
        input_micros_per_million: 1_000_000,
        output_micros_per_million: 2_000_000,
        per_request_micros: 7,
        minimum_reservation_micros: 100,
      }],
    }, {
      authorization: `Bearer ${env.ADMIN_TOKEN}`,
    })
    expect(bootstrap.status).toBe(201)
    const bootstrapped = await responseData<{
      user_id: string
      group_id: string
      account_id: string
      api_key_id: string
      api_key: string
      admin_session: string
    }>(bootstrap)
    const routeModel = await env.DB.prepare(
      'SELECT id FROM models WHERE public_name = ?',
    ).bind('gpt-bridge-failover').first<{ id: string }>()
    expect(routeModel).not.toBeNull()
    // The E2E file intentionally shares one migrated D1 instance, so only its
    // first bootstrapped administrator receives the one-time super-admin grant.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO admin_user_roles (
         user_id, role_id, active, control_version, assigned_by_user_id, assigned_at_ms
       ) VALUES (?, 'admin', 1, 1, NULL, ?)`,
    ).bind(bootstrapped.user_id, Date.now()).run()
    await env.DB.prepare(
      `UPDATE account_models
          SET chat_completions = 0, responses = 1, updated_at_ms = ?
        WHERE account_id = ? AND model_id = ?`,
    ).bind(Date.now(), bootstrapped.account_id, routeModel!.id).run()

    const fallback = await jsonRequest('/api/v1/admin/accounts', {
      name: 'Successful Responses fallback',
      platform: 'openai',
      protocol: 'openai',
      base_url: 'https://upstream-fallback.e2e.invalid/v1',
      auth_scheme: 'bearer',
      provider_config: {},
      api_key: 'upstream-fallback-e2e-secret',
      enabled: true,
      max_concurrency: 2,
      group_links: [{ group_id: bootstrapped.group_id, priority: 1, weight: 1 }],
      model_capabilities: [{
        model_id: routeModel!.id,
        chat_completions: false,
        responses: true,
      }],
    }, {
      authorization: `Bearer ${bootstrapped.admin_session}`,
      'idempotency-key': 'binding-e2e-create-fallback-account-0001',
    })
    expect(fallback.status, JSON.stringify(await fallback.clone().json())).toBe(201)
    const fallbackAccount = await responseData<{ id: string }>(fallback)

    const completion = await jsonRequest('/v1/chat/completions', {
      model: 'gpt-bridge-failover',
      messages: [{ role: 'user', content: 'Use the healthy fallback.' }],
      stream: false,
    }, {
      authorization: `Bearer ${bootstrapped.api_key}`,
    })

    expect(completion.status, JSON.stringify(await completion.clone().json())).toBe(200)
    await expect(completion.json()).resolves.toMatchObject({
      id: 'resp-binding-failover',
      object: 'chat.completion',
      model: 'gpt-bridge-failover',
      choices: [{ message: { role: 'assistant', content: 'binding-failover-ok' } }],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
    })

    await expect.poll(async () => {
      const projections = await env.DB.prepare(
        `SELECT input_tokens, output_tokens, amount_micros, outcome, stream
           FROM usage_projection WHERE api_key_id = ?`,
      ).bind(bootstrapped.api_key_id).all()
      const user = await env.DB.prepare(
        'SELECT balance_micros FROM users WHERE id = ?',
      ).bind(bootstrapped.user_id).first()
      return { projections: projections.results, user }
    }, { timeout: 10_000, interval: 25 }).toEqual({
      projections: [{
        input_tokens: 9,
        output_tokens: 3,
        amount_micros: 22,
        outcome: 'completed',
        stream: 0,
      }],
      user: { balance_micros: 999_978 },
    })

    const poolName = [
      `group:${bootstrapped.group_id}`,
      'platform:openai',
      `model:${routeModel!.id}`,
      // The logical request pool contains both Chat and Responses candidates.
      'endpoint:chat_completions',
      'shard:0',
    ].join(':')
    const pool = env.POOL_STATE.get(env.POOL_STATE.idFromName(poolName))
    const state = await runInDurableObject(pool, (_instance, storage) => ({
      accounts: Array.from(storage.storage.sql.exec<{
        account_id: string
        consecutive_failures: number
      }>(
        'SELECT account_id, consecutive_failures FROM pool_accounts ORDER BY priority ASC',
      )),
      leases: Array.from(storage.storage.sql.exec<{
        account_id: string
        status: string
      }>(
        'SELECT account_id, status FROM pool_leases ORDER BY created_at_ms ASC',
      )),
    }))
    expect(state.accounts).toEqual([
      { account_id: bootstrapped.account_id, consecutive_failures: 1 },
      { account_id: fallbackAccount.id, consecutive_failures: 0 },
    ])
    expect(state.leases).toEqual([
      { account_id: bootstrapped.account_id, status: 'released' },
      { account_id: fallbackAccount.id, status: 'released' },
    ])
  })
})
