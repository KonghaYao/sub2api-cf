import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import {
  cleanupExpiredOAuthState,
  OAUTH_ACTIVE_FLOW_LIMITS,
  registerOAuthIdentityRoutes,
} from '../../src/auth/oauth-identities'
import type { Env } from '../../src/env'
import { encryptCredential } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'oauth-identity-test-pepper-at-least-32-bytes'
const MASTER_KEY = 'oauth-identity-test-master-key-at-least-32-bytes'
const DAY_MS = 86_400_000
const FLOW_TEST_TTL_MS = 60_000

interface Fixture {
  app: Hono<{ Bindings: Env }>
  raw: any
  env: Env
  authorization: string
}

describe('OAuth identities SQLite HTTP contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('logs in a linked GitHub identity with PKCE and consumes browser-bound state once', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    seedIdentity(test, 'github-subject')

    const started = await test.app.request(
      '/api/v1/auth/oauth/github/start?redirect=/dashboard',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
      test.env,
    )
    expect(started.status).toBe(200)
    const startedBody = await started.json() as any
    const authorizeUrl = new URL(startedBody.data.authorize_url)
    const state = authorizeUrl.searchParams.get('state')!
    const challenge = authorizeUrl.searchParams.get('code_challenge')!
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://github.test/authorize')
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(
      'https://worker.test/api/v1/auth/oauth/github/callback',
    )
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256')
    const browserCookie = responseCookie(started, 'sub2api_oauth_browser')

    let verifier = ''
    const upstream = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request)
      if (url === 'https://github.test/token') {
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('client_secret')).toBe('github-secret')
        expect(body.get('code')).toBe('provider-code')
        verifier = body.get('code_verifier') ?? ''
        return Response.json({ access_token: 'provider-access', token_type: 'bearer' })
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-access')
      if (url === 'https://github.test/user') {
        return Response.json({ id: 'github-subject', login: 'octocat', name: 'Octo Cat' })
      }
      if (url === 'https://github.test/emails') {
        return Response.json([{ email: 'alice@example.test', primary: true, verified: true }])
      }
      throw new Error(`unexpected external URL ${url}`)
    })
    vi.stubGlobal('fetch', upstream)

    const callback = await test.app.request(
      `/api/v1/auth/oauth/github/callback?code=provider-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: browserCookie } },
      test.env,
    )
    expect(callback.status).toBe(302)
    const callbackUrl = new URL(callback.headers.get('location')!, 'https://worker.test')
    expect(callbackUrl.pathname).toBe('/auth/oauth/callback')
    const completion = new URLSearchParams(callbackUrl.hash.slice(1))
    expect(completion.get('access_token')).toMatch(/^sat_v1_/)
    expect(completion.get('refresh_token')).toMatch(/^srt_v1_/)
    expect(completion.get('redirect')).toBe('/dashboard')
    expect(await pkceChallenge(verifier)).toBe(challenge)

    const replay = await test.app.request(
      `/api/v1/auth/oauth/github/callback?code=provider-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: browserCookie } },
      test.env,
    )
    expect(replay.status).toBe(302)
    expect(replay.headers.get('location')).toContain('error=invalid_state')
    expect(upstream).toHaveBeenCalledTimes(3)

    const listed = await test.app.request('/api/v1/user/auth-identities', {
      headers: { authorization: `Bearer ${completion.get('access_token')}` },
    }, test.env)
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject({
      data: {
        total: 1,
        items: [{ provider: 'github', display_name: 'Octo Cat' }],
        auth_bindings: { github: { bound: true } },
      },
    })
  })

  it('links through the frontend bind ticket, lists a masked identity, and revokes sessions on unlink', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    const ticket = await test.app.request('/api/v1/auth/oauth/bind-token', {
      method: 'POST',
      headers: { authorization: test.authorization },
    }, test.env)
    expect(ticket.status).toBe(200)

    const started = await test.app.request(
      '/api/v1/auth/oauth/github/bind/start?intent=bind_current_user&redirect=/profile',
      { headers: { cookie: responseCookie(ticket, 'sub2api_oauth_bind') } },
      test.env,
    )
    expect(started.status).toBe(302)
    const authorize = new URL(started.headers.get('location')!)
    const upstream = githubUpstream('new-github-subject', 'Alice Linked')
    vi.stubGlobal('fetch', upstream)
    const callback = await test.app.request(
      `/api/v1/auth/oauth/github/callback?code=link-code&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } },
      test.env,
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/profile?oauth_bound=github')

    const listed = await test.app.request('/api/v1/user/auth-identities', {
      headers: { authorization: test.authorization },
    }, test.env)
    const listedBody = await listed.json() as any
    expect(listedBody).toMatchObject({
      data: {
        total: 1,
        items: [{
          provider: 'github',
          display_name: 'Alice Linked',
          subject_hint: 'new-…ject',
          can_unbind: true,
        }],
      },
    })
    expect(JSON.stringify(listedBody)).not.toContain('new-github-subject')

    const unlinked = await test.app.request('/api/v1/user/account-bindings/github', {
      method: 'DELETE',
      headers: { authorization: test.authorization },
    }, test.env)
    expect(unlinked.status).toBe(200)
    await expect(unlinked.json()).resolves.toMatchObject({
      data: { github_bound: false, auth_bindings: { github: { bound: false } } },
    })
    expect(test.raw.prepare(
      `SELECT revoke_reason FROM user_sessions WHERE id = 'session-alice'`,
    ).get()).toEqual({ revoke_reason: 'oauth_identity_unlinked' })
  })

  it('rejects unlinking an OAuth-only account\'s last sign-in method', async () => {
    const test = await fixture()
    test.raw.prepare(`UPDATE users SET password_credential = NULL WHERE id = 'alice'`).run()
    seedIdentity(test, 'only-subject')

    const response = await test.app.request('/api/v1/user/account-bindings/github', {
      method: 'DELETE',
      headers: { authorization: test.authorization },
    }, test.env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'IDENTITY_UNBIND_LAST_METHOD' })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM auth_identities').get()).toEqual({ total: 1 })
  })

  it('uses a write-time CAS so concurrent unlinks cannot remove both OAuth-only methods', async () => {
    const test = await fixture()
    test.raw.prepare(`UPDATE users SET password_credential = NULL WHERE id = 'alice'`).run()
    seedIdentity(test, 'github-subject')
    seedIdentity(test, 'google-subject', 'google')

    const database = test.env.DB
    const originalBatch = database.batch.bind(database)
    let arrivals = 0
    let openBarrier!: () => void
    const barrier = new Promise<void>((resolve) => { openBarrier = resolve })
    test.env.DB = new Proxy(database, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            arrivals += 1
            if (arrivals === 2) openBarrier()
            await barrier
            return originalBatch(statements)
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    const responses = await Promise.all(['github', 'google'].map((provider) => test.app.request(
      `/api/v1/user/account-bindings/${provider}`,
      { method: 'DELETE', headers: { authorization: test.authorization } },
      test.env,
    )))

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    await expect(responses.find((response) => response.status === 409)!.json()).resolves.toMatchObject({
      code: 'IDENTITY_UNBIND_LAST_METHOD',
    })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM auth_identities WHERE user_id = 'alice'`,
    ).get()).toEqual({ total: 1 })
  })

  it('does not exchange a link code after the session that created the flow is revoked', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    const ticket = await test.app.request('/api/v1/auth/oauth/bind-token', {
      method: 'POST', headers: { authorization: test.authorization },
    }, test.env)
    const started = await test.app.request('/api/v1/auth/oauth/github/bind/start', {
      headers: { cookie: responseCookie(ticket, 'sub2api_oauth_bind') },
    }, test.env)
    const authorize = new URL(started.headers.get('location')!)
    test.raw.prepare(
      `UPDATE user_sessions SET revoked_at_ms = ?, revoke_reason = 'test' WHERE id = 'session-alice'`,
    ).run(Date.now())
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)

    const callback = await test.app.request(
      `/api/v1/auth/oauth/github/callback?code=must-not-exchange&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } },
      test.env,
    )

    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toContain('error=invalid_oauth_bind_session')
    expect(upstream).not.toHaveBeenCalled()
  })

  it('does not persist a linked identity when the binding session is revoked during provider calls', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    const ticket = await test.app.request('/api/v1/auth/oauth/bind-token', {
      method: 'POST', headers: { authorization: test.authorization },
    }, test.env)
    const started = await test.app.request('/api/v1/auth/oauth/github/bind/start', {
      headers: { cookie: responseCookie(ticket, 'sub2api_oauth_bind') },
    }, test.env)
    const authorize = new URL(started.headers.get('location')!)
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request)
      if (url === 'https://github.test/token') return Response.json({ access_token: 'provider-access' })
      if (url === 'https://github.test/user') {
        return Response.json({ id: 'late-link-subject', login: 'late-link', name: 'Late Link' })
      }
      if (url === 'https://github.test/emails') {
        test.raw.prepare(
          `UPDATE user_sessions SET revoked_at_ms = ?, revoke_reason = 'test' WHERE id = 'session-alice'`,
        ).run(Date.now())
        return Response.json([{ email: 'alice@example.test', primary: true, verified: true }])
      }
      throw new Error(`unexpected external URL ${url}`)
    }))

    const callback = await test.app.request(
      `/api/v1/auth/oauth/github/callback?code=late-revoke&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } },
      test.env,
    )

    expect(callback.headers.get('location')).toContain('error=invalid_oauth_bind_session')
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM auth_identities WHERE provider_subject = 'late-link-subject'`,
    ).get()).toEqual({ total: 0 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM auth_audit_events WHERE event_type = 'auth.identity.link'`,
    ).get()).toEqual({ total: 0 })
  })

  it('keeps canonical identity ownership when another user completes the same provider identity', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    seedIdentity(test, 'owned-subject')
    const bob = await seedUserSession(test, 'bob', 'bob@example.test')
    const ticket = await test.app.request('/api/v1/auth/oauth/bind-token', {
      method: 'POST', headers: { authorization: bob },
    }, test.env)
    const started = await test.app.request('/api/v1/auth/oauth/github/bind/start', {
      headers: { cookie: responseCookie(ticket, 'sub2api_oauth_bind') },
    }, test.env)
    const authorize = new URL(started.headers.get('location')!)
    vi.stubGlobal('fetch', githubUpstream('owned-subject', 'Owned Elsewhere'))

    const callback = await test.app.request(
      `/api/v1/auth/oauth/github/callback?code=conflict&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } },
      test.env,
    )

    expect(callback.headers.get('location')).toContain('error=ownership_conflict')
    expect(test.raw.prepare(
      `SELECT user_id FROM auth_identities WHERE provider_subject = 'owned-subject'`,
    ).get()).toEqual({ user_id: 'alice' })
  })

  it('accepts OIDC only after RS256 signature, issuer, audience, nonce, and userinfo subject validation', async () => {
    const test = await fixture()
    await seedProvider(test, 'oidc')
    seedIdentity(test, 'oidc-subject', 'oidc', 'https://oidc.test')
    const keyPair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    Object.assign(publicJwk, { kid: 'signing-key', alg: 'RS256', use: 'sig' })
    const started = await test.app.request('/api/v1/auth/oauth/oidc/start', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, test.env)
    const authorize = new URL((await started.json() as any).data.authorize_url)
    const nonce = authorize.searchParams.get('nonce')!
    let idToken = await signJwt(keyPair.privateKey, {
      iss: 'https://oidc.test',
      aud: 'oidc-client',
      sub: 'oidc-subject',
      nonce,
      exp: Math.floor(Date.now() / 1_000) + 300,
      iat: Math.floor(Date.now() / 1_000),
      email: 'alice@example.test',
      email_verified: true,
      name: 'Alice OIDC',
    })
    const upstream = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request)
      if (url === 'https://oidc.test/token') {
        return Response.json({ access_token: 'oidc-access', token_type: 'Bearer', id_token: idToken })
      }
      if (url === 'https://oidc.test/jwks') return Response.json({ keys: [publicJwk] })
      if (url === 'https://oidc.test/user') {
        return Response.json({
          sub: 'oidc-subject', email: 'alice@example.test', email_verified: true, name: 'Alice OIDC',
        })
      }
      throw new Error(`unexpected external URL ${url}`)
    })
    vi.stubGlobal('fetch', upstream)

    const callback = await test.app.request(
      `/api/v1/auth/oauth/oidc/callback?code=oidc-code&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } },
      test.env,
    )

    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toMatch(/^\/auth\/oidc\/callback#access_token=sat_v1_/)
    expect(upstream.mock.calls.map(([request]) => String(request))).toEqual([
      'https://oidc.test/token',
      'https://oidc.test/jwks',
      'https://oidc.test/user',
    ])

    const rejectedStart = await test.app.request('/api/v1/auth/oauth/oidc/start', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }, test.env)
    const rejectedAuthorize = new URL((await rejectedStart.json() as any).data.authorize_url)
    idToken = await signJwt(keyPair.privateKey, {
      iss: 'https://oidc.test',
      aud: 'oidc-client',
      sub: 'oidc-subject',
      nonce: 'wrong-browser-flow-nonce',
      exp: Math.floor(Date.now() / 1_000) + 300,
    })
    const rejected = await test.app.request(
      `/api/v1/auth/oauth/oidc/callback?code=bad-nonce&state=${encodeURIComponent(rejectedAuthorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(rejectedStart, 'sub2api_oauth_browser') } },
      test.env,
    )
    expect(rejected.headers.get('location')).toContain('error=oidc_token_invalid')
    expect(upstream).toHaveBeenCalledTimes(5)
  })

  it('atomically registers a new verified provider identity when public registration is enabled', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    test.raw.prepare(
      `UPDATE system_settings
          SET public_json = json_set(public_json, '$.registration_enabled', json('true'))
        WHERE id = 'global'`,
    ).run()
    const started = await test.app.request('/api/v1/auth/oauth/github/start', { method: 'POST' }, test.env)
    const authorize = new URL((await started.json() as any).data.authorize_url)
    vi.stubGlobal('fetch', githubUpstream('new-registration-subject', 'New Person', 'new@example.test'))

    const callback = await test.app.request(
      `/api/v1/auth/oauth/github/callback?code=register&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } },
      test.env,
    )

    expect(callback.headers.get('location')).toMatch(/^\/auth\/oauth\/callback#access_token=sat_v1_/)
    expect(test.raw.prepare(
      `SELECT u.email, u.password_credential, i.provider_subject,
              (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id) AS sessions
         FROM users u JOIN auth_identities i ON i.user_id = u.id
        WHERE u.email = 'new@example.test'`,
    ).get()).toEqual({
      email: 'new@example.test',
      password_credential: null,
      provider_subject: 'new-registration-subject',
      sessions: 1,
    })
  })

  it('never auto-binds a new provider identity to an existing email account', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    test.raw.prepare(
      `UPDATE system_settings
          SET public_json = json_set(public_json, '$.registration_enabled', json('true'))
        WHERE id = 'global'`,
    ).run()
    const sessionsBefore = test.raw.prepare('SELECT COUNT(*) AS total FROM user_sessions').get()
    const started = await test.app.request('/api/v1/auth/oauth/github/start', { method: 'POST' }, test.env)
    const authorize = new URL((await started.json() as any).data.authorize_url)
    vi.stubGlobal('fetch', githubUpstream('attacker-controlled-subject', 'Not Alice', 'alice@example.test'))

    const callback = await test.app.request(
      `/api/v1/auth/oauth/github/callback?code=collision&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } },
      test.env,
    )

    expect(callback.headers.get('location')).toContain('error=oauth_account_binding_required')
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM auth_identities').get()).toEqual({ total: 0 })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM user_sessions').get()).toEqual(sessionsBefore)
  })

  it('never treats a LinuxDo email as verified for automatic registration', async () => {
    const test = await fixture()
    await seedProvider(test, 'linuxdo')
    test.raw.prepare(
      `UPDATE system_settings
          SET public_json = json_set(public_json, '$.registration_enabled', json('true'))
        WHERE id = 'global'`,
    ).run()
    const started = await test.app.request('/api/v1/auth/oauth/linuxdo/start', { method: 'POST' }, test.env)
    const authorize = new URL((await started.json() as any).data.authorize_url)
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      if (String(request) === 'https://linuxdo.test/token') {
        return Response.json({ access_token: 'linuxdo-access' })
      }
      return Response.json({
        sub: 'new-linuxdo-subject',
        email: 'new-linuxdo@example.test',
        email_verified: true,
        verified_email: true,
        name: 'New LinuxDo User',
      })
    }))

    const callback = await test.app.request(
      `/api/v1/auth/oauth/linuxdo/callback?code=linuxdo-register&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } },
      test.env,
    )

    expect(callback.headers.get('location')).toContain('error=oauth_registration_requires_verified_email')
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM users WHERE email = 'new-linuxdo@example.test'`,
    ).get()).toEqual({ total: 0 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM auth_identities WHERE provider = 'linuxdo'`,
    ).get()).toEqual({ total: 0 })
  })

  it.each(['google', 'linuxdo'] as const)('logs in a linked %s standard OAuth identity', async (provider) => {
    const test = await fixture()
    await seedProvider(test, provider)
    seedIdentity(test, `${provider}-subject`, provider)
    const started = await test.app.request(`/api/v1/auth/oauth/${provider}/start`, { method: 'POST' }, test.env)
    const authorize = new URL((await started.json() as any).data.authorize_url)
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request)
      if (url === `https://${provider}.test/token`) {
        expect(new URLSearchParams(String(init?.body)).get('client_secret')).toBe(`${provider}-secret`)
        return Response.json({ access_token: `${provider}-access` })
      }
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${provider}-access`)
      return Response.json({
        sub: `${provider}-subject`, email: 'alice@example.test', email_verified: true, name: 'Alice',
      })
    }))

    const callback = await test.app.request(
      `/api/v1/auth/oauth/${provider}/callback?code=standard&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } },
      test.env,
    )

    expect(callback.headers.get('location')).toMatch(/^\/auth\/.+#access_token=sat_v1_/)
  })

  it('uses DingTalk JSON token exchange and its access-token userinfo header', async () => {
    const test = await fixture()
    await seedProvider(test, 'dingtalk')
    seedIdentity(test, 'dingtalk-union', 'dingtalk')
    const started = await test.app.request('/api/v1/auth/oauth/dingtalk/start', { method: 'POST' }, test.env)
    const authorize = new URL((await started.json() as any).data.authorize_url)
    expect(authorize.searchParams.get('prompt')).toBe('consent')
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      if (String(request) === 'https://dingtalk.test/token') {
        expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
        expect(JSON.parse(String(init?.body))).toMatchObject({
          clientId: 'dingtalk-client', clientSecret: 'dingtalk-secret', grantType: 'authorization_code',
        })
        return Response.json({ accessToken: 'dingtalk-access' })
      }
      expect(new Headers(init?.headers).get('x-acs-dingtalk-access-token')).toBe('dingtalk-access')
      return Response.json({ unionId: 'dingtalk-union', nick: 'Alice DingTalk' })
    }))

    const callback = await test.app.request(
      `/api/v1/auth/oauth/dingtalk/callback?code=ding&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } },
      test.env,
    )

    expect(callback.headers.get('location')).toMatch(/^\/auth\/dingtalk\/callback#access_token=sat_v1_/)
  })

  it('uses WeChat appid query exchange and unionid/openid identity semantics', async () => {
    const test = await fixture()
    await seedProvider(test, 'wechat')
    seedIdentity(test, 'wechat-union', 'wechat')
    const started = await test.app.request('/api/v1/auth/oauth/wechat/start', { method: 'POST' }, test.env)
    const authorize = new URL((await started.json() as any).data.authorize_url)
    expect(authorize.searchParams.get('appid')).toBe('wechat-client')
    expect(authorize.searchParams.has('client_id')).toBe(false)
    expect(authorize.hash).toBe('#wechat_redirect')
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(String(request))
      if (url.pathname === '/token') {
        expect(url.searchParams.get('appid')).toBe('wechat-client')
        expect(url.searchParams.get('secret')).toBe('wechat-secret')
        return Response.json({ access_token: 'wechat-access', openid: 'wechat-open' })
      }
      expect(url.searchParams.get('access_token')).toBe('wechat-access')
      expect(url.searchParams.get('openid')).toBe('wechat-open')
      return Response.json({ unionid: 'wechat-union', openid: 'wechat-open', nickname: 'Alice WeChat' })
    }))

    const callback = await test.app.request(
      `/api/v1/auth/oauth/wechat/callback?code=wechat&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } },
      test.env,
    )

    expect(callback.headers.get('location')).toMatch(/^\/auth\/wechat\/callback#access_token=sat_v1_/)
  })

  it.each([
    ['provider.test', 'https://provider.test'],
    ['localhost', 'https://localhost'],
    ['127.0.0.1', 'https://127.0.0.1'],
  ])('rejects unsafe provider host %s in production before external fetch', async (host, origin) => {
    const test = await fixture()
    await seedProvider(test, 'github')
    test.env.ENVIRONMENT = 'production'
    test.raw.prepare(
      `UPDATE oauth_providers
          SET authorization_endpoint = ?, token_endpoint = ?, userinfo_endpoint = ?,
              emails_endpoint = ?, allowed_hosts_json = ?
        WHERE provider = 'github'`,
    ).run(
      `${origin}/authorize`,
      `${origin}/token`,
      `${origin}/user`,
      `${origin}/emails`,
      JSON.stringify([host]),
    )
    const upstream = vi.fn()
    vi.stubGlobal('fetch', upstream)

    const response = await test.app.request('/api/v1/auth/oauth/github/start', { method: 'POST' }, test.env)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: 'oauth_provider_invalid' })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('cancels a chunked provider response as soon as it exceeds 64 KiB', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    const started = await test.app.request('/api/v1/auth/oauth/github/start', {
      method: 'POST',
    }, test.env)
    const authorize = new URL((await started.json() as any).data.authorize_url)
    let pulls = 0
    let cancelled = false
    let tailPulled = false
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls <= 2) {
          controller.enqueue(new Uint8Array(40 * 1_024).fill(0x78))
          return
        }
        tailPulled = true
        controller.enqueue(new Uint8Array(40 * 1_024).fill(0x79))
        controller.close()
      },
      cancel() {
        cancelled = true
      },
    }, { highWaterMark: 0 })
    const upstream = vi.fn(async () => new Response(oversized, {
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', upstream)

    const callback = await test.app.request(
      `/api/v1/auth/oauth/github/callback?code=oversized&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } },
      test.env,
    )

    expect(callback.headers.get('location')).toContain('error=oauth_provider_response_too_large')
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(cancelled).toBe(true)
    expect(tailPulled).toBe(false)
    expect(pulls).toBe(2)
  })

  it('atomically caps active anonymous OAuth flows for one browser', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    const first = await test.app.request('/api/v1/auth/oauth/github/start', { method: 'POST' }, test.env)
    const browserCookie = responseCookie(first, 'sub2api_oauth_browser')
    for (let index = 1; index < OAUTH_ACTIVE_FLOW_LIMITS.browser - 1; index += 1) {
      const response = await test.app.request('/api/v1/auth/oauth/github/start', {
        method: 'POST', headers: { cookie: browserCookie },
      }, test.env)
      expect(response.status).toBe(200)
      expect(responseCookie(response, 'sub2api_oauth_browser')).toBe(browserCookie)
    }

    const raced = await Promise.all([0, 1].map(() => test.app.request(
      '/api/v1/auth/oauth/github/start',
      { method: 'POST', headers: { cookie: browserCookie } },
      test.env,
    )))
    const rejected = raced.find((response) => response.status === 429)!

    expect(raced.map((response) => response.status).sort()).toEqual([200, 429])
    expect(rejected.status).toBe(429)
    await expect(rejected.json()).resolves.toMatchObject({ code: 'oauth_flow_capacity_exceeded' })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM oauth_flows WHERE consumed_at_ms IS NULL AND expires_at_ms > ?`,
    ).get(Date.now())).toEqual({ total: OAUTH_ACTIVE_FLOW_LIMITS.browser })
  })

  it('atomically caps active anonymous OAuth flows globally across browser tokens', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    const now = Date.now()
    test.raw.prepare(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 1
         UNION ALL SELECT value + 1 FROM sequence WHERE value < ?
       )
       INSERT INTO oauth_flows (
         id, provider, intent, state_hash, browser_token_hash, redirect_to,
         expires_at_ms, created_at_ms
       )
       SELECT 'capacity-flow-' || value, 'github', 'login',
              printf('%064x', value), printf('%064x', value + ?),
              '/dashboard', ?, ?
         FROM sequence`,
    ).run(
      OAUTH_ACTIVE_FLOW_LIMITS.global - 1,
      OAUTH_ACTIVE_FLOW_LIMITS.global,
      now + FLOW_TEST_TTL_MS,
      now,
    )

    const raced = await Promise.all([0, 1].map(() => test.app.request(
      '/api/v1/auth/oauth/github/start',
      { method: 'POST' },
      test.env,
    )))
    const rejected = raced.find((response) => response.status === 429)!

    expect(raced.map((response) => response.status).sort()).toEqual([200, 429])
    expect(rejected.status).toBe(429)
    await expect(rejected.json()).resolves.toMatchObject({ code: 'oauth_flow_capacity_exceeded' })
    expect(test.raw.prepare('SELECT COUNT(*) AS total FROM oauth_flows').get()).toEqual({
      total: OAUTH_ACTIVE_FLOW_LIMITS.global,
    })
  })

  it('deletes expired flows and bind tickets in bounded cron batches', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    const current = Date.now()
    for (let index = 0; index < 3; index += 1) {
      test.raw.prepare(
        `INSERT INTO oauth_flows (
           id, provider, intent, state_hash, browser_token_hash, redirect_to,
           expires_at_ms, created_at_ms
         ) VALUES (?, 'github', 'login', ?, ?, '/dashboard', ?, ?)`,
      ).run(
        `expired-flow-${index}`,
        `${index}`.padStart(64, 'a'),
        `${index}`.padStart(64, 'b'),
        current - 1_000,
        current - 2_000,
      )
      test.raw.prepare(
        `INSERT INTO oauth_bind_tickets (
           id, token_hash, user_id, session_id, auth_version, expires_at_ms, created_at_ms
         ) VALUES (?, ?, 'alice', 'session-alice', 1, ?, ?)`,
      ).run(
        `expired-ticket-${index}`,
        `${index}`.padStart(64, 'c'),
        current - 1_000,
        current - 2_000,
      )
    }

    await expect(cleanupExpiredOAuthState(test.env, current, 2)).resolves.toEqual({
      flowsDeleted: 2,
      bindTicketsDeleted: 2,
    })
    expect(test.raw.prepare('SELECT COUNT(*) AS count FROM oauth_flows').get()).toEqual({ count: 1 })
    expect(test.raw.prepare('SELECT COUNT(*) AS count FROM oauth_bind_tickets').get()).toEqual({ count: 1 })

    await expect(cleanupExpiredOAuthState(test.env, current, 2)).resolves.toEqual({
      flowsDeleted: 1,
      bindTicketsDeleted: 1,
    })
  })
})

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, password_credential, auth_version,
       password_changed_at_ms, created_at_ms, updated_at_ms
     ) VALUES ('alice', 'alice@example.test', 'Alice', 'user', 'active', 'password', 1, ?, ?, ?)`,
  ).run(now, now, now)
  const access = createOpaqueToken('access')
  const refresh = createOpaqueToken('refresh')
  raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms, user_agent
     ) VALUES ('session-alice', 'family-alice', 'alice', 1, ?, ?, ?, ?, ?, 'test-agent')`,
  ).run(
    await tokenDigest(access, PEPPER, 'access'),
    await tokenDigest(refresh, PEPPER, 'refresh'),
    now,
    now + DAY_MS,
    now + 30 * DAY_MS,
  )
  const env: Env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    PUBLIC_ORIGIN: 'https://worker.test',
    API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: MASTER_KEY,
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: d1,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  }
  const app = new Hono<{ Bindings: Env }>()
  registerOAuthIdentityRoutes(app)
  return { app, raw, env, authorization: `Bearer ${access}` }
}

async function seedProvider(
  test: Fixture,
  provider: 'github' | 'google' | 'linuxdo' | 'dingtalk' | 'wechat' | 'oidc',
): Promise<void> {
  const encrypted = await encryptCredential(
    { api_key: `${provider}-secret` },
    MASTER_KEY,
    `oauth-provider-secret/test/${provider}/1`,
  )
  const now = Date.now()
  test.raw.prepare(
    `INSERT INTO oauth_providers (
       provider, adapter, enabled, issuer, authorization_endpoint,
       token_endpoint, userinfo_endpoint, emails_endpoint, jwks_endpoint,
       client_id, secret_key_version, secret_nonce_b64, secret_ciphertext_b64,
       scopes_json, allowed_hosts_json, frontend_callback_path,
       pkce_enabled, created_at_ms, updated_at_ms
     ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    provider,
    provider === 'google' || provider === 'linuxdo' ? 'standard' : provider,
    provider === 'oidc' ? 'https://oidc.test' : provider,
    `https://${provider}.test/authorize`,
    `https://${provider}.test/token`,
    `https://${provider}.test/user`,
    provider === 'github' ? `https://${provider}.test/emails` : null,
    provider === 'oidc' ? `https://${provider}.test/jwks` : null,
    `${provider}-client`,
    encrypted.nonce_b64,
    encrypted.ciphertext_b64,
    JSON.stringify(['openid', 'profile', 'email']),
    JSON.stringify([`${provider}.test`]),
    provider === 'github' || provider === 'google'
      ? '/auth/oauth/callback'
      : `/auth/${provider}/callback`,
    provider === 'dingtalk' || provider === 'wechat' ? 0 : 1,
    now,
    now,
  )
}

function seedIdentity(
  test: Fixture,
  subject: string,
  provider: 'github' | 'google' | 'linuxdo' | 'dingtalk' | 'wechat' | 'oidc' = 'github',
  providerKey: string = provider,
): void {
  const now = Date.now()
  test.raw.prepare(
    `INSERT INTO auth_identities (
       id, user_id, provider, provider_key, provider_subject, issuer,
       metadata_json, verified_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, 'alice', ?, ?, ?, ?,
       '{"display_name":"Octo Cat","login":"octocat"}', ?, ?, ?)`,
  ).run(
    `identity-alice-${provider}`,
    provider,
    providerKey,
    subject,
    provider === 'oidc' ? providerKey : null,
    now,
    now,
    now,
  )
}

async function seedUserSession(test: Fixture, id: string, email: string): Promise<string> {
  const now = Date.now()
  test.raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, password_credential, auth_version,
       password_changed_at_ms, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, 'user', 'active', 'password', 1, ?, ?, ?)`,
  ).run(id, email, id, now, now, now)
  const access = createOpaqueToken('access')
  const refresh = createOpaqueToken('refresh')
  test.raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms, user_agent
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'test-agent')`,
  ).run(
    `session-${id}`,
    `family-${id}`,
    id,
    await tokenDigest(access, PEPPER, 'access'),
    await tokenDigest(refresh, PEPPER, 'refresh'),
    now,
    now + DAY_MS,
    now + 30 * DAY_MS,
  )
  return `Bearer ${access}`
}

function githubUpstream(subject: string, displayName: string, email = 'linked@example.test') {
  return vi.fn(async (request: RequestInfo | URL) => {
    const url = String(request)
    if (url === 'https://github.test/token') {
      return Response.json({ access_token: 'provider-access', token_type: 'bearer' })
    }
    if (url === 'https://github.test/user') {
      return Response.json({ id: subject, login: 'linked-user', name: displayName })
    }
    if (url === 'https://github.test/emails') {
      return Response.json([{ email, primary: true, verified: true }])
    }
    throw new Error(`unexpected external URL ${url}`)
  })
}

function responseCookie(response: Response, name: string): string {
  const header = response.headers.get('set-cookie') ?? ''
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`).exec(header)
  if (match === null) throw new Error(`missing ${name} cookie in ${header}`)
  return `${name}=${match[1]}`
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function signJwt(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT', kid: 'signing-key' })
  const payload = base64UrlJson(claims)
  const input = `${header}.${payload}`
  const signature = new Uint8Array(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(input),
  ))
  let binary = ''
  for (const byte of signature) binary += String.fromCharCode(byte)
  return `${input}.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`
}

function base64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
