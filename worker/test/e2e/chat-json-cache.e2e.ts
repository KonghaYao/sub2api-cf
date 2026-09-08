import { env, exports } from 'cloudflare:workers'
import { expect, it } from 'vitest'

it('serves a JSON-only Chat upstream as SSE with consistent cached usage, billing and dashboard', async () => {
  const model = 'chat-json-' + crypto.randomUUID()
  const bootstrap = await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/bootstrap', {
    method: 'POST', headers: { authorization: 'Bearer ' + env.ADMIN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ user: { email: crypto.randomUUID() + '@cache.test', balance_micros: 1000000 },
      group: { name: crypto.randomUUID() }, account: { name: crypto.randomUUID(), base_url: 'https://upstream.e2e.invalid/v1', api_key: 'fixture' },
      api_key: { name: 'chat-cache' }, models: [{ public_name: model, upstream_name: 'chat-json-cache-fixture', endpoint: 'chat_completions',
        input_micros_per_million: 2000000, output_micros_per_million: 4000000, cache_read_micros_per_million: 500000, minimum_reservation_micros: 100 }] }),
  }))
  expect(bootstrap.status).toBe(201)
  const f = (await bootstrap.json() as any).data
  const response = await exports.default.fetch(new Request('https://worker.e2e.invalid/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + f.api_key, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 128 }),
  }))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  // Parse actual SSE framing as a client would, retaining the delimiter.
  const reader = response.body!.getReader(), decoder = new TextDecoder()
  let pending = '', answer = '', cached = -1, written = -1, done = false
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    pending += decoder.decode(chunk.value, { stream: true })
    let index: number
    while ((index = pending.indexOf('\n\n')) >= 0) {
      const frame = pending.slice(0, index); pending = pending.slice(index + 2)
      const data = frame.slice(6)
      if (data === '[DONE]') { done = true; continue }
      const event = JSON.parse(data)
      expect(event.object).toBe('chat.completion.chunk')
      answer += event.choices[0]?.delta?.content ?? ''
      if (event.usage) { cached = event.usage.prompt_tokens_details.cached_tokens; written = event.usage.prompt_tokens_details.cache_write_tokens }
    }
  }
  expect({ answer, cached, written, done, pending }).toEqual({ answer: 'Cache and streaming OK', cached: 80, written: 10, done: true, pending: '' })
  await expect.poll(async () => (await env.DB.prepare('SELECT cache_read_tokens FROM usage_projection WHERE user_id=?').bind(f.user_id).first<any>())?.cache_read_tokens).toBe(80)
  const dashboard = await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/dashboard/snapshot-v2?user_id=' + f.user_id,
    { headers: { authorization: 'Bearer ' + f.admin_session } }))
  expect(dashboard.status).toBe(200)
  expect((await dashboard.json() as any).data.trend[0]).toMatchObject({ input_tokens: 10, cache_creation_tokens: 10, cache_read_tokens: 80, total_tokens: 102 })
  const adminGet = async (path: string) => {
    const res = await exports.default.fetch(new Request('https://worker.e2e.invalid' + path, { headers: { authorization: 'Bearer ' + f.admin_session } }))
    expect(res.status, path).toBe(200)
    return (await res.json() as any).data
  }
  expect(await adminGet('/api/v1/admin/usage/stats?user_id=' + f.user_id)).toMatchObject({ total_input_tokens: 10, total_cache_creation_tokens: 10, total_cache_read_tokens: 80, total_cache_tokens: 90, total_tokens: 102 })
  expect((await adminGet('/api/v1/admin/usage?page=1&user_id=' + f.user_id)).items[0]).toMatchObject({ input_tokens: 10, cache_creation_tokens: 10, cache_read_tokens: 80 })
  expect((await adminGet('/api/v1/admin/dashboard/models?user_id=' + f.user_id)).models[0]).toMatchObject({ input_tokens: 10, cache_creation_tokens: 10, cache_read_tokens: 80 })
  expect((await adminGet('/api/v1/admin/accounts/' + f.account_id + '/stats')).models[0]).toMatchObject({ input_tokens: 10, cache_creation_tokens: 10, cache_read_tokens: 80 })
  const keyUsage = await exports.default.fetch(new Request('https://worker.e2e.invalid/v1/usage', { headers: { authorization: 'Bearer ' + f.api_key } }))
  expect(keyUsage.status).toBe(200)
  expect(await keyUsage.json()).toMatchObject({ usage: { total: { input_tokens: 10, cache_creation_tokens: 10, cache_read_tokens: 80, total_tokens: 102 }, today: { cache_creation_tokens: 10 } }, model_stats: [{ cache_creation_tokens: 10 }], daily_usage: [{ cache_write_tokens: 10 }] })
  const state = await (await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
  await env.DB.prepare('UPDATE accounts SET ui_config_json=? WHERE id=?').bind(
    JSON.stringify({ extra: { openai_responses_mode: 'force_chat_completions' } }), f.account_id).run()
  const diagnostic = await exports.default.fetch(new Request(`https://worker.e2e.invalid/api/v1/admin/accounts/${f.account_id}/test`, {
    method: 'POST', headers: { authorization: 'Bearer ' + f.admin_session, 'content-type': 'application/json' },
    body: JSON.stringify({ model_id: 'chat-json-diagnostic-fixture', prompt: 'Hi' }),
  }))
  expect(diagnostic.status).toBe(200)
  const diagnosticEvents = (await diagnostic.text()).trim().split('\n\n').map(frame => JSON.parse(frame.slice(6)))
  expect(diagnosticEvents).toContainEqual({ type: 'content', text: 'Cache and streaming OK' })
  expect(diagnosticEvents.at(-1)).toMatchObject({ type: 'test_complete', success: true })
  expect(state.profile.reserved_micros).toBe(0)
  expect(state.ledger.filter((row: any) => row.amount_delta_micros < 0)).toHaveLength(1)
  expect(state.ledger.find((row: any) => row.amount_delta_micros < 0).amount_delta_micros).toBe(-88)
})
