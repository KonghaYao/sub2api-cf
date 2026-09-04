import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import { apiKeyDigest } from '../../src/gateway/crypto'
import {
  assignAdminUserRole,
  createAdminRole,
  deleteAdminRole,
  getAdminRole,
  listAdminPermissions,
  listAdminRbacAuditEvents,
  listAdminRoles,
  listAdminUserRoles,
  requireAdminPermission,
  revokeAdminUserRole,
  updateAdminRole,
} from '../../src/control/rbac'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const FIRST_ADMIN = 'admin-one'
const SECOND_ADMIN = 'admin-two'
const FIRST_TOKEN = 'first-admin-session-token-0001'
const SECOND_TOKEN = 'second-admin-session-token-001'
const ADMIN_TOKEN = 'break-glass-admin-token-00000001'
const PEPPER = 'p'.repeat(32)

interface Harness {
  app: Hono<{ Bindings: Env }>
  env: Env
  raw: any
}

async function harness(): Promise<Harness> {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw, 18)
  const now = Date.now()
  insertAdmin(raw, FIRST_ADMIN, now)
  insertAdmin(raw, SECOND_ADMIN, now + 1)
  await insertSession(raw, FIRST_ADMIN, 'session-one', FIRST_TOKEN, now)
  await insertSession(raw, SECOND_ADMIN, 'session-two', SECOND_TOKEN, now)

  const env: Env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    ADMIN_TOKEN,
    API_KEY_PEPPER: PEPPER,
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: d1,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  }
  const app = new Hono<{ Bindings: Env }>()
  app.get('/protected/read', requireAdminPermission('admin.users.read'), (context) => context.json({ ok: true }))
  app.post('/protected/write', requireAdminPermission('admin.users.write'), (context) => context.json({ ok: true }))
  app.get('/rbac/permissions', requireAdminPermission('admin.rbac.read'), listAdminPermissions)
  app.get('/rbac/roles', requireAdminPermission('admin.rbac.read'), listAdminRoles)
  app.post('/rbac/roles', requireAdminPermission('admin.rbac.write'), createAdminRole)
  app.get('/rbac/roles/:id', requireAdminPermission('admin.rbac.read'), getAdminRole)
  app.put('/rbac/roles/:id', requireAdminPermission('admin.rbac.write'), updateAdminRole)
  app.delete('/rbac/roles/:id', requireAdminPermission('admin.rbac.write'), deleteAdminRole)
  app.get('/rbac/users/:user_id/roles', requireAdminPermission('admin.rbac.read'), listAdminUserRoles)
  app.put(
    '/rbac/users/:user_id/roles/:role_id',
    requireAdminPermission('admin.rbac.write'),
    assignAdminUserRole,
  )
  app.delete(
    '/rbac/users/:user_id/roles/:role_id',
    requireAdminPermission('admin.rbac.write'),
    revokeAdminUserRole,
  )
  app.get('/rbac/audit', requireAdminPermission('admin.audit.read'), listAdminRbacAuditEvents)
  return { app, env, raw }
}

function insertAdmin(raw: any, id: string, now: number): void {
  raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
  ).run(id, `${id}@example.com`, id, now, now)
}

async function insertSession(
  raw: any,
  userId: string,
  sessionId: string,
  token: string,
  now: number,
): Promise<void> {
  raw.prepare(
    `INSERT INTO admin_sessions (
       id, user_id, token_hash, created_at_ms, expires_at_ms
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    userId,
    await apiKeyDigest(`admin-session:v1:${token}`, PEPPER),
    now,
    now + 60_000,
  )
}

function headers(
  token = FIRST_TOKEN,
  idempotencyKey?: string,
  version?: number,
): Record<string, string> {
  const result: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  }
  if (idempotencyKey !== undefined) result['idempotency-key'] = idempotencyKey
  if (version !== undefined) result['if-match'] = `"${version}"`
  return result
}

async function json(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>
}

describe('admin RBAC control plane', () => {
  let subject: Harness

  beforeEach(async () => {
    subject = await harness()
  })

  it('defaults to deny and only grants permissions through active roles', async () => {
    const denied = await subject.app.request('/protected/read', {
      headers: headers(SECOND_TOKEN),
    }, subject.env)
    expect(denied.status).toBe(403)
    expect((await json(denied)).error.code).toBe('admin_permission_required')

    subject.raw.prepare(
      `INSERT INTO admin_user_roles (
         user_id, role_id, active, control_version, assigned_by_user_id, assigned_at_ms
       ) VALUES (?, 'read_only', 1, 1, ?, ?)`,
    ).run(SECOND_ADMIN, FIRST_ADMIN, Date.now())
    const allowed = await subject.app.request('/protected/read', {
      headers: headers(SECOND_TOKEN),
    }, subject.env)
    const writeDenied = await subject.app.request('/protected/write', {
      method: 'POST', headers: headers(SECOND_TOKEN),
    }, subject.env)

    expect(allowed.status).toBe(200)
    expect(writeDenied.status).toBe(403)
  })

  it('fails closed for disabled roles, revoked sessions, and the break-glass token', async () => {
    const now = Date.now()
    subject.raw.prepare(
      `INSERT INTO admin_roles (
         id, name, description, active, control_version, created_at_ms, updated_at_ms
       ) VALUES ('custom-reader', 'Custom reader', '', 1, 0, ?, ?)`,
    ).run(now, now)
    subject.raw.prepare(
      `INSERT INTO admin_role_permissions (role_id, permission_key, created_at_ms)
       VALUES ('custom-reader', 'admin.users.read', ?)`,
    ).run(now)
    subject.raw.prepare(
      `INSERT INTO admin_user_roles (
         user_id, role_id, active, control_version, assigned_by_user_id, assigned_at_ms
       ) VALUES (?, 'custom-reader', 1, 1, ?, ?)`,
    ).run(SECOND_ADMIN, FIRST_ADMIN, now)

    subject.raw.prepare(`UPDATE admin_roles SET active = 0 WHERE id = 'custom-reader'`).run()
    const disabledRole = await subject.app.request('/protected/read', {
      headers: headers(SECOND_TOKEN),
    }, subject.env)
    expect(disabledRole.status).toBe(403)

    subject.raw.prepare(
      `UPDATE admin_sessions SET revoked_at_ms = ? WHERE id = 'session-one'`,
    ).run(now)
    const revokedSession = await subject.app.request('/protected/read', {
      headers: headers(FIRST_TOKEN),
    }, subject.env)
    expect(revokedSession.status).toBe(401)
    expect((await json(revokedSession)).error.code).toBe('invalid_admin_session')

    const breakGlass = await subject.app.request('/protected/read', {
      headers: headers(ADMIN_TOKEN),
    }, subject.env)
    expect(breakGlass.status).toBe(401)
    expect((await json(breakGlass)).error.code).toBe('invalid_admin_session')
  })

  it('creates, updates, lists, and deletes custom roles with CAS, idempotency, and audit', async () => {
    const createBody = JSON.stringify({
      name: 'Support',
      description: 'Customer support staff',
      permissions: ['admin.users.read', 'admin.commerce.read'],
    })
    const created = await subject.app.request('/rbac/roles', {
      method: 'POST',
      headers: headers(FIRST_TOKEN, 'create-support-role-0001'),
      body: createBody,
    }, subject.env)
    expect(created.status).toBe(201)
    expect(created.headers.get('etag')).toBe('"0"')
    const createdBody = await json(created)
    expect(createdBody.data).toMatchObject({
      name: 'Support',
      active: true,
      system: false,
      control_version: 0,
      permissions: ['admin.commerce.read', 'admin.users.read'],
    })
    const roleId = createdBody.data.id as string

    const replay = await subject.app.request('/rbac/roles', {
      method: 'POST',
      headers: headers(FIRST_TOKEN, 'create-support-role-0001'),
      body: createBody,
    }, subject.env)
    expect(replay.status).toBe(200)
    expect((await json(replay)).data.id).toBe(roleId)

    const conflictingReplay = await subject.app.request('/rbac/roles', {
      method: 'POST',
      headers: headers(FIRST_TOKEN, 'create-support-role-0001'),
      body: JSON.stringify({
        name: 'Different role',
        permissions: ['admin.users.read'],
      }),
    }, subject.env)
    expect(conflictingReplay.status).toBe(409)
    expect((await json(conflictingReplay)).code).toBe('idempotency_conflict')

    const updated = await subject.app.request(`/rbac/roles/${roleId}`, {
      method: 'PUT',
      headers: headers(FIRST_TOKEN, 'update-support-role-0001', 0),
      body: JSON.stringify({ active: false, permissions: ['admin.users.read'] }),
    }, subject.env)
    expect(updated.status).toBe(200)
    expect(updated.headers.get('etag')).toBe('"1"')
    expect((await json(updated)).data).toMatchObject({
      active: false,
      control_version: 1,
      permissions: ['admin.users.read'],
    })

    const stale = await subject.app.request(`/rbac/roles/${roleId}`, {
      method: 'PUT',
      headers: headers(FIRST_TOKEN, 'update-support-role-stale', 0),
      body: JSON.stringify({ name: 'Stale support' }),
    }, subject.env)
    expect(stale.status).toBe(412)
    expect((await json(stale)).code).toBe('control_version_conflict')

    const roles = await subject.app.request('/rbac/roles', {
      headers: headers(FIRST_TOKEN),
    }, subject.env)
    expect(roles.status).toBe(200)
    expect((await json(roles)).data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: roleId, name: 'Support' }),
      expect.objectContaining({ id: 'super_admin', system: true }),
    ]))

    const removed = await subject.app.request(`/rbac/roles/${roleId}`, {
      method: 'DELETE',
      headers: headers(FIRST_TOKEN, 'delete-support-role-0001', 1),
    }, subject.env)
    expect(removed.status).toBe(200)
    expect((await json(removed)).data.deleted).toBe(true)

    expect(subject.raw.prepare('SELECT COUNT(*) AS count FROM admin_rbac_audit_events').get())
      .toEqual({ count: 3 })
    expect(() => subject.raw.prepare('DELETE FROM admin_rbac_audit_events').run())
      .toThrow(/admin_rbac_audit_immutable/)
  })

  it('lists every role with one bounded permission query', async () => {
    const database = subject.env.DB
    const permissionQueries: string[] = []
    subject.env.DB = {
      prepare(query: string) {
        if (/FROM admin_role_permissions/i.test(query)) {
          permissionQueries.push(query)
        }
        return database.prepare(query)
      },
      batch(statements: D1PreparedStatement[]) {
        return database.batch(statements)
      },
    } as unknown as D1Database

    const response = await subject.app.request('/rbac/roles', {
      headers: headers(FIRST_TOKEN),
    }, subject.env)

    expect(response.status).toBe(200)
    expect((await json(response)).data.items).toHaveLength(3)
    expect(permissionQueries).toHaveLength(1)
  })

  it('rejects concurrent role writers and preserves the winner', async () => {
    const created = await subject.app.request('/rbac/roles', {
      method: 'POST',
      headers: headers(FIRST_TOKEN, 'create-concurrent-role'),
      body: JSON.stringify({ name: 'Concurrent', permissions: [] }),
    }, subject.env)
    const roleId = (await json(created)).data.id as string

    const [first, second] = await Promise.all([
      subject.app.request(`/rbac/roles/${roleId}`, {
        method: 'PUT',
        headers: headers(FIRST_TOKEN, 'concurrent-role-update-a', 0),
        body: JSON.stringify({ description: 'winner A' }),
      }, subject.env),
      subject.app.request(`/rbac/roles/${roleId}`, {
        method: 'PUT',
        headers: headers(FIRST_TOKEN, 'concurrent-role-update-b', 0),
        body: JSON.stringify({ description: 'winner B' }),
      }, subject.env),
    ])

    expect([first.status, second.status].sort()).toEqual([200, 412])
    const stored = subject.raw.prepare(
      'SELECT description, control_version FROM admin_roles WHERE id = ?',
    ).get(roleId) as { description: string; control_version: number }
    expect(stored.control_version).toBe(1)
    expect(['winner A', 'winner B']).toContain(stored.description)
  })

  it('protects built-in roles and the final active super administrator', async () => {
    const systemUpdate = await subject.app.request('/rbac/roles/super_admin', {
      method: 'PUT',
      headers: headers(FIRST_TOKEN, 'update-system-role-0001', 0),
      body: JSON.stringify({ active: false }),
    }, subject.env)
    expect(systemUpdate.status).toBe(409)
    expect((await json(systemUpdate)).code).toBe('system_admin_role_protected')

    const systemDelete = await subject.app.request('/rbac/roles/read_only', {
      method: 'DELETE',
      headers: headers(FIRST_TOKEN, 'delete-system-role-0001', 0),
    }, subject.env)
    expect(systemDelete.status).toBe(409)
    expect((await json(systemDelete)).code).toBe('system_admin_role_protected')

    const lastSuperAdmin = await subject.app.request(
      `/rbac/users/${FIRST_ADMIN}/roles/super_admin`,
      {
        method: 'DELETE',
        headers: headers(FIRST_TOKEN, 'revoke-last-super-admin', 1),
      },
      subject.env,
    )
    expect(lastSuperAdmin.status).toBe(409)
    expect((await json(lastSuperAdmin)).code).toBe('last_super_admin')

    const grantSecond = await subject.app.request(
      `/rbac/users/${SECOND_ADMIN}/roles/super_admin`,
      {
        method: 'PUT',
        headers: headers(FIRST_TOKEN, 'grant-second-super-admin', 0),
      },
      subject.env,
    )
    expect(grantSecond.status).toBe(201)

    const revokeFirst = await subject.app.request(
      `/rbac/users/${FIRST_ADMIN}/roles/super_admin`,
      {
        method: 'DELETE',
        headers: headers(FIRST_TOKEN, 'revoke-first-super-admin', 1),
      },
      subject.env,
    )
    expect(revokeFirst.status).toBe(200)
    expect((await json(revokeFirst)).data).toMatchObject({
      active: false,
      control_version: 2,
    })
  })

  it('keeps role assignment history instead of cascading it during role deletion', async () => {
    const created = await subject.app.request('/rbac/roles', {
      method: 'POST',
      headers: headers(FIRST_TOKEN, 'create-audited-role-0001'),
      body: JSON.stringify({ name: 'Audited role', permissions: ['admin.users.read'] }),
    }, subject.env)
    const roleId = (await json(created)).data.id as string
    const assigned = await subject.app.request(
      `/rbac/users/${SECOND_ADMIN}/roles/${roleId}`,
      {
        method: 'PUT',
        headers: headers(FIRST_TOKEN, 'assign-audited-role-0001', 0),
      },
      subject.env,
    )
    expect(assigned.status).toBe(201)

    const removed = await subject.app.request(`/rbac/roles/${roleId}`, {
      method: 'DELETE',
      headers: headers(FIRST_TOKEN, 'delete-audited-role-0001', 0),
    }, subject.env)

    expect(removed.status).toBe(409)
    expect((await json(removed)).code).toBe('admin_role_has_assignments')
    expect(subject.raw.prepare(
      'SELECT active FROM admin_user_roles WHERE user_id = ? AND role_id = ?',
    ).get(SECOND_ADMIN, roleId)).toEqual({ active: 1 })
  })

  it('assigns and revokes roles with versioned replay-safe mutations', async () => {
    const assigned = await subject.app.request(
      `/rbac/users/${SECOND_ADMIN}/roles/read_only`,
      {
        method: 'PUT',
        headers: headers(FIRST_TOKEN, 'assign-read-only-0001', 0),
      },
      subject.env,
    )
    expect(assigned.status).toBe(201)
    expect((await json(assigned)).data).toMatchObject({
      user_id: SECOND_ADMIN,
      role_id: 'read_only',
      active: true,
      control_version: 1,
    })

    const replay = await subject.app.request(
      `/rbac/users/${SECOND_ADMIN}/roles/read_only`,
      {
        method: 'PUT',
        headers: headers(FIRST_TOKEN, 'assign-read-only-0001', 0),
      },
      subject.env,
    )
    expect(replay.status).toBe(200)
    expect((await json(replay)).data.control_version).toBe(1)

    const revoked = await subject.app.request(
      `/rbac/users/${SECOND_ADMIN}/roles/read_only`,
      {
        method: 'DELETE',
        headers: headers(FIRST_TOKEN, 'revoke-read-only-0001', 1),
      },
      subject.env,
    )
    expect(revoked.status).toBe(200)
    expect((await json(revoked)).data).toMatchObject({ active: false, control_version: 2 })

    const staleReassignment = await subject.app.request(
      `/rbac/users/${SECOND_ADMIN}/roles/read_only`,
      {
        method: 'PUT',
        headers: headers(FIRST_TOKEN, 'reassign-read-only-stale', 1),
      },
      subject.env,
    )
    expect(staleReassignment.status).toBe(412)

    const assignments = await subject.app.request(`/rbac/users/${SECOND_ADMIN}/roles`, {
      headers: headers(FIRST_TOKEN),
    }, subject.env)
    expect(assignments.status).toBe(200)
    expect((await json(assignments)).data.items).toEqual([
      expect.objectContaining({ role_id: 'read_only', active: false, control_version: 2 }),
    ])

    const audit = await subject.app.request('/rbac/audit?page=1&page_size=10', {
      headers: headers(FIRST_TOKEN),
    }, subject.env)
    expect(audit.status).toBe(200)
    const auditBody = await json(audit)
    expect(auditBody.data).toMatchObject({ total: 2, page: 1, page_size: 10 })
    expect(auditBody.data.items[0]).toMatchObject({ details: expect.any(Object) })
    expect(JSON.stringify(auditBody)).not.toContain('details_json')
  })
})
