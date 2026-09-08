import type { Context } from 'hono'
import type { Env } from '../env'
import { hashPassword, PasswordValidationError, validateNewPassword } from '../auth/password'
import { sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { normalizeSubscriptionWindows } from '../subscription-windows'
import { authenticateAdminSession, type AdminActor } from './admin-auth'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
} from './idempotency'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  optionalString,
  queryInteger,
  readJsonObject,
  requireIdempotencyKey,
  requireResourceId,
  requireSafeInteger,
  requireString,
  optionalBoolean,
  optionalSafeInteger,
} from './http'

type ControlBindings = { Bindings: Env }

interface UserRow {
  id: string
  email: string
  display_name: string
  role: 'user' | 'admin'
  status: 'active' | 'disabled'
  balance_micros: number
  concurrency: number
  rpm_limit: number
  state_version: number
  control_version: number
  restrict_public_groups: number
  created_at_ms: number
  updated_at_ms: number
}

interface UserListRow extends UserRow {
  last_active_at_ms: number | null
  last_used_at_ms: number | null
}

interface UserGroupPermissionRow {
  user_id: string
  group_id: string
}

interface UserGroupRateRow extends UserGroupPermissionRow {
  rate_multiplier_ppm: number
}

interface UserListSubscriptionRow {
  id: string
  user_id: string
  group_id: string
  status: 'active' | 'suspended' | 'revoked' | 'expired'
  starts_at_ms: number
  expires_at_ms: number
  daily_quota_micros: number | null
  weekly_quota_micros: number | null
  monthly_quota_micros: number | null
  daily_used_micros: number
  weekly_used_micros: number
  monthly_used_micros: number
  daily_anchor_ms: number
  daily_window_start_ms: number | null
  weekly_window_start_ms: number | null
  monthly_window_start_ms: number | null
  control_version: number
  created_at_ms: number
  updated_at_ms: number
  group_name: string
  group_description: string | null
  group_platform: string
  group_enabled: number
  group_type: 'standard' | 'subscription'
  group_is_exclusive: number
  effective_rate_multiplier_ppm: number
}

interface UserConcurrencySnapshot {
  active_concurrency?: unknown
}

interface CreateUserInput {
  email: string
  display_name: string
  role: UserRow['role']
  balance_micros: number
  concurrency: number
  rpm_limit: number
  password?: string
  allowed_groups?: string[]
  restrict_public_groups?: boolean
  group_rates?: Record<string, number | null>
}

interface UserUpdatePatch {
  expected_control_version?: number
  email?: string
  display_name?: string
  role?: UserRow['role']
  status?: UserRow['status']
  concurrency?: number
  rpm_limit?: number
  password?: string
  allowed_groups?: string[]
  restrict_public_groups?: boolean
  group_rates?: Record<string, number | null>
}

interface UserFinancialEventRow {
  event_id: string
  user_id: string
  state_version: number
  event_type: 'opening_balance' | 'balance_adjustment' | 'settlement'
  source_type: string
  source_id: string
  request_id: string | null
  actor_user_id: string | null
  amount_delta_micros: number
  gross_amount_micros: number
  spend_debt_delta_micros: number
  balance_after_micros: number
  spend_debt_after_micros: number
  occurred_at_ms: number
}

interface DeletableUserRow extends UserRow {
  auth_version: number
}

interface BalanceHistoryCursor {
  v: 1
  occurred_at_ms: number
  event_id: string
}

const MAX_BALANCE_HISTORY_CURSOR_BYTES = 1_024
const LIVE_USER_SQL = `NOT (
  status = 'disabled' AND display_name = '[deleted]'
  AND email IN ('deleted-' || id || '@users.invalid', 'deleted+' || id || '@users.invalid')
)`

export async function createAdminUser(context: Context<ControlBindings>): Promise<Response> {
  try {
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const input = parseCreateUser(await readJsonObject(context.req.raw))
    const idempotency = await controlIdempotency('admin.users.create.v1', idempotencyKey, input)
    const userId = await deterministicUuid('admin.users.create.v1', idempotencyKey)
    const mutationDigest = await sha256Hex(`admin.users.create.v1\u0000${idempotencyKey}`)
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      const user = parseIdempotentResponse<UserRow>(previous, 'user')
      if (previous.resource_id !== user.id) {
        throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
      }
      await ensureUserConfigured(context.env, user, `admin-create:${mutationDigest}`, true)
      return controlSuccess(user)
    }

    const emailOwner = await findUserByEmail(context.env, input.email)
    if (emailOwner !== null) {
      throw new GatewayError(409, 'email_already_exists', 'A user with this email already exists')
    }
    const now = Date.now()
    const passwordCredential = input.password === undefined
      ? null
      : await hashPassword(input.password)
    const groupAccessChanged = hasGroupAccessPatch(input)
    const actor = groupAccessChanged
      ? await authenticateAdminSession(context.req.raw, context.env)
      : null
    const user: UserRow = {
      id: userId,
      email: input.email,
      display_name: input.display_name,
      role: input.role,
      status: 'active',
      balance_micros: input.balance_micros,
      concurrency: input.concurrency,
      rpm_limit: input.rpm_limit,
      state_version: 0,
      control_version: 0,
      restrict_public_groups: input.restrict_public_groups ? 1 : 0,
      created_at_ms: now,
      updated_at_ms: now,
    }
    await assertEditableUserGroups(context.env, input.allowed_groups, input.group_rates)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO users (
             id, email, display_name, role, status, balance_micros,
             concurrency, rpm_limit, state_version, created_at_ms, updated_at_ms,
             password_credential, password_changed_at_ms, email_verified_at_ms,
             financial_history_complete, restrict_public_groups
           ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 0, ?, ?, ?, ?, ?, 1, ?)`,
        ).bind(
          user.id,
          user.email,
          user.display_name,
          user.role,
          user.balance_micros,
          user.concurrency,
          user.rpm_limit,
          now,
          now,
          passwordCredential,
          passwordCredential === null ? null : now,
          passwordCredential === null ? null : now,
          user.restrict_public_groups,
        ),
        ...userGroupConfigStatements(context.env, user.id, input.allowed_groups, input.group_rates, now),
        ...(actor === null ? [] : [userGroupAccessAuditStatement(
          context.env,
          actor,
          'user.group_access.create',
          user.id,
          user.control_version,
          idempotency.key_hash,
          input,
          now,
        )]),
        controlIdempotencyInsert(context.env, idempotency, 'user', user.id, user, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered === null) {
        if (isUniqueEmailError(error)) {
          throw new GatewayError(409, 'email_already_exists', 'A user with this email already exists')
        }
        const conflictingEmail = await findUserByEmail(context.env, input.email)
        if (conflictingEmail !== null) {
          throw new GatewayError(409, 'email_already_exists', 'A user with this email already exists')
        }
        throw error
      }
      const replay = parseIdempotentResponse<UserRow>(recovered, 'user')
      await ensureUserConfigured(context.env, replay, `admin-create:${mutationDigest}`, true)
      return controlSuccess(replay)
    }

    await ensureUserConfigured(context.env, user, `admin-create:${mutationDigest}`, false)
    return controlSuccess(user, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminUsers(context: Context<ControlBindings>): Promise<Response> {
  try {
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const orderBy = parseUserListOrder(context.req.query('sort_by'), context.req.query('sort_order'))
    const conditions: string[] = [`NOT (
      u.status = 'disabled' AND u.display_name = '[deleted]'
      AND u.email IN ('deleted-' || u.id || '@users.invalid', 'deleted+' || u.id || '@users.invalid')
    )`]
    const values: unknown[] = []
    const status = context.req.query('status')
    if (status !== undefined) {
      if (status !== 'active' && status !== 'disabled') {
        throw new GatewayError(400, 'invalid_status', 'status must be active or disabled')
      }
      conditions.push('u.status = ?')
      values.push(status)
    }
    const role = context.req.query('role')
    if (role !== undefined) {
      if (role !== 'user' && role !== 'admin') {
        throw new GatewayError(400, 'invalid_role', 'role must be user or admin')
      }
      conditions.push('u.role = ?')
      values.push(role)
    }
    const search = context.req.query('search')?.trim()
    if (search) {
      if (search.length > 320) {
        throw new GatewayError(400, 'invalid_search', 'search must not exceed 320 characters')
      }
      conditions.push(
        `(u.email LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR EXISTS (
            SELECT 1
              FROM api_keys search_key
             WHERE search_key.user_id = u.id
               AND search_key.revoked_at_ms IS NULL
               AND (search_key.name LIKE ? ESCAPE '\\' COLLATE NOCASE
                    OR search_key.key_prefix LIKE ? ESCAPE '\\' COLLATE NOCASE)
          ))`,
      )
      const pattern = `%${escapeLike(search)}%`
      values.push(pattern, pattern, pattern, pattern)
    }

    const groupName = context.req.query('group_name')?.trim()
    if (groupName) {
      if (groupName.length > 128) {
        throw new GatewayError(400, 'invalid_group_name', 'group_name must not exceed 128 characters')
      }
      conditions.push(
        `EXISTS (
           SELECT 1
             FROM user_group_permissions permission
             JOIN "groups" allowed_group ON allowed_group.id = permission.group_id
            WHERE permission.user_id = u.id
              AND allowed_group.name LIKE ? ESCAPE '\\' COLLATE NOCASE
         )`,
      )
      values.push(`%${escapeLike(groupName)}%`)
    }

    const apiKeyGroupIdValue = context.req.query('api_key_group_id')?.trim()
    if (apiKeyGroupIdValue) {
      const apiKeyGroupId = requireResourceId(apiKeyGroupIdValue, 'group')
      conditions.push(
        `EXISTS (
           SELECT 1
             FROM api_keys api_key
            WHERE api_key.user_id = u.id
              AND api_key.group_id = ?
              AND api_key.revoked_at_ms IS NULL
         )`,
      )
      values.push(apiKeyGroupId)
    }

    for (const [attributeId, attributeValue] of parseUserAttributeFilters(context.req.raw)) {
      conditions.push(
        `EXISTS (
           SELECT 1
             FROM user_attribute_values attribute_value
            WHERE attribute_value.user_id = u.id
              AND attribute_value.attribute_id = ?
              AND attribute_value.value LIKE ? ESCAPE '\\' COLLATE NOCASE
         )`,
      )
      values.push(attributeId, `%${escapeLike(attributeValue)}%`)
    }

    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const countStatement = context.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM users u ${where}`,
    ).bind(...values)
    const rowsStatement = context.env.DB.prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.status, u.balance_micros,
              u.concurrency, u.rpm_limit, u.state_version, u.control_version,
              u.restrict_public_groups, u.created_at_ms, u.updated_at_ms,
              u.last_login_at_ms AS last_active_at_ms,
              (SELECT MAX(usage.occurred_at_ms)
                 FROM usage_projection usage
                WHERE usage.user_id = u.id) AS last_used_at_ms
         FROM users u
         ${where}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
    ).bind(...values, pageSize, (page - 1) * pageSize)
    const [countResult, rowsResult] = await context.env.DB.batch([countStatement, rowsStatement])
    const totalValue = (countResult.results[0] as { total?: unknown } | undefined)?.total
    if (!Number.isSafeInteger(totalValue) || (totalValue as number) < 0) {
      throw new GatewayError(500, 'invalid_user_count', 'User count projection is invalid', 'server_error')
    }
    const total = totalValue as number
    const rows = rowsResult.results as unknown as UserListRow[]
    const includeSubscriptions = parseUserListBoolean(
      context.req.query('include_subscriptions'),
      true,
    )
    const items = await hydrateAdminUserList(context.env, rows, includeSubscriptions)
    return controlSuccess({
      items,
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function parseUserListOrder(sortBy: string | undefined, sortOrder: string | undefined): string {
  const columns: Record<string, { column: string, nulls?: 'first' | 'last' | 'directional' }> = {
    id: { column: 'u.id' },
    email: { column: 'u.email COLLATE NOCASE' },
    username: { column: 'u.display_name COLLATE NOCASE' },
    role: { column: 'u.role' },
    balance: { column: 'u.balance_micros' },
    concurrency: { column: 'u.concurrency' },
    rpm: { column: 'u.rpm_limit' },
    rpm_limit: { column: 'u.rpm_limit' },
    status: { column: 'u.status' },
    last_active_at: { column: 'last_active_at_ms', nulls: 'last' },
    last_used_at: { column: 'last_used_at_ms', nulls: 'directional' },
    created_at: { column: 'u.created_at_ms' },
  }
  const key = sortBy ?? 'created_at'
  const projection = columns[key]
  if (projection === undefined) {
    throw new GatewayError(422, 'unsupported_user_sort', `User sort ${key} is not supported`)
  }
  if (sortOrder !== undefined && sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw new GatewayError(400, 'invalid_sort_order', 'sort_order must be asc or desc')
  }
  const direction = (sortOrder ?? 'desc').toUpperCase()
  const nullPlacement = projection.nulls === 'directional'
    ? (direction === 'ASC' ? 'first' : 'last')
    : projection.nulls
  const nullOrdering = projection.nulls === undefined
    ? ''
    : `${projection.column} IS NULL ${nullPlacement === 'last' ? 'ASC' : 'DESC'}, `
  const tieDirection = direction === 'ASC' ? 'ASC' : 'DESC'
  return `${nullOrdering}${projection.column} ${direction}, u.id ${tieDirection}`
}

function parseUserAttributeFilters(request: Request): Array<[number, string]> {
  const filters = new Map<number, string>()
  for (const [key, value] of new URL(request.url).searchParams) {
    const match = /^attr\[(\d+)\]$/.exec(key)
    if (match === null || value.length === 0) continue
    const attributeId = Number(match[1])
    if (!Number.isSafeInteger(attributeId) || attributeId <= 0 || filters.has(attributeId)) continue
    if (value.length > 16_384) {
      throw new GatewayError(400, 'invalid_attribute_filter', 'Attribute filter is too long')
    }
    filters.set(attributeId, value)
    if (filters.size > 50) {
      throw new GatewayError(400, 'too_many_attribute_filters', 'At most 50 attribute filters are allowed')
    }
  }
  return [...filters]
}

function parseUserListBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  switch (raw.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false
    default:
      return fallback
  }
}

async function hydrateAdminUserList(
  env: Env,
  rows: UserListRow[],
  includeSubscriptions: boolean,
): Promise<Array<Record<string, unknown>>> {
  const now = Date.now()
  const currentConcurrency = await loadUserCurrentConcurrency(env, rows.map((row) => row.id))
  const items = rows.map((row) => {
    const { last_active_at_ms: lastActiveAt, last_used_at_ms: lastUsedAt, ...user } = row
    return {
      ...user,
      allowed_groups: [] as string[],
      group_rates: Object.create(null) as Record<string, number>,
      current_concurrency: currentConcurrency.get(row.id) ?? 0,
      last_active_at: nullableUserListIso(lastActiveAt ?? null),
      last_used_at: nullableUserListIso(lastUsedAt ?? null),
      ...(includeSubscriptions ? { subscriptions: [] as Array<Record<string, unknown>> } : {}),
    }
  })
  if (items.length === 0) return items

  const ids = rows.map((row) => row.id)
  const placeholders = ids.map(() => '?').join(', ')
  const statements = [
    env.DB.prepare(
      `SELECT user_id, group_id
         FROM user_group_permissions
        WHERE user_id IN (${placeholders})
        ORDER BY user_id ASC, group_id ASC`,
    ).bind(...ids),
    env.DB.prepare(
      `SELECT user_id, group_id, rate_multiplier_ppm
         FROM user_group_rate_overrides
        WHERE user_id IN (${placeholders})
        ORDER BY user_id ASC, group_id ASC`,
    ).bind(...ids),
  ]
  if (includeSubscriptions) {
    statements.push(env.DB.prepare(
      `SELECT subscription.id, subscription.user_id, subscription.group_id,
              subscription.status, subscription.starts_at_ms, subscription.expires_at_ms,
              subscription.daily_quota_micros, subscription.weekly_quota_micros,
              subscription.monthly_quota_micros, subscription.daily_used_micros,
              subscription.weekly_used_micros, subscription.monthly_used_micros,
              subscription.daily_anchor_ms, subscription.daily_window_start_ms,
              subscription.weekly_window_start_ms, subscription.monthly_window_start_ms,
              subscription.control_version, subscription.created_at_ms,
              subscription.updated_at_ms, subscription_group.name AS group_name,
              subscription_group.description AS group_description,
              subscription_group.platform AS group_platform,
              subscription_group.enabled AS group_enabled,
              subscription_group.group_type AS group_type,
              subscription_group.is_exclusive AS group_is_exclusive,
              COALESCE(rate.rate_multiplier_ppm, subscription_group.rate_multiplier_ppm)
                AS effective_rate_multiplier_ppm
         FROM user_subscriptions subscription
         JOIN "groups" subscription_group ON subscription_group.id = subscription.group_id
         LEFT JOIN user_group_rate_overrides rate
           ON rate.user_id = subscription.user_id AND rate.group_id = subscription.group_id
        WHERE subscription.user_id IN (${placeholders})
          AND subscription.status = 'active'
        ORDER BY subscription.user_id ASC, subscription.expires_at_ms DESC, subscription.id ASC`,
    ).bind(...ids))
  }

  const results = await env.DB.batch(statements)
  const itemById = new Map(items.map((item) => [item.id as string, item]))
  for (const row of results[0].results as unknown as UserGroupPermissionRow[]) {
    const item = itemById.get(row.user_id)
    if (item !== undefined) (item.allowed_groups as string[]).push(row.group_id)
  }
  for (const row of results[1].results as unknown as UserGroupRateRow[]) {
    const item = itemById.get(row.user_id)
    if (item !== undefined) {
      const rates = item.group_rates as Record<string, number>
      rates[row.group_id] = userListMicros(row.rate_multiplier_ppm)
    }
  }
  if (includeSubscriptions) {
    for (const row of results[2].results as unknown as UserListSubscriptionRow[]) {
      const item = itemById.get(row.user_id)
      if (item !== undefined) {
        const subscriptions = item.subscriptions as Array<Record<string, unknown>>
        subscriptions.push(publicUserListSubscription(row, now))
      }
    }
  }
  return items
}

function publicUserListSubscription(
  row: UserListSubscriptionRow,
  now: number,
): Record<string, unknown> {
  const normalized = normalizeSubscriptionWindows(row, now)
  return {
    id: row.id,
    user_id: row.user_id,
    group_id: row.group_id,
    status: row.status === 'active' && (row.starts_at_ms > now || row.expires_at_ms <= now)
      ? 'expired'
      : row.status,
    starts_at: userListIso(row.starts_at_ms),
    expires_at: userListIso(row.expires_at_ms),
    daily_usage_usd: userListMicros(normalized.daily_used_micros),
    weekly_usage_usd: userListMicros(normalized.weekly_used_micros),
    monthly_usage_usd: userListMicros(normalized.monthly_used_micros),
    daily_window_start: nullableUserListIso(normalized.daily_window_start_ms),
    weekly_window_start: nullableUserListIso(normalized.weekly_window_start_ms),
    monthly_window_start: nullableUserListIso(normalized.monthly_window_start_ms),
    created_at: userListIso(row.created_at_ms),
    updated_at: userListIso(row.updated_at_ms),
    revoked_at: null,
    control_version: row.control_version,
    group: {
      id: row.group_id,
      name: row.group_name,
      description: row.group_description,
      platform: row.group_platform,
      status: row.group_enabled === 1 ? 'active' : 'inactive',
      subscription_type: row.group_type,
      is_exclusive: row.group_is_exclusive === 1,
      rate_multiplier: userListMicros(row.effective_rate_multiplier_ppm),
      daily_limit_usd: nullableUserListMicros(row.daily_quota_micros),
      weekly_limit_usd: nullableUserListMicros(row.weekly_quota_micros),
      monthly_limit_usd: nullableUserListMicros(row.monthly_quota_micros),
    },
  }
}

async function loadUserCurrentConcurrency(
  env: Env,
  userIds: string[],
): Promise<Map<string, number>> {
  const result = new Map(userIds.map((userId) => [userId, 0]))
  if (env.API_KEY_LIMIT_STATE === undefined || userIds.length === 0) return result

  await boundedUserListMap(userIds, 16, async (userId) => {
    try {
      const stub = env.API_KEY_LIMIT_STATE!.get(
        env.API_KEY_LIMIT_STATE!.idFromName(`user:${userId}`),
      )
      const response = await stub.fetch('https://state.internal/snapshot')
      if (!response.ok) return
      const snapshot = await response.json() as UserConcurrencySnapshot
      const current = snapshot.active_concurrency
      if (Number.isSafeInteger(current) && (current as number) >= 0) {
        result.set(userId, current as number)
      }
    } catch {
      // The original service treats transient concurrency-state lookup failures as zero.
    }
  })
  return result
}

async function boundedUserListMap<T>(
  items: T[],
  limit: number,
  visit: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await visit(items[next++]!)
  }))
}

function userListMicros(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError(500, 'invalid_user_list_projection', 'User list projection is invalid', 'server_error')
  }
  return value / 1_000_000
}

function nullableUserListMicros(value: number | null): number | null {
  return value === null ? null : userListMicros(value)
}

function userListIso(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new GatewayError(500, 'invalid_user_list_projection', 'User list projection is invalid', 'server_error')
  }
  return new Date(value).toISOString()
}

function nullableUserListIso(value: number | null): string | null {
  return value === null ? null : userListIso(value)
}

export async function getAdminUser(context: Context<ControlBindings>): Promise<Response> {
  try {
    const userId = requireResourceId(context.req.param('id'), 'user')
    const user = await findUserById(context.env, userId)
    if (user === null) throw new GatewayError(404, 'user_not_found', 'User was not found')

    let stateResponse = await fetchUserState(context.env, user.id, '/snapshot')
    if (!stateResponse.ok && (await responseErrorCode(stateResponse)) === 'user_not_configured') {
      stateResponse = await postUserState(context.env, user.id, '/configure', {
        schema_version: 1,
        mutation_id: `d1-user:${user.state_version}`,
        user_id: user.id,
        balance_micros: user.balance_micros,
        enabled: user.status === 'active',
        initial_state_version: user.state_version,
      })
    }
    if (!stateResponse.ok) throw await stateError(stateResponse)
    const state = await parseUserState(stateResponse, user.id)
    const groupConfig = await readUserGroupConfig(context.env, user.id)
    return controlSuccess({
      ...user,
      ...groupConfig,
      balance_micros: state.balance_micros,
      reserved_micros: state.reserved_micros,
      settled_micros: state.settled_micros,
      available_micros: state.available_micros,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/**
 * Soft-deletes a non-administrator while retaining its D1 identity as the
 * foreign-key anchor for immutable financial and audit history.
 */
export async function deleteAdminUser(context: Context<ControlBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const userId = requireResourceId(context.req.param('id'), 'user')
    const user = await findUserByIdIncludingDeleted(context.env, userId)
    if (user === null) throw new GatewayError(404, 'user_not_found', 'User was not found')
    if (isDeletedUser(user)) return controlSuccess(userDeletedResponse())
    if (user.role === 'admin') {
      throw new GatewayError(
        409,
        actor.user_id === user.id ? 'cannot_delete_self' : 'cannot_delete_admin_user',
        actor.user_id === user.id
          ? 'Administrators cannot delete their own account'
          : 'Administrator accounts cannot be deleted',
      )
    }

    const configured = await postUserState(context.env, user.id, '/configure', {
      schema_version: 1,
      mutation_id: `d1-user:${user.state_version}`,
      user_id: user.id,
      balance_micros: user.balance_micros,
      enabled: user.status === 'active',
      initial_state_version: user.state_version,
    })
    if (!configured.ok && (await responseErrorCode(configured)) !== 'user_already_configured') {
      throw await stateError(configured)
    }
    const mutationDigest = await sha256Hex(
      `admin.users.delete.v1\u0000${user.id}\u0000${user.control_version}`,
    )
    const disabled = await postUserState(context.env, user.id, '/enabled', {
      schema_version: 1,
      mutation_id: `admin-delete:${mutationDigest}`,
      enabled: false,
    })
    if (!disabled.ok) throw await stateError(disabled)
    const state = await parseUserState(disabled, user.id)
    const statusMutationApplied = state.idempotent === false && state.applied !== false
    const now = Date.now()
    const tombstoneEmail = deletedUserEmail(user.id)
    const userTombstone = context.env.DB.prepare(
      `UPDATE users
          SET email = ?, display_name = '[deleted]', status = 'disabled',
              password_credential = NULL, email_verified_at_ms = NULL,
              password_changed_at_ms = NULL, last_login_at_ms = NULL,
              auth_version = auth_version + 1,
              state_version = CASE WHEN state_version < ? THEN ? ELSE state_version END,
              balance_micros = ?,
              control_version = CASE
                WHEN control_version = ? AND role = 'user' AND email <> ?
                  THEN control_version + 1
                ELSE -1
              END,
              updated_at_ms = ?
        WHERE id = ?`,
    ).bind(
      tombstoneEmail,
      state.state_version,
      state.state_version,
      state.balance_micros,
      user.control_version,
      tombstoneEmail,
      now,
      user.id,
    )
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE api_keys
              SET key_hash = lower(hex(randomblob(32))), key_prefix = '[deleted]',
                  enabled = 0, revoked_at_ms = COALESCE(revoked_at_ms, ?),
                  auth_version = auth_version + 1,
                  control_version = control_version + 1,
                  updated_at_ms = ?
            WHERE user_id = ?`,
        ).bind(now, now, user.id),
        ...deleteUserAuthenticatorStatements(context.env, user.id),
        userTombstone,
        context.env.DB.prepare(
          `INSERT INTO auth_audit_events (
             id, user_id, event_type, outcome, email_hash, ip_hash,
             session_id, metadata_json, occurred_at_ms
           ) VALUES (?, ?, 'admin.users.delete', 'succeeded', NULL, NULL, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          actor.user_id,
          actor.session_id,
          JSON.stringify({
            target_user_id: user.id,
            target_control_version: user.control_version,
          }),
          now,
        ),
      ])
    } catch (error) {
      const current = await findUserByIdIncludingDeleted(context.env, user.id)
      if (current !== null && isDeletedUser(current)) {
        return controlSuccess(userDeletedResponse())
      }
      if (statusMutationApplied) {
        await compensateDeletedUserStatus(
          context.env,
          user,
          mutationDigest,
          state.state_version,
        )
      }
      if (isControlVersionError(error) || isUniqueEmailError(error)) {
        throw new GatewayError(
          409,
          'user_delete_conflict',
          'User changed concurrently; retry the deletion',
        )
      }
      throw error
    }
    return controlSuccess(userDeletedResponse())
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/**
 * Read the immutable D1 projection of authoritative UserStateDO financial
 * transitions. Cursor ordering is a complete tuple, so concurrent newer writes
 * never shift or duplicate an already-started traversal.
 */
export async function listAdminUserBalanceHistory(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const userId = requireResourceId(context.req.param('id'), 'user')
    const limit = queryInteger(context.req.query('limit'), 'limit', 20, 1, 100)
    const cursorRaw = context.req.query('cursor')
    const cursor = cursorRaw === undefined ? null : decodeBalanceHistoryCursor(cursorRaw)
    const type = parseBalanceHistoryType(context.req.query('type'))
    const user = await findUserById(context.env, userId)
    if (user === null) {
      throw new GatewayError(404, 'user_not_found', 'User was not found')
    }

    const conditions = ['user_id = ?']
    const values: unknown[] = [userId]
    appendBalanceHistoryTypeCondition(conditions, values, type)
    if (cursor !== null) {
      conditions.push('(occurred_at_ms < ? OR (occurred_at_ms = ? AND event_id < ?))')
      values.push(cursor.occurred_at_ms, cursor.occurred_at_ms, cursor.event_id)
    }
    const where = conditions.join(' AND ')
    const typeOnlyConditions = ['user_id = ?']
    const typeOnlyValues: unknown[] = [userId]
    appendBalanceHistoryTypeCondition(typeOnlyConditions, typeOnlyValues, type)
    const typeOnlyWhere = typeOnlyConditions.join(' AND ')

    const [rowsResult, summaryResult] = await context.env.DB.batch([
      context.env.DB.prepare(
        `SELECT event_id, user_id, state_version, event_type, source_type, source_id,
                request_id, actor_user_id,
                amount_delta_micros, gross_amount_micros,
                spend_debt_delta_micros, balance_after_micros,
                spend_debt_after_micros, occurred_at_ms
           FROM user_financial_events
          WHERE ${where}
          ORDER BY occurred_at_ms DESC, event_id DESC
          LIMIT ?`,
      ).bind(...values, limit + 1),
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total,
                (SELECT COALESCE(SUM(gross_amount_micros), 0)
                   FROM user_financial_events AS recharge
                  WHERE recharge.user_id = ?
                    AND recharge.event_type = 'balance_adjustment'
                    AND recharge.gross_amount_micros > 0
                ) AS total_recharged_micros,
                (SELECT applied_at_ms FROM schema_migrations WHERE version = 55)
                  AS history_available_from_ms,
                (SELECT financial_history_complete FROM users WHERE id = ?)
                  AS financial_history_complete,
                EXISTS (
                  SELECT 1 FROM user_financial_events AS opening
                   WHERE opening.user_id = ? AND opening.event_type = 'opening_balance'
                ) AS has_opening_event
           FROM user_financial_events
          WHERE ${typeOnlyWhere}`,
      ).bind(userId, userId, userId, ...typeOnlyValues),
    ])
    const rows = rowsResult.results as unknown as UserFinancialEventRow[]
    const summary = summaryResult.results[0] as {
      total?: unknown
      total_recharged_micros?: unknown
      history_available_from_ms?: unknown
      financial_history_complete?: unknown
      has_opening_event?: unknown
    } | undefined
    if (
      !Number.isSafeInteger(summary?.total) || (summary!.total as number) < 0 ||
      !Number.isSafeInteger(summary?.total_recharged_micros) ||
      (summary!.total_recharged_micros as number) < 0 ||
      !Number.isSafeInteger(summary?.history_available_from_ms) ||
      (summary!.history_available_from_ms as number) < 0 ||
      (summary?.financial_history_complete !== 0 && summary?.financial_history_complete !== 1) ||
      (summary?.has_opening_event !== 0 && summary?.has_opening_event !== 1)
    ) {
      throw new GatewayError(
        500,
        'invalid_balance_history_projection',
        'Balance history projection is invalid',
        'server_error',
      )
    }
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit)
    const last = items.at(-1)
    return controlSuccess({
      items,
      total: summary!.total,
      limit,
      has_more: hasMore,
      next_cursor: hasMore && last !== undefined ? encodeBalanceHistoryCursor(last) : null,
      total_recharged_micros: summary!.total_recharged_micros,
      history_complete:
        summary!.financial_history_complete === 1 && summary!.has_opening_event === 1,
      history_available_from_ms: summary!.history_available_from_ms,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function adjustAdminUserBalance(context: Context<ControlBindings>): Promise<Response> {
  try {
    const userId = requireResourceId(context.req.param('id'), 'user')
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw)
    const amountDeltaMicros = requireSafeInteger(
      body,
      'amount_delta_micros',
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    )
    const user = await findUserById(context.env, userId)
    if (user === null) throw new GatewayError(404, 'user_not_found', 'User was not found')

    const configured = await postUserState(context.env, user.id, '/configure', {
      schema_version: 1,
      mutation_id: `d1-user:${user.state_version}`,
      user_id: user.id,
      balance_micros: user.balance_micros,
      enabled: user.status === 'active',
      initial_state_version: user.state_version,
    })
    if (!configured.ok && (await responseErrorCode(configured)) !== 'user_already_configured') {
      throw await stateError(configured)
    }

    const mutationDigest = await sha256Hex(
      `admin.users.balance.adjust.v1\u0000${user.id}\u0000${idempotencyKey}`,
    )
    const adjusted = await postUserState(context.env, user.id, '/balance/adjust', {
      schema_version: 1,
      mutation_id: `admin-balance:${mutationDigest}`,
      amount_delta_micros: amountDeltaMicros,
      actor_user_id: actor.user_id,
      actor_session_id: actor.session_id,
    })
    if (!adjusted.ok) throw await stateError(adjusted)
    const state = await parseUserState(adjusted, user.id)
    const now = Date.now()
    await context.env.DB.prepare(
      `UPDATE users
          SET balance_micros = ?, state_version = ?, updated_at_ms = ?
        WHERE id = ? AND state_version < ?`,
    )
      .bind(state.balance_micros, state.state_version, now, user.id, state.state_version)
      .run()
    return controlSuccess({
      ...user,
      balance_micros: state.balance_micros,
      state_version: state.state_version,
      updated_at_ms: now,
      reserved_micros: state.reserved_micros,
      settled_micros: state.settled_micros,
      available_micros: state.available_micros,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updateAdminUser(context: Context<ControlBindings>): Promise<Response> {
  try {
    const userId = requireResourceId(context.req.param('id'), 'user')
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const patch = parseUserUpdatePatch(body)
    const idempotency = await controlIdempotency(
      'admin.users.update.v1',
      idempotencyKey,
      { user_id: userId, ...patch },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      const replay = parseIdempotentResponse<UserRow>(previous, 'user')
      if (previous.resource_id !== replay.id || replay.id !== userId) {
        throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
      }
      return controlSuccess(replay)
    }
    const user = await findUserById(context.env, userId)
    if (user === null) throw new GatewayError(404, 'user_not_found', 'User was not found')
    if (
      patch.expected_control_version !== undefined &&
      patch.expected_control_version !== user.control_version
    ) {
      throw new GatewayError(412, 'user_version_conflict', 'User changed; reload it and retry')
    }
    await assertEditableUserGroups(context.env, patch.allowed_groups, patch.group_rates)
    const groupAccessChanged = hasGroupAccessPatch(patch)
    const actor = groupAccessChanged
      ? await authenticateAdminSession(context.req.raw, context.env)
      : null
    const next = applyUserUpdatePatch(patch, user)
    if (
      user.role === 'admin' &&
      user.status === 'active' &&
      (next.role !== 'admin' || next.status !== 'active') &&
      !(await hasOtherActiveAdmin(context.env, user.id))
    ) {
      throw new GatewayError(
        409,
        'last_active_admin',
        'Create another active admin before disabling or demoting this account',
      )
    }
    let balanceMicros = user.balance_micros
    let stateVersion = user.state_version
    let controlVersion = user.control_version
    let projectedStatus = next.status
    let statusMutationDigest: string | null = null
    let statusMutationApplied = false
    const metadataChanged =
      next.email !== user.email ||
      next.display_name !== user.display_name ||
      next.role !== user.role ||
      next.concurrency !== user.concurrency ||
      next.rpm_limit !== user.rpm_limit ||
      patch.password !== undefined ||
      patch.restrict_public_groups !== undefined ||
      patch.allowed_groups !== undefined ||
      patch.group_rates !== undefined
    let updatedAtMs = user.updated_at_ms
    const statements: D1PreparedStatement[] = []

    if (metadataChanged) {
      const passwordCredential = patch.password === undefined
        ? null
        : await hashPassword(patch.password)
      updatedAtMs = Date.now()
      if (controlVersion >= Number.MAX_SAFE_INTEGER) {
        throw new GatewayError(409, 'control_version_exhausted', 'User control version is exhausted')
      }
      statements.push(
        context.env.DB.prepare(
          `UPDATE users
              SET email = ?, display_name = ?, role = ?, concurrency = ?, rpm_limit = ?,
                  restrict_public_groups = ?,
                  email_verified_at_ms = CASE
                    WHEN email <> ? THEN NULL
                    ELSE email_verified_at_ms
                  END,
                  password_credential = CASE
                    WHEN ? IS NULL THEN password_credential
                    ELSE ?
                  END,
                  password_changed_at_ms = CASE
                    WHEN ? IS NULL THEN password_changed_at_ms
                    ELSE ?
                  END,
                  auth_version = CASE
                    WHEN ? IS NULL THEN auth_version
                    ELSE auth_version + 1
                  END,
                  control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                  updated_at_ms = ?
            WHERE id = ?`,
        ).bind(
          next.email,
          next.display_name,
          next.role,
          next.concurrency,
          next.rpm_limit,
          patch.restrict_public_groups === undefined
            ? user.restrict_public_groups
            : patch.restrict_public_groups ? 1 : 0,
          next.email,
          passwordCredential,
          passwordCredential,
          passwordCredential,
          updatedAtMs,
          passwordCredential,
          controlVersion,
          controlVersion + 1,
          updatedAtMs,
          user.id,
        ),
      )
      statements.push(...userGroupConfigStatements(
        context.env,
        user.id,
        patch.allowed_groups,
        patch.group_rates,
        updatedAtMs,
      ))
      if (passwordCredential !== null) {
        statements.push(context.env.DB.prepare(
          `UPDATE user_sessions
              SET revoked_at_ms = ?, revoke_reason = 'admin_password_reset'
            WHERE user_id = ? AND revoked_at_ms IS NULL`,
        ).bind(updatedAtMs, user.id))
        statements.push(context.env.DB.prepare(
          `UPDATE admin_sessions
              SET revoked_at_ms = ?
            WHERE user_id = ? AND revoked_at_ms IS NULL`,
        ).bind(updatedAtMs, user.id))
      }
      controlVersion += 1
    }

    if (actor !== null) {
      statements.push(userGroupAccessAuditStatement(
        context.env,
        actor,
        'user.group_access.replace',
        user.id,
        controlVersion,
        idempotency.key_hash,
        patch,
        updatedAtMs,
      ))
    }

    if (patch.status !== undefined) {
      const configured = await postUserState(context.env, user.id, '/configure', {
        schema_version: 1,
        mutation_id: `d1-user:${user.state_version}`,
        user_id: user.id,
        balance_micros: user.balance_micros,
        enabled: user.status === 'active',
        initial_state_version: user.state_version,
      })
      if (!configured.ok && (await responseErrorCode(configured)) !== 'user_already_configured') {
        throw await stateError(configured)
      }
      statusMutationDigest = await sha256Hex(
        `admin.users.enabled.v1\u0000${user.id}\u0000${idempotencyKey}`,
      )
      const enabled = await postUserState(context.env, user.id, '/enabled', {
        schema_version: 1,
        mutation_id: `admin-enabled:${statusMutationDigest}`,
        enabled: next.status === 'active',
      })
      if (!enabled.ok) throw await stateError(enabled)
      const state = await parseUserState(enabled, user.id)
      statusMutationApplied = state.idempotent === false && state.applied !== false
      balanceMicros = state.balance_micros
      stateVersion = state.state_version
      projectedStatus = state.enabled ? 'active' : 'disabled'
      updatedAtMs = Date.now()
      statements.push(context.env.DB.prepare(
        `UPDATE users
            SET auth_version = CASE
                  WHEN status <> ? AND ? = 'disabled' THEN auth_version + 1
                  ELSE auth_version
                END,
                status = ?, balance_micros = ?, state_version = ?, updated_at_ms = ?
          WHERE id = ? AND state_version < ?`,
      ).bind(projectedStatus, projectedStatus, projectedStatus, balanceMicros, stateVersion, updatedAtMs, user.id, stateVersion))
      if (projectedStatus === 'disabled') {
        // Revocation is permanent: re-enabling an account must require a fresh
        // login instead of reviving sessions that existed before its suspension.
        // Gate on the projection so a stale DO result cannot revoke newer state.
        statements.push(context.env.DB.prepare(
          `UPDATE user_sessions
              SET revoked_at_ms = ?, revoke_reason = 'admin_user_disabled'
            WHERE user_id = ? AND revoked_at_ms IS NULL
              AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'disabled' AND state_version = ?)`,
        ).bind(updatedAtMs, user.id, user.id, stateVersion))
        statements.push(context.env.DB.prepare(
          `UPDATE admin_sessions
              SET revoked_at_ms = ?
            WHERE user_id = ? AND revoked_at_ms IS NULL
              AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'disabled' AND state_version = ?)`,
        ).bind(updatedAtMs, user.id, user.id, stateVersion))
      }
    }
    const response = {
      ...user,
      ...next,
      restrict_public_groups: patch.restrict_public_groups === undefined
        ? user.restrict_public_groups
        : patch.restrict_public_groups ? 1 : 0,
      status: projectedStatus,
      balance_micros: balanceMicros,
      state_version: stateVersion,
      control_version: controlVersion,
      updated_at_ms: updatedAtMs,
    }
    statements.push(controlIdempotencyInsert(
      context.env,
      idempotency,
      'user',
      user.id,
      response,
      Date.now(),
    ))
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        const replay = parseIdempotentResponse<UserRow>(recovered, 'user')
        if (recovered.resource_id !== replay.id || replay.id !== userId) {
          throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
        }
        return controlSuccess(replay)
      }
      if (
        statusMutationApplied &&
        statusMutationDigest !== null &&
        projectedStatus !== user.status
      ) {
        await compensateUserStatus(context.env, user, statusMutationDigest, stateVersion)
      }
      if (isUniqueEmailError(error)) {
        throw new GatewayError(409, 'email_already_exists', 'A user with this email already exists')
      }
      if (isControlVersionError(error)) {
        throw new GatewayError(409, 'user_update_conflict', 'User changed concurrently; retry the update')
      }
      if (isLastSuperAdminError(error)) {
        throw new GatewayError(
          409,
          'last_super_admin',
          'Assign another active super administrator before disabling or demoting this account',
        )
      }
      if (isLastActiveAdminError(error)) {
        throw new GatewayError(
          409,
          'last_active_admin',
          'Create another active admin before disabling or demoting this account',
        )
      }
      throw error
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function batchUpdateAdminUserLimits(context: Context<ControlBindings>): Promise<Response> {
  try {
    const key = requireIdempotencyKey(context.req.raw)
    const input = parseBatchUserLimits(await readJsonObject(context.req.raw, 128 * 1024))
    const idempotency = await controlIdempotency('admin.users.batch-limits.v1', key, input)
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      return controlSuccess(parseIdempotentResponse(previous, 'user_limits_batch'))
    }
    const now = Date.now()
    const placeholders = input.user_ids.map(() => '?').join(', ')
    const countGuard = `(SELECT COUNT(*) FROM users WHERE id IN (${placeholders})) = ?`
    const response = { affected: input.user_ids.length }
    const updated = context.env.DB.prepare(
      `UPDATE users
          SET concurrency = COALESCE(?, concurrency),
              rpm_limit = COALESCE(?, rpm_limit),
              control_version = control_version + 1,
              updated_at_ms = ?
        WHERE id IN (${placeholders}) AND ${countGuard}`,
    ).bind(
      input.concurrency ?? null,
      input.rpm_limit ?? null,
      now,
      ...input.user_ids,
      ...input.user_ids,
      input.user_ids.length,
    )
    const idempotencyInsert = context.env.DB.prepare(
      `INSERT INTO control_idempotency (
         scope, key_hash, request_hash, resource_type, resource_id,
         response_json, created_at_ms, expires_at_ms
       ) SELECT ?, ?, ?, 'user_limits_batch', ?, ?, ?, ?
         WHERE ${countGuard}`,
    ).bind(
      idempotency.scope,
      idempotency.key_hash,
      idempotency.request_hash,
      input.user_ids.join(','),
      JSON.stringify(response),
      now,
      now + 7 * 24 * 60 * 60 * 1_000,
      ...input.user_ids,
      input.user_ids.length,
    )
    const result = await context.env.DB.batch([updated, idempotencyInsert])
    if (result[0].meta.changes !== input.user_ids.length) {
      throw new GatewayError(409, 'user_batch_conflict', 'A selected user no longer exists; reload and retry')
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function parseCreateUser(body: Record<string, unknown>): CreateUserInput {
  const email = requireString(body, 'email', 320).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new GatewayError(400, 'invalid_email', 'email must be a valid email address')
  }
  const role = body.role ?? 'user'
  if (role !== 'user' && role !== 'admin') {
    throw new GatewayError(400, 'invalid_role', 'role must be user or admin')
  }
  return {
    email,
    display_name: optionalString(body, 'display_name', 256) ?? '',
    role,
    balance_micros: body.balance_micros === undefined
      ? 0
      : requireSafeInteger(body, 'balance_micros'),
    concurrency: optionalSafeInteger(body, 'concurrency') ?? 5,
    rpm_limit: optionalSafeInteger(body, 'rpm_limit') ?? 0,
    password: optionalNewPassword(body),
    allowed_groups: parseOptionalGroupIds(body, 'allowed_groups'),
    restrict_public_groups: optionalBoolean(body, 'restrict_public_groups'),
    group_rates: parseOptionalGroupRates(body),
  }
}

function parseUserUpdatePatch(body: Record<string, unknown>): UserUpdatePatch {
  const patch: UserUpdatePatch = {}
  patch.expected_control_version = optionalSafeInteger(body, 'expected_control_version')
  if (body.email !== undefined) {
    const email = requireString(body, 'email', 320).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new GatewayError(400, 'invalid_email', 'email must be a valid email address')
    }
    patch.email = email
  }
  if (body.display_name !== undefined) {
    patch.display_name = requireString(body, 'display_name', 256)
  }
  if (body.role !== undefined) {
    if (body.role !== 'user' && body.role !== 'admin') {
      throw new GatewayError(400, 'invalid_role', 'role must be user or admin')
    }
    patch.role = body.role
  }
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'disabled') {
      throw new GatewayError(400, 'invalid_status', 'status must be active or disabled')
    }
    patch.status = body.status
  }
  patch.concurrency = optionalSafeInteger(body, 'concurrency')
  patch.rpm_limit = optionalSafeInteger(body, 'rpm_limit')
  patch.password = optionalNewPassword(body)
  patch.allowed_groups = parseOptionalGroupIds(body, 'allowed_groups')
  patch.restrict_public_groups = optionalBoolean(body, 'restrict_public_groups')
  patch.group_rates = parseOptionalGroupRates(body)
  return patch
}

function parseBatchUserLimits(body: Record<string, unknown>): {
  user_ids: string[]
  concurrency?: number
  rpm_limit?: number
} {
  const allowed = new Set(['user_ids', 'all', 'concurrency', 'rpm_limit'])
  const unknown = Object.keys(body).find((key) => !allowed.has(key))
  if (unknown !== undefined) throw new GatewayError(400, 'unsupported_batch_limits_field', `${unknown} is not supported`)
  if (body.all === true) {
    throw new GatewayError(422, 'worker_batch_all_not_supported', 'Worker batch limit updates require explicit user IDs')
  }
  if (body.all !== undefined && body.all !== false) {
    throw new GatewayError(400, 'invalid_all', 'all must be boolean')
  }
  if (!Array.isArray(body.user_ids) || body.user_ids.length === 0 || body.user_ids.length > 500) {
    throw new GatewayError(400, 'invalid_user_ids', 'user_ids must contain between 1 and 500 user IDs')
  }
  const userIds = body.user_ids.map((value) => requireResourceId(
    typeof value === 'string' || typeof value === 'number' ? String(value) : undefined,
    'user',
  ))
  if (new Set(userIds).size !== userIds.length) {
    throw new GatewayError(400, 'duplicate_user_id', 'user_ids must not contain duplicates')
  }
  const concurrency = optionalSafeInteger(body, 'concurrency')
  const rpmLimit = optionalSafeInteger(body, 'rpm_limit')
  if (concurrency === undefined && rpmLimit === undefined) {
    throw new GatewayError(400, 'empty_batch_limits_update', 'Provide concurrency or rpm_limit')
  }
  return { user_ids: userIds, ...(concurrency === undefined ? {} : { concurrency }), ...(rpmLimit === undefined ? {} : { rpm_limit: rpmLimit }) }
}

function parseOptionalGroupIds(body: Record<string, unknown>, field: string): string[] | undefined {
  if (body[field] === undefined) return undefined
  if (body[field] === null) return []
  if (!Array.isArray(body[field]) || body[field].length > 100) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must contain at most 100 group IDs`)
  }
  return [...new Set(body[field].map((value) => requireResourceId(
    typeof value === 'number' ? String(value) : value as string | undefined,
    'group',
  )))].sort()
}

function parseOptionalGroupRates(body: Record<string, unknown>): Record<string, number | null> | undefined {
  if (body.group_rates === undefined) return undefined
  if (body.group_rates === null || typeof body.group_rates !== 'object' || Array.isArray(body.group_rates)) {
    throw new GatewayError(400, 'invalid_group_rates', 'group_rates must be an object')
  }
  const values = Object.entries(body.group_rates as Record<string, unknown>)
  if (values.length > 100) {
    throw new GatewayError(400, 'invalid_group_rates', 'group_rates must contain at most 100 entries')
  }
  const rates: Record<string, number | null> = Object.create(null) as Record<string, number | null>
  for (const [rawGroupId, rawRate] of values) {
    const groupId = requireResourceId(rawGroupId, 'group')
    if (rawRate === null) {
      rates[groupId] = null
      continue
    }
    if (typeof rawRate !== 'number' || !Number.isFinite(rawRate) || rawRate < 0) {
      throw new GatewayError(400, 'invalid_group_rates', 'Group rates must be non-negative numbers')
    }
    const ppm = Math.round(rawRate * 1_000_000)
    if (!Number.isSafeInteger(ppm) || ppm > Number.MAX_SAFE_INTEGER) {
      throw new GatewayError(400, 'invalid_group_rates', 'Group rate is out of range')
    }
    rates[groupId] = ppm
  }
  return rates
}

async function assertEditableUserGroups(
  env: Env,
  allowedGroups: readonly string[] | undefined,
  groupRates: Record<string, number | null> | undefined,
): Promise<void> {
  const ids = [...new Set([...(allowedGroups ?? []), ...Object.keys(groupRates ?? {})])]
  if (ids.length === 0) return
  const results = await env.DB.batch(ids.map((id) => env.DB.prepare(
    `SELECT id FROM "groups" WHERE id = ? AND enabled = 1 AND group_type = 'standard'`,
  ).bind(id)))
  if (results.some((result) => result.results.length !== 1)) {
    throw new GatewayError(409, 'invalid_user_group', 'Groups must be active standard groups')
  }
}

function userGroupConfigStatements(
  env: Env,
  userId: string,
  allowedGroups: readonly string[] | undefined,
  groupRates: Record<string, number | null> | undefined,
  now: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  if (allowedGroups !== undefined) {
    statements.push(env.DB.prepare('DELETE FROM user_group_permissions WHERE user_id = ?').bind(userId))
    for (const groupId of allowedGroups) {
      statements.push(env.DB.prepare(
        `INSERT INTO user_group_permissions (user_id, group_id, granted_by_user_id, created_at_ms)
         VALUES (?, ?, NULL, ?)`,
      ).bind(userId, groupId, now))
    }
  }
  for (const [groupId, ratePpm] of Object.entries(groupRates ?? {})) {
    if (ratePpm === null) {
      statements.push(env.DB.prepare(
        'DELETE FROM user_group_rate_overrides WHERE user_id = ? AND group_id = ?',
      ).bind(userId, groupId))
    } else {
      statements.push(env.DB.prepare(
        `INSERT INTO user_group_rate_overrides (
           user_id, group_id, rate_multiplier_ppm, control_version, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(user_id, group_id) DO UPDATE SET
           rate_multiplier_ppm = excluded.rate_multiplier_ppm,
           control_version = user_group_rate_overrides.control_version + 1,
           updated_at_ms = excluded.updated_at_ms`,
      ).bind(userId, groupId, ratePpm, now, now))
    }
  }
  return statements
}

function hasGroupAccessPatch(input: Pick<
  CreateUserInput | UserUpdatePatch,
  'allowed_groups' | 'restrict_public_groups' | 'group_rates'
>): boolean {
  return input.allowed_groups !== undefined ||
    input.restrict_public_groups !== undefined ||
    input.group_rates !== undefined
}

function userGroupAccessAuditStatement(
  env: Env,
  actor: AdminActor,
  action: 'user.group_access.create' | 'user.group_access.replace',
  targetUserId: string,
  controlVersion: number,
  idempotencyKeyHash: string,
  patch: Pick<CreateUserInput | UserUpdatePatch, 'allowed_groups' | 'restrict_public_groups' | 'group_rates'>,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO admin_user_group_access_audit_events (
       id, actor_user_id, actor_session_id, action, target_user_id, control_version,
       idempotency_key_hash, metadata_json, occurred_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    actor.user_id,
    actor.session_id,
    action,
    targetUserId,
    controlVersion,
    idempotencyKeyHash,
    JSON.stringify({
      allowed_group_ids: patch.allowed_groups ?? null,
      group_rates_ppm: patch.group_rates ?? null,
      restrict_public_groups: patch.restrict_public_groups ?? null,
    }),
    now,
  )
}

async function readUserGroupConfig(
  env: Env,
  userId: string,
): Promise<{ allowed_groups: string[]; group_rates: Record<string, number> }> {
  const [permissionResult, rateResult] = await env.DB.batch([
    env.DB.prepare(
      'SELECT group_id FROM user_group_permissions WHERE user_id = ? ORDER BY group_id ASC',
    ).bind(userId),
    env.DB.prepare(
      `SELECT group_id, rate_multiplier_ppm FROM user_group_rate_overrides
        WHERE user_id = ? ORDER BY group_id ASC`,
    ).bind(userId),
  ])
  const groupRates: Record<string, number> = Object.create(null) as Record<string, number>
  for (const row of rateResult.results as Array<{ group_id: string; rate_multiplier_ppm: number }>) {
    groupRates[row.group_id] = row.rate_multiplier_ppm / 1_000_000
  }
  return {
    allowed_groups: (permissionResult.results as Array<{ group_id: string }>).map((row) => row.group_id),
    group_rates: groupRates,
  }
}

function applyUserUpdatePatch(
  patch: UserUpdatePatch,
  current: UserRow,
): Pick<UserRow, 'email' | 'display_name' | 'role' | 'status' | 'concurrency' | 'rpm_limit'> {
  return {
    email: patch.email ?? current.email,
    display_name: patch.display_name ?? current.display_name,
    role: patch.role ?? current.role,
    status: patch.status ?? current.status,
    concurrency: patch.concurrency ?? current.concurrency,
    rpm_limit: patch.rpm_limit ?? current.rpm_limit,
  }
}

function parseBalanceHistoryType(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null
  const value = raw.trim()
  if (![
    'balance',
    'affiliate_balance',
    'admin_balance',
    'concurrency',
    'admin_concurrency',
    'subscription',
  ].includes(value)) {
    throw new GatewayError(400, 'invalid_type', 'Balance history type is invalid')
  }
  return value
}

function appendBalanceHistoryTypeCondition(
  conditions: string[],
  values: unknown[],
  type: string | null,
): void {
  if (type === null) return
  if (type === 'admin_balance') {
    conditions.push('source_type = ?')
    values.push('admin_adjustment')
    return
  }
  if (type === 'affiliate_balance') {
    conditions.push('source_type IN (?, ?)')
    values.push('affiliate_transfer', 'affiliate_refund_clawback')
    return
  }
  if (type === 'balance') {
    conditions.push("source_type NOT IN ('admin_adjustment', 'affiliate_transfer', 'affiliate_refund_clawback')")
    return
  }
  // The Worker financial ledger intentionally does not synthesize concurrency
  // or subscription events. Preserve the legacy filter contract as an empty set.
  conditions.push('0 = 1')
}

function encodeBalanceHistoryCursor(
  row: Pick<UserFinancialEventRow, 'occurred_at_ms' | 'event_id'>,
): string {
  const bytes = new TextEncoder().encode(JSON.stringify({
    v: 1,
    occurred_at_ms: row.occurred_at_ms,
    event_id: row.event_id,
  } satisfies BalanceHistoryCursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeBalanceHistoryCursor(raw: string): BalanceHistoryCursor {
  if (
    raw.length === 0 || raw.length > MAX_BALANCE_HISTORY_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  ) throw invalidBalanceHistoryCursor()
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - raw.length % 4) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as Partial<BalanceHistoryCursor> | null
    if (
      value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.v !== 1 || !Number.isSafeInteger(value.occurred_at_ms) ||
      (value.occurred_at_ms as number) < 0 ||
      typeof value.event_id !== 'string' || value.event_id.length === 0 ||
      value.event_id.length > 256 || /[\u0000-\u001f\u007f]/.test(value.event_id)
    ) throw invalidBalanceHistoryCursor()
    return value as BalanceHistoryCursor
  } catch {
    throw invalidBalanceHistoryCursor()
  }
}

function invalidBalanceHistoryCursor(): GatewayError {
  return new GatewayError(400, 'invalid_cursor', 'Balance history cursor is invalid')
}

function optionalNewPassword(body: Record<string, unknown>): string | undefined {
  if (body.password === undefined) return undefined
  if (typeof body.password !== 'string') {
    throw new GatewayError(400, 'invalid_password', 'Password must be a string')
  }
  try {
    validateNewPassword(body.password)
  } catch (error) {
    if (error instanceof PasswordValidationError) {
      throw new GatewayError(400, error.code, error.message)
    }
    throw error
  }
  return body.password
}

async function findUserById(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, display_name, role, status, balance_micros, concurrency, rpm_limit,
            state_version, control_version, restrict_public_groups, created_at_ms, updated_at_ms
       FROM users
      WHERE id = ? AND ${LIVE_USER_SQL}`,
  )
    .bind(id)
    .first<UserRow>()
}

async function findUserByIdIncludingDeleted(
  env: Env,
  id: string,
): Promise<DeletableUserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, display_name, role, status, balance_micros, concurrency, rpm_limit,
            state_version, control_version, restrict_public_groups, auth_version,
            created_at_ms, updated_at_ms
       FROM users
      WHERE id = ?`,
  )
    .bind(id)
    .first<DeletableUserRow>()
}

function deletedUserEmail(id: string): string {
  // '+' tags are stripped by canonical_email_inbox. Keep the unique user ID
  // in the mailbox itself so deleting a second user cannot collide.
  return `deleted-${id}@users.invalid`
}

function isDeletedUser(user: Pick<UserRow, 'id' | 'email' | 'display_name' | 'status'>): boolean {
  return user.status === 'disabled' &&
    user.display_name === '[deleted]' &&
    (user.email === deletedUserEmail(user.id) || user.email === `deleted+${user.id}@users.invalid`)
}

function userDeletedResponse(): { message: string } {
  return { message: 'User deleted successfully' }
}

function deleteUserAuthenticatorStatements(env: Env, userId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare('DELETE FROM email_binding_challenges WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM oauth_bind_tickets WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM oauth_flows WHERE target_user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM admin_sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM auth_identities WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM user_totp_credentials WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM user_totp_setup_challenges WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM user_totp_login_challenges WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM user_totp_verification_budgets WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM passkey_challenges WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM passkey_credentials WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM passkey_user_handles WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM email_challenges WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM registration_email_challenge_claims WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM user_notification_email_challenges WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM user_totp_email_challenges WHERE user_id = ?').bind(userId),
  ]
}

async function findUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, display_name, role, status, balance_micros, concurrency, rpm_limit,
            state_version, control_version, restrict_public_groups, created_at_ms, updated_at_ms
       FROM users
      WHERE email = ?`,
  )
    .bind(email)
    .first<UserRow>()
}

async function hasOtherActiveAdmin(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id
       FROM users
      WHERE role = 'admin' AND status = 'active' AND id <> ?
      LIMIT 1`,
  )
    .bind(userId)
    .first<{ id: string }>()
  return row !== null
}

async function compensateUserStatus(
  env: Env,
  user: UserRow,
  failedMutationDigest: string,
  expectedStateVersion: number,
): Promise<void> {
  const response = await postUserState(env, user.id, '/enabled', {
    schema_version: 1,
    mutation_id: `admin-enabled-compensate:${failedMutationDigest}:${expectedStateVersion}`,
    enabled: user.status === 'active',
    expected_state_version: expectedStateVersion,
    rollback_mutation_id: `admin-enabled:${failedMutationDigest}`,
  })
  if (!response.ok) {
    throw new GatewayError(
      503,
      'admin_status_compensation_failed',
      'The rejected admin status change could not be compensated',
      'server_error',
    )
  }
}

async function compensateDeletedUserStatus(
  env: Env,
  user: UserRow,
  failedMutationDigest: string,
  expectedStateVersion: number,
): Promise<void> {
  const response = await postUserState(env, user.id, '/enabled', {
    schema_version: 1,
    mutation_id: `admin-delete-compensate:${failedMutationDigest}:${expectedStateVersion}`,
    enabled: user.status === 'active',
    expected_state_version: expectedStateVersion,
    rollback_mutation_id: `admin-delete:${failedMutationDigest}`,
  })
  if (!response.ok) {
    throw new GatewayError(
      503,
      'admin_user_delete_compensation_failed',
      'The rejected user deletion could not be compensated',
      'server_error',
    )
  }
}

async function ensureUserConfigured(
  env: Env,
  user: UserRow,
  mutationId: string,
  acceptAlreadyConfigured: boolean,
): Promise<void> {
  const response = await postUserState(env, user.id, '/configure', {
    schema_version: 1,
    mutation_id: mutationId,
    user_id: user.id,
    balance_micros: user.balance_micros,
    enabled: user.status === 'active',
    initial_state_version: user.state_version,
  })
  if (
    !response.ok &&
    (!acceptAlreadyConfigured || (await responseErrorCode(response)) !== 'user_already_configured')
  ) {
    throw await stateError(response)
  }
}

function postUserState(
  env: Env,
  userId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const stub = userStateStub(env, userId)
  return stub.fetch(
    new Request(`https://user-state.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

function fetchUserState(env: Env, userId: string, path: string): Promise<Response> {
  return userStateStub(env, userId).fetch(new Request(`https://user-state.internal${path}`))
}

function userStateStub(env: Env, userId: string): DurableObjectStub {
  return env.USER_STATE.get(env.USER_STATE.idFromName(userId))
}

async function stateError(response: Response): Promise<GatewayError> {
  let code = 'state_operation_failed'
  let message = 'User state operation failed'
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } }
    if (typeof body.error?.code === 'string') code = body.error.code
    if (typeof body.error?.message === 'string') message = body.error.message
  } catch {
    // Keep the sanitized fallback when an internal response is malformed.
  }
  return new GatewayError(
    response.status >= 400 && response.status < 500 ? response.status : 503,
    code,
    message,
    'server_error',
  )
}

async function responseErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { error?: { code?: unknown } }
    return typeof body.error?.code === 'string' ? body.error.code : undefined
  } catch {
    return undefined
  }
}

async function parseUserState(
  response: Response,
  userId: string,
): Promise<{
  balance_micros: number
  reserved_micros: number
  settled_micros: number
  available_micros: number
  state_version: number
  enabled: boolean
  idempotent?: boolean
  applied?: boolean
}> {
  const body = (await response.json()) as {
    profile?: {
      user_id?: unknown
      balance_micros?: unknown
      reserved_micros?: unknown
      settled_micros?: unknown
      enabled?: unknown
    }
    available_micros?: unknown
    state_version?: unknown
    idempotent?: unknown
    applied?: unknown
  }
  const profile = body.profile
  if (
    profile?.user_id !== userId ||
    !isNonNegativeInteger(profile.balance_micros) ||
    !isNonNegativeInteger(profile.reserved_micros) ||
    !isNonNegativeInteger(profile.settled_micros) ||
    typeof profile.enabled !== 'boolean'
  ) {
    throw new GatewayError(503, 'invalid_user_state', 'User state returned invalid data', 'server_error')
  }
  const available = body.available_micros ?? profile.balance_micros - profile.reserved_micros
  if (!isNonNegativeInteger(available)) {
    throw new GatewayError(503, 'invalid_user_state', 'User state returned invalid data', 'server_error')
  }
  if (!isNonNegativeInteger(body.state_version)) {
    throw new GatewayError(503, 'invalid_user_state', 'User state returned invalid data', 'server_error')
  }
  if (body.idempotent !== undefined && typeof body.idempotent !== 'boolean') {
    throw new GatewayError(503, 'invalid_user_state', 'User state returned invalid data', 'server_error')
  }
  if (body.applied !== undefined && typeof body.applied !== 'boolean') {
    throw new GatewayError(503, 'invalid_user_state', 'User state returned invalid data', 'server_error')
  }
  return {
    balance_micros: profile.balance_micros,
    reserved_micros: profile.reserved_micros,
    settled_micros: profile.settled_micros,
    available_micros: available,
    state_version: body.state_version,
    enabled: profile.enabled,
    idempotent: body.idempotent,
    applied: body.applied,
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function isUniqueEmailError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /UNIQUE constraint failed:\s*(?:users\.(?:email|canonical_email_inbox)|index 'uq_users_canonical_email_inbox')/i.test(message)
}

function isControlVersionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /CHECK constraint failed:.*control_version/i.test(message)
}

function isLastActiveAdminError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /last_active_admin/i.test(message)
}

function isLastSuperAdminError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /last_super_admin/i.test(message)
}
