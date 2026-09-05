import { env, exports } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'

async function request(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  method = 'POST',
): Promise<Response> {
  return exports.default.fetch(new Request(`https://worker.e2e.invalid${path}`, {
    method,
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
      user_id: string; group_id: string; account_id: string; api_key_id: string; api_key: string; admin_session: string
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

    await env.DB.prepare(
      `INSERT OR IGNORE INTO admin_user_roles (
         user_id, role_id, active, control_version, assigned_by_user_id, assigned_at_ms
       ) VALUES (?, 'admin', 1, 1, NULL, ?)`,
    ).bind(setup.user_id, Date.now()).run()
    const adminHeaders = {
      authorization: `Bearer ${setup.admin_session}`,
      'idempotency-key': 'sync-images-codex-binding-e2e',
    }
    const groupResponse = await request('/api/v1/admin/groups', {
      name: 'Codex Images Binding Group', platform: 'codex', allow_image_generation: true,
      image_rate_independent: true, image_rate_multiplier_ppm: 1_000_000,
      image_price_1k_micros: 100_000, image_price_2k_micros: 200_000, image_price_4k_micros: 400_000,
    }, adminHeaders)
    expect(groupResponse.status, await groupResponse.clone().text()).toBe(201)
    const codexGroup = await groupResponse.json() as { data: { id: string } }
    const modelResponse = await request('/api/v1/admin/models', {
      public_name: 'gpt-image-codex-binding', upstream_name: 'gpt-image-codex-upstream',
      platform: 'codex', endpoint: 'responses', image_generation: true,
    }, { ...adminHeaders, 'idempotency-key': 'sync-images-codex-model-binding-e2e' })
    expect(modelResponse.status, await modelResponse.clone().text()).toBe(201)
    const codexModel = await modelResponse.json() as { data: { id: string } }
    const linkResponse = await request(
      `/api/v1/admin/groups/${codexGroup.data.id}/models/${codexModel.data.id}`,
      { expected_control_version: 0 },
      { ...adminHeaders, 'idempotency-key': 'sync-images-codex-link-binding-e2e' },
      'PUT',
    )
    expect(linkResponse.status, await linkResponse.clone().text()).toBe(201)
    const priceResponse = await request(
      `/api/v1/admin/groups/${codexGroup.data.id}/models/${codexModel.data.id}/prices`,
      {
        expected_control_version: 0, input_micros_per_million: 0, output_micros_per_million: 0,
        per_request_micros: 0, minimum_reservation_micros: 1,
      },
      { ...adminHeaders, 'idempotency-key': 'sync-images-codex-price-binding-e2e' },
    )
    expect(priceResponse.status, await priceResponse.clone().text()).toBe(201)
    const accountResponse = await request('/api/v1/admin/accounts', {
      name: 'Codex Images Binding Account', platform: 'codex', protocol: 'codex',
      base_url: 'https://upstream.e2e.invalid', auth_scheme: 'bearer',
      provider_config: { account_id: 'workspace-binding' }, api_key: 'codex-binding-secret',
      enabled: true, max_concurrency: 2,
      group_links: [{ group_id: codexGroup.data.id, priority: 0, weight: 1 }],
      model_capabilities: [{
        model_id: codexModel.data.id, chat_completions: false, responses: true, image_generation: true,
      }],
    }, { ...adminHeaders, 'idempotency-key': 'sync-images-codex-account-binding-e2e' })
    expect(accountResponse.status, await accountResponse.clone().text()).toBe(201)
    await env.DB.prepare('UPDATE api_keys SET group_id = ?, updated_at_ms = ? WHERE id = ?')
      .bind(codexGroup.data.id, Date.now(), setup.api_key_id).run()

    const oauthGenerated = await request('/v1/images/generations', {
      model: 'gpt-image-codex-binding', prompt: 'binding oauth image', response_format: 'url',
    }, { authorization: `Bearer ${setup.api_key}` })
    expect(oauthGenerated.status, await oauthGenerated.clone().text()).toBe(200)
    await expect(oauthGenerated.json()).resolves.toMatchObject({
      created: 1_710_000_010,
      model: 'gpt-image-codex-binding',
      data: [{ url: expect.stringMatching(/^data:image\/png;base64,iVBOR/) }],
    })
  })
})
