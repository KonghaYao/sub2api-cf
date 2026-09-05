import { beforeEach, describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../../src/auth/password'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'profile-test-pepper-value-that-is-at-least-32-bytes'
const DAY_MS = 86_400_000

class MemoryObjects {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>()

  async put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream, options?: R2PutOptions): Promise<R2Object> {
    if (!(value instanceof Uint8Array)) throw new Error('test avatar uploads must be Uint8Array')
    const metadata = options?.httpMetadata
    const contentType = metadata instanceof Headers
      ? metadata.get('content-type') ?? undefined
      : metadata?.contentType
    this.objects.set(key, { bytes: new Uint8Array(value), contentType })
    return { key } as R2Object
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key)
    return object === undefined
      ? null
      : ({ key, body: object.bytes, httpMetadata: { contentType: object.contentType } } as unknown as R2ObjectBody)
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }
}

interface Fixture {
  raw: any
  env: Env
  objects: MemoryObjects
  currentAuthorization: string
  otherAuthorization: string
}

let now = Date.now()

beforeEach(() => {
  now = Date.now()
})

async function fixture(): Promise<Fixture> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const credential = await hashPassword('correct horse battery staple')
  raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, password_credential, auth_version,
       password_changed_at_ms, created_at_ms, updated_at_ms
     ) VALUES ('alice', 'alice@example.test', 'Alice', 'user', 'active', ?, 1, ?, ?, ?)`,
  ).run(credential, now, now, now)
  const currentAccess = createOpaqueToken('access')
  const currentRefresh = createOpaqueToken('refresh')
  const otherAccess = createOpaqueToken('access')
  const otherRefresh = createOpaqueToken('refresh')
  for (const [id, family, access, refresh] of [
    ['current-session', 'current-family', currentAccess, currentRefresh],
    ['other-session', 'other-family', otherAccess, otherRefresh],
  ] as const) {
    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms, user_agent
       ) VALUES (?, ?, 'alice', 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, family, await tokenDigest(access, PEPPER, 'access'), await tokenDigest(refresh, PEPPER, 'refresh'),
      now, now + DAY_MS, now + 30 * DAY_MS, `${id} agent`,
    )
  }
  const objects = new MemoryObjects()
  return {
    raw,
    objects,
    currentAuthorization: `Bearer ${currentAccess}`,
    otherAuthorization: `Bearer ${otherAccess}`,
    env: {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      DB: d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: objects as unknown as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      USER_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    },
  }
}

async function request(test: Fixture, path: string, init: RequestInit = {}, authorization = test.currentAuthorization): Promise<Response> {
  return await createApp().request(path, {
    ...init,
    headers: { authorization, ...init.headers },
  }, test.env)
}

async function responseBody(response: Response): Promise<any> {
  return response.json()
}

describe('user profile HTTP contract', () => {
  it('projects the authenticated profile and persists a bounded R2-backed avatar without storing its data URL in D1', async () => {
    const test = await fixture()
    expect((await createApp().request('/api/v1/user/profile', {}, test.env)).status).toBe(401)
    await expect(responseBody(await request(test, '/api/v1/user/profile'))).resolves.toMatchObject({
      data: {
        id: 'alice',
        username: 'Alice',
        avatar_url: null,
        has_password: true,
        password_binding_required: false,
      },
    })

    const renamed = await request(test, '/api/v1/user', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Alice Cooper' }),
    })
    expect(renamed.status).toBe(200)
    expect((await responseBody(renamed)).data).toMatchObject({ username: 'Alice Cooper' })
    expect(test.raw.prepare('SELECT display_name FROM users WHERE id = ?').get('alice')).toEqual({ display_name: 'Alice Cooper' })

    const upload = await request(test, '/api/v1/user', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avatar_url: 'data:image/png;base64,AQID' }),
    })
    expect(upload.status).toBe(200)
    const avatarUrl = (await responseBody(upload)).data.avatar_url as string
    expect(avatarUrl).toMatch(/^\/api\/v1\/user\/avatar\/alice\?v=\d+$/)
    const stored = test.raw.prepare(
      'SELECT avatar_object_key, avatar_content_type FROM users WHERE id = ?',
    ).get('alice')
    expect(stored.avatar_object_key).toMatch(/^avatars\/alice\//)
    expect(stored.avatar_content_type).toBe('image/png')
    expect(JSON.stringify(stored)).not.toContain('data:image')
    expect(test.objects.objects.get(stored.avatar_object_key)?.bytes).toEqual(new Uint8Array([1, 2, 3]))

    const asset = await createApp().request(avatarUrl, {}, test.env)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('image/png')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))

    const secondUpload = await request(test, '/api/v1/user', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avatar_url: 'data:image/webp;base64,BAUG' }),
    })
    const secondAvatarUrl = (await responseBody(secondUpload)).data.avatar_url as string
    expect(secondAvatarUrl).not.toBe(avatarUrl)
    expect((await createApp().request(avatarUrl, {}, test.env)).status).toBe(404)

    const deleted = await request(test, '/api/v1/user', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ avatar_url: '' }),
    })
    expect((await responseBody(deleted)).data.avatar_url).toBeNull()
    expect(test.raw.prepare('SELECT avatar_object_key FROM users WHERE id = ?').get('alice')).toEqual({ avatar_object_key: null })
    expect(test.objects.objects.has(stored.avatar_object_key)).toBe(false)
    expect(test.raw.prepare(
      `SELECT COUNT(*) AS total FROM auth_audit_events WHERE user_id = 'alice' AND event_type = 'profile.update'`,
    ).get()).toEqual({ total: 4 })
  })

  it('routes notification preferences and rejects malformed or oversized profile updates without a false-success write', async () => {
    const test = await fixture()
    const notification = await request(test, '/api/v1/user', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ balance_notify_enabled: false, notification_preferences_version: 0 }),
    })
    expect(notification.status).toBe(200)
    expect((await responseBody(notification)).data).toMatchObject({
      balance_notify_enabled: false,
      notification_preferences_version: 1,
    })
    const combined = await request(test, '/api/v1/user', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Alice Combined',
        balance_notify_threshold: 2.5,
        notification_preferences_version: 1,
      }),
    })
    expect(combined.status).toBe(200)
    expect((await responseBody(combined)).data).toMatchObject({
      username: 'Alice Combined',
      balance_notify_enabled: false,
      balance_notify_threshold: 2.5,
      notification_preferences_version: 2,
    })
    const missingVersion = await request(test, '/api/v1/user', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Must Not Apply', balance_notify_enabled: true }),
    })
    expect(missingVersion.status).toBe(428)
    expect(test.raw.prepare('SELECT display_name FROM users WHERE id = ?').get('alice')).toEqual({
      display_name: 'Alice Combined',
    })
    const emailChange = await request(test, '/api/v1/user', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'changed@example.com' }),
    })
    expect(emailChange.status).toBe(400)
    const malformed = await request(test, '/api/v1/user', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ avatar_url: 'https://example.test/avatar.png' }),
    })
    expect(malformed.status).toBe(400)
    const tooLarge = await request(test, '/api/v1/user', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ avatar_url: `data:image/png;base64,${'A'.repeat(45_000)}` }),
    })
    expect(tooLarge.status).toBe(413)
    expect(test.objects.objects.size).toBe(0)
    expect(test.raw.prepare('SELECT avatar_object_key FROM users WHERE id = ?').get('alice')).toEqual({ avatar_object_key: null })
  })

  it('changes a password only after old-password verification, retains the current refresh family, and revokes all other sessions', async () => {
    const test = await fixture()
    const wrong = await request(test, '/api/v1/user/password', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ old_password: 'not the password', new_password: 'new secure password' }),
    })
    expect(wrong.status).toBe(401)
    expect(test.raw.prepare('SELECT auth_version FROM users WHERE id = ?').get('alice')).toEqual({ auth_version: 1 })

    const unchanged = await request(test, '/api/v1/user/password', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ old_password: 'correct horse battery staple', new_password: 'correct horse battery staple' }),
    })
    expect(unchanged.status).toBe(400)
    expect(test.raw.prepare('SELECT auth_version FROM users WHERE id = ?').get('alice')).toEqual({ auth_version: 1 })

    const changed = await request(test, '/api/v1/user/password', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ old_password: 'correct horse battery staple', new_password: 'new secure password' }),
    })
    expect(changed.status).toBe(200)
    expect((await responseBody(changed)).data).toEqual({ message: 'Password changed successfully' })
    const user = test.raw.prepare('SELECT password_credential, auth_version FROM users WHERE id = ?').get('alice')
    await expect(verifyPassword('new secure password', user.password_credential)).resolves.toBe(true)
    await expect(verifyPassword('correct horse battery staple', user.password_credential)).resolves.toBe(false)
    expect(test.raw.prepare(
      'SELECT auth_version, revoked_at_ms FROM user_sessions WHERE id = ?',
    ).get('current-session')).toEqual({ auth_version: 2, revoked_at_ms: null })
    expect(test.raw.prepare(
      'SELECT revoked_at_ms, revoke_reason FROM user_sessions WHERE id = ?',
    ).get('other-session')).toMatchObject({ revoke_reason: 'password_changed' })
    expect((await request(test, '/api/v1/user/profile')).status).toBe(200)
    expect((await request(test, '/api/v1/user/profile', {}, test.otherAuthorization)).status).toBe(401)
    expect(test.raw.prepare(
      `SELECT outcome FROM auth_audit_events WHERE event_type = 'auth.password.change' ORDER BY occurred_at_ms DESC`,
    ).all()).toEqual(expect.arrayContaining([{ outcome: 'succeeded' }, { outcome: 'failed' }]))
  })
})
