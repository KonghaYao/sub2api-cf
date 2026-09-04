import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPasskeyHandlers, type PasskeyConfiguration } from '../../src/auth/passkeys'
import { hashPassword } from '../../src/auth/password'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const NOW = Date.parse('2026-09-05T01:00:00.000Z')
const PASSWORD = 'correct horse battery staple'
const PEPPER = 'passkey-test-api-key-pepper-32-byte-value'
const RP_ID = 'passkeys.example.test'
const ORIGIN = `https://${RP_ID}`
const CONFIG: PasskeyConfiguration = {
  enabled: true,
  rpId: RP_ID,
  rpOrigins: [ORIGIN],
  rpDisplayName: 'Sub2API Test',
}

interface Fixture {
  raw: any
  env: Env
  app: Hono<{ Bindings: Env }>
  authorization: Record<'alice' | 'bob', string>
}

interface RegistrationOptions {
  challenge: string
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: Array<{ type: string; alg: number }>
}

interface LoginOptions {
  challenge: string
  rpId: string
  userVerification: string
}

interface TestAuthenticator {
  credentialId: string
  registrationCredential(challenge: string, origin?: string): Promise<Record<string, unknown>>
  assertionCredential(
    challenge: string,
    userHandle: string,
    counter: number,
    origin?: string,
    rpId?: string,
  ): Promise<Record<string, unknown>>
}

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const credential = await hashPassword(PASSWORD)
  for (const [id, email] of [
    ['alice', 'alice@example.test'],
    ['bob', 'bob@example.test'],
  ] as const) {
    raw.prepare(
      `INSERT INTO users (
         id, email, display_name, role, status, auth_version, password_credential,
         password_changed_at_ms, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 'user', 'active', 1, ?, ?, ?, ?)`,
    ).run(id, email, id, credential, NOW, NOW, NOW)
  }
  const authorization = {} as Fixture['authorization']
  for (const userId of ['alice', 'bob'] as const) {
    const accessToken = createOpaqueToken('access')
    const refreshToken = createOpaqueToken('refresh')
    authorization[userId] = `Bearer ${accessToken}`
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms, user_agent
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'passkey-fixture')`,
    ).run(
      `${userId}-session`, `${userId}-family`, userId,
      await tokenDigest(accessToken, PEPPER, 'access'),
      await tokenDigest(refreshToken, PEPPER, 'refresh'),
      NOW, NOW + 86_400_000, NOW + 2_592_000_000,
    )
  }
  const env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: PEPPER,
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: d1,
    CONFIG_KV: { get: async () => null } as unknown as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: { send: async () => undefined } as unknown as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  } satisfies Env
  const app = new Hono<{ Bindings: Env }>()
  const passkeys = createPasskeyHandlers(() => CONFIG)
  app.post('/api/v1/auth/passkey/login/begin', passkeys.beginLogin)
  app.post('/api/v1/auth/passkey/login/finish', passkeys.finishLogin)
  app.post('/api/v1/user/passkeys/register/begin', passkeys.beginRegistration)
  app.post('/api/v1/user/passkeys/register/finish', passkeys.finishRegistration)
  app.get('/api/v1/user/passkeys', passkeys.list)
  app.patch('/api/v1/user/passkeys/:id', passkeys.rename)
  app.delete('/api/v1/user/passkeys/:id', passkeys.remove)
  return {
    raw,
    env,
    app,
    authorization,
  }
}

async function api(
  test: Fixture,
  path: string,
  options: {
    user?: 'alice' | 'bob'
    body?: Record<string, unknown>
    method?: string
    authorization?: string
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (options.authorization !== undefined) headers.authorization = options.authorization
  else if (options.user !== undefined) headers.authorization = test.authorization[options.user]
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return test.app.request(path, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }, test.env)
}

async function responseData<T>(response: Response): Promise<T> {
  return (await response.json() as { data: T }).data
}

async function beginRegistration(test: Fixture, user: 'alice' | 'bob' = 'alice') {
  const response = await api(test, '/api/v1/user/passkeys/register/begin', {
    user,
    body: { password: PASSWORD },
  })
  expect(response.status).toBe(200)
  return responseData<{
    session_token: string
    options: { publicKey: RegistrationOptions }
  }>(response)
}

async function registerCredential(
  test: Fixture,
  authenticator: TestAuthenticator,
  user: 'alice' | 'bob' = 'alice',
): Promise<{ id: number; userHandle: string }> {
  const begin = await beginRegistration(test, user)
  const response = await api(test, '/api/v1/user/passkeys/register/finish', {
    user,
    body: {
      session_token: begin.session_token,
      name: 'Test passkey',
      credential: await authenticator.registrationCredential(begin.options.publicKey.challenge),
    },
  })
  expect(response.status).toBe(200)
  const registered = await responseData<{ id: number }>(response)
  return { id: registered.id, userHandle: begin.options.publicKey.user.id }
}

async function beginLogin(test: Fixture): Promise<{
  session_token: string
  options: { publicKey: LoginOptions }
}> {
  const response = await api(test, '/api/v1/auth/passkey/login/begin', { method: 'POST' })
  expect(response.status).toBe(200)
  return responseData(response)
}

describe('passkey Worker HTTP contract', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }))
  afterEach(() => vi.useRealTimers())

  it('registers an owner-bound credential and consumes its challenge once', async () => {
    const test = await fixture()
    const begin = await beginRegistration(test)
    expect(begin.session_token).toMatch(/^spk_v1_[A-Za-z0-9_-]{43}$/)
    expect(begin.options.publicKey).toMatchObject({
      challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      rp: { id: RP_ID, name: 'Sub2API Test' },
      user: { name: 'alice@example.test', displayName: 'alice' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    })
    const authenticator = await createTestAuthenticator()
    const credential = await authenticator.registrationCredential(
      begin.options.publicKey.challenge,
    )

    const wrongOwner = await api(test, '/api/v1/user/passkeys/register/finish', {
      user: 'bob',
      body: { session_token: begin.session_token, name: 'Work laptop', credential },
    })
    expect(wrongOwner.status).toBe(400)
    await expect(wrongOwner.json()).resolves.toMatchObject({ code: 'PASSKEY_SESSION_INVALID' })

    const finish = await api(test, '/api/v1/user/passkeys/register/finish', {
      user: 'alice',
      body: { session_token: begin.session_token, name: '  Work laptop  ', credential },
    })
    expect(finish.status).toBe(200)
    await expect(responseData(finish)).resolves.toMatchObject({
      id: expect.any(Number),
      name: 'Work laptop',
      backup: true,
      created_at: new Date(NOW).toISOString(),
    })
    const listed = await api(test, '/api/v1/user/passkeys', { user: 'alice' })
    await expect(responseData(listed)).resolves.toEqual([
      expect.objectContaining({ name: 'Work laptop', backup: true }),
    ])
    await expect(responseData(await api(test, '/api/v1/user/passkeys', {
      user: 'bob',
    }))).resolves.toEqual([])

    const replay = await api(test, '/api/v1/user/passkeys/register/finish', {
      user: 'alice',
      body: { session_token: begin.session_token, name: 'Replay', credential },
    })
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({ code: 'PASSKEY_SESSION_INVALID' })
  })

  it('requires the current password before creating enrollment state', async () => {
    const test = await fixture()
    const missing = await api(test, '/api/v1/user/passkeys/register/begin', {
      user: 'alice', body: {},
    })
    expect(missing.status).toBe(400)
    await expect(missing.json()).resolves.toMatchObject({ code: 'PASSWORD_REQUIRED' })
    const incorrect = await api(test, '/api/v1/user/passkeys/register/begin', {
      user: 'alice', body: { password: 'wrong password' },
    })
    expect(incorrect.status).toBe(400)
    await expect(incorrect.json()).resolves.toMatchObject({ code: 'PASSWORD_INCORRECT' })
    expect(test.raw.prepare('SELECT COUNT(*) AS count FROM passkey_user_handles').get()).toEqual({
      count: 0,
    })
    expect(test.raw.prepare('SELECT COUNT(*) AS count FROM passkey_challenges').get()).toEqual({
      count: 0,
    })
  })

  it('does not persist a credential when account security changes during verification', async () => {
    const test = await fixture()
    const begin = await beginRegistration(test)
    const authenticator = await createTestAuthenticator()
    const credential = await authenticator.registrationCredential(
      begin.options.publicKey.challenge,
    )
    const originalImportKey = crypto.subtle.importKey.bind(crypto.subtle)
    let securityChanged = false
    vi.spyOn(crypto.subtle, 'importKey').mockImplementation(async (
      ...args: Parameters<SubtleCrypto['importKey']>
    ) => {
      const algorithm = args[2]
      if (
        !securityChanged && typeof algorithm === 'object' && algorithm !== null &&
        algorithm.name === 'ECDSA'
      ) {
        securityChanged = true
        test.raw.prepare(
          `UPDATE users SET auth_version = auth_version + 1, updated_at_ms = ? WHERE id = 'alice'`,
        ).run(NOW)
        test.raw.prepare(
          `UPDATE user_sessions
              SET revoked_at_ms = ?, revoke_reason = 'password_changed'
            WHERE id = 'alice-session'`,
        ).run(NOW)
      }
      return Reflect.apply(originalImportKey, undefined, args) as Promise<CryptoKey>
    })

    const finish = await api(test, '/api/v1/user/passkeys/register/finish', {
      user: 'alice',
      body: { session_token: begin.session_token, name: 'Racing passkey', credential },
    })

    expect(securityChanged).toBe(true)
    expect(finish.status).toBe(400)
    await expect(finish.json()).resolves.toMatchObject({ code: 'PASSKEY_SESSION_INVALID' })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = 'alice'`,
    ).get()).toEqual({ count: 0 })
  })

  it('does not finish an enrollment from before an auth-version change in a replacement session', async () => {
    const test = await fixture()
    const begin = await beginRegistration(test)
    const authenticator = await createTestAuthenticator()
    const accessToken = createOpaqueToken('access')
    const refreshToken = createOpaqueToken('refresh')
    test.raw.prepare(
      `UPDATE users SET auth_version = 2, updated_at_ms = ? WHERE id = 'alice'`,
    ).run(NOW)
    test.raw.prepare(
      `UPDATE user_sessions
          SET revoked_at_ms = ?, revoke_reason = 'password_changed'
        WHERE id = 'alice-session'`,
    ).run(NOW)
    test.raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms, user_agent
       ) VALUES ('alice-replacement', 'alice-replacement-family', 'alice', 2, ?, ?, ?, ?, ?,
                 'passkey-replacement-session')`,
    ).run(
      await tokenDigest(accessToken, PEPPER, 'access'),
      await tokenDigest(refreshToken, PEPPER, 'refresh'),
      NOW,
      NOW + 86_400_000,
      NOW + 2_592_000_000,
    )

    const finish = await api(test, '/api/v1/user/passkeys/register/finish', {
      authorization: `Bearer ${accessToken}`,
      body: {
        session_token: begin.session_token,
        name: 'Stale enrollment',
        credential: await authenticator.registrationCredential(
          begin.options.publicKey.challenge,
        ),
      },
    })

    expect(finish.status).toBe(400)
    await expect(finish.json()).resolves.toMatchObject({ code: 'PASSKEY_SESSION_INVALID' })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = 'alice'`,
    ).get()).toEqual({ count: 0 })
  })

  it('rejects a credential ID already owned by another account', async () => {
    const test = await fixture()
    const authenticator = await createTestAuthenticator()
    await registerCredential(test, authenticator, 'alice')
    const bob = await beginRegistration(test, 'bob')
    const duplicate = await api(test, '/api/v1/user/passkeys/register/finish', {
      user: 'bob',
      body: {
        session_token: bob.session_token,
        name: 'Duplicate',
        credential: await authenticator.registrationCredential(bob.options.publicKey.challenge),
      },
    })
    expect(duplicate.status).toBe(409)
    await expect(duplicate.json()).resolves.toMatchObject({ code: 'PASSKEY_ALREADY_EXISTS' })
    await expect(responseData(await api(test, '/api/v1/user/passkeys', {
      user: 'bob',
    }))).resolves.toEqual([])
  })

  it('logs in with a discoverable credential and rejects origin, replay, and stale counters', async () => {
    const test = await fixture()
    const authenticator = await createTestAuthenticator()
    const registered = await registerCredential(test, authenticator)

    const wrongOriginBegin = await beginLogin(test)
    const wrongOrigin = await api(test, '/api/v1/auth/passkey/login/finish', {
      body: {
        session_token: wrongOriginBegin.session_token,
        credential: await authenticator.assertionCredential(
          wrongOriginBegin.options.publicKey.challenge,
          registered.userHandle,
          1,
          'https://evil.example.test',
        ),
      },
    })
    expect(wrongOrigin.status).toBe(401)
    await expect(wrongOrigin.json()).resolves.toMatchObject({
      code: 'PASSKEY_VERIFICATION_FAILED',
    })

    const badSignatureBegin = await beginLogin(test)
    const badSignature = await authenticator.assertionCredential(
      badSignatureBegin.options.publicKey.challenge,
      registered.userHandle,
      1,
    )
    const badSignatureResponse = badSignature.response as Record<string, unknown>
    const encodedSignature = badSignatureResponse.signature as string
    badSignatureResponse.signature = `${encodedSignature[0] === 'A' ? 'B' : 'A'}${encodedSignature.slice(1)}`
    const rejectedSignature = await api(test, '/api/v1/auth/passkey/login/finish', {
      body: { session_token: badSignatureBegin.session_token, credential: badSignature },
    })
    expect(rejectedSignature.status).toBe(401)
    await expect(rejectedSignature.json()).resolves.toMatchObject({
      code: 'PASSKEY_VERIFICATION_FAILED',
    })

    const wrongRpBegin = await beginLogin(test)
    const wrongRp = await api(test, '/api/v1/auth/passkey/login/finish', {
      body: {
        session_token: wrongRpBegin.session_token,
        credential: await authenticator.assertionCredential(
          wrongRpBegin.options.publicKey.challenge,
          registered.userHandle,
          1,
          ORIGIN,
          'other.example.test',
        ),
      },
    })
    expect(wrongRp.status).toBe(401)
    await expect(wrongRp.json()).resolves.toMatchObject({ code: 'PASSKEY_VERIFICATION_FAILED' })

    const successfulBegin = await beginLogin(test)
    const firstAssertion = await authenticator.assertionCredential(
      successfulBegin.options.publicKey.challenge,
      registered.userHandle,
      1,
    )
    const login = await api(test, '/api/v1/auth/passkey/login/finish', {
      body: { session_token: successfulBegin.session_token, credential: firstAssertion },
    })
    expect(login.status).toBe(200)
    const authenticated = await responseData<{
      access_token: string
      refresh_token: string
      user: { id: string }
    }>(login)
    expect(authenticated).toMatchObject({
      access_token: expect.stringMatching(/^sat_v1_/),
      refresh_token: expect.stringMatching(/^srt_v1_/),
      user: { id: 'alice' },
    })
    expect((await api(test, '/api/v1/user/passkeys', {
      authorization: `Bearer ${authenticated.access_token}`,
    })).status).toBe(200)

    const replay = await api(test, '/api/v1/auth/passkey/login/finish', {
      body: { session_token: successfulBegin.session_token, credential: firstAssertion },
    })
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({ code: 'PASSKEY_SESSION_INVALID' })

    const staleBegin = await beginLogin(test)
    const stale = await api(test, '/api/v1/auth/passkey/login/finish', {
      body: {
        session_token: staleBegin.session_token,
        credential: await authenticator.assertionCredential(
          staleBegin.options.publicKey.challenge,
          registered.userHandle,
          1,
        ),
      },
    })
    expect(stale.status).toBe(401)
    await expect(stale.json()).resolves.toMatchObject({ code: 'PASSKEY_VERIFICATION_FAILED' })
  })

  it('allows only one concurrent assertion to consume a challenge and advance the counter', async () => {
    const test = await fixture()
    const authenticator = await createTestAuthenticator()
    const registered = await registerCredential(test, authenticator)
    const begin = await beginLogin(test)
    const assertion = await authenticator.assertionCredential(
      begin.options.publicKey.challenge,
      registered.userHandle,
      1,
    )

    const responses = await Promise.all([
      api(test, '/api/v1/auth/passkey/login/finish', {
        body: { session_token: begin.session_token, credential: assertion },
      }),
      api(test, '/api/v1/auth/passkey/login/finish', {
        body: { session_token: begin.session_token, credential: assertion },
      }),
    ])
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1)
    expect(responses.filter((response) => response.status !== 200)).toHaveLength(1)
    expect(test.raw.prepare(
      `SELECT sign_count, version FROM passkey_credentials WHERE id = ?`,
    ).get(registered.id)).toEqual({ sign_count: 1, version: 2 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM auth_audit_events
        WHERE event_type = 'auth.login.passkey' AND outcome = 'succeeded'`,
    ).get()).toEqual({ count: 1 })
  })

  it('uses credential CAS across concurrent independent challenges', async () => {
    const test = await fixture()
    const authenticator = await createTestAuthenticator()
    const registered = await registerCredential(test, authenticator)
    const [firstBegin, secondBegin] = await Promise.all([beginLogin(test), beginLogin(test)])
    const [firstAssertion, secondAssertion] = await Promise.all([
      authenticator.assertionCredential(
        firstBegin.options.publicKey.challenge,
        registered.userHandle,
        1,
      ),
      authenticator.assertionCredential(
        secondBegin.options.publicKey.challenge,
        registered.userHandle,
        1,
      ),
    ])
    const responses = await Promise.all([
      api(test, '/api/v1/auth/passkey/login/finish', {
        body: { session_token: firstBegin.session_token, credential: firstAssertion },
      }),
      api(test, '/api/v1/auth/passkey/login/finish', {
        body: { session_token: secondBegin.session_token, credential: secondAssertion },
      }),
    ])
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1)
    expect(responses.filter((response) => response.status === 401)).toHaveLength(1)
    expect(test.raw.prepare(
      `SELECT sign_count, version FROM passkey_credentials WHERE id = ?`,
    ).get(registered.id)).toEqual({ sign_count: 1, version: 2 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM user_sessions WHERE user_id = 'alice'`,
    ).get()).toEqual({ count: 2 })
  })

  it('expires ceremonies and fails closed for disabled or invalid RP configuration', async () => {
    const test = await fixture()
    const authenticator = await createTestAuthenticator()
    const registered = await registerCredential(test, authenticator)
    const expiredBegin = await beginLogin(test)
    vi.advanceTimersByTime(5 * 60_000 + 1)
    const expired = await api(test, '/api/v1/auth/passkey/login/finish', {
      body: {
        session_token: expiredBegin.session_token,
        credential: await authenticator.assertionCredential(
          expiredBegin.options.publicKey.challenge,
          registered.userHandle,
          1,
        ),
      },
    })
    expect(expired.status).toBe(400)
    await expect(expired.json()).resolves.toMatchObject({ code: 'PASSKEY_SESSION_INVALID' })

    const disabledApp = createPasskeyHandlers(async () => ({
      enabled: false,
      rpId: '',
      rpOrigins: [],
    }))
    const disabledRouter = new Hono<{ Bindings: Env }>()
    disabledRouter.post('/disabled', disabledApp.beginLogin)
    disabledRouter.get('/disabled-list', disabledApp.list)
    const disabled = await disabledRouter.request('/disabled', { method: 'POST' }, test.env)
    expect(disabled.status).toBe(403)
    await expect(disabled.json()).resolves.toMatchObject({ code: 'PASSKEY_DISABLED' })
    const disabledList = await disabledRouter.request('/disabled-list', {
      headers: { authorization: test.authorization.alice },
    }, test.env)
    expect(disabledList.status).toBe(200)
    await expect(responseData<Array<unknown>>(disabledList)).resolves.toHaveLength(1)

    const invalidApp = createPasskeyHandlers(async () => ({
      enabled: true,
      rpId: RP_ID,
      rpOrigins: ['https://evil.example.test'],
    }))
    const invalidRouter = new Hono<{ Bindings: Env }>()
    invalidRouter.post('/invalid', invalidApp.beginLogin)
    const invalid = await invalidRouter.request('/invalid', { method: 'POST' }, test.env)
    expect(invalid.status).toBe(503)
    await expect(invalid.json()).resolves.toMatchObject({ code: 'PASSKEY_NOT_CONFIGURED' })
  })

  it('rejects WebAuthn request bodies larger than 64 KiB before ceremony lookup', async () => {
    const test = await fixture()
    const response = await test.app.request('/api/v1/auth/passkey/login/finish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(64 * 1024) }),
    }, test.env)

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({ code: 'request_too_large' })
  })

  it('keeps credential rename and password-gated deletion owner-scoped and concurrent-safe', async () => {
    const test = await fixture()
    const registered = await registerCredential(test, await createTestAuthenticator())

    const crossOwnerRename = await api(test, `/api/v1/user/passkeys/${registered.id}`, {
      user: 'bob', method: 'PATCH', body: { name: 'stolen' },
    })
    expect(crossOwnerRename.status).toBe(404)
    expect((await api(test, `/api/v1/user/passkeys/${registered.id}`, {
      user: 'alice', method: 'PATCH', body: { name: `  ${'密'.repeat(110)}  ` },
    })).status).toBe(200)
    const listed = await responseData<Array<{ id: number; name: string }>>(
      await api(test, '/api/v1/user/passkeys', { user: 'alice' }),
    )
    expect(Array.from(listed[0].name)).toHaveLength(100)

    const wrongPassword = await api(test, `/api/v1/user/passkeys/${registered.id}`, {
      user: 'alice', method: 'DELETE', body: { password: 'wrong password' },
    })
    expect(wrongPassword.status).toBe(400)
    await expect(wrongPassword.json()).resolves.toMatchObject({ code: 'PASSWORD_INCORRECT' })
    const crossOwnerDelete = await api(test, `/api/v1/user/passkeys/${registered.id}`, {
      user: 'bob', method: 'DELETE', body: { password: PASSWORD },
    })
    expect(crossOwnerDelete.status).toBe(404)

    const deletions = await Promise.all([
      api(test, `/api/v1/user/passkeys/${registered.id}`, {
        user: 'alice', method: 'DELETE', body: { password: PASSWORD },
      }),
      api(test, `/api/v1/user/passkeys/${registered.id}`, {
        user: 'alice', method: 'DELETE', body: { password: PASSWORD },
      }),
    ])
    expect(deletions.map((response) => response.status).sort()).toEqual([200, 404])
    await expect(responseData(await api(test, '/api/v1/user/passkeys', {
      user: 'alice',
    }))).resolves.toEqual([])
  })
})

async function createTestAuthenticator(): Promise<TestAuthenticator> {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const credentialIdBytes = crypto.getRandomValues(new Uint8Array(32))
  const credentialId = toBase64Url(credentialIdBytes)
  const coseKey = cbor(new Map<unknown, unknown>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, fromBase64Url(publicJwk.x as string)],
    [-3, fromBase64Url(publicJwk.y as string)],
  ]))

  return {
    credentialId,
    async registrationCredential(challenge, origin = ORIGIN) {
      const rpHash = new Uint8Array(await crypto.subtle.digest(
        'SHA-256',
        ownedBuffer(utf8(RP_ID)),
      ))
      const authData = join(
        rpHash,
        new Uint8Array([0x5d]),
        uint32(0),
        new Uint8Array(16),
        uint16(credentialIdBytes.byteLength),
        credentialIdBytes,
        coseKey,
      )
      const attestationObject = cbor(new Map<unknown, unknown>([
        ['fmt', 'none'],
        ['authData', authData],
        ['attStmt', new Map()],
      ]))
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        clientExtensionResults: { credProps: { rk: true } },
        response: {
          attestationObject: toBase64Url(attestationObject),
          clientDataJSON: toBase64Url(clientData('webauthn.create', challenge, origin)),
          transports: ['internal', 'hybrid'],
        },
      }
    },
    async assertionCredential(challenge, userHandle, counter, origin = ORIGIN, rpId = RP_ID) {
      const authData = join(
        new Uint8Array(await crypto.subtle.digest('SHA-256', ownedBuffer(utf8(rpId)))),
        new Uint8Array([0x1d]),
        uint32(counter),
      )
      const client = clientData('webauthn.get', challenge, origin)
      const clientHash = new Uint8Array(await crypto.subtle.digest(
        'SHA-256',
        ownedBuffer(client),
      ))
      const rawSignature = new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.privateKey,
        ownedBuffer(join(authData, clientHash)),
      ))
      return {
        id: credentialId,
        rawId: credentialId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          authenticatorData: toBase64Url(authData),
          clientDataJSON: toBase64Url(client),
          signature: toBase64Url(rawEcdsaToDer(rawSignature)),
          userHandle,
        },
      }
    },
  }
}

function clientData(type: string, challenge: string, origin: string): Uint8Array {
  return utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
}

function cbor(value: unknown): Uint8Array {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value)
  }
  if (typeof value === 'string') {
    const bytes = utf8(value)
    return join(cborHead(3, bytes.byteLength), bytes)
  }
  if (value instanceof Uint8Array) return join(cborHead(2, value.byteLength), value)
  if (value instanceof Map) {
    const entries = Array.from(value.entries())
    return join(cborHead(5, entries.length), ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)]))
  }
  throw new Error('Unsupported test CBOR value')
}

function cborHead(major: number, value: number): Uint8Array {
  if (value < 24) return new Uint8Array([(major << 5) | value])
  if (value <= 0xff) return new Uint8Array([(major << 5) | 24, value])
  if (value <= 0xffff) return new Uint8Array([(major << 5) | 25, value >>> 8, value])
  return new Uint8Array([
    (major << 5) | 26,
    value >>> 24, value >>> 16, value >>> 8, value,
  ])
}

function rawEcdsaToDer(raw: Uint8Array): Uint8Array {
  const integer = (value: Uint8Array): Uint8Array => {
    let offset = 0
    while (offset < value.length - 1 && value[offset] === 0) offset += 1
    const sliced = value.slice(offset)
    const normalized = (sliced[0] & 0x80) !== 0
      ? join(new Uint8Array([0]), sliced)
      : new Uint8Array(sliced)
    return join(new Uint8Array([0x02, normalized.length]), normalized)
  }
  const r = integer(raw.slice(0, 32))
  const s = integer(raw.slice(32, 64))
  return join(new Uint8Array([0x30, r.length + s.length]), r, s)
}

function uint16(value: number): Uint8Array {
  return new Uint8Array([value >>> 8, value])
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([value >>> 24, value >>> 16, value >>> 8, value])
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function join(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.byteLength
  }
  return result
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const result = new Uint8Array(value.byteLength)
  result.set(value)
  return result.buffer
}

function toBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value: string): Uint8Array {
  const binary = atob(`${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - value.length % 4) % 4)}`)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
