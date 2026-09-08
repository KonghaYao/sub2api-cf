import { env, exports } from 'cloudflare:workers'
import { expect, it } from 'vitest'

it('does not send a bound account directly when its proxy transport is unavailable', async () => {
  const boot = await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/bootstrap', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      user: { email: 'proxy-gateway@example.test', display_name: 'Proxy gateway', balance_micros: 1000000 },
      group: { name: 'Proxy gateway' },
      account: { name: 'Bound account', base_url: 'https://upstream.e2e.invalid/v1', api_key: 'test-secret', max_concurrency: 1 },
      api_key: { name: 'Proxy key' },
      models: [{ public_name: 'gpt-binding', upstream_name: 'gpt-binding-upstream', endpoint: 'chat_completions', input_micros_per_million: 1000000, output_micros_per_million: 2000000, minimum_reservation_micros: 100 }],
    }),
  }))
  expect(boot.status).toBe(201)
  const { data } = await boot.json() as { data: { account_id: string; api_key: string; admin_session: string } }
  const request = () => exports.default.fetch(new Request('https://worker.e2e.invalid/v1/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${data.api_key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-binding', messages: [{ role: 'user', content: 'binding' }] }),
  }))
  const direct = await request()
  expect(direct.status).toBe(200)
  await direct.text()
  // The ordinary outbound fixture succeeds. A proxy-bound request must instead
  // enter proxy transport and fail closed while nested TLS is unavailable.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO proxies(id,name,protocol,host,port,status,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES('nested-proxy','Nested TLS','https','proxy.invalid',443,'active','','',1,1)"),
    env.DB.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.proxy_id','nested-proxy'),config_version=config_version+1 WHERE id=?").bind(data.account_id),
  ])
  const bound = await request()
  expect(bound.status).toBeGreaterThanOrEqual(500)
  expect(await bound.text()).not.toContain('binding-ok')
  const sync = await exports.default.fetch(new Request(
    `https://worker.e2e.invalid/api/v1/admin/accounts/${data.account_id}/models/sync-upstream`, {
      method: 'POST', headers: { authorization: `Bearer ${data.admin_session}` },
    },
  ))
  expect(sync.status).toBe(503)
  expect(await sync.json()).toMatchObject({ error: { code: 'proxy_nested_tls_unavailable' } })
})
