import { prepareWechatVariants } from '../../src/auth/wechat-variants'
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
import { commercialCodeDigest } from '../../src/commercial/registration'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
import { getUserProfile } from '../../src/user/profile'
import { getMyPlatformQuotas } from '../../src/user/platform-quotas'
import { listUserSubscriptions } from '../../src/user/subscriptions'

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

  it('grants OAuth first-bind defaults once, extends an existing subscription, and adjusts UserStateDO idempotently', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO "groups" (
         id, name, platform, group_type, daily_quota_micros,
         weekly_quota_micros, monthly_quota_micros, created_at_ms, updated_at_ms
       ) VALUES ('github-welcome', 'GitHub welcome', 'openai', 'subscription',
                 1000000, 5000000, 9000000, ?, ?)`,
    ).run(now, now)
    test.raw.prepare(
      `INSERT INTO user_subscriptions (
         id, user_id, group_id, status, starts_at_ms, expires_at_ms,
         daily_used_micros, weekly_used_micros, monthly_used_micros,
         source_type, source_id, created_at_ms, updated_at_ms
       ) VALUES ('existing-sub', 'alice', 'github-welcome', 'active', ?, ?,
                 10, 20, 30, 'admin', 'seed', ?, ?)`,
    ).run(now - DAY_MS, now + 5 * DAY_MS, now, now)
    test.raw.prepare(
      `UPDATE auth_source_defaults
          SET balance_micros = 12500000, concurrency = 3, grant_on_first_bind = 1
        WHERE source = 'github'`,
    ).run()
    test.raw.prepare(
      `INSERT INTO auth_source_default_subscriptions (source, group_id, validity_days)
       VALUES ('github', 'github-welcome', 30)`,
    ).run()
    test.raw.prepare(
      `INSERT INTO auth_source_default_platform_quotas (
         source, platform, daily_limit_micros, weekly_limit_micros, monthly_limit_micros
       ) VALUES ('github', 'openai', 2000000, NULL, 10000000)`,
    ).run()
    const userState = grantUserStateNamespace('alice', 0)
    test.env.USER_STATE = userState.namespace
    test.env.SUBSCRIPTION_STATE = successfulStateNamespace()

    const first = await linkGithub(test, 'grant-subject-one', 'First Link')
    expect(first.status).toBe(302)
    expect(first.headers.get('location')).toBe('/profile?oauth_bound=github')

    const profile = await test.app.request('/api/v1/user/profile', {
      headers: { authorization: test.authorization },
    }, test.env)
    await expect(profile.json()).resolves.toMatchObject({
      data: { balance: 12.5, concurrency: 8 },
    })
    const subscriptions = await test.app.request('/api/v1/subscriptions', {
      headers: { authorization: test.authorization },
    }, test.env)
    await expect(subscriptions.json()).resolves.toMatchObject({
      data: [{
        id: 'existing-sub',
        group_id: 'github-welcome',
        status: 'active',
      }],
    })
    const extended = test.raw.prepare(
      "SELECT expires_at_ms, daily_used_micros FROM user_subscriptions WHERE id = 'existing-sub'",
    ).get() as { expires_at_ms: number; daily_used_micros: number }
    expect(extended.expires_at_ms).toBe(now + 35 * DAY_MS)
    expect(extended.daily_used_micros).toBe(10)

    const second = await linkGithub(test, 'grant-subject-two', 'Second Link')
    expect(second.headers.get('location')).toBe('/profile?oauth_bound=github')
    expect(userState.adjustments).toHaveLength(1)
    expect(test.raw.prepare(
      `SELECT balance_micros, concurrency FROM users WHERE id = 'alice'`,
    ).get()).toEqual({ balance_micros: 12_500_000, concurrency: 8 })
    expect(test.raw.prepare(
      "SELECT expires_at_ms FROM user_subscriptions WHERE id = 'existing-sub'",
    ).get()).toEqual({ expires_at_ms: now + 35 * DAY_MS })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM auth_source_entitlement_grants
        WHERE user_id = 'alice' AND source = 'github' AND reason = 'first_bind'`,
    ).get()).toEqual({ count: 1 })
  })

  it('arbitrates concurrent first binds for the same source without duplicating entitlements', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    test.raw.prepare(
      `UPDATE auth_source_defaults
          SET balance_micros = 1000000, concurrency = 2, grant_on_first_bind = 1
        WHERE source = 'github'`,
    ).run()
    const userState = grantUserStateNamespace('alice', 0)
    test.env.USER_STATE = userState.namespace
    const firstStart = await startGithubLink(test)
    const secondStart = await startGithubLink(test)
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request)
      if (url === 'https://github.test/token') {
        const code = new URLSearchParams(String(init?.body)).get('code')!
        return Response.json({ access_token: `access-${code}`, token_type: 'bearer' })
      }
      const authorization = new Headers(init?.headers).get('authorization') ?? ''
      const suffix = authorization.endsWith('first') ? 'first' : 'second'
      if (url === 'https://github.test/user') {
        return Response.json({ id: `concurrent-${suffix}`, login: suffix, name: suffix })
      }
      if (url === 'https://github.test/emails') {
        return Response.json([{ email: `${suffix}@example.test`, primary: true, verified: true }])
      }
      throw new Error(`unexpected external URL ${url}`)
    }))

    const responses = await Promise.all([
      finishGithubLink(test, firstStart, 'first'),
      finishGithubLink(test, secondStart, 'second'),
    ])

    expect(responses.map((response) => response.headers.get('location')))
      .toEqual(['/profile?oauth_bound=github', '/profile?oauth_bound=github'])
    expect(userState.adjustments).toHaveLength(1)
    expect(test.raw.prepare(
      `SELECT balance_micros, concurrency FROM users WHERE id = 'alice'`,
    ).get()).toEqual({ balance_micros: 1_000_000, concurrency: 7 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM auth_source_entitlement_grants
        WHERE user_id = 'alice' AND source = 'github' AND reason = 'first_bind'`,
    ).get()).toEqual({ count: 1 })
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

  it.each(['client_secret_basic', 'none'])('consumes OIDC %s, claim paths, and verified-email policy without ID-token validation', async (method) => {
    const test = await fixture()
    await seedProvider(test, 'oidc')
    seedIdentity(test, 'mapped-subject', 'oidc', 'https://oidc.test')
    test.raw.prepare(`UPDATE oauth_providers SET advanced_json = ? WHERE provider = 'oidc'`).run(JSON.stringify({ oidc_connect_validate_id_token: false, oidc_connect_token_auth_method: method, oidc_connect_userinfo_id_path: 'account.id', oidc_connect_userinfo_email_path: 'account.email', oidc_connect_userinfo_username_path: 'account.name', oidc_connect_require_email_verified: true }))
    let verified = false
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/token')) {
        const form = new URLSearchParams(String(init?.body))
        expect(form.has('client_secret')).toBe(false)
        expect(new Headers(init?.headers).get('authorization')?.startsWith('Basic ') ?? false).toBe(method === 'client_secret_basic')
        return Response.json({ access_token: 'access' })
      }
      return Response.json({ account: { id: 'mapped-subject', email: 'alice@example.test', name: 'Mapped name' }, email_verified: verified })
    })
    vi.stubGlobal('fetch', fetcher)
    for (const expected of ['error=oidc_email_unverified', '#access_token=sat_v1_']) {
      const started = await test.app.request('/api/v1/auth/oauth/oidc/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, test.env)
      const authorize = new URL((await started.json() as { data: { authorize_url: string } }).data.authorize_url)
      const result = await test.app.request(`/api/v1/auth/oauth/oidc/callback?code=code&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`, { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } }, test.env)
      expect(result.headers.get('location')).toContain(expected)
      verified = true
    }
    expect(fetcher.mock.calls.every(([url]) => !String(url).endsWith('/jwks'))).toBe(true)
  })

  it.each(['RS256', 'PS256', 'ES256'])('accepts OIDC only after %s signature, issuer, audience, nonce, and userinfo subject validation', async (alg) => {
    const test = await fixture()
    await seedProvider(test, 'oidc')
    seedIdentity(test, 'oidc-subject', 'oidc', 'https://oidc.test')
    const keyPair = await crypto.subtle.generateKey(
      alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: alg === 'PS256' ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
    Object.assign(publicJwk, { kid: 'signing-key', alg, use: 'sig' })
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

  it('requires local email verification for forced third-party signup and consumes pending state once', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    const settings = { registration_enabled: true, force_email_on_third_party_signup: true, email_verification_enabled: false }
    test.raw.prepare("UPDATE system_settings SET public_json = ? WHERE id='global'").run(JSON.stringify(settings))
    test.env.CONFIG_KV = { get: async () => settings } as unknown as KVNamespace
    test.env.AUTH_RATE_LIMIT = { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({ schema_version: 1, allowed: true, recorded: true }) }) } as unknown as DurableObjectNamespace
    test.env.EMAIL_DELIVERY = { fetch: async () => new Response(null, { status: 202 }) } as unknown as Fetcher
    const events: any[] = []
    test.env.EVENTS_QUEUE = { send: async (event: unknown) => { events.push(event) } } as unknown as Queue
    const started = await test.app.request('/api/v1/auth/oauth/github/start', { method: 'POST' }, test.env)
    const authorize = new URL((await started.json() as any).data.authorize_url)
    const browser = responseCookie(started, 'sub2api_oauth_browser')
    vi.stubGlobal('fetch', githubUpstream('pending-subject', 'Pending Person', 'provider@example.test'))
    const callback = await test.app.request(`/api/v1/auth/oauth/github/callback?code=register&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`, { headers: { cookie: browser } }, test.env)
    expect(callback.headers.get('location')).toBe('/auth/oauth/complete')
    expect(test.raw.prepare("SELECT COUNT(*) AS n FROM auth_identities WHERE provider='github'").get().n).toBe(0)
    const cookie = `${browser}; ${responseCookie(callback, 'sub2api_oauth_pending')}`
    const post = (path: string, body: unknown, session = cookie) => test.app.request(`/api/v1/auth/oauth/pending/${path}`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json' }, body: JSON.stringify(body) }, test.env)
    expect((await post('exchange', {}, responseCookie(callback, 'sub2api_oauth_pending'))).status).toBe(401)
    expect((await post('exchange', {})).status).toBe(200)
    const sent = await post('send-verify-code', { email: 'local@example.test' })
    expect(sent.status, await sent.clone().text()).toBe(200)
    expect(events).toHaveLength(1)
    const body = { email: 'local@example.test', password: 'Strong-local-password-789', verify_code: events[0].payload.token }
    expect((await post('create-account', { ...body, verify_code: '000000' })).status).toBe(400)
    const created = await post('create-account', body)
    expect(created.status, await created.clone().text()).toBe(200)
    expect((await created.json() as any).data.access_token).toMatch(/^sat_v1_/)
    expect(test.raw.prepare("SELECT email_verified_at_ms,password_credential FROM users WHERE email='local@example.test'").get()).toMatchObject({ email_verified_at_ms: expect.any(Number), password_credential: expect.any(String) })
    expect((await post('create-account', body)).status).toBe(401)
  })

  it('atomically registers a new verified provider identity when public registration is enabled', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    test.raw.prepare(
      `UPDATE system_settings
          SET public_json = json_set(public_json, '$.registration_enabled', json('true'))
        WHERE id = 'global'`,
    ).run()
    test.raw.prepare(
      `UPDATE auth_source_defaults
          SET balance_micros = 3500000, concurrency = 9, grant_on_signup = 1
        WHERE source = 'github'`,
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
    const callbackLocation = new URL(callback.headers.get('location')!, 'https://worker.test')
    const accessToken = new URLSearchParams(callbackLocation.hash.slice(1)).get('access_token')!
    const profile = await test.app.request('/api/v1/user/profile', {
      headers: { authorization: `Bearer ${accessToken}` },
    }, test.env)
    await expect(profile.json()).resolves.toMatchObject({
      data: { balance: 3.5, concurrency: 9 },
    })
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

  it('keeps commercial codes encrypted across OAuth and consumes them with the new user transaction', async () => {
    const test = await fixture()
    await seedProvider(test, 'github')
    const now = Date.now()
    const publicSettings = {
      registration_enabled: true,
      promo_code_enabled: true,
      invitation_code_enabled: true,
      affiliate_enabled: true,
    }
    test.raw.prepare(
      `UPDATE system_settings SET public_json = ? WHERE id = 'global'`,
    ).run(JSON.stringify(publicSettings))
    test.env.CONFIG_KV = {
      get: vi.fn(async () => publicSettings),
    } as unknown as KVNamespace

    const promoSecret = await encryptCredential({ api_key: 'PROMO-2026' }, MASTER_KEY, 'test-promo')
    const inviteSecret = await encryptCredential({ api_key: 'INVITE-2026' }, MASTER_KEY, 'test-invite')
    const affiliateSecret = await encryptCredential({ api_key: 'ALICE-CODE' }, MASTER_KEY, 'test-affiliate')
    test.raw.prepare(
      `INSERT INTO promotion_codes (
         id, code_hash, code_prefix, secret_key_version, secret_nonce_b64,
         secret_ciphertext_b64, bonus_micros, max_uses, created_at_ms, updated_at_ms
       ) VALUES ('promo-oauth', ?, 'PROMO', 1, ?, ?, 2500000, 1, ?, ?)`,
    ).run(
      await commercialCodeDigest('promotion', 'PROMO-2026', PEPPER),
      promoSecret.nonce_b64,
      promoSecret.ciphertext_b64,
      now,
      now,
    )
    test.raw.prepare(
      `INSERT INTO invitation_codes (
         id, code_hash, code_prefix, secret_key_version, secret_nonce_b64,
         secret_ciphertext_b64, max_uses, created_at_ms, updated_at_ms
       ) VALUES ('invite-oauth', ?, 'INVITE', 1, ?, ?, 1, ?, ?)`,
    ).run(
      await commercialCodeDigest('invitation', 'INVITE-2026', PEPPER),
      inviteSecret.nonce_b64,
      inviteSecret.ciphertext_b64,
      now,
      now,
    )
    test.raw.prepare(
      `INSERT INTO affiliate_profiles (
         user_id, code_hash, code_prefix, code_key_version, code_nonce_b64,
         code_ciphertext_b64, created_at_ms, updated_at_ms
       ) VALUES ('alice', ?, 'ALICE', 1, ?, ?, ?, ?)`,
    ).run(
      await commercialCodeDigest('affiliate', 'ALICE-CODE', PEPPER),
      affiliateSecret.nonce_b64,
      affiliateSecret.ciphertext_b64,
      now,
      now,
    )
    test.raw.prepare(
      `INSERT INTO platform_quota_defaults (
         platform, weekly_limit_micros, control_version, updated_at_ms
       ) VALUES ('anthropic', 9000000, 1, ?)`,
    ).run(now)
    test.raw.prepare(
      `UPDATE platform_quota_defaults_control
          SET control_version = 1, updated_at_ms = ? WHERE singleton = 1`,
    ).run(now)

    const started = await test.app.request(
      '/api/v1/auth/oauth/github/start?promo_code=PROMO-2026&invitation_code=INVITE-2026&aff_code=ALICE-CODE',
      { method: 'POST' },
      test.env,
    )
    expect(started.status).toBe(200)
    const authorize = new URL((await started.json() as any).data.authorize_url)
    const storedFlow = test.raw.prepare(
      `SELECT commercial_key_version, commercial_ciphertext_b64 FROM oauth_flows
        WHERE provider = 'github' ORDER BY created_at_ms DESC LIMIT 1`,
    ).get() as { commercial_key_version: number; commercial_ciphertext_b64: string }
    expect(storedFlow.commercial_key_version).toBe(1)
    expect(storedFlow.commercial_ciphertext_b64).not.toContain('PROMO-2026')
    expect(JSON.stringify(storedFlow)).not.toContain('INVITE-2026')
    expect(JSON.stringify(storedFlow)).not.toContain('ALICE-CODE')

    vi.stubGlobal('fetch', githubUpstream('commercial-oauth-subject', 'Commercial OAuth', 'commercial@example.test'))
    const callback = await test.app.request(
      `/api/v1/auth/oauth/github/callback?code=commercial&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`,
      { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } },
      test.env,
    )

    expect(callback.headers.get('location')).toMatch(/^\/auth\/oauth\/callback#access_token=sat_v1_/)
    expect(test.raw.prepare(
      `SELECT balance_micros FROM users WHERE email = 'commercial@example.test'`,
    ).get()).toEqual({ balance_micros: 2_500_000 })
    expect(test.raw.prepare(
      `SELECT p.used_count AS promo_uses, i.used_count AS invitation_uses
         FROM promotion_codes p CROSS JOIN invitation_codes i
        WHERE p.id = 'promo-oauth' AND i.id = 'invite-oauth'`,
    ).get()).toEqual({ promo_uses: 1, invitation_uses: 1 })
    expect(test.raw.prepare(
      `SELECT inviter_user_id FROM affiliate_referrals referral
         JOIN users user ON user.id = referral.invitee_user_id
        WHERE user.email = 'commercial@example.test'`,
    ).get()).toEqual({ inviter_user_id: 'alice' })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM user_platform_quotas quota
         JOIN users user ON user.id = quota.user_id
        WHERE user.email = 'commercial@example.test'`,
    ).get()).toEqual({ total: 1 })
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

    expect(callback.headers.get('location')).toContain('#access_token=')
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM users WHERE email = 'new-linuxdo@example.test'`,
    ).get()).toEqual({ total: 0 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM auth_identities WHERE provider = 'linuxdo'`,
    ).get()).toEqual({ total: 1 })
    expect(test.raw.prepare("SELECT email_verified_at_ms FROM users WHERE email LIKE 'linuxdo-%@oauth.invalid'").get()).toEqual({ email_verified_at_ms: null })
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

  it('checks real DingTalk app membership before registration bypass and syncs corporate attributes', async () => {
    const test = await fixture()
    await seedProvider(test, 'dingtalk')
    test.raw.prepare("UPDATE oauth_providers SET advanced_json=? WHERE provider='dingtalk'").run(JSON.stringify({ dingtalk_connect_corp_restriction_policy: 'internal_only', dingtalk_connect_bypass_registration: true, dingtalk_connect_sync_corp_email: true, dingtalk_connect_sync_display_name: true, dingtalk_connect_sync_dept: true }))
    let member = false
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request))
      if (url.pathname === '/token') return Response.json({ accessToken: JSON.parse(String(init?.body)).appKey ? 'app-token' : 'user-token' })
      if (url.pathname === '/user') return Response.json({ unionId: 'staff-union', nick: 'Personal Nickname' })
      expect(url.searchParams.get('access_token')).toBe('app-token')
      if (url.pathname.endsWith('/getbyunionid')) return Response.json(member ? { errcode: 0, result: { userid: 'employee' } } : { errcode: 60011 })
      if (url.pathname.endsWith('/user/get')) return Response.json({ errcode: 0, result: { active: true, name: 'Corporate Name', email: 'staff@corp.test', dept_id_list: [7] } })
      return Response.json({ errcode: 0, result: { name: 'Engineering', parent_id: 0 } })
    }))
    const login = async () => {
      const started = await test.app.request('/api/v1/auth/oauth/dingtalk/start', { method: 'POST' }, test.env)
      const authorize = new URL((await started.json() as any).data.authorize_url)
      return test.app.request(`/api/v1/auth/oauth/dingtalk/callback?code=staff&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`, { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } }, test.env)
    }
    expect((await login()).headers.get('location')).toContain('error=dingtalk_corp_rejected')
    expect(test.raw.prepare("SELECT COUNT(*) AS n FROM auth_identities WHERE provider='dingtalk'").get().n).toBe(0)
    member = true
    expect((await login()).headers.get('location')).toContain('#access_token=')
    const user = test.raw.prepare("SELECT u.id,u.display_name FROM users u JOIN auth_identities i ON i.user_id=u.id WHERE i.provider='dingtalk'").get()
    expect(user.display_name).toBe('Corporate Name')
    expect(test.raw.prepare('SELECT d.key,v.value FROM user_attribute_values v JOIN user_attribute_definitions d ON d.id=v.attribute_id WHERE user_id=? ORDER BY d.key').all(user.id)).toEqual([
      { key: 'dingtalk_dept', value: 'Engineering' }, { key: 'dingtalk_email', value: 'staff@corp.test' }, { key: 'dingtalk_name', value: 'Corporate Name' },
    ])
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

  it.each(['mp', 'mobile'] as const)('binds the %s WeChat app to OAuth state and uses its own credential', async mode => {
    const test = await fixture()
    await seedProvider(test, 'wechat')
    seedIdentity(test, 'shared-union', 'wechat')
    const variants = await prepareWechatVariants(test.env, { open: { enabled: true, client_id: 'web-app', client_secret: 'web-secret' }, [mode]: { enabled: true, client_id: `${mode}-app`, client_secret: `${mode}-secret` } })
    await test.env.DB.batch(variants.statements)
    const started = await test.app.request(`/api/v1/auth/oauth/wechat/start?mode=${mode}`, { method: 'POST' }, test.env)
    const authorize = new URL((await started.json() as any).data.authorize_url)
    expect(authorize.searchParams.get('appid')).toBe(`${mode}-app`)
    expect(authorize.searchParams.get('scope')).toBe(mode === 'mp' ? 'snsapi_userinfo' : 'snsapi_login')
    expect(authorize.pathname).toBe(mode === 'mp' ? '/connect/oauth2/authorize' : '/connect/qrconnect')
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(String(request))
      if (url.pathname.endsWith('/access_token')) {
        expect(url.searchParams.get('appid')).toBe(`${mode}-app`)
        expect(url.searchParams.get('secret')).toBe(`${mode}-secret`)
        return Response.json({ access_token: 'wechat-access', openid: 'mode-openid', unionid: 'shared-union' })
      }
      return Response.json({ openid: 'mode-openid', nickname: 'WeChat Person' })
    }))
    const callback = await test.app.request(`/api/v1/auth/oauth/wechat/callback?mode=open&code=variant&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`, { headers: { cookie: responseCookie(started, 'sub2api_oauth_browser') } }, test.env)
    expect(callback.headers.get('location')).toContain('#access_token=')
    expect(test.raw.prepare("SELECT COUNT(*) AS n FROM auth_identities WHERE provider='wechat'").get().n).toBe(1)
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
  app.get('/api/v1/user/profile', getUserProfile)
  app.get('/api/v1/subscriptions', listUserSubscriptions)
  app.get('/api/v1/user/platform-quotas', getMyPlatformQuotas)
  return { app, raw, env, authorization: `Bearer ${access}` }
}

async function linkGithub(test: Fixture, subject: string, name: string): Promise<Response> {
  const started = await startGithubLink(test)
  vi.stubGlobal('fetch', githubUpstream(subject, name))
  return finishGithubLink(test, started, 'link-code')
}

async function startGithubLink(test: Fixture): Promise<{ state: string; cookie: string }> {
  const ticket = await test.app.request('/api/v1/auth/oauth/bind-token', {
    method: 'POST', headers: { authorization: test.authorization },
  }, test.env)
  const started = await test.app.request(
    '/api/v1/auth/oauth/github/bind/start?intent=bind_current_user&redirect=/profile',
    { headers: { cookie: responseCookie(ticket, 'sub2api_oauth_bind') } },
    test.env,
  )
  const authorize = new URL(started.headers.get('location')!)
  return {
    state: authorize.searchParams.get('state')!,
    cookie: responseCookie(started, 'sub2api_oauth_browser'),
  }
}

function finishGithubLink(
  test: Fixture,
  started: { state: string; cookie: string },
  code: string,
): Promise<Response> {
  return Promise.resolve(test.app.request(
    `/api/v1/auth/oauth/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(started.state)}`,
    { headers: { cookie: started.cookie } },
    test.env,
  ))
}

function grantUserStateNamespace(userId: string, initialBalance: number): {
  namespace: DurableObjectNamespace
  adjustments: Array<Record<string, unknown>>
} {
  let balance = initialBalance
  let version = 0
  const seen = new Map<string, { balance: number; version: number }>()
  const adjustments: Array<Record<string, unknown>> = []
  const fetch = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname
    if (path === '/configure') {
      return Response.json({ error: { code: 'user_already_configured' } }, { status: 409 })
    }
    const body = await request.json() as { mutation_id: string; amount_delta_micros: number }
    const prior = seen.get(body.mutation_id)
    if (prior === undefined) {
      balance += body.amount_delta_micros
      version += 1
      seen.set(body.mutation_id, { balance, version })
      adjustments.push(body)
    }
    const state = seen.get(body.mutation_id)!
    return Response.json({
      profile: { user_id: userId, balance_micros: state.balance },
      state_version: state.version,
    })
  })
  return {
    namespace: {
      idFromName: vi.fn((name: string) => ({ toString: () => name })),
      get: vi.fn(() => ({ fetch })),
    } as unknown as DurableObjectNamespace,
    adjustments,
  }
}

function successfulStateNamespace(): DurableObjectNamespace {
  return {
    idFromName: vi.fn((name: string) => ({ toString: () => name })),
    get: vi.fn(() => ({ fetch: vi.fn(async () => Response.json({ ok: true })) })),
  } as unknown as DurableObjectNamespace
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
  const alg = key.algorithm.name === 'ECDSA' ? 'ES256' : key.algorithm.name === 'RSA-PSS' ? 'PS256' : 'RS256'
  const header = base64UrlJson({ alg, typ: 'JWT', kid: 'signing-key' })
  const payload = base64UrlJson(claims)
  const input = `${header}.${payload}`
  const signature = new Uint8Array(await crypto.subtle.sign(
    alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : alg === 'PS256' ? { name: 'RSA-PSS', saltLength: 32 } : 'RSASSA-PKCS1-v1_5',
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
