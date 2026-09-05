import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'p'.repeat(32)
const TOKEN = 'granular-admin-session-token-0001'

describe('production admin route permission matrix', () => {
  let raw: any
  let env: Env

  beforeEach(async () => {
    const database = createSqliteD1()
    raw = database.raw
    applyMigrations(raw)
    const now = Date.now()
    raw.prepare(
      `INSERT INTO users (
         id, email, display_name, role, status, created_at_ms, updated_at_ms
       ) VALUES ('root-admin', 'root@example.com', 'Root', 'admin', 'active', ?, ?)`,
    ).run(now, now)
    raw.prepare(
      `INSERT INTO users (
         id, email, display_name, role, status, created_at_ms, updated_at_ms
       ) VALUES ('granular-admin', 'granular@example.com', 'Granular', 'admin', 'active', ?, ?)`,
    ).run(now, now)
    raw.prepare(
      `INSERT INTO admin_sessions (
         id, user_id, token_hash, created_at_ms, expires_at_ms
       ) VALUES ('granular-session', 'granular-admin', ?, ?, ?)`,
    ).run(
      await apiKeyDigest(`admin-session:v1:${TOKEN}`, PEPPER),
      now,
      now + 60_000,
    )
    env = {
      APP_VERSION: 'test',
      ENVIRONMENT: 'test',
      API_KEY_PEPPER: PEPPER,
      DB: database.d1,
      CONFIG_KV: {} as KVNamespace,
      OBJECTS: {} as R2Bucket,
      EVENTS_QUEUE: {} as Queue,
      ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
      USER_STATE: {} as DurableObjectNamespace,
      SUBSCRIPTION_STATE: {} as DurableObjectNamespace,
      POOL_STATE: {} as DurableObjectNamespace,
    }
  })

  it('allows the granted read category and denies writes and unrelated categories', async () => {
    grantRole('user-reader', ['admin.users.read'])

    const users = await request('/api/v1/admin/users')
    const create = await request('/api/v1/admin/users', 'POST')
    const groups = await request('/api/v1/admin/groups')

    expect(users.status).toBe(200)
    expect(await create.clone().json()).toMatchObject({ error: { code: 'admin_permission_required' } })
    expect(create.status).toBe(403)
    expect(groups.status).toBe(403)
  })

  it('routes nested subscription reads to commerce instead of user or catalog permissions', async () => {
    grantRole('commerce-reader', ['admin.commerce.read'])

    const groupSubscriptions = await request('/api/v1/admin/groups/group-1/subscriptions')
    const userSubscriptions = await request('/api/v1/admin/users/user-1/subscriptions')
    const group = await request('/api/v1/admin/groups/group-1')
    const user = await request('/api/v1/admin/users/user-1')

    expect(groupSubscriptions.status).not.toBe(403)
    expect(userSubscriptions.status).not.toBe(403)
    expect(await group.clone().json()).toMatchObject({ error: { code: 'admin_permission_required' } })
    expect(group.status).toBe(403)
    expect(user.status).toBe(403)
  })

  it('requires operations permission in addition to catalog permission for probes', async () => {
    grantRole('catalog-writer', ['admin.catalog.write'])

    const response = await request('/api/v1/admin/accounts/account-1/test', 'POST')

    expect(await response.clone().json()).toMatchObject({ error: { code: 'admin_permission_required' } })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'admin_permission_required' },
    })
  })

  it('requires operations permission in addition to commerce permission for order cancellation', async () => {
    grantRole('commerce-writer', ['admin.commerce.write'])

    const response = await request('/api/v1/admin/payment/orders/order-1/cancel', 'POST')

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'admin_permission_required',
        message: expect.stringContaining('admin.operations.write'),
      },
    })
  })

  it('requires operations permission in addition to commerce permission for reconciliation actions', async () => {
    grantRole('commerce-reconciler', ['admin.commerce.write'])

    const response = await request(
      '/api/v1/admin/payment/reconciliation/issue-1/resolve',
      'POST',
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'admin_permission_required',
        message: expect.stringContaining('admin.operations.write'),
      },
    })
  })

  it('classifies promotions and affiliates as commerce while guarding manual accrual as operations', async () => {
    grantRole('commerce-operator', ['admin.commerce.read', 'admin.commerce.write'])

    const promotions = await request('/api/v1/admin/promo-codes')
    const accrue = await request('/api/v1/admin/affiliates/rebates/accrue', 'POST')

    expect(promotions.status).not.toBe(403)
    expect(accrue.status).toBe(403)
    await expect(accrue.json()).resolves.toMatchObject({
      error: {
        code: 'admin_permission_required',
        message: expect.stringContaining('admin.operations.write'),
      },
    })
  })

  it('classifies platform quota policy as commerce and guards manual resets as operations', async () => {
    grantRole('quota-operator', ['admin.commerce.read', 'admin.commerce.write'])

    const defaults = await request('/api/v1/admin/platform-quota-defaults')
    const userQuotas = await request('/api/v1/admin/users/user-1/platform-quotas')
    const reset = await request('/api/v1/admin/users/user-1/platform-quotas/reset', 'POST')

    expect(defaults.status).not.toBe(403)
    expect(userQuotas.status).not.toBe(403)
    expect(reset.status).toBe(403)
    await expect(reset.json()).resolves.toMatchObject({
      error: {
        code: 'admin_permission_required',
        message: expect.stringContaining('admin.operations.write'),
      },
    })
  })

  it('isolates the immutable audit stream behind the audit read permission', async () => {
    grantRole('audit-reader', ['admin.audit.read'])

    const audit = await request('/api/v1/admin/audit/events')
    const operations = await request('/api/v1/admin/payment/dashboard')

    expect(audit.status).toBe(200)
    await expect(audit.json()).resolves.toMatchObject({
      data: { items: [], has_more: false, next_cursor: null },
    })
    expect(operations.status).toBe(403)
    await expect(operations.json()).resolves.toMatchObject({
      error: { code: 'admin_permission_required' },
    })
  })

  function grantRole(roleId: string, permissions: string[]): void {
    const now = Date.now()
    raw.prepare(
      `INSERT INTO admin_roles (
         id, name, description, active, control_version, created_at_ms, updated_at_ms
       ) VALUES (?, ?, '', 1, 0, ?, ?)`,
    ).run(roleId, roleId, now, now)
    const permissionInsert = raw.prepare(
      `INSERT INTO admin_role_permissions (role_id, permission_key, created_at_ms)
       VALUES (?, ?, ?)`,
    )
    for (const permission of permissions) permissionInsert.run(roleId, permission, now)
    raw.prepare(
      `INSERT INTO admin_user_roles (
         user_id, role_id, active, control_version, assigned_by_user_id, assigned_at_ms
       ) VALUES ('granular-admin', ?, 1, 1, NULL, ?)`,
    ).run(roleId, now)
  }

  function request(path: string, method = 'GET'): Promise<Response> {
    return Promise.resolve(createApp().request(path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      ...(method === 'GET' ? {} : { body: '{}' }),
    }, env))
  }
})
