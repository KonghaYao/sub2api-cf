import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { apiKeyDigest } from '../../src/gateway/crypto'
import { deleteAdminUser, getAdminUser, listAdminUsers } from '../../src/control/users'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'p'.repeat(32)

class UserStateStub {
  readonly calls: Array<Record<string, unknown>> = []
  onDisable: (() => void) | undefined
  userId = 'user-1'

  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as Record<string, unknown>
    this.calls.push(body)
    if (typeof body.user_id === 'string') this.userId = body.user_id
    if (body.enabled === false) this.onDisable?.()
    return Response.json({
      schema_version: 1,
      idempotent: false,
      applied: true,
      profile: {
        user_id: this.userId,
        enabled: body.enabled,
        balance_micros: body.balance_micros ?? 0,
        reserved_micros: 0,
        settled_micros: 0,
      },
      state_version: body.initial_state_version ?? 1,
    })
  }
}

async function fixture(): Promise<{
  app: Hono<{ Bindings: Env }>
  env: Env
  raw: any
  authorization: string
  state: UserStateStub
}> {
  const database = createSqliteD1()
  applyMigrations(database.raw)
  const now = Date.now()
  database.raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, auth_version, created_at_ms, updated_at_ms
     ) VALUES
       ('admin-1', 'admin@example.test', 'Admin', 'admin', 'active', 1, ?, ?),
       ('user-1', 'alice@example.test', 'Alice', 'user', 'active', 1, ?, ?)`,
  ).run(now, now, now, now)
  const token = `adm-sub2api-${'r'.repeat(48)}`
  database.raw.prepare(
    `INSERT INTO admin_sessions (
       id, user_id, token_hash, created_at_ms, expires_at_ms
     ) VALUES ('admin-session-1', 'admin-1', ?, ?, ?)`,
  ).run(
    await apiKeyDigest(`admin-session:v1:${token}`, PEPPER),
    now,
    now + 60_000,
  )
  const state = new UserStateStub()
  const env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    ASSETS: {} as Fetcher,
    DB: database.d1,
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
  const app = new Hono<{ Bindings: Env }>()
  app.delete('/users/:id', deleteAdminUser)
  app.get('/users/:id', getAdminUser)
  app.get('/users', listAdminUsers)
  return { app, env, raw: database.raw, authorization: `Bearer ${token}`, state }
}

describe('admin user deletion contract', () => {
  it('deletes multiple users without colliding after canonical mailbox normalization', async () => {
    const test = await fixture()
    test.raw.prepare(`INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-2', 'second@example.test', ?, ?)`).run(Date.now(), Date.now())
    for (const id of ['user-1', 'user-2']) {
      const response = await test.app.request(`/users/${id}`, {
        method: 'DELETE', headers: { authorization: test.authorization },
      }, test.env)
      expect(response.status, await response.clone().text()).toBe(200)
    }
    const rows = test.raw.prepare(`SELECT canonical_email_inbox FROM users WHERE role = 'user'`).all()
    expect(new Set(rows.map((row: any) => row.canonical_email_inbox)).size).toBe(2)
  })

  it('keeps legacy tombstones hidden and idempotent while deleting another user', async () => {
    const test = await fixture()
    test.raw.prepare(`UPDATE users SET email = 'deleted+user-1@users.invalid',
      display_name = '[deleted]', status = 'disabled' WHERE id = 'user-1'`).run()
    test.raw.prepare(`INSERT INTO users (id, email, created_at_ms, updated_at_ms)
      VALUES ('user-2', 'second@example.test', ?, ?)`).run(Date.now(), Date.now())
    const headers = { authorization: test.authorization }
    expect((await test.app.request('/users/user-1', { headers }, test.env)).status).toBe(404)
    const listing = await test.app.request('/users', { headers }, test.env)
    expect((await listing.json() as any).data.items.map((row: any) => row.id)).not.toContain('user-1')
    expect((await test.app.request('/users/user-1', { method: 'DELETE', headers }, test.env)).status).toBe(200)
    expect(test.state.calls).toHaveLength(0)
    const response = await test.app.request('/users/user-2', { method: 'DELETE', headers }, test.env)
    expect(response.status, await response.clone().text()).toBe(200)
  })

  it('deletes a regular user through the public HTTP handler', async () => {
    const test = await fixture()

    const response = await test.app.request('/users/user-1', {
      method: 'DELETE',
      headers: { authorization: test.authorization },
    }, test.env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      code: 0,
      data: { message: 'User deleted successfully' },
    })
  })

  it('hides a deleted user from detail and list HTTP reads', async () => {
    const test = await fixture()
    const headers = { authorization: test.authorization }

    expect((await test.app.request('/users/user-1', { method: 'DELETE', headers }, test.env)).status)
      .toBe(200)
    const detail = await test.app.request('/users/user-1', { headers }, test.env)
    const list = await test.app.request('/users', { headers }, test.env)

    expect(detail.status).toBe(404)
    await expect(list.json()).resolves.toMatchObject({
      data: { items: [{ id: 'admin-1' }], total: 1 },
    })
  })

  it('treats repeated deletion as an idempotent success', async () => {
    const test = await fixture()
    const request = { method: 'DELETE', headers: { authorization: test.authorization } }

    const first = await test.app.request('/users/user-1', request, test.env)
    const repeated = await test.app.request('/users/user-1', request, test.env)

    expect(first.status).toBe(200)
    expect(repeated.status).toBe(200)
    await expect(repeated.json()).resolves.toMatchObject({
      data: { message: 'User deleted successfully' },
    })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM auth_audit_events
        WHERE event_type = 'admin.users.delete'`,
    ).get()).toEqual({ count: 1 })
    expect(test.state.calls).toHaveLength(2)
  })

  it('removes authenticators while retaining subscription and financial history', async () => {
    const test = await fixture()
    const now = Date.now()
    test.raw.prepare(
      `UPDATE users SET password_credential = 'stored-password-hash' WHERE id = 'user-1'`,
    ).run()
    test.raw.prepare(
      `INSERT INTO api_keys (
         id, user_id, key_hash, key_prefix, name, enabled, created_at_ms, updated_at_ms
       ) VALUES ('key-1', 'user-1', ?, 'sk-original', 'Original', 1, ?, ?)`,
    ).run('a'.repeat(64), now, now)
    test.raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES ('user-session-1', 'family-1', 'user-1', 1, ?, ?, ?, ?, ?)`,
    ).run('b'.repeat(64), 'c'.repeat(64), now, now + 60_000, now + 120_000)
    test.raw.prepare(
      `INSERT INTO auth_identities (
         id, user_id, provider, provider_key, provider_subject, created_at_ms, updated_at_ms
       ) VALUES ('identity-1', 'user-1', 'github', 'github', 'subject-1', ?, ?)`,
    ).run(now, now)
    test.raw.prepare(
      `INSERT INTO user_totp_credentials (
         user_id, nonce_b64, ciphertext_b64, enabled_at_ms, created_at_ms, updated_at_ms
       ) VALUES ('user-1', ?, ?, ?, ?, ?)`,
    ).run('N'.repeat(16), 'C'.repeat(24), now, now, now)
    test.raw.prepare(
      `INSERT INTO user_totp_setup_challenges (
         id, user_id, token_hash, nonce_b64, ciphertext_b64,
         created_at_ms, expires_at_ms, updated_at_ms
       ) VALUES ('totp-setup-1', 'user-1', ?, ?, ?, ?, ?, ?)`,
    ).run('d'.repeat(64), 'S'.repeat(16), 'T'.repeat(24), now, now + 60_000, now)
    test.raw.prepare(
      `INSERT INTO user_totp_login_challenges (
         id, user_id, token_hash, created_at_ms, expires_at_ms, updated_at_ms
       ) VALUES ('totp-login-1', 'user-1', ?, ?, ?, ?)`,
    ).run('e'.repeat(64), now, now + 60_000, now)
    test.raw.prepare(
      `INSERT INTO user_totp_verification_budgets (
         user_id, window_started_at_ms, attempt_count, updated_at_ms
       ) VALUES ('user-1', ?, 1, ?)`,
    ).run(now, now)
    test.raw.prepare(
      `INSERT INTO passkey_user_handles (user_id, user_handle_b64, created_at_ms)
       VALUES ('user-1', ?, ?)`,
    ).run('H'.repeat(43), now)
    test.raw.prepare(
      `INSERT INTO passkey_credentials (
         user_id, credential_id_b64, public_key_jwk, algorithm, created_at_ms, updated_at_ms
       ) VALUES ('user-1', 'credential-1', '{}', -7, ?, ?)`,
    ).run(now, now)
    test.raw.prepare(
      `INSERT INTO "groups" (
         id, name, platform, group_type, enabled, created_at_ms, updated_at_ms
       ) VALUES ('group-1', 'Group 1', 'openai', 'subscription', 1, ?, ?)`,
    ).run(now, now)
    test.raw.prepare(
      `INSERT INTO user_subscriptions (
         id, user_id, group_id, status, starts_at_ms, expires_at_ms,
         source_type, source_id, created_at_ms, updated_at_ms
       ) VALUES ('subscription-1', 'user-1', 'group-1', 'active', ?, ?,
         'admin', 'seed', ?, ?)`,
    ).run(now, now + 86_400_000, now, now)
    test.raw.prepare(
      `INSERT INTO user_financial_events (
         event_id, user_id, state_version, event_type, source_type, source_id,
         amount_delta_micros, gross_amount_micros, spend_debt_delta_micros,
         balance_after_micros, spend_debt_after_micros, occurred_at_ms, projected_at_ms
       ) VALUES ('event-1', 'user-1', 1, 'opening_balance', 'opening_balance', 'seed',
         0, 0, 0, 0, 0, ?, ?)`,
    ).run(now, now)

    const response = await test.app.request('/users/user-1', {
      method: 'DELETE',
      headers: { authorization: test.authorization },
    }, test.env)

    expect(response.status).toBe(200)
    expect(test.raw.prepare(
      `SELECT email, display_name, status, password_credential, auth_version
         FROM users WHERE id = 'user-1'`,
    ).get()).toEqual({
      email: 'deleted-user-1@users.invalid',
      display_name: '[deleted]',
      status: 'disabled',
      password_credential: null,
      auth_version: 2,
    })
    expect(test.raw.prepare(
      `SELECT enabled, revoked_at_ms, key_hash, key_prefix FROM api_keys WHERE id = 'key-1'`,
    ).get()).toMatchObject({
      enabled: 0,
      revoked_at_ms: expect.any(Number),
      key_prefix: '[deleted]',
    })
    expect(test.raw.prepare(`SELECT key_hash FROM api_keys WHERE id = 'key-1'`).get())
      .not.toEqual({ key_hash: 'a'.repeat(64) })
    for (const table of [
      'user_sessions',
      'auth_identities',
      'user_totp_credentials',
      'user_totp_setup_challenges',
      'user_totp_login_challenges',
      'user_totp_verification_budgets',
      'passkey_user_handles',
      'passkey_credentials',
    ]) {
      expect(test.raw.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = 'user-1'`).get())
        .toEqual({ count: 0 })
    }
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM user_subscriptions WHERE user_id = 'user-1'`,
    ).get()).toEqual({ count: 1 })
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS count FROM user_financial_events WHERE user_id = 'user-1'`,
    ).get()).toEqual({ count: 1 })
    expect(test.raw.prepare(
      `SELECT event_type, outcome FROM auth_audit_events
        WHERE event_type = 'admin.users.delete'`,
    ).get()).toEqual({ event_type: 'admin.users.delete', outcome: 'succeeded' })
  })

  it('returns not found for an id that has never existed', async () => {
    const test = await fixture()

    const response = await test.app.request('/users/missing', {
      method: 'DELETE',
      headers: { authorization: test.authorization },
    }, test.env)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'user_not_found' } })
  })

  it('releases the original email address for a replacement account', async () => {
    const test = await fixture()
    const now = Date.now()

    expect((await test.app.request('/users/user-1', {
      method: 'DELETE',
      headers: { authorization: test.authorization },
    }, test.env)).status).toBe(200)

    expect(() => test.raw.prepare(
      `INSERT INTO users (
         id, email, display_name, role, status, auth_version, created_at_ms, updated_at_ms
       ) VALUES ('replacement', 'alice@example.test', 'Replacement', 'user', 'active', 1, ?, ?)`,
    ).run(now, now)).not.toThrow()
  })

  it('rolls back credential removal and compensates UserStateDO after a CAS conflict', async () => {
    const test = await fixture()
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO api_keys (
         id, user_id, key_hash, key_prefix, name, enabled, created_at_ms, updated_at_ms
       ) VALUES ('key-1', 'user-1', ?, 'sk-original', 'Original', 1, ?, ?)`,
    ).run('a'.repeat(64), now, now)
    test.state.onDisable = () => {
      test.raw.prepare(
        `UPDATE users SET display_name = 'Concurrent', control_version = control_version + 1
          WHERE id = 'user-1'`,
      ).run()
      test.state.onDisable = undefined
    }

    const response = await test.app.request('/users/user-1', {
      method: 'DELETE',
      headers: { authorization: test.authorization },
    }, test.env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'user_delete_conflict' },
    })
    expect(test.raw.prepare(
      `SELECT email, display_name, status FROM users WHERE id = 'user-1'`,
    ).get()).toEqual({
      email: 'alice@example.test',
      display_name: 'Concurrent',
      status: 'active',
    })
    expect(test.raw.prepare(
      `SELECT enabled, revoked_at_ms, key_hash FROM api_keys WHERE id = 'key-1'`,
    ).get()).toEqual({ enabled: 1, revoked_at_ms: null, key_hash: 'a'.repeat(64) })
    expect(test.state.calls.map((call) => call.enabled)).toEqual([true, false, true])
  })

  it('forbids an administrator from deleting their own account', async () => {
    const test = await fixture()

    const response = await test.app.request('/users/admin-1', {
      method: 'DELETE',
      headers: { authorization: test.authorization },
    }, test.env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'cannot_delete_self' } })
  })

  it('preserves the original contract that no administrator account is deletable', async () => {
    const test = await fixture()
    const now = Date.now()
    test.raw.prepare(
      `INSERT INTO users (
         id, email, display_name, role, status, auth_version, created_at_ms, updated_at_ms
       ) VALUES ('admin-2', 'second-admin@example.test', 'Second Admin', 'admin', 'active', 1, ?, ?)`,
    ).run(now, now)

    const response = await test.app.request('/users/admin-2', {
      method: 'DELETE',
      headers: { authorization: test.authorization },
    }, test.env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'cannot_delete_admin_user' },
    })
  })
})
