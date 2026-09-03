import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { createOpaqueToken } from '../../src/auth/tokens'
import { requireAdminSession } from '../../src/control/admin-auth'
import type { Env } from '../../src/env'

function env(): Env {
  return {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    ADMIN_TOKEN: 'a'.repeat(32),
    API_KEY_PEPPER: 'p'.repeat(32),
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
        }),
      }),
    } as unknown as D1Database,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  }
}

describe('admin control-plane authentication', () => {
  it('rejects missing and incorrect admin sessions before routing admin APIs', async () => {
    const app = createApp()

    const missing = await app.request('/api/v1/admin/users', {}, env())
    const incorrect = await app.request(
      '/api/v1/admin/users',
      { headers: { authorization: `Bearer ${'s'.repeat(32)}` } },
      env(),
    )

    expect(missing.status).toBe(401)
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'admin_session_required' },
    })
    expect(incorrect.status).toBe(401)
    await expect(incorrect.json()).resolves.toMatchObject({
      error: { code: 'invalid_admin_session' },
    })
  })

  it('keeps the break-glass token scoped to bootstrap', async () => {
    const response = await createApp().request(
      '/api/v1/admin/users',
      { headers: { authorization: `Bearer ${'a'.repeat(32)}` } },
      env(),
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_admin_session' },
    })
  })

  it('accepts a normal signed-in access session only when its user is an active admin', async () => {
    const token = createOpaqueToken('access')
    const app = new Hono<{ Bindings: Env }>()
    app.use('*', requireAdminSession)
    app.get('/admin-only', (context) => context.json({ ok: true }))
    const roleEnv = (role: 'admin' | 'user'): Env => ({
      ...env(),
      DB: {
        prepare: (query: string) => ({
          bind: () => ({
            first: async () => query.includes('FROM user_sessions s') ? ({
              session_id: 'user-session-1',
              family_id: 'family-1',
              session_auth_version: 1,
              access_token_hash: 'a'.repeat(64),
              refresh_token_hash: 'b'.repeat(64),
              previous_refresh_token_hash: null,
              access_expires_at_ms: Date.now() + 60_000,
              refresh_expires_at_ms: Date.now() + 120_000,
              revoked_at_ms: null,
              id: `${role}-1`,
              email: `${role}@example.com`,
              display_name: role,
              role,
              status: 'active',
              balance_micros: 0,
              state_version: 0,
              auth_version: 1,
              password_credential: 'not-returned',
              email_verified_at_ms: null,
              password_changed_at_ms: Date.now(),
              last_login_at_ms: Date.now(),
              created_at_ms: Date.now(),
              updated_at_ms: Date.now(),
            }) : null,
          }),
        }),
      } as unknown as D1Database,
    })

    const admin = await app.request('/admin-only', {
      headers: { authorization: `Bearer ${token}` },
    }, roleEnv('admin'))
    const user = await app.request('/admin-only', {
      headers: { authorization: `Bearer ${token}` },
    }, roleEnv('user'))

    expect(admin.status).toBe(200)
    expect(user.status).toBe(403)
    await expect(user.json()).resolves.toMatchObject({
      error: { code: 'admin_role_required' },
    })
  })
})
