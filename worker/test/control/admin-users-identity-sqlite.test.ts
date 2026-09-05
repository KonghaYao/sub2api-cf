import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { verifyPassword } from '../../src/auth/password'
import { createAdminUser, updateAdminUser } from '../../src/control/users'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

class UserStateStub {
  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as Record<string, unknown>
    return Response.json({
      schema_version: 1,
      idempotent: false,
      profile: {
        user_id: body.user_id,
        enabled: body.enabled,
        balance_micros: body.balance_micros,
        reserved_micros: 0,
        settled_micros: 0,
      },
      state_version: body.initial_state_version ?? 0,
    })
  }
}

function fixture(): { app: Hono<{ Bindings: Env }>; env: Env; raw: any } {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const state = new UserStateStub()
  const app = new Hono<{ Bindings: Env }>()
  app.post('/users', createAdminUser)
  app.put('/users/:id', updateAdminUser)
  const env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    ASSETS: {} as Fetcher,
    DB: d1,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {
      idFromName: (name: string) => name,
      get: () => state,
    } as unknown as DurableObjectNamespace,
    SUBSCRIPTION_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
    AUTH_RATE_LIMIT: {} as DurableObjectNamespace,
    API_KEY_LIMIT_STATE: {} as DurableObjectNamespace,
  } as Env
  return { app, env, raw }
}

describe('admin user Worker identity and admission contract', () => {
  it('creates a login-capable user without exposing its password credential', async () => {
    const test = fixture()
    const response = await test.app.request('/users', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'admin-create-login-user-0001',
      },
      body: JSON.stringify({
        email: 'worker-user@example.test',
        display_name: 'Worker User',
        password: 'correct horse battery staple',
        balance_micros: 2_500_000,
        concurrency: 7,
        rpm_limit: 42,
      }),
    }, test.env)

    expect(response.status).toBe(201)
    const payload = await response.json() as any
    expect(payload.data).toMatchObject({
      email: 'worker-user@example.test',
      display_name: 'Worker User',
      balance_micros: 2_500_000,
      concurrency: 7,
      rpm_limit: 42,
    })
    expect(JSON.stringify(payload)).not.toContain('correct horse battery staple')
    expect(JSON.stringify(payload)).not.toContain('password_credential')

    const stored = test.raw.prepare(
      `SELECT password_credential, password_changed_at_ms, concurrency, rpm_limit
         FROM users WHERE id = ?`,
    ).get(payload.data.id) as Record<string, unknown>
    expect(stored).toMatchObject({ concurrency: 7, rpm_limit: 42 })
    expect(stored.password_changed_at_ms).toEqual(expect.any(Number))
    await expect(verifyPassword(
      'correct horse battery staple',
      String(stored.password_credential),
    )).resolves.toBe(true)
  })

  it('maps canonical mailbox aliases to the public duplicate-email conflict', async () => {
    const test = fixture()
    const first = await test.app.request('/users', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'admin-create-canonical-user-0001',
      },
      body: JSON.stringify({
        email: 'some.one+first@gmail.com', password: 'correct horse battery staple',
      }),
    }, test.env)
    expect(first.status).toBe(201)

    const duplicate = await test.app.request('/users', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'admin-create-canonical-user-0002',
      },
      body: JSON.stringify({
        email: 'someone+second@googlemail.com.', password: 'correct horse battery staple',
      }),
    }, test.env)
    expect(duplicate.status).toBe(409)
    await expect(duplicate.json()).resolves.toMatchObject({
      error: { code: 'email_already_exists' },
    })
  })

  it('updates admission limits and rotates the password while revoking sessions atomically', async () => {
    const test = fixture()
    const created = await test.app.request('/users', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'admin-create-rotate-user-0001',
      },
      body: JSON.stringify({
        email: 'rotate@example.test',
        password: 'initial-password-value',
      }),
    }, test.env)
    const user = (await created.json() as any).data
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES ('session-1', 'family-1', ?, 1, ?, ?, ?, ?, ?)`,
    ).run(user.id, 'a'.repeat(64), 'b'.repeat(64), now, now + 60_000, now + 120_000)

    const response = await test.app.request(`/users/${user.id}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'admin-rotate-login-user-0001',
      },
      body: JSON.stringify({
        password: 'replacement-password-value',
        concurrency: 0,
        rpm_limit: 120,
      }),
    }, test.env)

    expect(response.status).toBe(200)
    const payload = await response.json() as any
    expect(payload.data).toMatchObject({ concurrency: 0, rpm_limit: 120, control_version: 1 })
    expect(JSON.stringify(payload)).not.toContain('replacement-password-value')
    const stored = test.raw.prepare(
      `SELECT password_credential, auth_version, concurrency, rpm_limit
         FROM users WHERE id = ?`,
    ).get(user.id) as Record<string, unknown>
    await expect(verifyPassword(
      'replacement-password-value',
      String(stored.password_credential),
    )).resolves.toBe(true)
    expect(stored).toMatchObject({ auth_version: 2, concurrency: 0, rpm_limit: 120 })
    expect(test.raw.prepare(
      `SELECT revoke_reason FROM user_sessions WHERE id = 'session-1'`,
    ).get()).toEqual({ revoke_reason: 'admin_password_reset' })
  })

  it.each([
    [{ concurrency: -1 }, 'invalid_concurrency'],
    [{ rpm_limit: 1.5 }, 'invalid_rpm_limit'],
    [{ password: 'short' }, 'invalid_password'],
  ])('rejects invalid create input %j', async (body, code) => {
    const test = fixture()
    const response = await test.app.request('/users', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `admin-invalid-user-${code}`,
      },
      body: JSON.stringify({ email: `${code}@example.test`, ...body }),
    }, test.env)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code } })
  })
})
