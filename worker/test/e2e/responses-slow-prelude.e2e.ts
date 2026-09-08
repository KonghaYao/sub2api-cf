import { env, exports } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it } from 'vitest'
import { poolStateName } from '../../src/gateway/state-client'

it('keeps a healthy slow Responses upstream for Chat and renews every lease before first content', async () => {
  async function bootstrap(key: string) {
    const publicModel = 'prelude-' + crypto.randomUUID()
    const result = await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/bootstrap', {
      method: 'POST', headers: { authorization: 'Bearer ' + env.ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ user: { email: crypto.randomUUID() + '@prelude.test', balance_micros: 1000000 },
        group: { name: crypto.randomUUID() }, account: { name: crypto.randomUUID(), base_url: 'https://upstream.e2e.invalid/v1', api_key: key },
        api_key: { name: 'Prelude' }, models: [{ public_name: publicModel, upstream_name: 'responses-slow-prelude-fixture', endpoint: 'responses',
          input_micros_per_million: 1000000, output_micros_per_million: 2000000, per_request_micros: 7, minimum_reservation_micros: 100 }] }),
    }))
    expect(result.status).toBe(201)
    return { ...(await result.json() as any).data, publicModel }
  }
  const first = await bootstrap('slow-prelude-key'), second = await bootstrap('unexpected-fallback-key'), now = Date.now()
  const model = await env.DB.prepare('SELECT model_id FROM group_models WHERE group_id=?').bind(first.group_id).first<{ model_id: string }>()
  await env.DB.batch([
    env.DB.prepare('UPDATE account_groups SET priority=0 WHERE account_id=?').bind(first.account_id),
    env.DB.prepare('INSERT INTO account_groups(account_id,group_id,priority,weight,created_at_ms,updated_at_ms) VALUES(?,?,100,1,?,?)').bind(second.account_id, first.group_id, now, now),
    env.DB.prepare('INSERT INTO account_models(account_id,model_id,chat_completions,responses,created_at_ms,updated_at_ms) VALUES(?,?,0,1,?,?)').bind(second.account_id, model!.model_id, now, now),
  ])
  const response = await exports.default.fetch(new Request('https://worker.e2e.invalid/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + first.api_key, 'content-type': 'application/json' },
    body: JSON.stringify({ model: first.publicModel, stream: true, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 128 }),
  }))
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).toContain('Slow reasoning OK')
  expect(text).not.toContain('Unexpected fallback')
  expect(text).toContain('data: [DONE]')
  const pool = env.POOL_STATE.get(env.POOL_STATE.idFromName(poolStateName(first.group_id, model!.model_id, 'chat_completions')))
  const leases = await runInDurableObject(pool, (_instance, state) => Array.from(state.storage.sql.exec('SELECT account_id,status,renewal_sequence FROM pool_leases')))
  expect(leases).toHaveLength(1)
  expect(leases[0]).toMatchObject({ account_id: first.account_id, status: 'released' })
  expect(Number(leases[0].renewal_sequence)).toBeGreaterThanOrEqual(3)
  const metrics = await (await pool.fetch('https://pool.test/snapshot')).json() as any
  expect(metrics.scheduler_metrics).toEqual([expect.objectContaining({ account_id: first.account_id, error_rate: 0 })])
  const state = await (await env.USER_STATE.get(env.USER_STATE.idFromName(first.user_id)).fetch('https://state.test/snapshot')).json() as any
  expect(state.profile).toMatchObject({ balance_micros: 999973, reserved_micros: 0 })
  expect(state.ledger.filter((row: any) => row.amount_delta_micros < 0)).toHaveLength(1)
}, 90000)
