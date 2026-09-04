import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'p'.repeat(32)

describe('admin mutation security boundary', () => {
  let raw: any
  let env: Env
  let authorization: string

  beforeEach(async () => {
    const database = createSqliteD1()
    raw = database.raw
    applyMigrations(raw)
    const now = Date.now()
    const accessToken = createOpaqueToken('access')
    const refreshToken = createOpaqueToken('refresh')
    raw.prepare(
      `INSERT INTO users (
         id, email, display_name, role, status, auth_version, created_at_ms, updated_at_ms
       ) VALUES ('admin-1', 'admin@example.test', 'Admin', 'admin', 'active', 1, ?, ?)`,
    ).run(now, now)
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES ('admin-session-1', 'admin-family-1', 'admin-1', 1, ?, ?, ?, ?, ?)`,
    ).run(
      await tokenDigest(accessToken, PEPPER, 'access'),
      await tokenDigest(refreshToken, PEPPER, 'refresh'),
      now,
      now + 60_000,
      now + 120_000,
    )
    // Migration 0018 promotes the first administrator created after rollout.
    expect(raw.prepare(
      `SELECT active FROM admin_user_roles
        WHERE user_id = 'admin-1' AND role_id = 'super_admin'`,
    ).get()).toEqual({ active: 1 })
    authorization = `Bearer ${accessToken}`
    env = {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      DB: database.d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      USER_STATE: {} as DurableObjectNamespace,
      SUBSCRIPTION_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    }
  })

  it('rejects cross-site browser mutations while retaining non-browser administration', async () => {
    const crossSite = await mutate({
      origin: 'https://attacker.example',
      'sec-fetch-site': 'cross-site',
    })
    expect(crossSite.status).toBe(403)
    await expect(crossSite.json()).resolves.toMatchObject({
      error: { code: 'admin_origin_forbidden' },
    })

    const sameOrigin = await mutate({ origin: 'http://localhost' })
    expect(sameOrigin.status).not.toBe(403)

    const nonBrowser = await mutate()
    expect(nonBrowser.status).not.toBe(403)
  })

  it('requires a supplied Origin header to exactly equal the request origin', async () => {
    const response = await mutate({ origin: 'http://localhost/admin' })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'admin_origin_forbidden' },
    })
  })

  it('requires session-bound TOTP step-up only when the persisted switch is enabled', async () => {
    raw.prepare("UPDATE system_settings SET step_up_enabled = 1 WHERE id = 'global'").run()

    const withoutTotp = await mutate()
    expect(withoutTotp.status).toBe(403)
    await expect(withoutTotp.json()).resolves.toMatchObject({
      error: { code: 'STEP_UP_TOTP_NOT_ENABLED' },
    })

    const now = Date.now()
    raw.prepare(
      `INSERT INTO user_totp_credentials (
         user_id, nonce_b64, ciphertext_b64, enabled_at_ms, created_at_ms, updated_at_ms
       ) VALUES ('admin-1', ?, ?, ?, ?, ?)`,
    ).run('A'.repeat(16), 'B'.repeat(24), now, now, now)
    const withoutGrant = await mutate()
    expect(withoutGrant.status).toBe(403)
    await expect(withoutGrant.json()).resolves.toMatchObject({
      error: { code: 'STEP_UP_REQUIRED' },
    })

    raw.prepare(
      "UPDATE user_sessions SET step_up_expires_at_ms = ? WHERE id = 'admin-session-1'",
    ).run(now + 60_000)
    const granted = await mutate()
    expect(granted.status).not.toBe(403)
  })

  it('retains the independent break-glass recovery path when TOTP is unavailable', async () => {
    const now = Date.now()
    const recoveryToken = `adm-sub2api-${'r'.repeat(48)}`
    raw.prepare("UPDATE system_settings SET step_up_enabled = 1 WHERE id = 'global'").run()
    raw.prepare(
      `INSERT INTO user_totp_credentials (
         user_id, nonce_b64, ciphertext_b64, enabled_at_ms, created_at_ms, updated_at_ms
       ) VALUES ('admin-1', ?, ?, ?, ?, ?)`,
    ).run('A'.repeat(16), 'B'.repeat(24), now, now, now)
    raw.prepare(
      `INSERT INTO admin_sessions (
         id, user_id, token_hash, created_at_ms, expires_at_ms
       ) VALUES ('recovery-session-1', 'admin-1', ?, ?, ?)`,
    ).run(
      await apiKeyDigest(`admin-session:v1:${recoveryToken}`, PEPPER),
      now,
      now + 60_000,
    )
    authorization = `Bearer ${recoveryToken}`

    const response = await mutate()

    expect(response.status).not.toBe(403)
  })

  async function mutate(extraHeaders: Record<string, string> = {}): Promise<Response> {
    return createApp().request('/api/v1/admin/users', {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        ...extraHeaders,
      },
      body: '{}',
    }, env)
  }
})
