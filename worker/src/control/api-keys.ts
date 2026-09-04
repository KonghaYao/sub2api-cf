import type { Context } from 'hono'
import type { Env } from '../env'
import { apiKeyDigest, randomToken } from '../gateway/crypto'
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

interface ApiKeyRow {
  id: string
  user_id: string
  key_hash: string
  name: string
  enabled: number
  expires_at_ms: number | null
  last_used_at_ms: number | null
  created_at_ms: number
  updated_at_ms: number
  group_id: string | null
  key_prefix: string
  auth_version: number
  control_version: number
  revoked_at_ms: number | null
}

interface HydratedApiKeyRow extends ApiKeyRow {
  group_name?: string | null
  group_description?: string | null
  group_platform?: string | null
  group_enabled?: number | null
  group_rate_multiplier_ppm?: number | null
  group_type?: 'standard' | 'subscription' | null
  group_is_exclusive?: number | null
}

interface CreateApiKeyInput {
  name: string
  group_id: string
  expires_at_ms: number | null
}

interface ApiKeyUpdatePatch {
  name?: string
  group_id?: string | null
  enabled?: boolean
  expires_at_ms?: number | null
}

export async function createAdminApiKey(context: Context<ControlBindings>): Promise<Response> {
  try {
    const userId = requireResourceId(context.req.param('id'), 'user')
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const input = parseCreateApiKey(await readJsonObject(context.req.raw))
    const idempotency = await controlIdempotency(
      'admin.api_keys.create.v1',
      idempotencyKey,
      { user_id: userId, ...input },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      const replay = parseIdempotentResponse<Omit<ApiKeyRow, 'key_hash'>>(previous, 'api_key')
      if (previous.resource_id !== replay.id) {
        throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
      }
      return controlSuccess({
        ...replay,
        warning: 'This idempotent operation already completed; the API key is not shown again.',
      })
    }
    const pepper = requireApiKeyPepper(context.env)
    const user = await context.env.DB.prepare('SELECT id, status FROM users WHERE id = ?')
      .bind(userId)
      .first<{ id: string; status: string }>()
    if (user === null) throw new GatewayError(404, 'user_not_found', 'User was not found')
    const authorization = await requireAdminApiKeyGroupAuthorization(
      context.env,
      userId,
      input.group_id,
      'create',
    )

    const scope = `${userId}\u0000${idempotencyKey}`
    const keyId = await deterministicUuid('admin.api_keys.create.v1', scope)
    const collidingKey = await findApiKey(context.env, keyId)
    if (collidingKey !== null) {
      throw new GatewayError(409, 'idempotency_record_missing', 'API key exists without its idempotency record')
    }
    if (input.expires_at_ms !== null && input.expires_at_ms <= Date.now() + 1_000) {
      throw new GatewayError(400, 'invalid_expires_at_ms', 'expires_at_ms must be in the future')
    }
    const rawKey = `sk-sub2api-${randomToken(36)}`
    const keyHash = await apiKeyDigest(rawKey, pepper)
    const keyPrefix = rawKey.slice(0, 16)
    const now = Date.now()
    const row: ApiKeyRow = {
      id: keyId,
      user_id: userId,
      key_hash: keyHash,
      name: input.name,
      enabled: 1,
      expires_at_ms: input.expires_at_ms,
      last_used_at_ms: null,
      created_at_ms: now,
      updated_at_ms: now,
      group_id: input.group_id,
      key_prefix: keyPrefix,
      auth_version: 1,
      control_version: 0,
      revoked_at_ms: null,
    }
    const safe = publicApiKey(row, authorization.group)
    try {
      await context.env.DB.batch([
        exclusiveStandardGroupGrantStatement(context.env, row.user_id, row.group_id!, now),
        context.env.DB.prepare(
          `INSERT INTO api_keys (
             id, user_id, key_hash, name, enabled, expires_at_ms,
             last_used_at_ms, created_at_ms, updated_at_ms,
             group_id, key_prefix, auth_version, revoked_at_ms
           ) SELECT ?, ?, ?,
             CASE WHEN ${adminApiKeyGroupAuthorizationPredicate('g')} THEN ? ELSE NULL END,
             1, ?, NULL, ?, ?, ?, ?, 1, NULL`,
        ).bind(
          row.id,
          row.user_id,
          row.key_hash,
          row.group_id,
          row.user_id,
          row.user_id,
          now,
          now,
          row.name,
          row.expires_at_ms,
          now,
          now,
          row.group_id,
          row.key_prefix,
        ),
        controlIdempotencyInsert(context.env, idempotency, 'api_key', row.id, safe, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        const replay = parseIdempotentResponse<ReturnType<typeof publicApiKey>>(recovered, 'api_key')
        if (recovered.resource_id !== replay.id || replay.user_id !== userId) {
          throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
        }
        return controlSuccess({
          ...replay,
          warning: 'This idempotent operation already completed; the API key is not shown again.',
        })
      }
      if (isGroupAuthorizationGuardError(error)) {
        await requireAdminApiKeyGroupAuthorization(
          context.env,
          userId,
          input.group_id,
          'create',
        )
        throw groupAuthorizationChanged()
      }
      throw error
    }

    return controlSuccess(
      {
        ...safe,
        api_key: rawKey,
        warning: 'The API key is shown once and is not persisted in plaintext. Keep it secret.',
      },
      201,
    )
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminApiKeys(context: Context<ControlBindings>): Promise<Response> {
  try {
    const userId = requireResourceId(context.req.param('id'), 'user')
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const user = await context.env.DB.prepare('SELECT id, status FROM users WHERE id = ?')
      .bind(userId)
      .first<{ id: string; status: string }>()
    if (user === null) throw new GatewayError(404, 'user_not_found', 'User was not found')

    const [countResult, rowsResult] = await context.env.DB.batch([
      context.env.DB.prepare('SELECT COUNT(*) AS total FROM api_keys WHERE user_id = ?').bind(userId),
      context.env.DB.prepare(
        `${apiKeySelect()}
          WHERE k.user_id = ?
          ORDER BY k.created_at_ms DESC, k.id DESC
          LIMIT ? OFFSET ?`,
      ).bind(userId, pageSize, (page - 1) * pageSize),
    ])
    const totalValue = (countResult.results[0] as { total?: unknown } | undefined)?.total
    if (!Number.isSafeInteger(totalValue) || (totalValue as number) < 0) {
      throw new GatewayError(500, 'invalid_api_key_count', 'API key count is invalid', 'server_error')
    }
    const total = totalValue as number
    return controlSuccess({
      items: (rowsResult.results as unknown as HydratedApiKeyRow[]).map((row) => publicApiKey(row)),
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function revokeAdminApiKey(context: Context<ControlBindings>): Promise<Response> {
  try {
    const keyId = requireResourceId(context.req.param('id'), 'api_key')
    let row = await findApiKey(context.env, keyId)
    if (row === null) throw new GatewayError(404, 'api_key_not_found', 'API key was not found')
    if (row.revoked_at_ms === null) {
      const now = Date.now()
      await context.env.DB.prepare(
        `UPDATE api_keys
            SET enabled = 0, revoked_at_ms = ?, updated_at_ms = ?,
                auth_version = auth_version + 1,
                control_version = control_version + 1
          WHERE id = ? AND revoked_at_ms IS NULL`,
      )
        .bind(now, now, row.id)
        .run()
      row = await findApiKey(context.env, keyId)
      if (row === null) {
        throw new GatewayError(503, 'api_key_projection_failed', 'API key update could not be read', 'server_error')
      }
    }
    return controlSuccess(publicApiKey(row))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updateAdminApiKey(context: Context<ControlBindings>): Promise<Response> {
  try {
    const keyId = requireResourceId(context.req.param('id'), 'api_key')
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const patch = parseApiKeyUpdatePatch(body)
    const idempotency = await controlIdempotency(
      'admin.api_keys.update.v2',
      idempotencyKey,
      { api_key_id: keyId, ...patch },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      const replay = parseIdempotentResponse<AdminApiKeyUpdateResult>(previous, 'api_key')
      if (previous.resource_id !== replay.api_key.id || replay.api_key.id !== keyId) {
        throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
      }
      return controlSuccess(replay)
    }
    let row = await findApiKey(context.env, keyId)
    if (row === null) throw new GatewayError(404, 'api_key_not_found', 'API key was not found')

    const name = patch.name ?? row.name
    const groupId = Object.hasOwn(patch, 'group_id') ? patch.group_id ?? null : row.group_id
    const enabled = patch.enabled ?? row.enabled === 1
    if (row.revoked_at_ms !== null && enabled) {
      throw new GatewayError(409, 'api_key_revoked', 'A revoked API key cannot be re-enabled')
    }
    const authorization = groupId !== null && (groupId !== row.group_id || enabled)
      ? await requireAdminApiKeyGroupAuthorization(context.env, row.user_id, groupId, 'bind')
      : null
    const group = authorization?.group ?? (groupId === row.group_id ? groupFromRow(row) : null)
    const autoGrantedGroupAccess = authorization?.auto_granted_group_access ?? false
    let expiresAtMs = row.expires_at_ms
    if (Object.hasOwn(patch, 'expires_at_ms')) {
      expiresAtMs = patch.expires_at_ms ?? null
    }
    const authChanged =
      groupId !== row.group_id ||
      enabled !== (row.enabled === 1) ||
      expiresAtMs !== row.expires_at_ms
    const changed = authChanged || name !== row.name
    if (changed) {
      const now = Date.now()
      const authVersion = row.auth_version + (authChanged ? 1 : 0)
      const controlVersion = row.control_version + 1
      if (!Number.isSafeInteger(authVersion)) {
        throw new GatewayError(409, 'auth_version_exhausted', 'API key auth version is exhausted')
      }
      if (!Number.isSafeInteger(controlVersion)) {
        throw new GatewayError(409, 'control_version_exhausted', 'API key control version is exhausted')
      }
      const update = context.env.DB.prepare(authorization === null
        ? `UPDATE api_keys
            SET name = ?, group_id = ?, enabled = ?, expires_at_ms = ?,
                auth_version = ?,
                control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                updated_at_ms = ?
          WHERE id = ?`
        : `UPDATE api_keys
            SET name = CASE WHEN ${adminApiKeyGroupAuthorizationPredicate('g')}
                            THEN ? ELSE NULL END,
                group_id = ?, enabled = ?, expires_at_ms = ?,
                auth_version = ?,
                control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                updated_at_ms = ?
          WHERE id = ?`)
        .bind(
          ...(authorization === null ? [] : [
            groupId,
            row.user_id,
            row.user_id,
            now,
            now,
          ]),
          name,
          groupId,
          enabled ? 1 : 0,
          expiresAtMs,
          authVersion,
          row.control_version,
          controlVersion,
          now,
          row.id,
        )
      row = {
        ...row,
        name,
        group_id: groupId,
        enabled: enabled ? 1 : 0,
        expires_at_ms: expiresAtMs,
        auth_version: authVersion,
        control_version: controlVersion,
        updated_at_ms: now,
      }
      const result = adminApiKeyUpdateResult(row, group, autoGrantedGroupAccess)
      try {
        const statements = [
          ...(authorization === null || groupId === null
            ? []
            : [exclusiveStandardGroupGrantStatement(context.env, row.user_id, groupId, now)]),
          update,
          controlIdempotencyInsert(
            context.env,
            idempotency,
            'api_key',
            row.id,
            result,
            now,
          ),
        ]
        await context.env.DB.batch(statements)
      } catch (error) {
        const replay = await recoverApiKeyUpdate(context.env, idempotency, keyId)
        if (replay !== null) return controlSuccess(replay)
        if (isControlVersionError(error)) {
          throw new GatewayError(409, 'api_key_update_conflict', 'API key changed concurrently; retry the update')
        }
        if (authorization !== null && groupId !== null && isGroupAuthorizationGuardError(error)) {
          await requireAdminApiKeyGroupAuthorization(context.env, row.user_id, groupId, 'bind')
          throw groupAuthorizationChanged()
        }
        throw error
      }
      return controlSuccess(result)
    }
    const result = adminApiKeyUpdateResult(row, groupFromRow(row), false)
    try {
      await controlIdempotencyInsert(
        context.env,
        idempotency,
        'api_key',
        row.id,
        result,
        Date.now(),
      ).run()
    } catch (error) {
      const replay = await recoverApiKeyUpdate(context.env, idempotency, keyId)
      if (replay !== null) return controlSuccess(replay)
      throw error
    }
    return controlSuccess(result)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function parseCreateApiKey(body: Record<string, unknown>): CreateApiKeyInput {
  const groupId = requireResourceId(requireString(body, 'group_id', 128), 'group')
  let expiresAtMs: number | null = null
  if (body.expires_at_ms !== undefined && body.expires_at_ms !== null) {
    expiresAtMs = requireSafeInteger(body, 'expires_at_ms')
  }
  return {
    name: optionalString(body, 'name', 128) ?? 'default',
    group_id: groupId,
    expires_at_ms: expiresAtMs,
  }
}

function parseApiKeyUpdatePatch(body: Record<string, unknown>): ApiKeyUpdatePatch {
  const patch: ApiKeyUpdatePatch = {}
  if (body.name !== undefined) patch.name = requireString(body, 'name', 128)
  if (body.group_id !== undefined) {
    patch.group_id = body.group_id === null
      ? null
      : requireResourceId(requireString(body, 'group_id', 128), 'group')
  }
  if (body.enabled !== undefined && body.status !== undefined) {
    throw new GatewayError(400, 'ambiguous_status', 'Provide enabled or status, not both')
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      throw new GatewayError(400, 'invalid_enabled', 'enabled must be a boolean')
    }
    patch.enabled = body.enabled
  }
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'inactive') {
      throw new GatewayError(400, 'invalid_status', 'status must be active or inactive')
    }
    patch.enabled = body.status === 'active'
  }
  if (Object.hasOwn(body, 'expires_at_ms')) {
    patch.expires_at_ms = body.expires_at_ms === null
      ? null
      : requireSafeInteger(body, 'expires_at_ms', Date.now() + 1_000)
  }
  return patch
}

function requireApiKeyPepper(env: Env): string {
  if (!env.API_KEY_PEPPER || env.API_KEY_PEPPER.length < 32) {
    throw new GatewayError(
      503,
      'api_key_secret_not_configured',
      'API key secret is not configured',
      'server_error',
    )
  }
  return env.API_KEY_PEPPER
}

function apiKeySelect(): string {
  return `SELECT k.id, k.user_id, k.key_hash, k.name, k.enabled, k.expires_at_ms,
                 k.last_used_at_ms, k.created_at_ms, k.updated_at_ms, k.group_id,
                 k.key_prefix, k.auth_version, k.control_version, k.revoked_at_ms,
                 g.name AS group_name, g.description AS group_description,
                 g.platform AS group_platform, g.enabled AS group_enabled,
                 g.rate_multiplier_ppm AS group_rate_multiplier_ppm,
                 g.group_type, g.is_exclusive AS group_is_exclusive
            FROM api_keys k
            LEFT JOIN "groups" g ON g.id = k.group_id`
}

async function findApiKey(env: Env, id: string): Promise<HydratedApiKeyRow | null> {
  return env.DB.prepare(`${apiKeySelect()} WHERE k.id = ?`)
    .bind(id)
    .first<HydratedApiKeyRow>()
}

async function recoverApiKeyUpdate(
  env: Env,
  idempotency: Awaited<ReturnType<typeof controlIdempotency>>,
  keyId: string,
): Promise<AdminApiKeyUpdateResult | null> {
  const recovered = await findControlIdempotency(env, idempotency)
  if (recovered === null) return null
  const replay = parseIdempotentResponse<AdminApiKeyUpdateResult>(recovered, 'api_key')
  if (recovered.resource_id !== replay.api_key.id || replay.api_key.id !== keyId) {
    throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
  }
  return replay
}

function isControlVersionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /CHECK constraint failed:.*control_version/i.test(message)
}

interface AdminApiKeyGroup {
  id: string
  name: string
  description: string | null
  platform: string
  enabled: number
  rate_multiplier_ppm: number
  group_type: 'standard' | 'subscription'
  is_exclusive: number
}

interface AdminApiKeyGroupAuthorization {
  group: AdminApiKeyGroup
  auto_granted_group_access: boolean
}

interface AdminApiKeyUpdateResult {
  api_key: ReturnType<typeof publicApiKey>
  auto_granted_group_access: boolean
  granted_group_id?: string
  granted_group_name?: string
}

function adminApiKeyUpdateResult(
  row: ApiKeyRow,
  group: AdminApiKeyGroup | null,
  autoGrantedGroupAccess: boolean,
): AdminApiKeyUpdateResult {
  return {
    api_key: publicApiKey(row, group),
    auto_granted_group_access: autoGrantedGroupAccess,
    ...(autoGrantedGroupAccess && group !== null
      ? { granted_group_id: group.id, granted_group_name: group.name }
      : {}),
  }
}

function publicApiKey(
  row: ApiKeyRow,
  group = groupFromRow(row),
): Omit<ApiKeyRow, 'key_hash'> & Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    enabled: row.enabled,
    expires_at_ms: row.expires_at_ms,
    last_used_at_ms: row.last_used_at_ms,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
    group_id: row.group_id,
    key_prefix: row.key_prefix,
    auth_version: row.auth_version,
    control_version: row.control_version,
    revoked_at_ms: row.revoked_at_ms,
    status: apiKeyStatus(row),
    expires_at: nullableIso(row.expires_at_ms),
    last_used_at: nullableIso(row.last_used_at_ms),
    created_at: new Date(row.created_at_ms).toISOString(),
    updated_at: new Date(row.updated_at_ms).toISOString(),
    revoked_at: nullableIso(row.revoked_at_ms),
    ...(group === null ? {} : { group: publicAdminApiKeyGroup(group) }),
  }
}

async function requireAdminApiKeyGroupAuthorization(
  env: Env,
  userId: string,
  groupId: string,
  action: 'create' | 'bind',
): Promise<AdminApiKeyGroupAuthorization> {
  const now = Date.now()
  const group = await env.DB.prepare(
    `WITH selected_group AS (
       SELECT id, name, description, platform, enabled, rate_multiplier_ppm,
              group_type, is_exclusive
         FROM "groups" WHERE id = ?
     )
     SELECT g.id, g.name, g.description, g.platform, g.enabled,
            g.rate_multiplier_ppm, g.group_type, g.is_exclusive,
            CASE WHEN EXISTS (
              SELECT 1 FROM user_group_permissions permission
               WHERE permission.user_id = ? AND permission.group_id = g.id
            ) THEN 1 ELSE 0 END AS has_permission,
            CASE WHEN EXISTS (
              SELECT 1 FROM user_subscriptions subscription
               WHERE subscription.user_id = ? AND subscription.group_id = g.id
                 AND subscription.status = 'active'
                 AND subscription.starts_at_ms <= ? AND subscription.expires_at_ms > ?
            ) THEN 1 ELSE 0 END AS has_active_subscription
       FROM selected_group g`,
  ).bind(groupId, userId, userId, now, now).first<AdminApiKeyGroup & {
    has_permission: number
    has_active_subscription: number
  }>()
  if (group === null) throw new GatewayError(404, 'group_not_found', 'Group was not found')
  if (group.enabled !== 1) {
    throw new GatewayError(
      409,
      'group_disabled',
      action === 'create'
        ? 'Cannot create an API key for a disabled group'
        : 'Cannot bind an API key to a disabled group',
    )
  }
  if (group.group_type === 'subscription' && group.has_active_subscription !== 1) {
    throw new GatewayError(
      409,
      'subscription_required',
      'User does not have an active subscription for this group',
    )
  }
  return {
    group,
    auto_granted_group_access:
      group.group_type === 'standard' && group.is_exclusive === 1 && group.has_permission !== 1,
  }
}

function exclusiveStandardGroupGrantStatement(
  env: Env,
  userId: string,
  groupId: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO user_group_permissions (
       user_id, group_id, granted_by_user_id, created_at_ms
     )
     SELECT ?, g.id, NULL, ?
       FROM "groups" g
      WHERE g.id = ? AND g.enabled = 1
        AND g.group_type = 'standard' AND g.is_exclusive = 1`,
  ).bind(userId, now, groupId)
}

function adminApiKeyGroupAuthorizationPredicate(groupAlias: string): string {
  return `EXISTS (
    SELECT 1 FROM "groups" ${groupAlias}
     WHERE ${groupAlias}.id = ? AND ${groupAlias}.enabled = 1
       AND (
         (${groupAlias}.group_type = 'standard' AND (
           ${groupAlias}.is_exclusive = 0 OR EXISTS (
             SELECT 1 FROM user_group_permissions permission
              WHERE permission.user_id = ? AND permission.group_id = ${groupAlias}.id
           )
         ))
         OR (${groupAlias}.group_type = 'subscription' AND EXISTS (
           SELECT 1 FROM user_subscriptions subscription
            WHERE subscription.user_id = ? AND subscription.group_id = ${groupAlias}.id
              AND subscription.status = 'active'
              AND subscription.starts_at_ms <= ? AND subscription.expires_at_ms > ?
         ))
       )
  )`
}

function groupFromRow(row: ApiKeyRow): AdminApiKeyGroup | null {
  const hydrated = row as HydratedApiKeyRow
  if (
    row.group_id === null ||
    typeof hydrated.group_name !== 'string' ||
    typeof hydrated.group_platform !== 'string' ||
    !Number.isSafeInteger(hydrated.group_enabled) ||
    !Number.isSafeInteger(hydrated.group_rate_multiplier_ppm) ||
    (hydrated.group_type !== 'standard' && hydrated.group_type !== 'subscription') ||
    !Number.isSafeInteger(hydrated.group_is_exclusive)
  ) return null
  return {
    id: row.group_id,
    name: hydrated.group_name,
    description: hydrated.group_description ?? null,
    platform: hydrated.group_platform,
    enabled: hydrated.group_enabled as number,
    rate_multiplier_ppm: hydrated.group_rate_multiplier_ppm as number,
    group_type: hydrated.group_type,
    is_exclusive: hydrated.group_is_exclusive as number,
  }
}

function publicAdminApiKeyGroup(group: AdminApiKeyGroup): Record<string, unknown> {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    platform: group.platform,
    status: group.enabled === 1 ? 'active' : 'inactive',
    rate_multiplier: group.rate_multiplier_ppm / 1_000_000,
    subscription_type: group.group_type,
    is_exclusive: group.is_exclusive === 1,
  }
}

function isGroupAuthorizationGuardError(error: unknown): boolean {
  return /NOT NULL constraint failed: api_keys\.name/i.test(errorMessage(error))
}

function groupAuthorizationChanged(): GatewayError {
  return new GatewayError(
    409,
    'group_authorization_changed',
    'Group authorization changed concurrently; retry the update',
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function apiKeyStatus(row: ApiKeyRow): 'active' | 'inactive' | 'expired' {
  if (row.revoked_at_ms !== null || row.enabled !== 1) return 'inactive'
  if (row.expires_at_ms !== null && row.expires_at_ms <= Date.now()) return 'expired'
  return 'active'
}

function nullableIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}
