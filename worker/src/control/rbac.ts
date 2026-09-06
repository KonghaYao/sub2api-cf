import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError, gatewayErrorResponse } from '../gateway/errors'
import { authenticateAdminSession, type AdminActor } from './admin-auth'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
  type ControlIdempotency,
} from './idempotency'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  optionalBoolean,
  queryInteger,
  readJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
  requireString,
} from './http'

type ControlBindings = { Bindings: Env }

export const ADMIN_PERMISSIONS = [
  'admin.settings.read',
  'admin.settings.write',
  'admin.users.read',
  'admin.users.write',
  'admin.catalog.read',
  'admin.catalog.write',
  'admin.commerce.read',
  'admin.commerce.write',
  'admin.operations.read',
  'admin.operations.write',
  'admin.audit.read',
  'admin.rbac.read',
  'admin.rbac.write',
] as const

export type AdminPermission = typeof ADMIN_PERMISSIONS[number]

interface PermissionRow {
  permission_key: AdminPermission
  description: string
}

interface RolePermissionRow {
  role_id: string
  permission_key: AdminPermission
}

interface RoleRow {
  id: string
  name: string
  description: string
  system_key: 'super_admin' | 'admin' | 'read_only' | null
  active: number
  control_version: number
  created_at_ms: number
  updated_at_ms: number
}

export interface AdminRoleView {
  id: string
  name: string
  description: string
  system_key: RoleRow['system_key']
  system: boolean
  active: boolean
  permissions: AdminPermission[]
  control_version: number
  created_at_ms: number
  updated_at_ms: number
}

interface AssignmentRow {
  user_id: string
  role_id: string
  role_name: string
  role_system_key: RoleRow['system_key']
  role_active: number
  active: number
  control_version: number
  assigned_by_user_id: string | null
  assigned_at_ms: number
  revoked_by_user_id: string | null
  revoked_at_ms: number | null
}

interface AssignmentView {
  user_id: string
  role_id: string
  role_name: string
  role_system_key: RoleRow['system_key']
  role_active: boolean
  active: boolean
  control_version: number
  assigned_by_user_id: string | null
  assigned_at_ms: number
  revoked_by_user_id: string | null
  revoked_at_ms: number | null
}

interface RoleInput {
  name: string
  description: string
  active: boolean
  permissions: AdminPermission[]
}

interface RolePatch {
  name?: string
  description?: string
  active?: boolean
  permissions?: AdminPermission[]
}

export function requireAdminPermission(
  permission: AdminPermission,
): MiddlewareHandler<ControlBindings> {
  return async (context, next) => {
    try {
      await enforceAdminPermission(context, permission)
      await next()
    } catch (error) {
      return gatewayErrorResponse(asGatewayError(error))
    }
  }
}

/** Deny-by-default permission routing for every production administrative endpoint. */
export const requireAdminRoutePermission: MiddlewareHandler<ControlBindings> = async (
  context,
  next,
) => {
  try {
    const routePermissions = adminRoutePermissions(
      new URL(context.req.url).pathname,
      context.req.method,
    )
    for (const permission of routePermissions) {
      await enforceAdminPermission(context, permission)
    }
    await next()
  } catch (error) {
    return gatewayErrorResponse(asGatewayError(error))
  }
}

/** Select the read permission for safe methods and the write permission for mutations. */
export function requireAdminReadWritePermission(
  readPermission: AdminPermission,
  writePermission: AdminPermission,
): MiddlewareHandler<ControlBindings> {
  return async (context, next) => {
    const permission = context.req.method === 'GET' || context.req.method === 'HEAD'
      ? readPermission
      : writePermission
    return requireAdminPermission(permission)(context, next)
  }
}

async function enforceAdminPermission(
  context: Context<ControlBindings>,
  permission: AdminPermission,
): Promise<void> {
  const actor = await authenticateAdminSession(context.req.raw, context.env)
  const grant = await context.env.DB.prepare(
    `SELECT 1 AS allowed
       FROM admin_user_roles AS assignment
       JOIN admin_roles AS role ON role.id = assignment.role_id
       JOIN admin_role_permissions AS grant_row ON grant_row.role_id = role.id
      WHERE assignment.user_id = ?
        AND assignment.active = 1
        AND role.active = 1
        AND grant_row.permission_key = ?
      LIMIT 1`,
  ).bind(actor.user_id, permission).first<{ allowed: number }>()
  if (grant === null) {
    throw new GatewayError(
      403,
      'admin_permission_required',
      `Administrative permission is required: ${permission}`,
      'permission_error',
    )
  }
}

function adminRoutePermissions(pathname: string, method: string): AdminPermission[] {
  if (pathname.startsWith('/api/v1/admin/rbac/')) return []
  const write = method !== 'GET' && method !== 'HEAD'
  const category = (read: AdminPermission, mutation: AdminPermission): AdminPermission =>
    write ? mutation : read
  if (/^\/api\/v1\/admin\/audit(?:\/|$)/.test(pathname)) {
    return ['admin.audit.read']
  }
  if (/^\/api\/v1\/admin\/(?:settings$|oauth-providers(?:\/|$))/.test(pathname)) {
    return [category('admin.settings.read', 'admin.settings.write')]
  }
  if (
    /^\/api\/v1\/admin\/(?:groups|users)\/[^/]+\/subscriptions$/.test(pathname)
  ) {
    return [category('admin.commerce.read', 'admin.commerce.write')]
  }
  if (
    /^\/api\/v1\/admin\/accounts\/(?:[^/]+\/test|health-probes)$/.test(pathname)
  ) {
    return ['admin.catalog.write', 'admin.operations.write']
  }
  if (/^\/api\/v1\/admin\/accounts\/[^/]+\/stats$/.test(pathname)) {
    return ['admin.catalog.read', 'admin.operations.read']
  }
  if (
    /^\/api\/v1\/admin\/payment\/orders\/[^/]+\/(?:cancel|retry|refund\/query)$/.test(pathname)
  ) {
    return ['admin.commerce.write', 'admin.operations.write']
  }
  if (
    /^\/api\/v1\/admin\/payment\/reconciliation\/[^/]+\/(?:acknowledge|resolve|reopen)$/.test(pathname)
  ) {
    return ['admin.commerce.write', 'admin.operations.write']
  }
  if (/^\/api\/v1\/admin\/affiliates\/rebates\/accrue$/.test(pathname)) {
    return ['admin.commerce.write', 'admin.operations.write']
  }
  if (/^\/api\/v1\/admin\/users\/[^/]+\/platform-quotas\/reset$/.test(pathname)) {
    return ['admin.commerce.write', 'admin.operations.write']
  }
  if (/^\/api\/v1\/admin\/users\/[^/]+\/platform-quotas(?:\/|$)/.test(pathname)) {
    return [category('admin.commerce.read', 'admin.commerce.write')]
  }
  if (/^\/api\/v1\/admin\/(?:users|api-keys|financial-history)(?:\/|$)/.test(pathname)) {
    return [category('admin.users.read', 'admin.users.write')]
  }
  if (/^\/api\/v1\/admin\/(?:groups|models|accounts|channels)(?:\/|$)/.test(pathname)) {
    return [category('admin.catalog.read', 'admin.catalog.write')]
  }
  if (
    /^\/api\/v1\/admin\/(?:payment|subscriptions|redeem-codes|promo-codes|invitation-codes|affiliates|commercial|platform-quota-defaults)(?:\/|$)/.test(pathname)
  ) {
    return [category('admin.commerce.read', 'admin.commerce.write')]
  }
  return [category('admin.operations.read', 'admin.operations.write')]
}

export async function listAdminPermissions(context: Context<ControlBindings>): Promise<Response> {
  try {
    const result = await context.env.DB.prepare(
      `SELECT permission_key, description
         FROM admin_permissions
        ORDER BY permission_key`,
    ).all<PermissionRow>()
    return controlSuccess({ items: result.results })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminRoles(context: Context<ControlBindings>): Promise<Response> {
  try {
    const [roleResult, permissionResult] = await context.env.DB.batch([
      context.env.DB.prepare(`${roleSelect()} ORDER BY name COLLATE NOCASE, id`),
      context.env.DB.prepare(
        `SELECT role_id, permission_key
           FROM admin_role_permissions
          ORDER BY role_id, permission_key`,
      ),
    ])
    const permissionsByRole = new Map<string, AdminPermission[]>()
    for (const row of permissionResult.results as unknown as RolePermissionRow[]) {
      const permissions = permissionsByRole.get(row.role_id) ?? []
      permissions.push(row.permission_key)
      permissionsByRole.set(row.role_id, permissions)
    }
    const roles = (roleResult.results as unknown as RoleRow[]).map((row) =>
      roleViewWithPermissions(row, permissionsByRole.get(row.id) ?? []))
    return controlSuccess({ items: roles })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminRole(context: Context<ControlBindings>): Promise<Response> {
  try {
    const role = await requireRole(context.env, context.req.param('id'))
    return versionedControlSuccess(await roleView(context.env, role))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function createAdminRole(context: Context<ControlBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const input = parseRoleInput(await readJsonObject(context.req.raw))
    const idempotency = await controlIdempotency('admin.rbac.roles.create.v1', idempotencyKey, input)
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      return controlSuccess(parseIdempotentResponse<AdminRoleView>(previous, 'admin_role'))
    }

    const roleId = await deterministicUuid('admin.rbac.roles.create.v1', idempotencyKey)
    const now = Date.now()
    const response: AdminRoleView = {
      id: roleId,
      name: input.name,
      description: input.description,
      system_key: null,
      system: false,
      active: input.active,
      permissions: input.permissions,
      control_version: 0,
      created_at_ms: now,
      updated_at_ms: now,
    }
    const statements = [
      context.env.DB.prepare(
        `INSERT INTO admin_roles (
           id, name, description, system_key, active, control_version,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, NULL, ?, 0, ?, ?)`,
      ).bind(roleId, input.name, input.description, input.active ? 1 : 0, now, now),
      ...permissionInserts(context.env, roleId, input.permissions, now),
      auditInsert(
        context.env,
        actor,
        'admin_role.create',
        'admin_role',
        roleId,
        0,
        idempotency,
        { after: response },
        now,
      ),
      controlIdempotencyInsert(context.env, idempotency, 'admin_role', roleId, response, now),
    ]
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return controlSuccess(parseIdempotentResponse<AdminRoleView>(recovered, 'admin_role'))
      }
      throw mapRbacWriteError(error)
    }
    return versionedControlSuccess(response, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updateAdminRole(context: Context<ControlBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const roleId = requireResourceId(context.req.param('id'), 'admin_role')
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const patch = parseRolePatch(body)
    const idempotency = await controlIdempotency(
      'admin.rbac.roles.update.v1',
      idempotencyKey,
      { role_id: roleId, expected_control_version: expected, ...patch },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      return controlSuccess(parseIdempotentResponse<AdminRoleView>(previous, 'admin_role'))
    }
    const current = await requireRole(context.env, roleId)
    assertCustomRole(current)
    assertControlVersion(current.control_version, expected)
    const currentView = await roleView(context.env, current)
    const now = Date.now()
    const response: AdminRoleView = {
      ...currentView,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      active: patch.active ?? current.active === 1,
      permissions: patch.permissions ?? currentView.permissions,
      control_version: expected + 1,
      updated_at_ms: now,
    }
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `UPDATE admin_roles
            SET name = ?, description = ?, active = ?,
                control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                updated_at_ms = ?
          WHERE id = ? AND system_key IS NULL`,
      ).bind(
        response.name,
        response.description,
        response.active ? 1 : 0,
        expected,
        expected + 1,
        now,
        roleId,
      ),
    ]
    if (patch.permissions !== undefined) {
      statements.push(
        context.env.DB.prepare('DELETE FROM admin_role_permissions WHERE role_id = ?').bind(roleId),
        ...permissionInserts(context.env, roleId, patch.permissions, now),
      )
    }
    statements.push(
      auditInsert(
        context.env,
        actor,
        'admin_role.update',
        'admin_role',
        roleId,
        expected + 1,
        idempotency,
        { before: currentView, after: response },
        now,
      ),
      controlIdempotencyInsert(context.env, idempotency, 'admin_role', roleId, response, now),
    )
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return controlSuccess(parseIdempotentResponse<AdminRoleView>(recovered, 'admin_role'))
      }
      throw mapRbacWriteError(error)
    }
    return versionedControlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function deleteAdminRole(context: Context<ControlBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const roleId = requireResourceId(context.req.param('id'), 'admin_role')
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const body = await readOptionalJson(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const request = { role_id: roleId, expected_control_version: expected }
    const idempotency = await controlIdempotency('admin.rbac.roles.delete.v1', idempotencyKey, request)
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      return controlSuccess(parseIdempotentResponse(previous, 'admin_role_deletion'))
    }
    const role = await requireRole(context.env, roleId)
    assertCustomRole(role)
    assertControlVersion(role.control_version, expected)
    const deletedRole = await roleView(context.env, role)
    const now = Date.now()
    const response = { deleted: true, role: { ...deletedRole, control_version: expected + 1 } }
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE admin_roles
              SET control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                  updated_at_ms = ?
            WHERE id = ? AND system_key IS NULL`,
        ).bind(expected, expected + 1, now, roleId),
        context.env.DB.prepare(
          'DELETE FROM admin_roles WHERE id = ? AND control_version = ? AND system_key IS NULL',
        ).bind(roleId, expected + 1),
        auditInsert(
          context.env,
          actor,
          'admin_role.delete',
          'admin_role',
          roleId,
          expected + 1,
          idempotency,
          { before: deletedRole },
          now,
        ),
        controlIdempotencyInsert(
          context.env,
          idempotency,
          'admin_role_deletion',
          roleId,
          response,
          now,
        ),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return controlSuccess(parseIdempotentResponse(recovered, 'admin_role_deletion'))
      }
      throw mapRbacWriteError(error)
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminUserRoles(context: Context<ControlBindings>): Promise<Response> {
  try {
    const userId = requireResourceId(context.req.param('user_id'), 'user')
    await requireAdminUser(context.env, userId)
    const result = await context.env.DB.prepare(
      `${assignmentSelect()} WHERE assignment.user_id = ? ORDER BY role.name COLLATE NOCASE, role.id`,
    ).bind(userId).all<AssignmentRow>()
    return controlSuccess({ items: result.results.map(assignmentView) })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function assignAdminUserRole(context: Context<ControlBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const userId = requireResourceId(context.req.param('user_id'), 'user')
    const roleId = requireResourceId(context.req.param('role_id'), 'admin_role')
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const body = await readOptionalJson(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const request = { user_id: userId, role_id: roleId, expected_control_version: expected }
    const idempotency = await controlIdempotency('admin.rbac.assignments.assign.v1', idempotencyKey, request)
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      return controlSuccess(parseIdempotentResponse<AssignmentView>(previous, 'admin_user_role'))
    }
    await requireAdminUser(context.env, userId)
    const role = await requireRole(context.env, roleId)
    if (role.active !== 1) {
      throw new GatewayError(409, 'admin_role_disabled', 'Disabled administrative roles cannot be assigned')
    }
    const current = await findAssignment(context.env, userId, roleId)
    if (current !== null && current.active === 1) {
      throw new GatewayError(409, 'admin_role_already_assigned', 'Administrative role is already assigned')
    }
    const actualVersion = current?.control_version ?? 0
    assertControlVersion(actualVersion, expected)
    const now = Date.now()
    const response: AssignmentView = {
      user_id: userId,
      role_id: roleId,
      role_name: role.name,
      role_system_key: role.system_key,
      role_active: true,
      active: true,
      control_version: expected + 1,
      assigned_by_user_id: actor.user_id,
      assigned_at_ms: now,
      revoked_by_user_id: null,
      revoked_at_ms: null,
    }
    const assignmentStatement = current === null
      ? context.env.DB.prepare(
        `INSERT INTO admin_user_roles (
           user_id, role_id, active, control_version,
           assigned_by_user_id, assigned_at_ms, revoked_by_user_id, revoked_at_ms
         ) VALUES (?, ?, 1, 1, ?, ?, NULL, NULL)`,
      ).bind(userId, roleId, actor.user_id, now)
      : context.env.DB.prepare(
        `UPDATE admin_user_roles
            SET active = 1,
                control_version = CASE WHEN control_version = ? THEN ? ELSE 0 END,
                assigned_by_user_id = ?, assigned_at_ms = ?,
                revoked_by_user_id = NULL, revoked_at_ms = NULL
          WHERE user_id = ? AND role_id = ?`,
      ).bind(expected, expected + 1, actor.user_id, now, userId, roleId)
    try {
      await context.env.DB.batch([
        assignmentStatement,
        auditInsert(
          context.env,
          actor,
          'admin_user_role.assign',
          'admin_user_role',
          assignmentResourceId(userId, roleId),
          expected + 1,
          idempotency,
          { after: response },
          now,
        ),
        controlIdempotencyInsert(
          context.env,
          idempotency,
          'admin_user_role',
          assignmentResourceId(userId, roleId),
          response,
          now,
        ),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return controlSuccess(parseIdempotentResponse<AssignmentView>(recovered, 'admin_user_role'))
      }
      throw mapRbacWriteError(error)
    }
    return versionedControlSuccess(response, current === null ? 201 : 200)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function revokeAdminUserRole(context: Context<ControlBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const userId = requireResourceId(context.req.param('user_id'), 'user')
    const roleId = requireResourceId(context.req.param('role_id'), 'admin_role')
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const body = await readOptionalJson(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const request = { user_id: userId, role_id: roleId, expected_control_version: expected }
    const idempotency = await controlIdempotency('admin.rbac.assignments.revoke.v1', idempotencyKey, request)
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      return controlSuccess(parseIdempotentResponse<AssignmentView>(previous, 'admin_user_role'))
    }
    const current = await requireAssignment(context.env, userId, roleId)
    if (current.active !== 1) {
      throw new GatewayError(409, 'admin_role_not_assigned', 'Administrative role is not active for this user')
    }
    assertControlVersion(current.control_version, expected)
    const now = Date.now()
    const response: AssignmentView = {
      ...assignmentView(current),
      active: false,
      control_version: expected + 1,
      revoked_by_user_id: actor.user_id,
      revoked_at_ms: now,
    }
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE admin_user_roles
              SET active = 0,
                  control_version = CASE WHEN control_version = ? THEN ? ELSE 0 END,
                  revoked_by_user_id = ?, revoked_at_ms = ?
            WHERE user_id = ? AND role_id = ?`,
        ).bind(expected, expected + 1, actor.user_id, now, userId, roleId),
        auditInsert(
          context.env,
          actor,
          'admin_user_role.revoke',
          'admin_user_role',
          assignmentResourceId(userId, roleId),
          expected + 1,
          idempotency,
          { before: assignmentView(current), after: response },
          now,
        ),
        controlIdempotencyInsert(
          context.env,
          idempotency,
          'admin_user_role',
          assignmentResourceId(userId, roleId),
          response,
          now,
        ),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return controlSuccess(parseIdempotentResponse<AssignmentView>(recovered, 'admin_user_role'))
      }
      throw mapRbacWriteError(error)
    }
    return versionedControlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminRbacAuditEvents(context: Context<ControlBindings>): Promise<Response> {
  try {
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 50, 1, 100)
    const [count, rows] = await context.env.DB.batch([
      context.env.DB.prepare('SELECT COUNT(*) AS total FROM admin_rbac_audit_events'),
      context.env.DB.prepare(
        `SELECT id, actor_user_id, actor_session_id, action, resource_type,
                resource_id, resource_version, idempotency_key_hash,
                request_hash, details_json, occurred_at_ms
           FROM admin_rbac_audit_events
          ORDER BY occurred_at_ms DESC, id DESC
          LIMIT ? OFFSET ?`,
      ).bind(pageSize, (page - 1) * pageSize),
    ])
    const total = (count.results[0] as { total?: unknown } | undefined)?.total
    if (!Number.isSafeInteger(total) || (total as number) < 0) {
      throw new GatewayError(500, 'invalid_rbac_audit_count', 'RBAC audit count is invalid', 'server_error')
    }
    return controlSuccess({
      items: rows.results.map((row) => {
        const value = row as Record<string, unknown>
        return { ...value, details: parseStoredJson(value.details_json), details_json: undefined }
      }),
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil((total as number) / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function roleSelect(): string {
  return `SELECT id, name, description, system_key, active, control_version,
                 created_at_ms, updated_at_ms
            FROM admin_roles`
}

function assignmentSelect(): string {
  return `SELECT assignment.user_id, assignment.role_id, role.name AS role_name,
                 role.system_key AS role_system_key, role.active AS role_active,
                 assignment.active, assignment.control_version,
                 assignment.assigned_by_user_id, assignment.assigned_at_ms,
                 assignment.revoked_by_user_id, assignment.revoked_at_ms
            FROM admin_user_roles AS assignment
            JOIN admin_roles AS role ON role.id = assignment.role_id`
}

async function requireRole(env: Env, idValue: string | undefined): Promise<RoleRow> {
  const id = requireResourceId(idValue, 'admin_role')
  const role = await env.DB.prepare(`${roleSelect()} WHERE id = ?`).bind(id).first<RoleRow>()
  if (role === null) throw new GatewayError(404, 'admin_role_not_found', 'Administrative role was not found')
  return role
}

async function roleView(env: Env, row: RoleRow): Promise<AdminRoleView> {
  const result = await env.DB.prepare(
    `SELECT permission_key
       FROM admin_role_permissions
      WHERE role_id = ?
      ORDER BY permission_key`,
  ).bind(row.id).all<{ permission_key: AdminPermission }>()
  return roleViewWithPermissions(
    row,
    result.results.map((permission) => permission.permission_key),
  )
}

function roleViewWithPermissions(
  row: RoleRow,
  permissions: AdminPermission[],
): AdminRoleView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    system_key: row.system_key,
    system: row.system_key !== null,
    active: row.active === 1,
    permissions,
    control_version: row.control_version,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  }
}

async function requireAdminUser(env: Env, userId: string): Promise<void> {
  const user = await env.DB.prepare(
    'SELECT role FROM users WHERE id = ?',
  ).bind(userId).first<{ role: 'user' | 'admin' }>()
  if (user === null) throw new GatewayError(404, 'user_not_found', 'User was not found')
  if (user.role !== 'admin') {
    throw new GatewayError(409, 'admin_role_required', 'RBAC roles can only be assigned to administrators')
  }
}

async function findAssignment(env: Env, userId: string, roleId: string): Promise<AssignmentRow | null> {
  return env.DB.prepare(
    `${assignmentSelect()} WHERE assignment.user_id = ? AND assignment.role_id = ?`,
  ).bind(userId, roleId).first<AssignmentRow>()
}

async function requireAssignment(env: Env, userId: string, roleId: string): Promise<AssignmentRow> {
  const assignment = await findAssignment(env, userId, roleId)
  if (assignment === null) {
    throw new GatewayError(404, 'admin_user_role_not_found', 'Administrative role assignment was not found')
  }
  return assignment
}

function assignmentView(row: AssignmentRow): AssignmentView {
  return {
    user_id: row.user_id,
    role_id: row.role_id,
    role_name: row.role_name,
    role_system_key: row.role_system_key,
    role_active: row.role_active === 1,
    active: row.active === 1,
    control_version: row.control_version,
    assigned_by_user_id: row.assigned_by_user_id,
    assigned_at_ms: row.assigned_at_ms,
    revoked_by_user_id: row.revoked_by_user_id,
    revoked_at_ms: row.revoked_at_ms,
  }
}

function parseRoleInput(body: Record<string, unknown>): RoleInput {
  return {
    name: requireString(body, 'name', 128),
    description: optionalText(body, 'description', 1_024) ?? '',
    active: optionalBoolean(body, 'active') ?? true,
    permissions: parsePermissions(body.permissions, true) ?? [],
  }
}

function parseRolePatch(body: Record<string, unknown>): RolePatch {
  const patch: RolePatch = {}
  if (body.name !== undefined) patch.name = requireString(body, 'name', 128)
  const description = optionalText(body, 'description', 1_024)
  if (description !== undefined) patch.description = description
  const active = optionalBoolean(body, 'active')
  if (active !== undefined) patch.active = active
  const permissions = parsePermissions(body.permissions, false)
  if (permissions !== undefined) patch.permissions = permissions
  if (Object.keys(patch).length === 0) {
    throw new GatewayError(400, 'empty_update', 'At least one role field is required')
  }
  return patch
}

function parsePermissions(value: unknown, required: boolean): AdminPermission[] | undefined {
  if (value === undefined) {
    if (required) throw new GatewayError(400, 'invalid_permissions', 'permissions must be an array')
    return undefined
  }
  if (!Array.isArray(value) || value.length > ADMIN_PERMISSIONS.length) {
    throw new GatewayError(400, 'invalid_permissions', 'permissions must be an array of known permission keys')
  }
  const known = new Set<string>(ADMIN_PERMISSIONS)
  const resolved = new Set<AdminPermission>()
  for (const permission of value) {
    if (typeof permission !== 'string' || !known.has(permission)) {
      throw new GatewayError(400, 'invalid_permission', 'Every permission must be a known permission key')
    }
    resolved.add(permission as AdminPermission)
  }
  return [...resolved].sort()
}

function optionalText(
  body: Record<string, unknown>,
  field: string,
  maximum: number,
): string | undefined {
  if (body[field] === undefined) return undefined
  if (typeof body[field] !== 'string' || (body[field] as string).length > maximum) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a string no longer than ${maximum} characters`)
  }
  return (body[field] as string).trim()
}

function permissionInserts(
  env: Env,
  roleId: string,
  permissions: AdminPermission[],
  now: number,
): D1PreparedStatement[] {
  return permissions.map((permission) => env.DB.prepare(
    `INSERT INTO admin_role_permissions (role_id, permission_key, created_at_ms)
     VALUES (?, ?, ?)`,
  ).bind(roleId, permission, now))
}

function auditInsert(
  env: Env,
  actor: AdminActor,
  action: 'admin_role.create' | 'admin_role.update' | 'admin_role.delete' |
    'admin_user_role.assign' | 'admin_user_role.revoke',
  resourceType: 'admin_role' | 'admin_user_role',
  resourceId: string,
  resourceVersion: number,
  idempotency: ControlIdempotency,
  details: unknown,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO admin_rbac_audit_events (
       id, actor_user_id, actor_session_id, action, resource_type,
       resource_id, resource_version, idempotency_key_hash,
       request_hash, details_json, occurred_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    actor.user_id,
    actor.session_id,
    action,
    resourceType,
    resourceId,
    resourceVersion,
    idempotency.key_hash,
    idempotency.request_hash,
    JSON.stringify(details),
    now,
  )
}

function assertCustomRole(role: RoleRow): void {
  if (role.system_key !== null) {
    throw new GatewayError(409, 'system_admin_role_protected', 'Built-in administrative roles cannot be changed')
  }
}

function assertControlVersion(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new GatewayError(412, 'control_version_conflict', 'Resource changed; reload it and retry')
  }
  if (expected >= Number.MAX_SAFE_INTEGER) {
    throw new GatewayError(409, 'control_version_exhausted', 'Resource control version is exhausted')
  }
}

function assignmentResourceId(userId: string, roleId: string): string {
  return `${userId}:${roleId}`
}

function mapRbacWriteError(error: unknown): unknown {
  if (error instanceof GatewayError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('last_super_admin')) {
    return new GatewayError(
      409,
      'last_super_admin',
      'Assign another active super administrator before revoking this access',
    )
  }
  if (message.includes('system_admin_role')) {
    return new GatewayError(409, 'system_admin_role_protected', 'Built-in administrative roles cannot be changed')
  }
  if (message.includes('UNIQUE constraint failed: admin_roles.name')) {
    return new GatewayError(409, 'admin_role_name_conflict', 'An administrative role with this name already exists')
  }
  if (message.includes('UNIQUE constraint failed: admin_user_roles')) {
    return new GatewayError(412, 'control_version_conflict', 'Role assignment changed; reload it and retry')
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return new GatewayError(
      409,
      'admin_role_has_assignments',
      'Administrative roles with assignment history cannot be deleted; disable the role instead',
    )
  }
  if (message.includes('control_version') || message.includes('CHECK constraint failed: control_version')) {
    return new GatewayError(412, 'control_version_conflict', 'Resource changed; reload it and retry')
  }
  return error
}

async function readOptionalJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (text.trim() === '') return {}
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object')
    return value as Record<string, unknown>
  } catch {
    throw new GatewayError(400, 'invalid_json', 'Request body must be a JSON object')
  }
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function versionedControlSuccess(
  value: { control_version: number },
  status = 200,
): Response {
  const response = controlSuccess(value, status)
  response.headers.set('etag', `"${value.control_version}"`)
  return response
}
