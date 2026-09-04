import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'session-management-test-pepper-32-bytes-minimum'

interface SessionTokens {
  access: string
  refresh: string
}

interface SessionFixture {
  raw: any
  env: Env
  tokens: Record<string, SessionTokens>
}

async function fixture(): Promise<SessionFixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  for (const [id, email] of [
    ['alice', 'alice@example.test'],
    ['bob', 'bob@example.test'],
  ]) {
    raw.prepare(
      `INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, email, id, now - 60_000, now - 60_000)
  }

  const tokens: Record<string, SessionTokens> = {}
  await seedSession(raw, tokens, {
    id: 'alice-current',
    userId: 'alice',
    familyId: 'family-current',
    createdAtMs: now - 40_000,
    userAgent: 'Current Browser/1.0',
  })
  await seedSession(raw, tokens, {
    id: 'alice-newer',
    userId: 'alice',
    familyId: 'family-newer',
    createdAtMs: now - 10_000,
    userAgent: 'New Browser/2.0',
  })
  await seedSession(raw, tokens, {
    id: 'alice-tie-a',
    userId: 'alice',
    familyId: 'family-tie-a',
    createdAtMs: now - 20_000,
    userAgent: '',
  })
  await seedSession(raw, tokens, {
    id: 'alice-tie-b',
    userId: 'alice',
    familyId: 'family-tie-b',
    createdAtMs: now - 20_000,
    userAgent: '',
  })
  await seedSession(raw, tokens, {
    id: 'alice-revoked',
    userId: 'alice',
    familyId: 'family-revoked',
    createdAtMs: now - 5_000,
    revokedAtMs: now - 1_000,
  })
  await seedSession(raw, tokens, {
    id: 'alice-expired',
    userId: 'alice',
    familyId: 'family-expired',
    createdAtMs: now - 120_000,
    accessExpiresAtMs: now - 90_000,
    refreshExpiresAtMs: now - 60_000,
  })
  await seedSession(raw, tokens, {
    id: 'bob-session',
    userId: 'bob',
    familyId: 'family-bob',
    createdAtMs: now - 1_000,
  })

  return {
    raw,
    tokens,
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      USER_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

async function seedSession(
  raw: any,
  tokens: Record<string, SessionTokens>,
  input: {
    id: string
    userId: string
    familyId: string
    createdAtMs: number
    userAgent?: string
    revokedAtMs?: number
    accessExpiresAtMs?: number
    refreshExpiresAtMs?: number
  },
): Promise<void> {
  const access = createOpaqueToken('access')
  const refresh = createOpaqueToken('refresh')
  tokens[input.id] = { access, refresh }
  raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version,
       access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms,
       revoked_at_ms, revoke_reason, user_agent
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.familyId,
    input.userId,
    await tokenDigest(access, PEPPER, 'access'),
    await tokenDigest(refresh, PEPPER, 'refresh'),
    input.createdAtMs,
    input.accessExpiresAtMs ?? input.createdAtMs + 10 * 60_000,
    input.refreshExpiresAtMs ?? input.createdAtMs + 30 * 60_000,
    input.revokedAtMs ?? null,
    input.revokedAtMs === undefined ? null : 'test_revocation',
    input.userAgent ?? '',
  )
}

function authorization(test: SessionFixture, sessionId: string): HeadersInit {
  return { authorization: `Bearer ${test.tokens[sessionId].access}` }
}

describe('user session management', () => {
  it('lists only the caller active sessions with a stable current-first order and no token material', async () => {
    const test = await fixture()
    const app = createApp()

    const unauthorized = await app.request('/api/v1/auth/sessions', undefined, test.env)
    const response = await app.request('/api/v1/auth/sessions', {
      headers: authorization(test, 'alice-current'),
    }, test.env)

    expect(unauthorized.status).toBe(401)
    expect(response.status).toBe(200)
    const payload = await response.json() as {
      data: { items: Array<Record<string, unknown>>; total: number }
    }
    expect(payload.data.total).toBe(4)
    expect(payload.data.items.map((item) => item.id)).toEqual([
      'alice-current',
      'alice-newer',
      'alice-tie-a',
      'alice-tie-b',
    ])
    expect(payload.data.items[0]).toMatchObject({
      id: 'alice-current',
      current: true,
      user_agent: 'Current Browser/1.0',
    })
    expect(payload.data.items[1]).toMatchObject({
      id: 'alice-newer',
      current: false,
      user_agent: 'New Browser/2.0',
    })
    expect(payload.data.items[2]).not.toHaveProperty('user_agent')
    expect(JSON.stringify(payload)).not.toMatch(/access_token|refresh_token|token_hash|ip_hash/)
  })

  it('revokes an owned session immediately for both access and refresh tokens while keeping the caller active', async () => {
    const test = await fixture()
    const app = createApp()

    const response = await app.request('/api/v1/auth/sessions/alice-newer', {
      method: 'DELETE',
      headers: authorization(test, 'alice-current'),
    }, test.env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      code: 0,
      data: { session_id: 'alice-newer', current: false },
    })
    const revokedAccess = await app.request('/api/v1/auth/me', {
      headers: authorization(test, 'alice-newer'),
    }, test.env)
    const revokedRefresh = await app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: test.tokens['alice-newer'].refresh }),
    }, test.env)
    const currentAccess = await app.request('/api/v1/auth/me', {
      headers: authorization(test, 'alice-current'),
    }, test.env)
    expect(revokedAccess.status).toBe(401)
    expect(revokedRefresh.status).toBe(401)
    expect(currentAccess.status).toBe(200)
  })

  it('does not disclose or mutate another user session through the targeted revoke endpoint', async () => {
    const test = await fixture()
    const app = createApp()

    const foreign = await app.request('/api/v1/auth/sessions/bob-session', {
      method: 'DELETE',
      headers: authorization(test, 'alice-current'),
    }, test.env)
    const missing = await app.request('/api/v1/auth/sessions/missing-session', {
      method: 'DELETE',
      headers: authorization(test, 'alice-current'),
    }, test.env)

    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    await expect(foreign.json()).resolves.toMatchObject({ code: 'session_not_found' })
    await expect(missing.json()).resolves.toMatchObject({ code: 'session_not_found' })
    const otherUser = await app.request('/api/v1/auth/me', {
      headers: authorization(test, 'bob-session'),
    }, test.env)
    expect(otherUser.status).toBe(200)
  })

  it('makes targeted revocation idempotent, preserves the first revocation evidence, and revokes the whole family', async () => {
    const test = await fixture()
    const app = createApp()
    const originalNow = Date.now()
    await seedSession(test.raw, test.tokens, {
      id: 'alice-family-sibling',
      userId: 'alice',
      familyId: 'family-newer',
      createdAtMs: originalNow - 2_000,
    })

    const first = await app.request('/api/v1/auth/sessions/alice-newer', {
      method: 'DELETE',
      headers: authorization(test, 'alice-current'),
    }, test.env)
    const firstEvidence = test.raw.prepare(
      `SELECT revoked_at_ms, revoke_reason FROM user_sessions WHERE id = 'alice-newer'`,
    ).get() as { revoked_at_ms: number; revoke_reason: string }
    const repeated = await app.request('/api/v1/auth/sessions/alice-newer', {
      method: 'DELETE',
      headers: authorization(test, 'alice-current'),
    }, test.env)
    const repeatedEvidence = test.raw.prepare(
      `SELECT revoked_at_ms, revoke_reason FROM user_sessions WHERE id = 'alice-newer'`,
    ).get()

    expect(first.status).toBe(200)
    expect(repeated.status).toBe(200)
    expect(repeatedEvidence).toEqual(firstEvidence)
    expect(firstEvidence.revoke_reason).toBe('user_session_revoked')
    const siblingAccess = await app.request('/api/v1/auth/me', {
      headers: authorization(test, 'alice-family-sibling'),
    }, test.env)
    expect(siblingAccess.status).toBe(401)
  })

  it('does not let refresh-token replay overwrite explicit family revocation evidence', async () => {
    const test = await fixture()
    const app = createApp()
    const previousRefresh = test.tokens['alice-newer'].refresh
    const rotation = await app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: previousRefresh }),
    }, test.env)
    expect(rotation.status).toBe(200)

    const revoke = await app.request('/api/v1/auth/sessions/alice-newer', {
      method: 'DELETE',
      headers: authorization(test, 'alice-current'),
    }, test.env)
    expect(revoke.status).toBe(200)
    const explicitEvidence = test.raw.prepare(
      `SELECT revoked_at_ms, revoke_reason FROM user_sessions WHERE id = 'alice-newer'`,
    ).get()

    const replay = await app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: previousRefresh }),
    }, test.env)
    const afterReplay = test.raw.prepare(
      `SELECT revoked_at_ms, revoke_reason FROM user_sessions WHERE id = 'alice-newer'`,
    ).get()

    expect(replay.status).toBe(401)
    await expect(replay.json()).resolves.toMatchObject({ code: 'refresh_token_reused' })
    expect(afterReplay).toEqual(explicitEvidence)
    expect(afterReplay).toMatchObject({ revoke_reason: 'user_session_revoked' })
  })

  it('can revoke the current session through DELETE and invalidates its access and refresh immediately', async () => {
    const test = await fixture()
    const app = createApp()

    const response = await app.request('/api/v1/auth/sessions/alice-current', {
      method: 'DELETE',
      headers: authorization(test, 'alice-current'),
    }, test.env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: { session_id: 'alice-current', current: true },
    })

    const access = await app.request('/api/v1/auth/me', {
      headers: authorization(test, 'alice-current'),
    }, test.env)
    const refresh = await app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: test.tokens['alice-current'].refresh }),
    }, test.env)
    expect(access.status).toBe(401)
    expect(refresh.status).toBe(401)
  })

  it('revokes every other session idempotently without crossing user ownership or revoking the caller', async () => {
    const test = await fixture()
    const app = createApp()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.request('/api/v1/auth/sessions/revoke-others', {
        method: 'POST',
        headers: authorization(test, 'alice-current'),
      }, test.env)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        code: 0,
        data: { current_session_id: 'alice-current' },
      })
    }

    for (const id of ['alice-newer', 'alice-tie-a', 'alice-tie-b']) {
      const access = await app.request('/api/v1/auth/me', {
        headers: authorization(test, id),
      }, test.env)
      expect(access.status).toBe(401)
    }
    const current = await app.request('/api/v1/auth/me', {
      headers: authorization(test, 'alice-current'),
    }, test.env)
    const otherUser = await app.request('/api/v1/auth/me', {
      headers: authorization(test, 'bob-session'),
    }, test.env)
    expect(current.status).toBe(200)
    expect(otherUser.status).toBe(200)
  })

  it('fences a session issued from a stale auth snapshot while retaining the current session', async () => {
    const test = await fixture()
    const app = createApp()

    const response = await app.request('/api/v1/auth/sessions/revoke-others', {
      method: 'POST',
      headers: authorization(test, 'alice-current'),
    }, test.env)
    expect(response.status).toBe(200)
    await seedSession(test.raw, test.tokens, {
      id: 'alice-racing-stale',
      userId: 'alice',
      familyId: 'family-racing-stale',
      createdAtMs: Date.now(),
    })

    const retained = await app.request('/api/v1/auth/me', {
      headers: authorization(test, 'alice-current'),
    }, test.env)
    const stale = await app.request('/api/v1/auth/me', {
      headers: authorization(test, 'alice-racing-stale'),
    }, test.env)
    const versions = test.raw.prepare(
      `SELECT u.auth_version AS user_version, s.auth_version AS session_version
         FROM users u JOIN user_sessions s ON s.user_id = u.id
        WHERE u.id = 'alice' AND s.id = 'alice-current'`,
    ).get()
    expect(retained.status).toBe(200)
    expect(stale.status).toBe(401)
    expect(versions).toEqual({ user_version: 2, session_version: 2 })
  })

  it('revokes all of the caller sessions including the current session and leaves other users active', async () => {
    const test = await fixture()
    const app = createApp()

    const response = await app.request('/api/v1/auth/sessions/revoke-all', {
      method: 'POST',
      headers: authorization(test, 'alice-current'),
    }, test.env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      code: 0,
      data: { message: 'All sessions have been revoked. Please log in again.' },
    })
    for (const id of ['alice-current', 'alice-newer', 'alice-tie-a', 'alice-tie-b']) {
      const access = await app.request('/api/v1/auth/me', {
        headers: authorization(test, id),
      }, test.env)
      expect(access.status).toBe(401)
    }
    const revokedRefresh = await app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: test.tokens['alice-newer'].refresh }),
    }, test.env)
    const otherUser = await app.request('/api/v1/auth/me', {
      headers: authorization(test, 'bob-session'),
    }, test.env)
    expect(revokedRefresh.status).toBe(401)
    expect(otherUser.status).toBe(200)
  })

  it('keeps the original revoke-all-sessions endpoint as an authenticated compatibility alias', async () => {
    const test = await fixture()
    const app = createApp()

    const response = await app.request('/api/v1/auth/revoke-all-sessions', {
      method: 'POST',
      headers: authorization(test, 'alice-current'),
    }, test.env)
    const current = await app.request('/api/v1/auth/me', {
      headers: authorization(test, 'alice-current'),
    }, test.env)

    expect(response.status).toBe(200)
    expect(current.status).toBe(401)
  })

  it('writes scoped audit events for every revocation command without token material', async () => {
    const test = await fixture()
    const app = createApp()

    await app.request('/api/v1/auth/sessions/alice-newer', {
      method: 'DELETE',
      headers: authorization(test, 'alice-current'),
    }, test.env)
    await app.request('/api/v1/auth/sessions/revoke-others', {
      method: 'POST',
      headers: authorization(test, 'alice-current'),
    }, test.env)
    await app.request('/api/v1/auth/sessions/revoke-all', {
      method: 'POST',
      headers: authorization(test, 'alice-current'),
    }, test.env)

    const events = test.raw.prepare(
      `SELECT user_id, event_type, outcome, session_id, metadata_json
         FROM auth_audit_events
        ORDER BY occurred_at_ms ASC, rowid ASC`,
    ).all() as Array<Record<string, unknown>>
    expect(events.map((event) => event.event_type)).toEqual([
      'auth.session.revoke',
      'auth.sessions.revoke_others',
      'auth.sessions.revoke_all',
    ])
    expect(events.every((event) =>
      event.user_id === 'alice' &&
      event.outcome === 'succeeded' &&
      event.session_id === 'alice-current'
    )).toBe(true)
    expect(JSON.stringify(events)).not.toMatch(/sat_v1_|srt_v1_|access_token|refresh_token/)
  })
})
