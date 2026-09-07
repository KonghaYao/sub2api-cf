import { env, exports } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { resolveGatewayRoute } from '../../src/gateway/repository'

it('returns model_not_found for an unconfigured model using real D1', async () => {
  await expect(resolveGatewayRoute(
    env, 'missing-group', 'nonexistent-diagnostic-model', 'chat_completions', 'missing-user', 'responses',
  )).rejects.toMatchObject({ code: 'model_not_found' })
})

it('resolves configured channel pricing in real D1 without expanding the billing expression', async () => {
  const response = await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/bootstrap', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      user: { email: 'pricing-d1@example.test', display_name: 'Pricing test', balance_micros: 1000000 },
      group: { name: 'Pricing D1' },
      account: { name: 'Pricing upstream', base_url: 'https://upstream.e2e.invalid/v1', api_key: 'test-secret', max_concurrency: 1 },
      api_key: { name: 'Pricing key' },
      models: [{ public_name: 'gpt-5.6-high', upstream_name: 'gpt-binding-upstream', endpoint: 'chat_completions', input_micros_per_million: 1000000, output_micros_per_million: 2000000, minimum_reservation_micros: 100 }],
    }),
  }))
  expect(response.status).toBe(201)
  const { data } = await response.json() as { data: { group_id: string; user_id: string } }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels(id,name,created_at_ms,updated_at_ms) VALUES('d1-channel','D1 channel',1,1)"),
    env.DB.prepare("INSERT INTO channel_groups(channel_id,group_id,created_at_ms) VALUES('d1-channel',?,1)").bind(data.group_id),
    env.DB.prepare("INSERT INTO channel_model_pricing(id,channel_id,platform,input_micros_per_million,output_micros_per_million,created_at_ms,updated_at_ms) VALUES('d1-price','d1-channel','openai',3000000,4000000,1,1)"),
    env.DB.prepare("INSERT INTO channel_pricing_models(pricing_id,model_pattern,created_at_ms) VALUES('d1-price','gpt-5.6-sol',1)"),
  ])
  const route = await resolveGatewayRoute(env, data.group_id, 'gpt-5.6-high', 'chat_completions', data.user_id, 'responses')
  expect(route.customer_pricing).toMatchObject({ input_micros_per_million: 3000000, output_micros_per_million: 4000000 })
  expect(route.candidates).toHaveLength(1)
})
