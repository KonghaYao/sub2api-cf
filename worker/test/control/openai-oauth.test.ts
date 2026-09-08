import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as adminAuth from '../../src/control/admin-auth'
import * as proxyTransport from '../../src/gateway/proxy-fetch'
import { generateOpenAIAuthURL, exchangeOpenAIAuthCode, refreshOpenAIAuthToken } from '../../src/control/openai-oauth'
import { OPENAI_OAUTH_CLIENT_ID } from '../../src/control/openai-oauth-http'
import { decryptCredential } from '../../src/gateway/crypto'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('original OpenAI account OAuth flow', () => {
  let raw: any; let env: Env; let app: Hono<{ Bindings: Env }>; let owner: string
  beforeEach(() => {
    const db = createSqliteD1(); raw = db.raw; applyMigrations(raw)
    raw.exec("INSERT INTO users(id,email,display_name,role,status,created_at_ms,updated_at_ms) VALUES('admin','admin@example.test','Admin','admin','active',1,1),('other','other@example.test','Other','admin','active',1,1)")
    env = { DB: db.d1, CREDENTIALS_MASTER_KEY: 'm'.repeat(32), ENVIRONMENT: 'test' } as Env
    owner = 'admin'
    vi.spyOn(adminAuth, 'authenticateAdminSession').mockImplementation(async () => ({ user_id: owner } as adminAuth.AdminActor))
    app = new Hono<{ Bindings: Env }>()
    app.post('/generate', generateOpenAIAuthURL); app.post('/exchange', exchangeOpenAIAuthCode); app.post('/refresh', refreshOpenAIAuthToken)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); raw.close() })
  const tokenResponse = () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600,
    id_token: `header.${btoa(JSON.stringify({ email: 'oauth@example.test', 'https://api.openai.com/auth': { chatgpt_account_id: 'personal', chatgpt_plan_type: 'pro' } }))}.signature` })
  const post = (path: string, body: unknown = {}) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env)
  const generate = async (body: unknown = {}) => {
    const response = await post('/generate', body)
    expect(response.status, await response.clone().text()).toBe(200)
    const data = (await response.json() as any).data
    return { id: data.session_id, url: new URL(data.auth_url), state: new URL(data.auth_url).searchParams.get('state') }
  }
  function outbound() {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(url) === 'https://auth.openai.com/oauth/token') return tokenResponse()
      if (String(url).includes('/settings/')) return new Response(null, { status: 204 })
      if (String(url).includes('/subscriptions')) return Response.json({ active_until: '2099-01-01T00:00:00Z' })
      return Response.json({ accounts: {} })
    })
  }

  it('stores an encrypted 30-minute PKCE session, exchanges once, and returns original token/profile fields', async () => {
    const start = Date.now(); const session = await generate()
    expect(session.id).toMatch(/^[a-f0-9]{32}$/); expect(session.state).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.fromEntries(session.url.searchParams)).toMatchObject({ client_id: OPENAI_OAUTH_CLIENT_ID,
      response_type: 'code', redirect_uri: 'http://localhost:1455/auth/callback', scope: 'openid profile email offline_access',
      code_challenge_method: 'S256', codex_cli_simplified_flow: 'true', id_token_add_organizations: 'true' })
    const row = raw.prepare('SELECT * FROM account_oauth_sessions WHERE id=?').get(session.id)
    expect(row.expires_at_ms - row.created_at_ms).toBe(30 * 60 * 1000)
    expect(JSON.stringify(row)).not.toContain(session.state)
    const { api_key: verifier } = await decryptCredential(row.nonce_b64, row.ciphertext_b64, env.CREDENTIALS_MASTER_KEY!, `account-oauth-session:v1:test:admin:${session.id}`)
    expect(verifier).toMatch(/^[a-f0-9]{128}$/)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    expect(session.url.searchParams.get('code_challenge')).toBe(btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
    const fetcher = outbound(); vi.stubGlobal('fetch', fetcher)
    const response = await post('/exchange', { session_id: session.id, code: 'one-use-code', state: session.state })
    expect(response.status, await response.clone().text()).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
    const info = (await response.json() as any).data
    expect(info).toMatchObject({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, client_id: OPENAI_OAUTH_CLIENT_ID,
      email: 'oauth@example.test', chatgpt_account_id: 'personal', plan_type: 'pro', subscription_expires_at: '2099-01-01T00:00:00Z', privacy_mode: 'training_off' })
    expect(info.expires_at).toBeGreaterThanOrEqual(Math.floor(start / 1000) + 3600)
    const init = fetcher.mock.calls[0]![1]!
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ grant_type: 'authorization_code', client_id: OPENAI_OAUTH_CLIENT_ID,
      code: 'one-use-code', redirect_uri: 'http://localhost:1455/auth/callback', code_verifier: verifier })
    expect(new Headers(init.headers).get('originator')).toBe('codex-tui'); expect(new Headers(init.headers).has('version')).toBe(false)
    expect(init.redirect).toBe('manual')
    expect(raw.prepare('SELECT * FROM account_oauth_sessions WHERE id=?').get(session.id)).toBeUndefined()
    expect((await post('/exchange', { session_id: session.id, code: 'one-use-code', state: session.state })).status).toBe(400)
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('auth.openai.com'))).toHaveLength(1)
  })

  it.each(['state', 'owner', 'expired', 'missing'] as const)('rejects invalid %s before contacting upstream', async condition => {
    const session = await generate(); const fetcher = outbound(); vi.stubGlobal('fetch', fetcher)
    if (condition === 'owner') owner = 'other'
    if (condition === 'expired') raw.prepare('UPDATE account_oauth_sessions SET created_at_ms=1, expires_at_ms=2 WHERE id=?').run(session.id)
    const response = await post('/exchange', { session_id: condition === 'missing' ? 'missing' : session.id, code: 'private-code', state: condition === 'state' ? 'wrong-state' : session.state })
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('private-code'); expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects simultaneous exchanges and releases the lease after provider rejection so the original modal can retry', async () => {
    const session = await generate(); let finish!: (response: Response) => void
    const fetcher = outbound(); fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const body = { session_id: session.id, code: 'retry-code', state: session.state }
    const first = post('/exchange', body)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    expect((await post('/exchange', body)).status).toBe(409)
    finish(new Response('private-provider-error', { status: 400 }))
    const rejected = await first
    expect(rejected.status).toBe(502); expect(await rejected.text()).not.toContain('private-provider-error')
    expect(raw.prepare('SELECT lease_token FROM account_oauth_sessions WHERE id=?').get(session.id)).toEqual({ lease_token: null })
    expect((await post('/exchange', body)).status).toBe(200)
  })

  it('uses the selected session proxy for tokens, profile and privacy, allowing an explicit proxy/redirect override', async () => {
    for (const id of ['first-proxy', 'second-proxy']) raw.prepare("INSERT INTO proxies(id,name,protocol,host,port,status,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES(?,?,'http','proxy.test',8080,'active','','',1,1)").run(id, id)
    const session = await generate({ proxy_id: 'first-proxy', redirect_uri: 'https://panel.test/callback' })
    const fetcher = outbound(); const direct = vi.fn(); vi.stubGlobal('fetch', direct)
    const proxy = vi.spyOn(proxyTransport, 'fetchAccountProxy').mockImplementation(async (_env, id, url, init) => {
      expect(id).toBe('second-proxy'); return fetcher(url.href, init)
    })
    const response = await post('/exchange', { session_id: session.id, code: 'proxied-code', state: session.state,
      proxy_id: 'second-proxy', redirect_uri: 'https://panel.test/override' })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(new URLSearchParams(String(fetcher.mock.calls[0]![1]!.body)).get('redirect_uri')).toBe('https://panel.test/override')
    expect(proxy).toHaveBeenCalledTimes(4); expect(direct).not.toHaveBeenCalled()
  })

  it('fails closed for missing proxies without creating a session', async () => {
    vi.stubGlobal('fetch', vi.fn())
    expect((await post('/generate', { proxy_id: 'missing-proxy' })).status).toBe(400)
    expect(raw.prepare('SELECT COUNT(*) AS n FROM account_oauth_sessions').get().n).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['refresh_token', 'rt'])('imports a refresh token with %s, custom client, and no OAuth session persistence', async field => {
    const fetcher = outbound(); vi.stubGlobal('fetch', fetcher)
    const response = await post('/refresh', { [field]: ' pasted-refresh ', client_id: 'custom-client' })
    expect(response.status).toBe(200)
    expect((await response.json() as any).data).toMatchObject({ access_token: 'new-access', refresh_token: 'new-refresh', client_id: 'custom-client' })
    expect(Object.fromEntries(new URLSearchParams(String(fetcher.mock.calls[0]![1]!.body)))).toEqual({ grant_type: 'refresh_token',
      refresh_token: 'pasted-refresh', client_id: 'custom-client', scope: 'openid profile email' })
    expect(raw.prepare('SELECT COUNT(*) AS n FROM account_oauth_sessions').get().n).toBe(0)
  })
})
