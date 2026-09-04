import type { Context } from 'hono'
import type { Env } from '../env'
import { sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
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
} from './http'

type ControlBindings = { Bindings: Env }

interface UserRow {
  id: string
  email: string
  display_name: string
  role: 'user' | 'admin'
  status: 'active' | 'disabled'
  balance_micros: number
  state_version: number
  control_version: number
  created_at_ms: number
  updated_at_ms: number
}

interface CreateUserInput {
  email: string
  display_name: string
  role: UserRow['role']
  balance_micros: number
}

interface UserUpdatePatch {
  email?: string
  display_name?: string
  role?: UserRow['role']
  status?: UserRow['status']
}

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
    const user: UserRow = {
      id: userId,
      email: input.email,
      display_name: input.display_name,
      role: input.role,
      status: 'active',
      balance_micros: input.balance_micros,
      state_version: 0,
      control_version: 0,
      created_at_ms: now,
      updated_at_ms: now,
    }
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO users (
             id, email, display_name, role, status, balance_micros,
             state_version, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?)`,
        ).bind(user.id, user.email, user.display_name, user.role, user.balance_micros, now, now),
        controlIdempotencyInsert(context.env, idempotency, 'user', user.id, user, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered === null) {
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
    const conditions: string[] = []
    const values: unknown[] = []
    const status = context.req.query('status')
    if (status !== undefined) {
      if (status !== 'active' && status !== 'disabled') {
        throw new GatewayError(400, 'invalid_status', 'status must be active or disabled')
      }
      conditions.push('status = ?')
      values.push(status)
    }
    const role = context.req.query('role')
    if (role !== undefined) {
      if (role !== 'user' && role !== 'admin') {
        throw new GatewayError(400, 'invalid_role', 'role must be user or admin')
      }
      conditions.push('role = ?')
      values.push(role)
    }
    const search = context.req.query('search')?.trim()
    if (search) {
      if (search.length > 320) {
        throw new GatewayError(400, 'invalid_search', 'search must not exceed 320 characters')
      }
      conditions.push(`(email LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')`)
      const pattern = `%${escapeLike(search)}%`
      values.push(pattern, pattern)
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const countStatement = context.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM users ${where}`,
    ).bind(...values)
    const rowsStatement = context.env.DB.prepare(
      `SELECT id, email, display_name, role, status, balance_micros,
              state_version, control_version, created_at_ms, updated_at_ms
         FROM users
         ${where}
        ORDER BY created_at_ms DESC, id DESC
        LIMIT ? OFFSET ?`,
    ).bind(...values, pageSize, (page - 1) * pageSize)
    const [countResult, rowsResult] = await context.env.DB.batch([countStatement, rowsStatement])
    const totalValue = (countResult.results[0] as { total?: unknown } | undefined)?.total
    if (!Number.isSafeInteger(totalValue) || (totalValue as number) < 0) {
      throw new GatewayError(500, 'invalid_user_count', 'User count projection is invalid', 'server_error')
    }
    const total = totalValue as number
    return controlSuccess({
      items: rowsResult.results as unknown as UserRow[],
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
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
    return controlSuccess({
      ...user,
      balance_micros: state.balance_micros,
      reserved_micros: state.reserved_micros,
      settled_micros: state.settled_micros,
      available_micros: state.available_micros,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function adjustAdminUserBalance(context: Context<ControlBindings>): Promise<Response> {
  try {
    const userId = requireResourceId(context.req.param('id'), 'user')
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
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
      next.role !== user.role
    let updatedAtMs = user.updated_at_ms
    const statements: D1PreparedStatement[] = []

    if (metadataChanged) {
      updatedAtMs = Date.now()
      if (controlVersion >= Number.MAX_SAFE_INTEGER) {
        throw new GatewayError(409, 'control_version_exhausted', 'User control version is exhausted')
      }
      statements.push(
        context.env.DB.prepare(
          `UPDATE users
              SET email = ?, display_name = ?, role = ?,
                  email_verified_at_ms = CASE
                    WHEN email <> ? THEN NULL
                    ELSE email_verified_at_ms
                  END,
                  control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                  updated_at_ms = ?
            WHERE id = ?`,
        ).bind(
          next.email,
          next.display_name,
          next.role,
          next.email,
          controlVersion,
          controlVersion + 1,
          updatedAtMs,
          user.id,
        ),
      )
      controlVersion += 1
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
            SET status = ?, balance_micros = ?, state_version = ?, updated_at_ms = ?
          WHERE id = ? AND state_version < ?`,
      ).bind(projectedStatus, balanceMicros, stateVersion, updatedAtMs, user.id, stateVersion))
    }
    const response = {
      ...user,
      ...next,
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
  }
}

function parseUserUpdatePatch(body: Record<string, unknown>): UserUpdatePatch {
  const patch: UserUpdatePatch = {}
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
  return patch
}

function applyUserUpdatePatch(
  patch: UserUpdatePatch,
  current: UserRow,
): Pick<UserRow, 'email' | 'display_name' | 'role' | 'status'> {
  return {
    email: patch.email ?? current.email,
    display_name: patch.display_name ?? current.display_name,
    role: patch.role ?? current.role,
    status: patch.status ?? current.status,
  }
}

async function findUserById(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, display_name, role, status, balance_micros,
            state_version, control_version, created_at_ms, updated_at_ms
       FROM users
      WHERE id = ?`,
  )
    .bind(id)
    .first<UserRow>()
}

async function findUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, display_name, role, status, balance_micros,
            state_version, control_version, created_at_ms, updated_at_ms
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
  return /UNIQUE constraint failed:\s*users\.email/i.test(message)
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
