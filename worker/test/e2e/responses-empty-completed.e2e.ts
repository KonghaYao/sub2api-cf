import { env, exports } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { poolStateName } from '../../src/gateway/state-client'

it.each([
  ['chat/completions', true, false, true], ['chat/completions', false, false, true], ['responses', true, false, true], ['responses', false, false, true],
  ['chat/completions', true, true, true], ['chat/completions', false, true, true], ['responses', true, true, true], ['responses', false, true, true],
  ['chat/completions', true, false, false],
] as const)('handles empty completed for %s stream=%s fallback=%s large=%s without leaking or charging the empty attempt', async (endpoint, stream, recover, large) => {
  async function bootstrap(key: string) {
    const model = 'empty-' + crypto.randomUUID()
    const response = await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/bootstrap', {
      method: 'POST', headers: { authorization: 'Bearer ' + env.ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ user: { email: crypto.randomUUID() + '@empty.test', balance_micros: 1000000 }, group: { name: crypto.randomUUID() },
        account: { name: crypto.randomUUID(), base_url: 'https://upstream.e2e.invalid/v1', api_key: key }, api_key: { name: 'Empty completed' },
        models: [{ public_name: model, upstream_name: 'responses-empty-completed-fixture', endpoint: 'responses', input_micros_per_million: 1000000,
          output_micros_per_million: 2000000, per_request_micros: 7, minimum_reservation_micros: 100 }] }),
    }))
    expect(response.status).toBe(201)
    return { ...(await response.json() as any).data, model }
  }
  const first = await bootstrap('empty-fixture-key')
  const route = await env.DB.prepare('SELECT model_id FROM group_models WHERE group_id=?').bind(first.group_id).first<{ model_id: string }>()
  if (recover) {
    const second = await bootstrap('silent-recovery-key'), now = Date.now()
    await env.DB.batch([
      env.DB.prepare('UPDATE account_groups SET priority=0 WHERE account_id=?').bind(first.account_id),
      env.DB.prepare('INSERT INTO account_groups(account_id,group_id,priority,weight,created_at_ms,updated_at_ms) VALUES(?,?,100,1,?,?)').bind(second.account_id, first.group_id, now, now),
      env.DB.prepare('INSERT INTO account_models(account_id,model_id,chat_completions,responses,created_at_ms,updated_at_ms) VALUES(?,?,0,1,?,?)').bind(second.account_id, route!.model_id, now, now),
    ])
  }
  const response = await exports.default.fetch(new Request('https://worker.e2e.invalid/v1/' + endpoint, {
    method: 'POST', headers: { authorization: 'Bearer ' + first.api_key, 'content-type': 'application/json' },
    body: JSON.stringify({ model: first.model, stream, ...(endpoint === 'responses' ? { input: 'Hello', max_output_tokens: 128 }
      : { messages: [{ role: 'user', content: large ? 'x'.repeat(65536) : 'Hello' }], max_tokens: 128 }) }),
  }))
  const shouldFail = !recover && (endpoint === 'responses' || large)
  expect(response.status).toBe(shouldFail ? 502 : 200)
  const text = await response.text()
  expect(text).toContain(recover ? 'Recovered' : shouldFail ? 'openai_silent_refusal' : 'data: [DONE]')
  if (recover || shouldFail) expect(text).not.toContain('empty-attempt')
  expect(text).not.toContain('empty-placeholder')
  const state = await (await env.USER_STATE.get(env.USER_STATE.idFromName(first.user_id)).fetch('https://state.test/snapshot')).json() as any
  expect(state.profile.reserved_micros).toBe(0)
  if (recover || shouldFail) {
    expect(state.profile.balance_micros).toBe(recover ? 999973 : 1000000)
    expect(state.ledger.filter((row: any) => row.amount_delta_micros < 0)).toHaveLength(recover ? 1 : 0)
  }
  const pool = env.POOL_STATE.get(env.POOL_STATE.idFromName(poolStateName(first.group_id, route!.model_id, endpoint === 'responses' ? 'responses' : 'chat_completions')))
  const metrics = await (await pool.fetch('https://pool.test/snapshot')).json() as any
  expect(metrics.scheduler_metrics.find((row: any) => row.account_id === first.account_id)).toMatchObject({ samples: 1, error_rate: recover || shouldFail ? 1 : 0 })
  expect(metrics.accounts.every((row: any) => row.active_leases === 0)).toBe(true)
})
