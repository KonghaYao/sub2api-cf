import { env, exports } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { createApp } from '../../src/app'
import { describe, expect, it, vi } from 'vitest'

async function request(path: string, token: string, body?: unknown): Promise<Response> {
  return exports.default.fetch(new Request(`https://worker.e2e.invalid${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
}
type Fixture = { user_id: string; api_key_id: string; api_key: string; group_id: string; account_id: string }
async function bootstrap(upstream = 'gpt-binding-upstream', balance = 1_000_000): Promise<Fixture> {
  const response = await request('/api/v1/admin/bootstrap', env.ADMIN_TOKEN!, {
    user: { email: `${crypto.randomUUID()}@lifecycle.test`, balance_micros: balance },
    group: { name: `Lifecycle ${crypto.randomUUID()}` },
    account: { name: `Upstream ${crypto.randomUUID()}`, base_url: 'https://upstream.e2e.invalid/v1', api_key: 'local-fixture-key', max_concurrency: 1 },
    api_key: { name: 'Lifecycle key' },
    models: [{ public_name: `lifecycle-${crypto.randomUUID()}`, upstream_name: upstream, endpoint: 'chat_completions', input_micros_per_million: 1_000_000, output_micros_per_million: 2_000_000, per_request_micros: 7, minimum_reservation_micros: 100 }],
  })
  expect(response.status, await response.clone().text()).toBe(201)
  return (await response.json() as { data: Fixture }).data
}
async function model(fixture: Fixture): Promise<string> {
  const row = await env.DB.prepare('SELECT m.public_name FROM models m JOIN group_models gm ON gm.model_id=m.id WHERE gm.group_id=?').bind(fixture.group_id).first<{ public_name: string }>()
  return row!.public_name
}
async function completion(fixture: Fixture, override: Record<string, unknown> = {}): Promise<Response> {
  return request('/v1/chat/completions', fixture.api_key, { model: await model(fixture), messages: [{ role: 'user', content: 'hello' }], max_tokens: 16, ...override })
}
type Snapshot = {
  profile: { balance_micros: number; reserved_micros: number }
  requests: { request_id: string; settled_micros: number | null }[]
  ledger: { request_id: string | null; amount_delta_micros: number }[]
}
async function snapshot(fixture: Fixture): Promise<Snapshot> {
  const stub = env.USER_STATE.get(env.USER_STATE.idFromName(fixture.user_id))
  return (await stub.fetch('https://state.test/snapshot')).json<Snapshot>()
}
async function assertNoCharge(fixture: Fixture): Promise<void> {
  const state = await snapshot(fixture)
  expect(state.profile).toMatchObject({ balance_micros: 1_000_000, reserved_micros: 0 })
  expect(state.requests.every((r) => (r.settled_micros ?? 0) === 0)).toBe(true)
  expect(await env.DB.prepare('SELECT quota_used_micros FROM api_keys WHERE id=?').bind(fixture.api_key_id).first()).toEqual({ quota_used_micros: 0 })
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM settlement_recovery WHERE user_id=?').bind(fixture.user_id).first()).toEqual({ count: 0 })
}

describe('billing lifecycle over real Worker/D1/DO/Queue', () => {
  it('ties the same successful request to a single ledger debit, Key usage and projected usage', async () => {
    const fixture = await bootstrap()
    const response = await completion(fixture)
    expect(response.status, await response.clone().text()).toBe(200)
    const requestId = response.headers.get('x-request-id')
    const state = await snapshot(fixture)
    expect(state.profile).toMatchObject({ balance_micros: 999_973, reserved_micros: 0 })
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0]).toMatchObject({ request_id: requestId, settled_micros: 27 })
    expect(state.ledger.filter((r) => r.request_id === requestId && r.amount_delta_micros < 0)).toHaveLength(1)
    await vi.waitFor(async () => {
      expect(await env.DB.prepare('SELECT amount_micros,outcome FROM usage_projection WHERE request_id=?').bind(requestId).first()).toEqual({ amount_micros: 27, outcome: 'completed' })
      expect(await env.DB.prepare('SELECT balance_micros FROM users WHERE id=?').bind(fixture.user_id).first()).toEqual({ balance_micros: 999_973 })
    })
    expect(await env.DB.prepare('SELECT quota_used_micros FROM api_keys WHERE id=?').bind(fixture.api_key_id).first()).toEqual({ quota_used_micros: 27 })
  })

  it.each(['user', 'key', 'group'])('immediately rejects a disabled %s after a successful request', async (kind) => {
    const fixture = await bootstrap()
    expect((await completion(fixture)).status).toBe(200)
    await vi.waitFor(async () => expect(await env.DB.prepare('SELECT balance_micros FROM users WHERE id=?').bind(fixture.user_id).first()).toEqual({ balance_micros: 999_973 }))
    if (kind === 'user') await env.DB.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(fixture.user_id).run()
    if (kind === 'key') await env.DB.prepare('UPDATE api_keys SET enabled=0 WHERE id=?').bind(fixture.api_key_id).run()
    if (kind === 'group') await env.DB.prepare('UPDATE groups SET enabled=0 WHERE id=?').bind(fixture.group_id).run()
    const response = await completion(fixture)
    expect([401, 403]).toContain(response.status)
    const state = await snapshot(fixture)
    expect(state.profile).toMatchObject({ balance_micros: 999_973, reserved_micros: 0 })
    expect(state.requests).toHaveLength(1)
    const models = await request('/v1/models', fixture.api_key)
    expect([401, 403]).toContain(models.status)
  })

  it('denies insufficient balance without reserving or settling', async () => {
    const fixture = await bootstrap('gpt-binding-upstream', 1)
    const response = await completion(fixture)
    expect(response.status, await response.clone().text()).toBe(403)
    expect((await snapshot(fixture)).profile).toMatchObject({ balance_micros: 1, reserved_micros: 0 })
  })

  it.each(['success', 'partial-error', 'cancel', 'late-usage'])('settles a %s stream once using reported usage and releases the reservation', async (mode) => {
    const fixture = await bootstrap(`lifecycle-stream-${mode}-upstream`)
    const ctx = createExecutionContext()
    // Invoke the same router inside workerd for cancellation: the service-binding
    // RPC response proxy does not propagate ReadableStream.cancel to its source.
    const response = mode === 'cancel'
      ? await createApp().fetch(new Request('https://worker.e2e.invalid/v1/chat/completions', {
          method: 'POST', headers: { authorization: `Bearer ${fixture.api_key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: await model(fixture), messages: [{ role: 'user', content: 'hello' }], max_tokens: 16, stream: true }),
        }), env, ctx)
      : await completion(fixture, { stream: true })
    expect(response.status).toBe(200)
    if (mode === 'cancel') {
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('hello')
      await reader.cancel('client went away')
      await waitOnExecutionContext(ctx)
    } else {
      expect(await response.text()).toContain('hello')
    }
    await vi.waitFor(async () => {
      const state = await snapshot(fixture)
      expect(state.profile).toMatchObject({ balance_micros: 999_973, reserved_micros: 0 })
      expect(state.requests).toHaveLength(1)
      expect(state.requests[0]).toMatchObject({ settled_micros: 27 })
      expect(state.ledger.filter((r) => r.amount_delta_micros < 0)).toHaveLength(1)
      expect(await env.DB.prepare('SELECT amount_micros,outcome FROM usage_projection WHERE api_key_id=?').bind(fixture.api_key_id).first()).toEqual({ amount_micros: 27, outcome: mode === 'success' ? 'completed' : mode === 'cancel' ? 'cancelled' : 'failed' })
    }, { timeout: 5000 })
    expect(await env.DB.prepare('SELECT quota_used_micros FROM api_keys WHERE id=?').bind(fixture.api_key_id).first()).toEqual({ quota_used_micros: 27 })
  })

  it('rejects exhausted Key quota and releases the user reservation', async () => {
    const fixture = await bootstrap()
    await env.DB.prepare('UPDATE api_keys SET quota_micros=1 WHERE id=?').bind(fixture.api_key_id).run()
    const response = await completion(fixture)
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: { code: 'api_key_quota_exceeded' } })
    await assertNoCharge(fixture)
  })

  it('hides unroutable models and rejects unknown models without spending', async () => {
    const fixture = await bootstrap()
    const publicName = await model(fixture)
    const visible = await request('/v1/models', fixture.api_key)
    expect(await visible.json()).toMatchObject({ data: [{ id: publicName }] })
    await env.DB.prepare('UPDATE accounts SET enabled=0 WHERE id=?').bind(fixture.account_id).run()
    expect(await (await request('/v1/models', fixture.api_key)).json()).toMatchObject({ data: [] })
    const response = await completion(fixture, { model: 'nonexistent-lifecycle-model' })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'model_not_found' } })
    expect(await env.DB.prepare('SELECT quota_used_micros FROM api_keys WHERE id=?').bind(fixture.api_key_id).first()).toEqual({ quota_used_micros: 0 })
  })

  it('records an error-only Chat stream as failed at zero cost even when followed by DONE', async () => {
    const fixture = await bootstrap('lifecycle-stream-error-upstream')
    const response = await completion(fixture, { stream: true })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('resource_exhausted')
    await vi.waitFor(async () => {
      expect(await env.DB.prepare('SELECT amount_micros,outcome,input_tokens,output_tokens FROM usage_projection WHERE api_key_id=?').bind(fixture.api_key_id).first()).toEqual({ amount_micros: 0, outcome: 'failed', input_tokens: 0, output_tokens: 0 })
    })
    await assertNoCharge(fixture)
  })

  it.each(['lifecycle-invalid-json-upstream', 'lifecycle-quota-upstream'])('rejects %s without charging or leaking a reservation', async (upstream) => {
    const fixture = await bootstrap(upstream)
    const response = await completion(fixture)
    expect(response.status, await response.clone().text()).toBe(upstream.includes('quota') ? 429 : 502)
    await assertNoCharge(fixture)
  })
})
