import { env, exports } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'

async function request(path: string, body: Record<string, unknown>, headers: Record<string, string>): Promise<Response> {
  return exports.default.fetch(new Request(`https://worker.e2e.invalid${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }))
}

describe('Synchronous Images Cloudflare binding E2E', () => {
  it('routes, reserves, settles actual output size, and projects image usage', async () => {
    const bootstrap = await request('/api/v1/admin/bootstrap', {
      user: { email: 'sync-images@binding-e2e.test', display_name: 'Sync Images', balance_micros: 1_000_000 },
      group: { name: 'Sync Images Group' },
      account: {
        name: 'Sync Images Upstream', base_url: 'https://upstream.e2e.invalid',
        api_key: 'sync-images-upstream-secret', max_concurrency: 2,
      },
      api_key: { name: 'Sync Images Key' },
      models: [{
        public_name: 'gpt-image-binding', upstream_name: 'gpt-image-binding-upstream',
        endpoint: 'responses', input_micros_per_million: 0, output_micros_per_million: 0,
        per_request_micros: 0, minimum_reservation_micros: 1,
      }],
    }, { authorization: `Bearer ${env.ADMIN_TOKEN}` })
    expect(bootstrap.status, await bootstrap.clone().text()).toBe(201)
    const result = await bootstrap.json() as { data: {
      user_id: string; group_id: string; account_id: string; api_key_id: string; api_key: string
    } }
    const setup = result.data
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(`UPDATE "groups" SET allow_image_generation = 1,
        image_rate_independent = 1, image_rate_multiplier_ppm = 1000000,
        image_price_1k_micros = 100000, image_price_2k_micros = 200000,
        image_price_4k_micros = 400000, updated_at_ms = ? WHERE id = ?`).bind(now, setup.group_id),
      env.DB.prepare(`UPDATE models SET image_generation = 1, updated_at_ms = ?
        WHERE public_name = 'gpt-image-binding'`).bind(now),
      env.DB.prepare(`UPDATE account_models SET image_generation = 1, updated_at_ms = ?
        WHERE account_id = ?`).bind(now, setup.account_id),
    ])

    const generated = await request('/v1/images/generations', {
      model: 'gpt-image-binding', prompt: 'binding image', size: '1024x1024',
    }, { authorization: `Bearer ${setup.api_key}` })
    expect(generated.status, await generated.clone().text()).toBe(200)
    await expect(generated.json()).resolves.toMatchObject({
      created: 1_700_000_000,
      data: [{ b64_json: expect.stringMatching(/^iVBOR/) }],
    })

    await vi.waitFor(async () => {
      expect(await env.DB.prepare(`SELECT amount_micros, billing_mode, request_type,
        inbound_endpoint, upstream_endpoint FROM usage_projection
        WHERE api_key_id = ? AND requested_model = 'gpt-image-binding'`)
        .bind(setup.api_key_id).first()).toEqual({
        amount_micros: 100_000,
        billing_mode: 'image',
        request_type: 1,
        inbound_endpoint: '/v1/images/generations',
        upstream_endpoint: '/v1/images/generations',
      })
    }, { timeout: 10_000, interval: 25 })
  })
})
