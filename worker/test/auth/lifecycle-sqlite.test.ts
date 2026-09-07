import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { apiKeyDigest } from '../../src/gateway/crypto'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'lifecycle-audit-pepper-at-least-32-bytes'
const PASSWORD = 'initial-user-password-value'

async function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(`INSERT INTO users (id,email,role,created_at_ms,updated_at_ms)
    VALUES ('admin','admin@example.test','admin',?,?)`).run(now, now)
  const admin = `adm-sub2api-${'l'.repeat(48)}`
  raw.prepare(`INSERT INTO admin_sessions (id,user_id,token_hash,created_at_ms,expires_at_ms)
    VALUES ('admin-session','admin',?,?,?)`).run(await apiKeyDigest(`admin-session:v1:${admin}`, PEPPER), now, now + 600000)
  const states = new Map<string, { version: number; balance: number; enabled: boolean }>()
  const env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    ASSETS: { fetch: async () => new Response('asset') },
    DB: d1,
    CONFIG_KV: { get: async () => ({ registration_enabled: true }), put: async () => {} },
    OBJECTS: {},
    EVENTS_QUEUE: {},
    POOL_STATE: {},
    SUBSCRIPTION_STATE: {},
    API_KEY_LIMIT_STATE: {},
    AUTH_RATE_LIMIT: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({
          schema_version: 1, allowed: true, recorded: true, cleared: ['account'],
        }),
      }),
    },
    USER_STATE: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async (request: Request) => {
          const body = await request.json() as any
          const path = new URL(request.url).pathname
          let state = states.get(name)
          if (!state) {
            state = {
              version: body.initial_state_version ?? 0,
              balance: body.balance_micros ?? 0,
              enabled: body.enabled ?? true,
            }
            states.set(name, state)
          }
          if (path === '/enabled') {
            state.enabled = body.enabled
            state.version++
          }
          return Response.json({
            schema_version: 1,
            idempotent: false,
            applied: true,
            state_version: state.version,
            profile: {
              user_id: body.user_id ?? name,
              enabled: state.enabled,
              balance_micros: state.balance,
              reserved_micros: 0,
              settled_micros: 0,
            },
          })
        },
      }),
    },
  } as unknown as Env
  const app = createApp()
  const request = (path: string, method = 'GET', body?: unknown, token?: string) => app.request(`/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'idempotency-key': crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env)
  const register = async (email = 'alice@example.test') => {
    const response = await request('/auth/register', 'POST', { email, password: PASSWORD })
    expect(response.status, await response.clone().text()).toBe(201)
    return (await response.json() as any).data
  }
  return { raw, env, request, register, admin }
}

describe('full user authentication lifecycle against migrated SQLite', () => {
  it('registers, logs in, rotates tokens, rejects reuse, and logs out', async () => {
    const t = await fixture()
    const registered = await t.register()
    expect((await t.request('/auth/me', 'GET', undefined, registered.access_token)).status).toBe(200)
    const duplicate = await t.request('/auth/register', 'POST', { email: 'alice@example.test', password: PASSWORD })
    expect(duplicate.status).toBe(409)
    expect((await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: 'incorrect-password' })).status).toBe(401)
    const login = await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: PASSWORD })
    expect(login.status).toBe(200)
    const tokens = (await login.json() as any).data
    const rotated = await t.request('/auth/refresh', 'POST', { refresh_token: tokens.refresh_token })
    expect(rotated.status).toBe(200)
    const current = (await rotated.json() as any).data
    expect((await t.request('/auth/me', 'GET', undefined, tokens.access_token)).status).toBe(401)
    expect((await t.request('/auth/me', 'GET', undefined, current.access_token)).status).toBe(200)
    expect((await t.request('/auth/refresh', 'POST', { refresh_token: tokens.refresh_token })).status).toBe(401)
    expect((await t.request('/auth/me', 'GET', undefined, current.access_token)).status).toBe(401)
    expect((await t.request('/auth/logout', 'POST', { refresh_token: registered.refresh_token })).status).toBe(200)
    expect((await t.request('/auth/me', 'GET', undefined, registered.access_token)).status).toBe(401)
  })

  it('does not resurrect old access or refresh tokens after an administrator disables and re-enables a user', async () => {
    const t = await fixture()
    const user = await t.register()
    const disable = await t.request(`/admin/users/${user.user.id}`, 'PUT', { status: 'disabled' }, t.admin)
    expect(disable.status, await disable.clone().text()).toBe(200)
    expect((await t.request('/auth/me', 'GET', undefined, user.access_token)).status).toBe(401)
    const enable = await t.request(`/admin/users/${user.user.id}`, 'PUT', { status: 'active' }, t.admin)
    expect(enable.status, await enable.clone().text()).toBe(200)
    expect((await t.request('/auth/me', 'GET', undefined, user.access_token)).status).toBe(401)
    expect((await t.request('/auth/refresh', 'POST', { refresh_token: user.refresh_token })).status).toBe(401)
    expect((await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: PASSWORD })).status).toBe(200)
  })

  it('revokes recovery administrator sessions when their password is reset', async () => {
    const t = await fixture()
    expect((await t.request('/admin/users', 'GET', undefined, t.admin)).status).toBe(200)
    const reset = await t.request('/admin/users/admin', 'PUT', { password: 'replacement-password-value' }, t.admin)
    expect(reset.status, await reset.clone().text()).toBe(200)
    expect((await t.request('/admin/users', 'GET', undefined, t.admin)).status).toBe(401)
  })

  it('keeps the changing browser logged in while revoking other logins and accepting only the new password', async () => {
    const t = await fixture()
    const user = await t.register()
    const secondResponse = await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: PASSWORD })
    const second = (await secondResponse.json() as any).data
    const changed = await t.request('/user/password', 'PUT', {
      old_password: PASSWORD, new_password: 'replacement-password-value',
    }, user.access_token)
    expect(changed.status, await changed.clone().text()).toBe(200)
    expect((await t.request('/auth/me', 'GET', undefined, user.access_token)).status).toBe(200)
    expect((await t.request('/auth/me', 'GET', undefined, second.access_token)).status).toBe(401)
    expect((await t.request('/auth/refresh', 'POST', { refresh_token: second.refresh_token })).status).toBe(401)
    expect((await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: PASSWORD })).status).toBe(401)
    expect((await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: 'replacement-password-value' })).status).toBe(200)
  })

  it('denies ordinary users admin access and makes a deleted user unable to log in or refresh', async () => {
    const t = await fixture()
    const user = await t.register()
    expect((await t.request('/admin/users', 'GET', undefined, user.access_token)).status).toBe(403)
    const deleted = await t.request(`/admin/users/${user.user.id}`, 'DELETE', undefined, t.admin)
    expect(deleted.status, await deleted.clone().text()).toBe(200)
    expect((await t.request(`/admin/users/${user.user.id}`, 'GET', undefined, t.admin)).status).toBe(404)
    expect((await t.request('/auth/me', 'GET', undefined, user.access_token)).status).toBe(401)
    expect((await t.request('/auth/refresh', 'POST', { refresh_token: user.refresh_token })).status).toBe(401)
    expect((await t.request('/auth/login', 'POST', { email: 'alice@example.test', password: PASSWORD })).status).toBe(401)
  })
})
