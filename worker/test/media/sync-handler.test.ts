import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { apiKeyDigest, encryptCredential } from '../../src/gateway/crypto'
import { authenticateGatewayRequest } from '../../src/gateway/repository'
import { executeSyncImagesForPrincipal, handleSyncImages } from '../../src/media/sync-handler'
import type { SyncImageBilling } from '../../src/media/sync-billing'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const RAW_KEY = 'sk-sync-image-test'
const PEPPER = 'sync-image-pepper-value-at-least-32-bytes'
const MASTER_KEY = 'sync-image-master-key-value-at-least-32-bytes'

async function fixture(platform: 'openai' | 'codex' = 'openai') {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(`INSERT INTO users (
    id, email, display_name, balance_micros, concurrency, rpm_limit, created_at_ms, updated_at_ms
  ) VALUES ('user-1','image@example.test','Image User',10000000,2,60,?,?)`).run(now, now)
  raw.prepare(`INSERT INTO "groups" (
    id,name,platform,enabled,rate_multiplier_ppm,group_type,is_exclusive,
    allow_image_generation,image_rate_independent,image_rate_multiplier_ppm,
    image_price_1k_micros,image_price_2k_micros,image_price_4k_micros,created_at_ms,updated_at_ms
  ) VALUES ('group-1','Images','${platform}',1,1000000,'standard',0,1,1,1000000,
    100000,200000,400000,?,?)`).run(now, now)
  raw.prepare(`INSERT INTO api_keys (
    id,user_id,key_hash,name,enabled,group_id,key_prefix,created_at_ms,updated_at_ms
  ) VALUES ('key-1','user-1',?,'Images key',1,'group-1','sk-sync',?,?)`)
    .run(await apiKeyDigest(RAW_KEY, PEPPER), now, now)
  const encrypted = await encryptCredential({ api_key: 'upstream-secret' }, MASTER_KEY, 'test/account-1/secret-1/1')
  raw.exec(`INSERT INTO models (
    id,platform,public_name,upstream_name,endpoint,image_generation,enabled,created_at_ms,updated_at_ms
  ) VALUES ('model-1','${platform}','gpt-image-2','gpt-image-upstream','responses',1,1,1,1);
  INSERT INTO group_models (group_id,model_id,enabled,catalog_visible,created_at_ms,updated_at_ms)
    VALUES ('group-1','model-1',1,1,1,1);
  INSERT INTO model_prices (
    id,group_id,model_id,version,active,input_micros_per_million,output_micros_per_million,
    cache_read_micros_per_million,per_request_micros,minimum_reservation_micros,effective_at_ms,created_at_ms
  ) VALUES ('price-1','group-1','model-1',1,1,0,0,0,0,1,1,1);
  INSERT INTO accounts (
    id,platform,name,credential_ref,enabled,max_concurrency,created_at_ms,updated_at_ms,
    protocol,base_url,auth_scheme,health_status,image_adapter,credential_kind
  ) VALUES ('account-1','${platform}','Image upstream','secret-1',1,2,1,1,'${platform}',
    '${platform === 'codex' ? 'https://chatgpt.example.test' : 'https://api.openai.com'}','bearer','healthy',
    '${platform === 'codex' ? 'responses_image_tool' : 'direct_images'}',
    '${platform === 'codex' ? 'oauth' : 'api_key'}');
  UPDATE accounts SET provider_config_json = '${platform === 'codex' ? '{"account_id":"workspace-123"}' : '{}'}'
    WHERE id = 'account-1';
  INSERT INTO account_secrets (
    id,account_id,key_version,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms
  ) VALUES ('secret-1','account-1',1,'${encrypted.nonce_b64}','${encrypted.ciphertext_b64}',1,1);
  INSERT INTO account_groups (account_id,group_id,priority,weight,created_at_ms,updated_at_ms)
    VALUES ('account-1','group-1',1,1,1,1);
  INSERT INTO account_models (
    account_id,model_id,chat_completions,responses,embeddings,image_generation,created_at_ms,updated_at_ms
  ) VALUES ('account-1','model-1',0,0,0,1,1,1);`)

  const stateCalls: string[] = []
  const failureRequests: Array<Record<string, unknown>> = []
  const namespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname
      stateCalls.push(path)
      if (path === '/admit') {
        const body = await request.json() as { request_id: string }
        return Response.json({ admitted: true, lease: { request_id: body.request_id, status: 'active' } })
      }
      if (path === '/reserve') return Response.json({ lease: { account_id: 'account-1', status: 'active' } })
      if (path === '/failure') failureRequests.push(await request.json() as Record<string, unknown>)
      return Response.json({ ok: true })
    } }),
  } as unknown as DurableObjectNamespace
  const reserve = vi.fn(async () => undefined)
  const settle = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  const billing: SyncImageBilling = { reserve, settle, cancel }
  const upstreamBodies: Array<{ url: string; body: Record<string, unknown> }> = []
  const upstreamFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer upstream-secret')
    const body = init?.body instanceof FormData
      ? Object.fromEntries(Array.from(init.body.entries(), ([key, value]) => [
          key,
          typeof value === 'string' ? value : { name: value.name, type: value.type, size: value.size },
        ]))
      : JSON.parse(String(init?.body)) as Record<string, unknown>
    upstreamBodies.push({ url: String(input), body })
    // The accounting parser needs only the PNG signature and IHDR dimensions.
    const png = new Uint8Array(24)
    png.set([137,80,78,71,13,10,26,10], 0)
    png.set([0,0,4,0,0,0,4,0], 16)
    let binary = ''
    for (const byte of png) binary += String.fromCharCode(byte)
    return Response.json({ created: 1, data: [{ b64_json: btoa(binary) }] })
  })
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: MASTER_KEY, DB: d1, USER_STATE: namespace,
    API_KEY_LIMIT_STATE: namespace, POOL_STATE: namespace,
    CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: { send: vi.fn() } as unknown as Queue,
    ASSETS: {} as Fetcher, SYNC_IMAGE_BILLING: billing, SYNC_IMAGE_UPSTREAM_FETCH: upstreamFetch,
  }
  return { raw, env, stateCalls, failureRequests, reserve, settle, cancel, upstreamFetch, upstreamBodies }
}

function app() {
  const api = new Hono()
  api.post('/v1/images/generations', (context) => handleSyncImages(context as never, 'generations'))
  api.post('/images/generations', (context) => handleSyncImages(context as never, 'generations'))
  api.post('/v1/images/edits', (context) => handleSyncImages(context as never, 'edits'))
  api.post('/images/edits', (context) => handleSyncImages(context as never, 'edits'))
  return api
}

function configureCompositeOpenAiQuota(test: Awaited<ReturnType<typeof fixture>>): void {
  const now = Date.now()
  test.raw.prepare("UPDATE \"groups\" SET platform = 'composite' WHERE id = 'group-1'").run()
  test.raw.prepare(`INSERT INTO user_platform_quotas (
    user_id, platform, enabled, daily_limit_micros, weekly_limit_micros, monthly_limit_micros,
    control_version, created_at_ms, updated_at_ms
  ) VALUES ('user-1', 'openai', 1, 10000000, 20000000, 30000000, 7, ?, ?)`)
    .run(now, now)
}

describe('synchronous image handler', () => {
  it.each(['/v1/images/generations', '/images/generations'])('serves %s through the image account pool', async (path) => {
    const test = await fixture()
    const response = await app().request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'draw a square', size: '1024x1024' }),
    }, test.env as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ created: 1, data: [{ b64_json: expect.any(String) }] })
    expect(test.reserve).toHaveBeenCalledWith(expect.objectContaining({ amountMicros: 400_000 }))
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ amountMicros: 100_000, operation: 'generations' }),
    }))
    expect(test.cancel).not.toHaveBeenCalled()
    expect(test.upstreamBodies).toEqual([expect.objectContaining({
      url: 'https://api.openai.com/v1/images/generations',
      body: expect.objectContaining({
        model: 'gpt-image-upstream', prompt: 'draw a square', n: 1, size: '1024x1024', moderation: 'auto',
      }),
    })])
    expect(test.stateCalls).toContain('/accounts/sync')
    expect(test.stateCalls).toContain('/release')
  })

  it('uses an aliased wildcard channel image tier for reservation and immutable settlement', async () => {
    const test = await fixture()
    test.raw.exec(`
      INSERT INTO channels (
        id, name, status, billing_model_source, restrict_models,
        features_config_json, apply_pricing_to_account_stats,
        control_version, created_at_ms, updated_at_ms
      ) VALUES (
        'channel-1', 'Image channel', 'active', 'channel_mapped', 0,
        '{}', 0, 1, 1, 1
      );
      INSERT INTO channel_groups (channel_id, group_id, created_at_ms)
      VALUES ('channel-1', 'group-1', 1);
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-1', 'openai', 'customer-image', 'gpt-image-2', 0, 0, 0, 1);
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, per_request_micros,
        control_version, created_at_ms, updated_at_ms
      ) VALUES ('channel-image-price', 'channel-1', 'openai', 'image', 275000, 3, 1, 1);
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-image-price', 'gpt-image-*', 1, 0, 1);
      INSERT INTO channel_pricing_intervals (
        id, pricing_id, min_tokens, max_tokens, tier_label, per_request_micros,
        sort_order, created_at_ms, updated_at_ms
      ) VALUES
        ('channel-image-1k', 'channel-image-price', 0, NULL, '1K', 125000, 0, 1, 1),
        ('channel-image-4k', 'channel-image-price', 0, NULL, '4K', 650000, 1, 1, 1);
    `)

    const response = await app().request('/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'customer-image', prompt: 'price this exactly', n: 2 }),
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    expect(test.reserve).toHaveBeenCalledWith(expect.objectContaining({ amountMicros: 1_300_000 }))
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({
        requestedModel: 'customer-image',
        upstreamModel: 'gpt-image-upstream',
        initialReservedMicros: 1_300_000,
        amountMicros: 125_000,
        standardCostMicros: 100_000,
        customerPricingBasisMicros: 125_000,
        customerPricingSnapshotJson: expect.any(String),
      }),
    }))
    const settled = (test.settle.mock.calls as unknown[][])[0]?.[0] as
      | { usage?: { customerPricingSnapshotJson?: string } }
      | undefined
    const usage = settled?.usage
    expect(JSON.parse(String(usage?.customerPricingSnapshotJson))).toMatchObject({
      version: 1,
      source: 'channel',
      channel_id: 'channel-1',
      channel_control_version: 1,
      pricing_id: 'channel-image-price',
      matched_model_pattern: 'gpt-image-*',
      billing_model: 'image',
      tier_prices_micros: { '1K': 125_000, '2K': 275_000, '4K': 650_000 },
      output_tier_counts: { '1K': 1, '2K': 0, '4K': 0 },
    })
    expect(test.upstreamFetch).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'a missing possible output tier',
      pricing: `
        INSERT INTO channel_model_pricing (
          id, channel_id, platform, billing_mode, per_request_micros,
          control_version, created_at_ms, updated_at_ms
        ) VALUES ('channel-image-price', 'channel-1', 'openai', 'image', NULL, 1, 1, 1);
        INSERT INTO channel_pricing_models (pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms)
        VALUES ('channel-image-price', 'gpt-image-2', 0, 0, 1);
        INSERT INTO channel_pricing_intervals (
          id, pricing_id, min_tokens, max_tokens, tier_label, per_request_micros,
          sort_order, created_at_ms, updated_at_ms
        ) VALUES ('only-1k', 'channel-image-price', 0, NULL, '1K', 100000, 0, 1, 1);`,
      code: 'invalid_pricing_state',
      status: 500,
    },
    {
      name: 'duplicate case-insensitive tier labels',
      pricing: `
        INSERT INTO channel_model_pricing (
          id, channel_id, platform, billing_mode, per_request_micros,
          control_version, created_at_ms, updated_at_ms
        ) VALUES ('channel-image-price', 'channel-1', 'openai', 'image', 100000, 1, 1, 1);
        INSERT INTO channel_pricing_models (pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms)
        VALUES ('channel-image-price', 'gpt-image-2', 0, 0, 1);
        INSERT INTO channel_pricing_intervals (
          id, pricing_id, min_tokens, max_tokens, tier_label, per_request_micros,
          sort_order, created_at_ms, updated_at_ms
        ) VALUES
          ('tier-a', 'channel-image-price', 0, NULL, '4K', 400000, 0, 1, 1),
          ('tier-b', 'channel-image-price', 0, NULL, '4k', 500000, 1, 1, 1);`,
      code: 'invalid_pricing_state',
      status: 500,
    },
    {
      name: 'ambiguous route price matches',
      pricing: `
        INSERT INTO channel_model_pricing (
          id, channel_id, platform, billing_mode, per_request_micros,
          control_version, created_at_ms, updated_at_ms
        ) VALUES
          ('channel-image-a', 'channel-1', 'openai', 'image', 100000, 1, 1, 1),
          ('channel-image-b', 'channel-1', 'openai', 'image', 200000, 1, 1, 1);
        INSERT INTO channel_pricing_models (pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms)
        VALUES
          ('channel-image-a', 'gpt-image-*', 1, 0, 1),
          ('channel-image-b', 'gpt-image-*', 1, 1, 1);`,
      code: 'ambiguous_channel_pricing',
      status: 409,
    },
  ])('fails closed before reservation for $name', async ({ pricing, code, status }) => {
    const test = await fixture()
    test.raw.exec(`
      INSERT INTO channels (
        id, name, status, billing_model_source, restrict_models,
        features_config_json, apply_pricing_to_account_stats,
        control_version, created_at_ms, updated_at_ms
      ) VALUES ('channel-1', 'Image channel', 'active', 'channel_mapped', 0, '{}', 0, 1, 1, 1);
      INSERT INTO channel_groups (channel_id, group_id, created_at_ms)
      VALUES ('channel-1', 'group-1', 1);
      ${pricing}
    `)

    const response = await app().request('/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'must fail before paid work' }),
    }, test.env as never)

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toMatchObject({ error: { code } })
    expect(test.reserve).not.toHaveBeenCalled()
    expect(test.upstreamFetch).not.toHaveBeenCalled()
    expect(test.stateCalls).not.toContain('/admit')
  })

  it('passes the resolved provider quota into a composite synchronous Images reservation', async () => {
    const test = await fixture()
    configureCompositeOpenAiQuota(test)

    const response = await app().request('/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'composite sync image' }),
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    expect(test.reserve).toHaveBeenCalledWith(expect.objectContaining({
      principal: expect.objectContaining({
        platform: 'composite',
        platform_quota: expect.objectContaining({
          platform: 'openai', control_version: 7, daily_limit_micros: 10_000_000,
        }),
      }),
    }))
  })

  it('passes the resolved provider quota into a composite durable-task Images reservation', async () => {
    const test = await fixture()
    configureCompositeOpenAiQuota(test)
    const authRequest = new Request('https://worker.test/v1/images/generations', {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    })
    const principal = await authenticateGatewayRequest(authRequest, test.env as never)
    expect(principal).toMatchObject({ platform: 'composite', platform_quota: null })

    const response = await executeSyncImagesForPrincipal({
      env: test.env as never,
      request: new Request('https://worker.test/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'composite async image' }),
      }),
      operation: 'generations',
      principal,
      moderationChecked: true,
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(test.reserve).toHaveBeenCalledWith(expect.objectContaining({
      principal: expect.objectContaining({
        platform: 'composite',
        platform_quota: expect.objectContaining({
          platform: 'openai', control_version: 7, daily_limit_micros: 10_000_000,
        }),
      }),
    }))
  })

  it('returns and bills every distinct provider output when the provider exceeds requested n', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(Response.json({
      created: 1,
      data: [
        { b64_json: 'Zmlyc3Q=', size: '3840x2160' },
        { b64_json: 'c2Vjb25k', size: '3840x2160' },
      ],
    }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'surprise me', n: 1, size: '1024x1024' }),
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({
      data: [
        { b64_json: 'Zmlyc3Q=', size: '3840x2160' },
        { b64_json: 'c2Vjb25k', size: '3840x2160' },
      ],
    })
    expect(test.reserve).toHaveBeenCalledWith(expect.objectContaining({ amountMicros: 400_000 }))
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({
        initialReservedMicros: 400_000,
        amountMicros: 800_000,
        imageCount: 2,
        imageSizeBreakdown: { '4K': 2 },
      }),
    }))
    expect(test.cancel).not.toHaveBeenCalled()
  })

  it('ignores an incompatible execution tuple without poisoning a valid route', async () => {
    const test = await fixture()
    const encrypted = await encryptCredential(
      { api_key: 'unused-responses-secret' }, MASTER_KEY, 'test/account-bad/secret-bad/1',
    )
    test.raw.prepare(`INSERT INTO accounts (
      id,platform,name,credential_ref,enabled,max_concurrency,created_at_ms,updated_at_ms,
      protocol,base_url,auth_scheme,health_status,image_adapter,credential_kind
    ) VALUES ('account-bad','openai','Ignored','secret-bad',1,2,1,1,'openai',
      'https://api.openai.test','bearer','healthy','responses_image_tool','oauth')`).run()
    test.raw.prepare(`INSERT INTO account_secrets (
      id,account_id,key_version,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms
    ) VALUES ('secret-bad','account-bad',1,?,?,1,1)`).run(encrypted.nonce_b64, encrypted.ciphertext_b64)
    test.raw.exec(`INSERT INTO account_groups (account_id,group_id,priority,weight,created_at_ms,updated_at_ms)
      VALUES ('account-bad','group-1',2,1,1,1);
    INSERT INTO account_models (
      account_id,model_id,chat_completions,responses,embeddings,image_generation,created_at_ms,updated_at_ms
    ) VALUES ('account-bad','model-1',0,0,0,1,1,1);`)

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    expect(test.upstreamFetch).toHaveBeenCalledOnce()
  })

  it('uses declared output size when image bytes have no detectable dimensions', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(Response.json({
      created: 1,
      data: [{ b64_json: 'aGVsbG8=', size: '3840x2160' }],
    }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'large cat', size: '1024x1024' }),
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({
        amountMicros: 400_000,
        imageInputSize: '1024x1024',
        imageOutputSize: '3840x2160',
        imageSizeSource: 'output',
        imageSizeBreakdown: { '4K': 1 },
      }),
    }))
  })

  it.each(['/v1/images/edits', '/images/edits'])('forwards safe JSON edits through %s', async (path) => {
    const test = await fixture()
    const response = await app().request(path, {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'add a hat',
        images: [{ image_url: 'https://images.example.test/cat.png' }],
      }),
    }, test.env as never)
    expect(response.status).toBe(200)
    expect(test.upstreamBodies).toEqual([expect.objectContaining({
      url: 'https://api.openai.com/v1/images/edits',
      body: expect.objectContaining({
        model: 'gpt-image-upstream', prompt: 'add a hat',
        images: [{ image_url: 'https://images.example.test/cat.png' }],
      }),
    })])
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ operation: 'edits' }),
    }))
  })

  it('forwards bounded multipart edits with image bytes and no synthetic content-type', async () => {
    const test = await fixture()
    const form = new FormData()
    form.set('prompt', 'add a hat')
    form.set('size', '1024x1024')
    form.set('image', new Blob([new Uint8Array([
      137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,
    ])], { type: 'image/png' }), 'cat.png')
    const response = await app().request('/v1/images/edits', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}` }, body: form,
    }, test.env as never)
    expect(response.status).toBe(200)
    expect(test.upstreamBodies).toEqual([expect.objectContaining({
      url: 'https://api.openai.com/v1/images/edits',
      body: expect.objectContaining({
        model: 'gpt-image-upstream', prompt: 'add a hat', size: '1024x1024',
        'image[]': { name: 'cat.png', type: 'image/png', size: 24 },
      }),
    })])
  })

  it('cancels the hold when the provider rejects a request before output', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(Response.json({
      error: { code: 'content_policy_violation', message: 'Request denied', type: 'invalid_request_error' },
    }, { status: 400 }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'blocked' }),
    }, test.env as never)
    expect(response.status).toBe(400)
    expect(test.cancel).toHaveBeenCalledOnce()
    expect(test.settle).not.toHaveBeenCalled()
  })

  it('preserves a successful provider status and safe response headers', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      created: 1, data: [{ b64_json: 'aGVsbG8=' }], provider_extension: { retained: true },
    }), { status: 201, headers: { 'content-type': 'application/problem+json; charset=utf-8', 'cache-control': 'no-store' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    }, test.env as never)
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toBe('application/problem+json; charset=utf-8')
    expect(response.headers.get('x-request-id')).toEqual(expect.any(String))
    expect(await response.json()).toMatchObject({ provider_extension: { retained: true } })
  })

  it('does not repeat an upstream image when durable settlement fails', async () => {
    const test = await fixture()
    test.settle.mockRejectedValueOnce(new Error('settlement unavailable'))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    }, test.env as never)
    expect(response.status).toBe(200)
    expect(test.upstreamFetch).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(test.settle).toHaveBeenCalledTimes(2))
    expect(test.cancel).not.toHaveBeenCalled()
  })

  it('reports an exhausted background settlement obligation without retrying paid work', async () => {
    const test = await fixture()
    const error = new Error('settlement unavailable')
    test.settle.mockRejectedValue(error)
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    }, test.env as never)
    expect(response.status).toBe(200)
    await vi.waitFor(() => expect(test.settle).toHaveBeenCalledTimes(4))
    expect(test.upstreamFetch).toHaveBeenCalledOnce()
    expect(test.cancel).not.toHaveBeenCalled()
    expect(reported).toHaveBeenCalledWith('image settlement retries exhausted', expect.objectContaining({
      name: 'Error',
    }))
  })

  it('runs configured moderation before admission, billing, and upstream work', async () => {
    const test = await fixture()
    const check = vi.fn(async () => ({ allowed: false, message: 'blocked locally' }))
    ;(test.env as typeof test.env & { SYNC_IMAGE_MODERATOR?: { check: typeof check } }).SYNC_IMAGE_MODERATOR = { check }
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'blocked' }),
    }, test.env as never)
    expect(response.status).toBe(400)
    expect(check).toHaveBeenCalledOnce()
    expect(test.reserve).not.toHaveBeenCalled()
    expect(test.upstreamFetch).not.toHaveBeenCalled()
    expect(test.stateCalls).not.toContain('/admit')
  })

  it('delegates to strict provider moderation when no preflight moderator is bound', async () => {
    const test = await fixture()
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', moderation: 'low' }),
    }, test.env as never)
    expect(response.status).toBe(200)
    expect(test.upstreamBodies[0]?.body).toMatchObject({ moderation: 'auto' })
  })

  it('pins the started provider, settlement, and cleanup lifecycle with waitUntil', async () => {
    const test = await fixture()
    const tasks: Promise<unknown>[] = []
    const request = new Request('https://worker.test/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    })
    const response = await app().fetch(request, test.env as never, {
      waitUntil(task: Promise<unknown>) { tasks.push(task) },
      passThroughOnException() {},
      props: {},
    } as never)
    expect(response.status).toBe(200)
    expect(tasks.length).toBeGreaterThan(0)
    await Promise.all(tasks)
    expect(test.settle).toHaveBeenCalledOnce()
    expect(test.stateCalls).toContain('/release')
  })

  it('renews API-key and account leases while provider work is running', async () => {
    const test = await fixture()
    const now = Date.now()
    test.raw.prepare(`INSERT INTO user_platform_quotas (
      user_id, platform, enabled, daily_limit_micros, weekly_limit_micros, monthly_limit_micros,
      control_version, created_at_ms, updated_at_ms
    ) VALUES ('user-1', 'openai', 1, 10000000, 10000000, 10000000, 1, ?, ?)`)
      .run(now, now)
    ;(test.env as typeof test.env & { SYNC_IMAGE_RENEW_AFTER_MS?: number }).SYNC_IMAGE_RENEW_AFTER_MS = 1
    const originalFetch = test.upstreamFetch.getMockImplementation()
    test.upstreamFetch.mockImplementationOnce(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (originalFetch === undefined) throw new Error('missing upstream fixture')
      return originalFetch(...args)
    })
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    }, test.env as never)
    expect(response.status).toBe(200)
    expect(test.stateCalls.filter((path) => path === '/renew').length).toBeGreaterThanOrEqual(2)
    expect(test.stateCalls).toContain('/platform-quota/renew')
  })

  it('executes a Codex OAuth account through Responses and returns buffered Images JSON', async () => {
    const test = await fixture('codex')
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    test.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.output_item.done',
      `data: {"type":"response.output_item.done","item":{"id":"ig_worker","type":"image_generation_call","status":"completed","result":"${png}","output_format":"png"}}`,
      '',
      'event: response.completed',
      `data: {"type":"response.completed","response":{"created_at":1710000000,"status":"completed","output":[{"id":"ig_worker","type":"image_generation_call","status":"completed","result":"${png}","output_format":"png"}],"tool_usage":{"image_gen":{"input_tokens":12,"output_tokens":99,"output_tokens_details":{"image_tokens":99},"images":1}}}}`,
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${RAW_KEY}`,
        'content-type': 'application/json',
        'accept-language': 'zh-CN',
      },
      body: JSON.stringify({ prompt: '画一个杯子', response_format: 'url' }),
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      created: 1_710_000_000,
      model: 'gpt-image-2',
      data: [{ url: `data:image/png;base64,${png}` }],
    })
    const call = test.upstreamFetch.mock.calls[0]
    expect(call?.[0]).toBe('https://chatgpt.example.test/backend-api/codex/responses')
    const headers = new Headers(call?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer upstream-secret')
    expect(headers.get('chatgpt-account-id')).toBe('workspace-123')
    expect(headers.get('accept-language')).toBe('zh-CN')
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      model: 'gpt-5.4-mini',
      stream: true,
      store: false,
      tools: [{ type: 'image_generation', action: 'generate', model: 'gpt-image-upstream' }],
    })
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ accountId: 'account-1', amountMicros: 100_000 }),
    }))
  })

  it('returns transformed Images SSE for a Codex OAuth streaming request and settles it', async () => {
    const test = await fixture('codex')
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    test.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.image_generation_call.partial_image',
      'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"cGFydGlhbA==","partial_image_index":0,"output_format":"png"}',
      '',
      'event: response.completed',
      `data: {"type":"response.completed","response":{"created_at":1710000002,"status":"completed","output":[{"id":"ig_stream","type":"image_generation_call","status":"completed","result":"${png}","output_format":"png"}]}}`,
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true, response_format: 'b64_json' }),
    }, test.env as never)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('event: image_generation.partial_image')
    expect(body).toContain('event: image_generation.completed')
    expect(body).toContain(png)
    expect(test.reserve).toHaveBeenCalledOnce()
    expect(test.settle).toHaveBeenCalledOnce()
  })

  it('returns the first Codex Images SSE frame before upstream completion', async () => {
    const test = await fixture('codex')
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | null = null
    const encoder = new TextEncoder()
    test.upstreamFetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller
        controller.enqueue(encoder.encode([
          'event: response.image_generation_call.partial_image',
          'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"cGFydGlhbA==","partial_image_index":0,"output_format":"png"}',
          '',
          '',
        ].join('\n')))
      },
    }), { headers: { 'content-type': 'text/event-stream' } }))

    const responsePromise = app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true }),
    }, test.env as never)
    await vi.waitFor(() => expect(upstreamController).not.toBeNull())
    let timer: ReturnType<typeof setTimeout> | undefined
    const earlyResponse = await Promise.race([
      responsePromise,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 25) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (earlyResponse === null) {
      upstreamController!.enqueue(encoder.encode([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"ig_late","type":"image_generation_call","result":"aW1hZ2U="}]}}',
        '',
        '',
      ].join('\n')))
      upstreamController!.close()
      await responsePromise
    }
    expect(earlyResponse).not.toBeNull()
    if (earlyResponse === null) return

    const reader = earlyResponse.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('image_generation.partial_image')
    expect(test.settle).not.toHaveBeenCalled()
    expect(test.stateCalls).not.toContain('/release')
    upstreamController!.enqueue(encoder.encode([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"ig_live","type":"image_generation_call","result":"aW1hZ2U="}]}}',
      '',
      '',
    ].join('\n')))
    upstreamController!.close()
    while (!(await reader.read()).done) { /* drain */ }
    await vi.waitFor(() => expect(test.settle).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(test.stateCalls).toContain('/release'))
  })

  it('drains and settles a Codex Images stream after the client disconnects', async () => {
    const test = await fixture('codex')
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | null = null
    const encoder = new TextEncoder()
    test.upstreamFetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller
        controller.enqueue(encoder.encode([
          'event: response.image_generation_call.partial_image',
          'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"cGFydGlhbA==","partial_image_index":0}',
          '',
          '',
        ].join('\n')))
      },
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true }),
    }, test.env as never)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('partial_image')
    await reader.cancel('client disconnected')
    upstreamController!.enqueue(encoder.encode([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"ig_detached","type":"image_generation_call","result":"aW1hZ2U="}]}}',
      '',
      '',
    ].join('\n')))
    upstreamController!.close()

    await vi.waitFor(() => expect(test.settle).toHaveBeenCalledOnce())
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ stream: true, outcome: 'cancelled', amountMicros: 200_000 }),
    }))
    await vi.waitFor(() => expect(test.stateCalls.filter((path) => path === '/release')).toHaveLength(2))
  })

  it('keeps a retryable stream failure precommit and returns JSON after retries exhaust', async () => {
    const test = await fixture('codex')
    test.upstreamFetch.mockImplementation(async () => new Response([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true }),
    }, test.env as never)

    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'IMAGE_UPSTREAM_RETRY_EXHAUSTED' },
    })
    expect(test.upstreamFetch).toHaveBeenCalledTimes(4)
  })

  it('never retries when a failure shares a chunk with the first partial image', async () => {
    const test = await fixture('codex')
    test.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.image_generation_call.partial_image',
      'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"cGFydGlhbA==","partial_image_index":0}',
      '',
      'event: response.failed',
      'data: {"type":"response.failed","response":{"status":"failed","usage":{"images":3},"error":{"type":"server_error","code":"server_error","message":"failed after partial"}}}',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true }),
    }, test.env as never)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('event: image_generation.partial_image')
    expect(body).toContain('event: error')
    expect(test.upstreamFetch).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(test.cancel).toHaveBeenCalledOnce())
  })

  it('settles declared paid output without retry when local image decoding fails', async () => {
    const test = await fixture('codex')
    test.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"id":"paid-invalid","type":"image_generation_call","result":"%%%"}}',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true }),
    }, test.env as never)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('IMAGE_INVALID_PROVIDER_OUTPUT')
    expect(test.upstreamFetch).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ amountMicros: 200_000, imageCount: 1, outcome: 'failed' }),
    })))
    expect(test.cancel).not.toHaveBeenCalled()
  })

  it('returns and bills distinct Codex outputs beyond requested n', async () => {
    const test = await fixture('codex')
    test.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","output":[' +
        '{"id":"ig_1","type":"image_generation_call","result":"Zmlyc3Q="},' +
        '{"id":"ig_2","type":"image_generation_call","result":"c2Vjb25k"}' +
        ']}}',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'two cats', n: 1 }),
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    expect((await response.json() as { data: unknown[] }).data).toHaveLength(2)
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({
        initialReservedMicros: 400_000,
        amountMicros: 400_000,
        imageCount: 2,
      }),
    }))
  })

  it('retries a completed-without-image Responses result on the same account before switching', async () => {
    const test = await fixture('codex')
    test.upstreamFetch
      .mockResolvedValueOnce(new Response([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"ig_retry","type":"image_generation_call","status":"completed","result":"aW1hZ2U=","output_format":"png"}]}}',
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'retry me' }),
    }, test.env as never)
    expect(test.upstreamFetch).toHaveBeenCalledTimes(2)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(test.settle).toHaveBeenCalledOnce()
  })

  it('honors a bounded retry-after carried by a non-2xx Responses SSE error', async () => {
    const test = await fixture('codex')
    test.upstreamFetch
      .mockResolvedValueOnce(new Response([
        'event: response.failed',
        'data: {"type":"response.failed","response":{"status":"failed","error":{"type":"rate_limit_error","code":"rate_limit_exceeded"}}}',
        '',
        '',
      ].join('\n'), { status: 429, headers: { 'content-type': 'text/event-stream', 'retry-after': '0.001' } }))
      .mockResolvedValueOnce(new Response([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"ig_rate_retry","type":"image_generation_call","status":"completed","result":"aW1hZ2U=","output_format":"png"}]}}',
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'rate retry' }),
    }, test.env as never)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(test.upstreamFetch).toHaveBeenCalledTimes(2)
    expect(test.settle).toHaveBeenCalledOnce()
  })

  it('does not cool an account for a text fallback but applies the image-pool cooldown for tool unavailable', async () => {
    const textFallback = await fixture('codex')
    textFallback.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Here is a polished prompt"}]}]}}',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    const textResponse = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'fallback' }),
    }, textFallback.env as never)
    expect(textResponse.status).toBe(502)
    expect(textFallback.failureRequests).toEqual([])

    const unavailable = await fixture('codex')
    unavailable.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.failed',
      'data: {"type":"response.failed","response":{"status":"failed","error":{"type":"upstream_error","code":"image_generation_unavailable","message":"tool absent"}}}',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
    const unavailableResponse = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'unavailable' }),
    }, unavailable.env as never)
    expect(unavailableResponse.status).toBe(502)
    expect(unavailable.failureRequests).toEqual([
      expect.objectContaining({ account_id: 'account-1', cooldown_ms: 1_800_000 }),
    ])
  })

  it('excludes a text-fallback account when switching within the same request', async () => {
    const test = await fixture('codex')
    const encrypted = await encryptCredential(
      { api_key: 'upstream-secret' },
      MASTER_KEY,
      'test/account-2/secret-2/1',
    )
    test.raw.prepare(`INSERT INTO accounts (
      id,platform,name,credential_ref,enabled,max_concurrency,created_at_ms,updated_at_ms,
      protocol,base_url,auth_scheme,health_status,image_adapter,credential_kind,provider_config_json
    ) VALUES ('account-2','codex','Second image upstream','secret-2',1,2,1,1,'codex',
      'https://chatgpt.example.test','bearer','healthy','responses_image_tool','oauth',?)`)
      .run('{"account_id":"workspace-456"}')
    test.raw.prepare(`INSERT INTO account_secrets (
      id,account_id,key_version,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms
    ) VALUES ('secret-2','account-2',1,?,?,1,1)`).run(encrypted.nonce_b64, encrypted.ciphertext_b64)
    test.raw.exec(`INSERT INTO account_groups (
      account_id,group_id,priority,weight,created_at_ms,updated_at_ms
    ) VALUES ('account-2','group-1',2,1,1,1);
    INSERT INTO account_models (
      account_id,model_id,chat_completions,responses,embeddings,image_generation,created_at_ms,updated_at_ms
    ) VALUES ('account-2','model-1',0,0,0,1,1,1);`)

    const reserveBodies: Array<{ excluded_account_ids?: string[] }> = []
    test.env.POOL_STATE = {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => ({ fetch: async (request: Request) => {
        const path = new URL(request.url).pathname
        if (path === '/reserve') {
          const body = await request.json() as { excluded_account_ids?: string[] }
          reserveBodies.push(body)
          const accountId = body.excluded_account_ids?.includes('account-1') ? 'account-2' : 'account-1'
          return Response.json({ lease: { account_id: accountId, status: 'active' } })
        }
        return Response.json({ ok: true })
      } }),
    } as unknown as DurableObjectNamespace

    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    test.upstreamFetch
      .mockResolvedValueOnce(new Response([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Try another prompt"}]}]}}',
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(new Response([
        'event: response.completed',
        `data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"ig_second","type":"image_generation_call","status":"completed","result":"${png}","output_format":"png"}]}}`,
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'fallback across accounts' }),
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    expect(reserveBodies).toHaveLength(2)
    expect(reserveBodies[1]?.excluded_account_ids).toEqual(['account-1'])
    expect(new Headers(test.upstreamFetch.mock.calls[1]?.[1]?.headers).get('chatgpt-account-id')).toBe('workspace-456')
    expect(test.settle).toHaveBeenCalledOnce()
  })

  it('applies the default cooldown to an ordinary upstream transport failure', async () => {
    const test = await fixture()
    test.upstreamFetch.mockRejectedValueOnce(new Error('connection reset'))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat' }),
    }, test.env as never)

    expect(response.status).toBe(502)
    expect(test.failureRequests).toEqual([
      expect.objectContaining({ account_id: 'account-1', cooldown_ms: 30_000 }),
    ])
  })

  it('preserves a sanitized Responses client error contract including param', async () => {
    const test = await fixture('codex')
    test.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.failed',
      'data: {"type":"response.failed","response":{"status":"failed","error":{"type":"invalid_request_error","code":"invalid_value","message":"Invalid image size","param":"size"}}}',
      '',
      '',
    ].join('\n'), { status: 400, headers: { 'content-type': 'text/event-stream' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'bad size' }),
    }, test.env as never)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'invalid_request_error', code: 'invalid_value',
        message: 'Invalid image size', param: 'size',
      },
    })
    expect(test.failureRequests).toEqual([])
  })

  it('preserves a sanitized content-policy error without retrying or cooling the account', async () => {
    const test = await fixture('codex')
    test.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: response.failed',
      'data: {"type":"response.failed","response":{"status":"failed","error":{' +
        '"type":"image_generation_user_error","code":"content_policy_violation",' +
        '"message":"Prompt violates image policy","param":"prompt"}}}',
      '',
      '',
    ].join('\n'), { status: 400, headers: { 'content-type': 'text/event-stream' } }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'blocked' }),
    }, test.env as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'image_generation_user_error', code: 'content_policy_violation',
        message: 'Prompt violates image policy', param: 'prompt',
      },
    })
    expect(test.upstreamFetch).toHaveBeenCalledOnce()
    expect(test.failureRequests).toEqual([])
  })

  it('preserves a non-SSE Responses client error including message and param', async () => {
    const test = await fixture('codex')
    test.upstreamFetch.mockResolvedValueOnce(Response.json({
      error: {
        type: 'invalid_request_error', code: 'invalid_value',
        message: 'Invalid image size', param: 'size',
      },
    }, { status: 400 }))
    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'bad size' }),
    }, test.env as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'invalid_request_error', code: 'invalid_value',
        message: 'Invalid image size', param: 'size',
      },
    })
    expect(test.failureRequests).toEqual([])
  })

  it('streams native Direct Images SSE from the direct endpoint and settles actual output', async () => {
    const test = await fixture()
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const upstreamSse = [
      ': provider-comment\r',
      '',
      'event: image_generation.partial_image',
      'data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"cGFydGlhbA=="}',
      '',
      'event: image_generation.completed',
      `data: {"type":"image_generation.completed","id":"img_direct","b64_json":"${png}","output_format":"png","size":"1024x1024"}`,
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n')
    test.upstreamFetch.mockResolvedValueOnce(new Response(upstreamSse, {
      headers: { 'content-type': 'text/event-stream' },
    }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true, size: '1024x1024' }),
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toBe(upstreamSse)
    const upstreamCall = test.upstreamFetch.mock.calls[0]
    expect(upstreamCall?.[0]).toBe('https://api.openai.com/v1/images/generations')
    expect(JSON.parse(String(upstreamCall?.[1]?.body))).toMatchObject({
      model: 'gpt-image-upstream', prompt: 'cat', stream: true,
    })
    await vi.waitFor(() => expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({
        stream: true, outcome: 'completed', amountMicros: 100_000,
        upstreamEndpoint: '/v1/images/generations',
      }),
    })))
    expect(test.cancel).not.toHaveBeenCalled()
  })

  it('streams multipart Direct image edits through the native edits endpoint', async () => {
    const test = await fixture()
    const upstreamSse = [
      'event: image_edit.completed',
      'data: {"type":"image_edit.completed","id":"edit_direct","b64_json":"aW1hZ2U=","size":"1024x1024"}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n')
    test.upstreamFetch.mockResolvedValueOnce(new Response(upstreamSse, {
      headers: { 'content-type': 'text/event-stream' },
    }))
    const form = new FormData()
    form.set('prompt', 'add a hat')
    form.set('stream', 'true')
    form.set('image', new Blob([new Uint8Array([
      137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,
    ])], { type: 'image/png' }), 'cat.png')

    const response = await app().request('/v1/images/edits', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}` }, body: form,
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.text()).toBe(upstreamSse)
    const upstreamCall = test.upstreamFetch.mock.calls[0]
    expect(upstreamCall?.[0]).toBe('https://api.openai.com/v1/images/edits')
    expect(upstreamCall?.[1]?.body).toBeInstanceOf(FormData)
    const upstreamForm = Object.fromEntries(Array.from((upstreamCall?.[1]?.body as FormData).entries(), ([key, value]) => [
      key,
      typeof value === 'string' ? value : { name: value.name, type: value.type, size: value.size },
    ]))
    expect(upstreamForm).toMatchObject({
      model: 'gpt-image-upstream', prompt: 'add a hat', stream: 'true',
      'image[]': { name: 'cat.png', type: 'image/png', size: 24 },
    })
    await vi.waitFor(() => expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ operation: 'edits', stream: true, imageCount: 1 }),
    })))
  })

  it('returns a raw JSON body mislabeled as event-stream and still settles its image', async () => {
    const test = await fixture()
    const upstreamJson = ' { "created":1710000009, "vendor_extension":{"future":true},' +
      ' "data":[{"b64_json":"ZmluYWw=","size":"1024x1024"}] }\n'
    test.upstreamFetch.mockResolvedValueOnce(new Response(upstreamJson, {
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'upstream-json-stream' },
    }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true, size: '1024x1024' }),
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.text()).toBe(upstreamJson)
    await vi.waitFor(() => expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({
        stream: true, outcome: 'completed', imageCount: 1, amountMicros: 100_000,
        upstreamEndpoint: '/v1/images/generations',
      }),
    })))
    expect(test.cancel).not.toHaveBeenCalled()
  })

  it('does not repeat an accepted Direct request when its 2xx JSON body is malformed', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(new Response('{not-json}', {
      headers: { 'content-type': 'application/json' },
    }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true }),
    }, test.env as never)

    expect(response.status).toBe(502)
    expect(test.upstreamFetch).toHaveBeenCalledOnce()
    expect(test.settle).not.toHaveBeenCalled()
    expect(test.cancel).toHaveBeenCalledOnce()
  })

  it('bills a Direct URL completion without rewriting its native event', async () => {
    const test = await fixture()
    const upstreamSse = [
      'event: image_generation.completed',
      'data: {"type":"image_generation.completed","call_id":"url-call","url":"https://cdn.example.test/image.png","size":"1024x1024"}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n')
    test.upstreamFetch.mockResolvedValueOnce(new Response(upstreamSse, {
      headers: { 'content-type': 'text/event-stream' },
    }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true, response_format: 'url' }),
    }, test.env as never)

    expect(await response.text()).toBe(upstreamSse)
    await vi.waitFor(() => expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({ imageCount: 1, amountMicros: 100_000, outcome: 'completed' }),
    })))
    expect(test.failureRequests).toEqual([])
  })

  it('keeps native Direct Images leases until a disconnected stream is drained and settled', async () => {
    const test = await fixture()
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | null = null
    const encoder = new TextEncoder()
    test.upstreamFetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller
        controller.enqueue(encoder.encode([
          'event: image_generation.partial_image',
          'data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"cGFydGlhbA=="}',
          '',
          '',
        ].join('\n')))
      },
    }), { headers: { 'content-type': 'text/event-stream' } }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true }),
    }, test.env as never)
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('partial_image')
    expect(test.stateCalls).not.toContain('/release')
    await reader.cancel('client disconnected')
    upstreamController!.enqueue(encoder.encode([
      'event: image_generation.completed',
      'data: {"type":"image_generation.completed","id":"img_direct_detached","b64_json":"aW1hZ2U=","size":"1024x1024"}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n')))
    upstreamController!.close()

    await vi.waitFor(() => expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({
      usage: expect.objectContaining({
        stream: true, outcome: 'cancelled', amountMicros: 100_000,
        upstreamEndpoint: '/v1/images/generations',
      }),
    })))
    await vi.waitFor(() => expect(test.stateCalls.filter((path) => path === '/release')).toHaveLength(2))
  })

  it('keeps a native Direct Images error precommit and returns JSON without charging output', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(new Response([
      'event: error',
      'data: {"type":"error","error":{"type":"invalid_request_error","code":"invalid_value","message":"bad size","param":"size"}}',
      '',
      '',
    ].join('\n'), { status: 400, headers: { 'content-type': 'text/event-stream' } }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true }),
    }, test.env as never)

    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      error: { type: 'invalid_request_error', code: 'invalid_value', message: 'bad size', param: 'size' },
    })
    expect(test.upstreamFetch).toHaveBeenCalledOnce()
    expect(test.settle).not.toHaveBeenCalled()
    expect(test.cancel).toHaveBeenCalledOnce()
  })

  it('retries a Direct streaming HTTP 429 before committing provider bytes', async () => {
    const test = await fixture()
    test.upstreamFetch
      .mockResolvedValueOnce(Response.json({
        error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'slow down' },
      }, { status: 429, headers: { 'retry-after': '0.001' } }))
      .mockResolvedValueOnce(new Response([
        'event: image_generation.completed',
        'data: {"type":"image_generation.completed","id":"after_retry","b64_json":"aW1hZ2U=","size":"1024x1024"}',
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true }),
    }, test.env as never)

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.text()).toContain('after_retry')
    expect(test.upstreamFetch).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(test.settle).toHaveBeenCalledOnce())
  })

  it('never retries a Direct 2xx stream after its first public bytes', async () => {
    const test = await fixture()
    const upstreamSse = [
      ': committed',
      '',
      'event: error',
      'data: {"type":"error","error":{"type":"server_error","code":"late_failure","message":"late"}}',
      '',
      '',
    ].join('\n')
    test.upstreamFetch.mockResolvedValueOnce(new Response(upstreamSse, {
      headers: { 'content-type': 'text/event-stream' },
    }))

    const response = await app().request('/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cat', stream: true }),
    }, test.env as never)

    expect(await response.text()).toBe(upstreamSse)
    expect(test.upstreamFetch).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(test.cancel).toHaveBeenCalledOnce())
    expect(test.settle).not.toHaveBeenCalled()
  })
})
