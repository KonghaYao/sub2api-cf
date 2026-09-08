import { env, exports } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it } from 'vitest'

it.each(['buffered', 'stream', 'slow'] as const)('bridges a Chat-only Composer catalog to Responses: %s', async mode => {
  const model = 'composer-' + crypto.randomUUID()
  const bootstrap = await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/bootstrap', {
    method: 'POST', headers: { authorization: 'Bearer ' + env.ADMIN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ user: { email: crypto.randomUUID() + '@composer.test', balance_micros: 1000000 },
      group: { name: crypto.randomUUID() }, account: { name: model, base_url: 'https://upstream.e2e.invalid/v1', api_key: 'fixture-only' }, api_key: { name: 'Composer' },
      models: [{ public_name: model, upstream_name: mode === 'slow' ? 'composer-slow-fixture' : 'composer-bridge-fixture', endpoint: 'chat_completions',
        input_micros_per_million: 1000000, output_micros_per_million: 2000000, per_request_micros: 7, minimum_reservation_micros: 100 }] }),
  }))
  expect(bootstrap.status).toBe(201)
  const f = (await bootstrap.json() as any).data
  const response = await exports.default.fetch(new Request('https://worker.e2e.invalid/v1/responses', {
    method: 'POST', headers: { authorization: 'Bearer ' + f.api_key, 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: 'Reply OK', max_output_tokens: 1024, stream: mode !== 'buffered' }),
  }))
  expect(response.status).toBe(200)
  const content = await response.text()
  expect(content).toContain('Composer')
  expect(content).not.toContain('lease_expired')
  expect(content).not.toContain('renewal_out_of_order')
  if (mode !== 'buffered') expect(content).toContain('response.completed')
  await expect.poll(async () => (await env.DB.prepare('SELECT quota_used_micros FROM api_keys WHERE id=?').bind(f.api_key_id).first<any>())?.quota_used_micros).toBe(27)
  const modelRow = await env.DB.prepare('SELECT id FROM models WHERE public_name=?').bind(model).first<any>()
  const pool = env.POOL_STATE.get(env.POOL_STATE.idFromName(`group:${f.group_id}:platform:openai:model:${modelRow.id}:endpoint:responses:shard:0`))
  const leases = await runInDurableObject(pool, (_instance, state) => Array.from(state.storage.sql.exec<{status:string;renewal_sequence:number}>('SELECT status,renewal_sequence FROM pool_leases')))
  expect(leases).toHaveLength(1)
  expect(leases[0].status).toBe('released')
  if (mode === 'slow') expect(leases[0].renewal_sequence).toBeGreaterThanOrEqual(4)
}, 120_000)
