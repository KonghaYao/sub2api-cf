// @ts-expect-error Node typings are intentionally excluded from the Worker tsconfig.
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ACCOUNT_MODELS } from '../../src/control/account-model-defaults'
import { getAdminAccountModels, syncAdminAccountModels, previewAdminAccountModels, parseUpstreamCatalog } from '../../src/control/account-models'
import { createApp } from '../../src/app'
import { encryptCredential } from '../../src/gateway/crypto'
import * as proxyTransport from '../../src/gateway/proxy-fetch'
import { credentialAad } from '../../src/gateway/repository'
import { providerContract, type ProviderPlatform } from '../../src/gateway/providers'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const MASTER = 'm'.repeat(32)
const META = { id: 'model-a', display_name: 'Model A', reasoning: true, supported_reasoning_levels: [{ effort: 'LOW' }, { effort: 'extra-high' }], input_modalities: ['text', 'image'], context_window: 128000 }
async function fixture(platform: ProviderPlatform = 'openai', config: Record<string, unknown> = {}, credential: Record<string, unknown> = { api_key: 'private-upstream-secret' }, kind = 'api_key') {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const contract = providerContract(platform)
  const baseUrl = platform === 'gemini' ? 'https://models.example.test/v1beta' : 'https://models.example.test/v1'
  const encrypted = await encryptCredential(credential, MASTER, credentialAad('test', 'opaque-account', 'vault-key', 1))
  raw.prepare(`INSERT INTO accounts (id, platform, name, credential_ref, enabled, max_concurrency,
    created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, credential_kind, ui_config_json)
    VALUES ('opaque-account', ?, 'Models', 'vault-key', 1, 4, 1, 1, ?, ?, ?, ?, ?)`)
    .run(platform, contract.protocol, baseUrl, contract.auth_scheme, kind, JSON.stringify(config))
  raw.prepare(`INSERT INTO account_secrets (id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms)
    VALUES ('vault-key', 'opaque-account', 1, ?, ?, 1, 1)`).run(encrypted.nonce_b64, encrypted.ciphertext_b64)
  const cache = new Map<string, string>()
  const env = { DB: d1, ENVIRONMENT: 'test', CREDENTIALS_MASTER_KEY: MASTER,
    CONFIG_KV: { get: async (key: string) => cache.has(key) ? JSON.parse(cache.get(key)!) : null,
      put: async (key: string, value: string) => { cache.set(key, value) } } } as unknown as Env
  const app = new Hono<{ Bindings: Env }>()
  app.get('/accounts/:id/models', getAdminAccountModels)
  app.post('/accounts/:id/models/sync-upstream', syncAdminAccountModels)
  app.post('/accounts/models/sync-upstream-preview', previewAdminAccountModels)
  const request = (path: string, body?: unknown) => app.request(path, { method: 'POST',
    headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env)
  const sync = () => request('/accounts/opaque-account/models/sync-upstream')
  const state = () => raw.prepare('SELECT ui_config_json, control_version, config_version FROM accounts').get() as any
  return { raw, env, app, request, sync, state, cache }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('original account model directory and live sync', () => {
  it.each([0, '0'])('treats legacy proxy sentinel %j as direct model synchronization', async proxyId => {
    const f = await fixture('openai', { proxy_id: proxyId })
    try {
      const transport = vi.spyOn(proxyTransport, 'fetchAccountProxy')
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [META] })))
      expect((await f.sync()).status).toBe(200)
      expect(transport).not.toHaveBeenCalled()
    } finally { f.raw.close() }
  })

  it('syncs a saved account through its proxy and preserves upstream authorization inside the transport', async () => {
    const f = await fixture()
    try {
      f.raw.exec("INSERT INTO proxies(id,name,protocol,host,port,status,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES('proxy-sync','Sync','http','proxy.test',8080,'active','','',1,1)")
      f.raw.exec("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.proxy_id','proxy-sync')")
      const transport = vi.spyOn(proxyTransport, 'fetchAccountProxy').mockResolvedValue(Response.json({ data: [META] }))
      const direct = vi.fn().mockRejectedValue(new Error('No direct upstream access'))
      vi.stubGlobal('fetch', direct)
      const response = await f.sync()
      expect(response.status).toBe(200)
      expect((await response.json() as any).data.models).toEqual(['model-a'])
      expect(transport).toHaveBeenCalledOnce()
      const [env, id, url, init] = transport.mock.calls[0]
      expect(env).toBe(f.env)
      expect(id).toBe('proxy-sync')
      expect(url.href).toBe('https://models.example.test/v1/models')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer private-upstream-secret')
      expect(direct.mock.calls.every(([url]) => url === 'https://models.dev/api.json')).toBe(true)
    } finally { f.raw.close() }
  })

  it('does not disguise an unavailable bound proxy as model-mapping fallback or direct success', async () => {
    const f = await fixture('openai', {}, { api_key: 'private-upstream-secret', model_mapping: { public: 'fallback' } })
    try {
      f.raw.exec("INSERT INTO proxies(id,name,protocol,host,port,status,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES('proxy-sync','Sync','https','proxy.test',443,'active','','',1,1)")
      f.raw.exec("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.proxy_id','proxy-sync')")
      const direct = vi.fn().mockResolvedValue(Response.json({ data: [META] }))
      vi.stubGlobal('fetch', direct)
      const before = f.state()
      const response = await f.sync()
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: { code: 'proxy_nested_tls_unavailable' } })
      expect(direct).not.toHaveBeenCalled()
      expect(f.state()).toEqual(before)
    } finally { f.raw.close() }
  })

  it.each(['openai', 'anthropic', 'gemini'] as const)('preserves the original %s catalog and mapping choices without reading credentials or calling upstream', async platform => {
    const f = await fixture(platform)
    try {
      const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
      const sourcePath = { openai: 'openai/constants.go', anthropic: 'claude/constants.go', gemini: 'geminicli/models.go' }[platform]
      const source = readFileSync(`../backend/internal/pkg/${sourcePath}`, 'utf8').match(/var DefaultModels = \[\]Model\{([\s\S]*?)\n\}/)![1]
      expect(DEFAULT_ACCOUNT_MODELS[platform].map(model => model.id)).toEqual([...source.matchAll(/ID:\s*"([^"]+)"/g)].map(match => match[1]))
      const result = await f.app.request('/accounts/opaque-account/models', {}, f.env)
      expect(await result.json()).toEqual({ code: 0, data: DEFAULT_ACCOUNT_MODELS[platform] })
      f.raw.prepare('UPDATE accounts SET ui_config_json = ?').run(JSON.stringify({ credentials: { model_mapping: { custom: 'target', [DEFAULT_ACCOUNT_MODELS[platform][0].id]: 'model-a' } } }))
      const mapped = await (await f.app.request('/accounts/opaque-account/models', {}, f.env)).json() as any
      expect(mapped.data.map((model: any) => model.id).sort()).toEqual(['custom', DEFAULT_ACCOUNT_MODELS[platform][0].id].sort())
      expect(fetcher).not.toHaveBeenCalled()
      expect((await f.app.request('/accounts/missing/models', {}, f.env)).status).toBe(404)
    } finally { f.raw.close() }
  })

  it('bypasses mappings for OpenAI passthrough and defaults for OAuth Claude/Gemini', async () => {
    const f = await fixture('openai', { credentials: { model_mapping: { hidden: 'target' } }, extra: { openai_passthrough: true } })
    try {
      expect((await (await f.app.request('/accounts/opaque-account/models', {}, f.env)).json() as any).data).toEqual(DEFAULT_ACCOUNT_MODELS.openai)
      f.raw.exec(`UPDATE accounts SET ui_config_json = json_set(ui_config_json, '$.extra.openai_passthrough', json('false'), '$.extra.openai_oauth_passthrough', json('true'))`)
      expect((await (await f.app.request('/accounts/opaque-account/models', {}, f.env)).json() as any).data.map((model: any) => model.id)).toEqual(['hidden'])
      f.raw.exec("UPDATE accounts SET platform='anthropic', protocol='anthropic', auth_scheme='x-api-key', credential_kind='oauth'")
      expect((await (await f.app.request('/accounts/opaque-account/models', {}, f.env)).json() as any).data).toEqual(DEFAULT_ACCOUNT_MODELS.anthropic)
    } finally { f.raw.close() }
  })

  it('honors Claude bearer authentication and permitted overrides while protecting auth and protocol headers', async () => {
    const f = await fixture('anthropic', { extra: { anthropic_apikey_auth_scheme: 'authorization_bearer' } }, {
      api_key: 'private-upstream-secret', header_override_enabled: true, header_overrides: {
        'X-Custom-Gateway': ' gateway-value ', 'Anthropic-Beta': 'custom-beta', Authorization: 'injected',
        'x-api-key': 'injected', 'content-type': 'invalid', 'Bad Header': 'ignored', 'x-newline': 'bad\nvalue',
      },
    })
    try {
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers)
        expect(headers.get('authorization')).toBe('Bearer private-upstream-secret')
        expect(headers.has('x-api-key')).toBe(false)
        expect(headers.get('x-custom-gateway')).toBe('gateway-value')
        expect(headers.get('anthropic-beta')).toBe('custom-beta')
        expect(headers.get('content-type')).not.toBe('invalid')
        expect(headers.has('x-newline')).toBe(false)
        expect(headers.get('user-agent')).toContain('claude-cli/')
        return Response.json({ data: [META] })
      }))
      expect((await f.sync()).status).toBe(200)
    } finally { f.raw.close() }
  })

  it('syncs encrypted credentials, normalizes metadata, and atomically merges runtime metadata without changing displayed versions', async () => {
    const f = await fixture('openai', { notes: 'keep', extra: { existing: true } })
    try {
      const fetcher = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://models.example.test/v1/models')
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer private-upstream-secret')
        expect(init.redirect).toBe('manual')
        return Response.json({ data: [META, META] })
      }); vi.stubGlobal('fetch', fetcher)
      const response = await f.sync()
      expect(response.status).toBe(200)
      const data = (await response.json() as any).data
      expect(data).toMatchObject({ models: ['model-a'], metadata: { 'model-a': {
        reasoning: true, default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'xhigh'], context_window: 128000,
      } } })
      expect(data.warnings).toBeUndefined()
      const state = f.state()
      expect(JSON.parse(state.ui_config_json)).toMatchObject({ notes: 'keep', extra: { existing: true, upstream_model_metadata: { source: 'upstream', models: data.metadata } } })
      expect(state.control_version).toBe(0)
      expect(JSON.stringify(data)).not.toContain('private-upstream-secret')
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally { f.raw.close() }
  })

  it('uses native Gemini list URLs/headers and recognizes native model names and limits', async () => {
    const f = await fixture('gemini')
    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://models.example.test/v1beta/models')
        expect(new Headers(init.headers).get('x-goog-api-key')).toBe('private-upstream-secret')
        expect(new Headers(init.headers).has('authorization')).toBe(false)
        return Response.json({ models: [{ name: 'models/gemini-test', displayName: 'Gemini Test', inputTokenLimit: 1000, outputTokenLimit: 200, reasoning: false, input_modalities: ['text'] }] })
      }))
      const data = (await (await f.sync()).json() as any).data
      expect(data).toMatchObject({ models: ['gemini-test'], metadata: { 'gemini-test': { display_name: 'Gemini Test', context_window: 1000, max_output_tokens: 200 } } })
    } finally { f.raw.close() }
  })

  it('uses the Codex manifest with the OAuth access token instead of the public OpenAI API key', async () => {
    const f = await fixture('openai', {}, { api_key: 'sentinel-not-oauth', access_token: 'oauth-access-secret', chatgpt_account_id: 'workspace-id' }, 'oauth')
    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.146.0')
        const headers = new Headers(init.headers)
        expect(headers.get('authorization')).toBe('Bearer oauth-access-secret')
        expect(headers.get('chatgpt-account-id')).toBe('workspace-id')
        expect(headers.get('originator')).toBe('codex-tui')
        expect(headers.get('version')).toBe('0.146.0')
        return Response.json({ models: [{ ...META, id: undefined, slug: 'codex-model' }] })
      }))
      expect((await f.sync()).status).toBe(200)
    } finally { f.raw.close() }
  })

  it('enriches only matching provider metadata and never sends upstream credentials to the registry', async () => {
    const f = await fixture()
    try {
      const fetcher = vi.fn(async (url: string, init: RequestInit) => {
        if (url === 'https://models.example.test/v1/models') return Response.json({ data: [{ id: 'model-a', display_name: 'Direct name' }] })
        expect(url).toBe('https://models.dev/api.json')
        expect(new Headers(init.headers).has('authorization')).toBe(false)
        return Response.json({ unrelated: { api: 'https://other.example/v1', models: { 'model-a': { reasoning: true } } },
          matched: { api: 'https://models.example.test/v1', models: { 'MODEL-A': { id: 'model-a', name: 'Registry name', reasoning: false, modalities: { input: ['text', 'image'] }, limit: { context: 64000, output: 8192 } } } } })
      }); vi.stubGlobal('fetch', fetcher)
      const data = (await (await f.sync()).json() as any).data
      expect(data.metadata['model-a']).toMatchObject({ display_name: 'Direct name', reasoning: false, context_window: 64000, max_output_tokens: 8192 })
      expect(JSON.parse(f.state().ui_config_json).extra.upstream_model_metadata.source).toBe('models.dev')
      await f.sync()
      expect(fetcher).toHaveBeenCalledTimes(3) // second sync uses the public registry cache
    } finally { f.raw.close() }
  })

  it('returns incomplete metadata as a warning and preserves an older complete snapshot', async () => {
    const f = await fixture('openai', { extra: { upstream_model_metadata: { source: 'old' } } })
    try {
      const before = f.state()
      vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('models.dev') ? new Response('secret error body', { status: 503 }) : Response.json({ data: [{ id: 'new-model' }] })))
      const response = await f.sync()
      expect(response.status).toBe(200)
      const data = (await response.json() as any).data
      expect(data.models).toEqual(['new-model'])
      expect(data.warnings[0].code).toBe('upstream_model_metadata_incomplete')
      expect(f.state()).toEqual(before)
    } finally { f.raw.close() }
  })

  it('falls back to concrete configured targets only for missing listing endpoints, including create preview', async () => {
    const f = await fixture()
    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('models.dev') ? Response.json({}) : new Response('do not expose', { status: 404 })))
      const data = (await (await f.request('/accounts/models/sync-upstream-preview', { platform: 'openai', type: 'apikey', base_url: 'https://models.example.test/v1', api_key: 'preview-secret', model_mapping: { alias: 'target', duplicate: 'target', wildcard: '*', blank: '' } })).json() as any).data
      expect(data.models).toEqual(['target'])
      expect(data.warnings[0].code).toBe('upstream_model_metadata_incomplete')
      expect(JSON.parse(f.state().ui_config_json)).toEqual({})
      vi.stubGlobal('fetch', vi.fn(async () => new Response('sensitive detail', { status: 401 })))
      const failed = await f.sync()
      expect(failed.status).toBe(502)
      expect(await failed.text()).not.toContain('sensitive detail')
    } finally { f.raw.close() }
  })

  it('rejects a metadata write after concurrent account editing without overwriting newer fields', async () => {
    const f = await fixture()
    try {
      vi.stubGlobal('fetch', vi.fn(async () => {
        f.raw.exec(`UPDATE accounts SET control_version=control_version+1, ui_config_json='{"notes":"newer edit"}'`)
        return Response.json({ data: [META] })
      }))
      expect((await f.sync()).status).toBe(412)
      expect(JSON.parse(f.state().ui_config_json)).toEqual({ notes: 'newer edit' })
    } finally { f.raw.close() }
  })

  it('bounds upstream bodies, returns safe errors for invalid responses and rejects unsafe preview inputs before fetching', async () => {
    const f = await fixture()
    try {
      const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
      for (const extra of [{ base_url: 'http://localhost' }, { type: 'oauth' }, { platform: '__proto__' }, { model_mapping: { a: null } }]) {
        expect((await f.request('/accounts/models/sync-upstream-preview', { platform: 'openai', type: 'apikey', api_key: 'preview-secret', ...extra })).status).toBe(400)
      }
      expect(fetcher).not.toHaveBeenCalled()
      fetcher.mockResolvedValueOnce(new Response(new Uint8Array(8 * 1024 * 1024 + 1)))
      expect((await f.sync()).status).toBe(502)
      fetcher.mockResolvedValueOnce(new Response('private credential echoed by upstream'))
      expect(await (await f.sync()).text()).not.toContain('private credential')
      fetcher.mockRejectedValueOnce(new DOMException('credential-bearing detail', 'TimeoutError'))
      expect((await f.sync()).status).toBe(504)
      expect(JSON.parse(f.state().ui_config_json)).toEqual({})
    } finally { f.raw.close() }
  })

  it('parses combined envelopes and normalizes reasoning while treating unknown capabilities as unknown', () => {
    const result = parseUpstreamCatalog({ data: [{ id: 'models/a' }], models: [{ slug: 'b', supported_reasoning_levels: ['off', 'extra_high', 'garbage', 'extra-high'], modalities: { input: ['TEXT', 'image', 'audio'] }, limit: { context: 2000 } }] })
    expect(result.models).toEqual(['a', 'b'])
    expect(result.metadata.a).toBeUndefined()
    expect(result.metadata.b).toMatchObject({ reasoning: true, supported_reasoning_levels: ['none', 'xhigh'], input_modalities: ['text', 'image'] })
    expect(() => parseUpstreamCatalog({ error: 'not a model list' })).toThrow('no supported models')
  })

  it('registers the original routes behind administrator authentication', async () => {
    const f = await fixture()
    try {
      const app = createApp()
      for (const [method, path] of [['GET', '/api/v1/admin/accounts/opaque-account/models'], ['POST', '/api/v1/admin/accounts/opaque-account/models/sync-upstream'], ['POST', '/api/v1/admin/accounts/models/sync-upstream-preview']]) {
        expect((await app.request(path, { method }, f.env)).status).toBe(401)
      }
    } finally { f.raw.close() }
  })
})

it.each(['saved-task',''])('synchronizes models with original key-only Agent credentials and task %j',async task=>{
  const credentials={auth_mode:'agentIdentity',agent_runtime_id:'models-runtime',agent_private_key:'MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f',chatgpt_account_id:'models-workspace',chatgpt_user_id:'models-user',task_id:task}
  const f=await fixture('openai',{},credentials,'oauth')
  try {
    const fetcher=vi.fn().mockImplementation(async(url:string)=>url.includes('/task/register')?Response.json({task_id:'registered-models-task'}):Response.json({models:[{...META,id:undefined,slug:'agent-model'}]}))
    vi.stubGlobal('fetch',fetcher)
    const response=await f.sync();expect(response.status,await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({data:{models:['agent-model']}})
    const calls=fetcher.mock.calls as unknown as Array<[string,RequestInit]>
    const modelCall=calls.find(([url])=>url.includes('/codex/models'))!
    expect(modelCall).toBeDefined()
    expect(new Headers(modelCall[1].headers).get('authorization')).toMatch(/^AgentAssertion /)
    expect(new Headers(modelCall[1].headers).get('chatgpt-account-id')).toBe('models-workspace')
    expect(JSON.parse(f.state().ui_config_json).extra.upstream_model_metadata.models).toHaveProperty('agent-model')
    expect(f.state().control_version).toBe(0)
    expect(calls.filter(([url])=>url.includes('/task/register'))).toHaveLength(task?0:1)
  } finally {f.raw.close()}
})
