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

  it('allows account catalog readers to load proxy choices and denies proxy mutations', async () => {
    grantRole('proxy-reader', ['admin.catalog.read'])
    expect((await request('/api/v1/admin/proxies/all')).status).toBe(200)
    expect((await request('/api/v1/admin/proxies')).status).toBe(200)
    expect((await request('/api/v1/admin/proxies', 'POST')).status).toBe(403)
    expect((await request('/api/v1/admin/proxies/missing', 'PUT')).status).toBe(403)
    expect((await request('/api/v1/admin/proxies/missing', 'DELETE')).status).toBe(403)
  })

  it('classifies channel administration as catalog access', async () => {
    grantRole('channel-reader', ['admin.catalog.read'])

    const list = await request('/api/v1/admin/channels')
    const defaultPricing = await request(
      '/api/v1/admin/channels/model-pricing?model=claude-sonnet-4',
    )
    const syncedModels = await request(
      '/api/v1/admin/channels/pricing/sync-models?platform=antigravity',
    )
    const accountStats = await request('/api/v1/admin/accounts/missing/stats?days=30')
    const create = await request('/api/v1/admin/channels', 'POST')

    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      data: { items: [], total: 0 },
    })
    expect(defaultPricing.status).toBe(200)
    await expect(defaultPricing.json()).resolves.toMatchObject({
      data: { found: true, input_price: 3e-6, output_price: 15e-6 },
    })
    expect(syncedModels.status).toBe(200)
    await expect(syncedModels.json()).resolves.toMatchObject({
      data: { models: expect.arrayContaining(['claude-sonnet-4']) },
    })
    expect(accountStats.status).toBe(403)
    await expect(accountStats.json()).resolves.toMatchObject({
      error: {
        code: 'admin_permission_required',
        message: expect.stringContaining('admin.operations.read'),
      },
    })
    expect(create.status).toBe(403)
    await expect(create.json()).resolves.toMatchObject({
      error: {
        code: 'admin_permission_required',
        message: expect.stringContaining('admin.catalog.write'),
      },
    })
  })

  it('requires both catalog and operations read permissions for account statistics', async () => {
    grantRole('operations-reader-only', ['admin.operations.read'])

    const missingCatalog = await request('/api/v1/admin/accounts/missing/stats?days=30')
    expect(missingCatalog.status).toBe(403)
    await expect(missingCatalog.json()).resolves.toMatchObject({
      error: {
        code: 'admin_permission_required',
        message: expect.stringContaining('admin.catalog.read'),
      },
    })

    grantRole('catalog-reader-too', ['admin.catalog.read'])
    const authorized = await request('/api/v1/admin/accounts/missing/stats?days=30')
    expect(authorized.status).toBe(404)
    await expect(authorized.json()).resolves.toMatchObject({
      error: { code: 'account_not_found' },
    })
  })

  it('allows catalog readers to query mixed-channel risk without granting writes', async () => {
    grantRole('mixed-channel-reader', ['admin.catalog.read'])
    const response = await request('/api/v1/admin/accounts/check-mixed-channel', 'POST')
    // Empty input reaches validation instead of being denied as a mutation.
    expect(response.status).toBe(400)
    expect((await request('/api/v1/admin/accounts', 'POST')).status).toBe(403)
  })

  it('requires user-read permission for keys exposed through a group', async () => {
    grantRole('group-key-catalog-reader', ['admin.catalog.read'])
    const response = await request('/api/v1/admin/groups/group-1/api-keys')
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { message: expect.stringContaining('admin.users.read') } })
  })

  it('requires catalog write permission for applying reauthorized credentials', async () => {
    grantRole('reauth-reader', ['admin.catalog.read'])
    const response = await request('/api/v1/admin/accounts/opaque-account/apply-oauth-credentials', 'POST')
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('admin.catalog.write') } })
  })

  it('permits temporary state reads but requires catalog write for clearing', async () => {
    grantRole('temp-state-reader', ['admin.catalog.read'])
    expect((await request('/api/v1/admin/accounts/opaque-account/temp-unschedulable')).status).toBe(404)
    expect((await request('/api/v1/admin/accounts/opaque-account/temp-unschedulable', 'DELETE')).status).toBe(403)
  })

  it('requires catalog write for original batch account creation', async () => {
    grantRole('batch-create-reader', ['admin.catalog.read'])
    expect((await request('/api/v1/admin/accounts/batch', 'POST')).status).toBe(403)
  })

  it('requires catalog write for original batch credential field updates', async () => {
    grantRole('batch-field-reader', ['admin.catalog.read'])
    expect((await request('/api/v1/admin/accounts/batch-update-credentials', 'POST')).status).toBe(403)
  })

  it('requires catalog write permission for manual account privacy', async () => {
    grantRole('privacy-reader', ['admin.catalog.read'])
    const response = await request('/api/v1/admin/accounts/opaque-account/set-privacy', 'POST')
    expect(response.status).toBe(403)
  })

  it.each(['generate-auth-url', 'exchange-code', 'refresh-token'])('requires catalog write permission for OpenAI OAuth %s', async action => {
    grantRole('oauth-operations-only', ['admin.operations.write'])
    const response = await request(`/api/v1/admin/openai/${action}`, 'POST')
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('admin.catalog.write') } })
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

  it.each(['/api/v1/admin/accounts/account-1/models/sync-upstream', '/api/v1/admin/accounts/models/sync-upstream-preview'])('requires operations permission for model sync %s', async path => {
    grantRole('model-sync-catalog-writer', ['admin.catalog.write'])
    const response = await request(path, 'POST')
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: {
      code: 'admin_permission_required', message: expect.stringContaining('admin.operations.write'),
    } })
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

  it('requires operations permission in addition to catalog permission for queued batch probes', async () => {
    grantRole('batch-probe-catalog-writer', ['admin.catalog.write'])

    const response = await request('/api/v1/admin/accounts/health-probes', 'POST')

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'admin_permission_required',
        message: expect.stringContaining('admin.operations.write'),
      },
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

  it('requires operations write permission for request observation resolution actions', async () => {
    grantRole('operations-reader', ['admin.operations.read'])

    const read = await request('/api/v1/admin/ops/request-errors')
    const resolve = await request(
      '/api/v1/admin/ops/request-errors/observation-1/resolve',
      'POST',
    )

    expect(read.status).not.toBe(403)
    expect(resolve.status).toBe(403)
    await expect(resolve.json()).resolves.toMatchObject({
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
    const denied = await request('/api/v1/admin/audit-logs')
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: 'admin_permission_required' },
    })

    grantRole('audit-reader', ['admin.audit.read'])

    const audit = await request('/api/v1/admin/audit/events')
    const requestAudit = await request('/api/v1/admin/audit-logs')
    const requestAuditDetail = await request('/api/v1/admin/audit-logs/999')
    const deniedClear = await request('/api/v1/admin/audit-logs/clear', 'POST')
    const operations = await request('/api/v1/admin/payment/dashboard')

    expect(audit.status).toBe(200)
    await expect(audit.json()).resolves.toMatchObject({
      data: { items: [], has_more: false, next_cursor: null },
    })
    expect(requestAudit.status).toBe(200)
    await expect(requestAudit.json()).resolves.toMatchObject({
      data: {
        items: [{ action: 'GET /api/v1/admin/audit/events' }],
        total: 1, page: 1, page_size: 20, pages: 1,
      },
    })
    expect(requestAuditDetail.status).toBe(404)
    await expect(requestAuditDetail.json()).resolves.toMatchObject({
      error: { code: 'audit_log_not_found' },
    })
    expect(deniedClear.status).toBe(403)
    await expect(deniedClear.json()).resolves.toMatchObject({
      error: {
        code: 'admin_permission_required',
        message: expect.stringContaining('admin.operations.write'),
      },
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
