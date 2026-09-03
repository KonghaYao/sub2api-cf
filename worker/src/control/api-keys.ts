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
  group_id: string
  key_prefix: string
  auth_version: number
  control_version: number
  revoked_at_ms: number | null
}

interface CreateApiKeyInput {
  name: string
  group_id: string
  expires_at_ms: number | null
}

interface ApiKeyUpdatePatch {
  name?: string
  group_id?: string
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
    const group = await context.env.DB.prepare('SELECT id, enabled FROM "groups" WHERE id = ?')
      .bind(input.group_id)
      .first<{ id: string; enabled: number }>()
    if (group === null) throw new GatewayError(404, 'group_not_found', 'Group was not found')
    if (group.enabled !== 1) {
      throw new GatewayError(409, 'group_disabled', 'Cannot create an API key for a disabled group')
    }

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
    const safe = publicApiKey(row)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO api_keys (
             id, user_id, key_hash, name, enabled, expires_at_ms,
             last_used_at_ms, created_at_ms, updated_at_ms,
             group_id, key_prefix, auth_version, revoked_at_ms
           ) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, 1, NULL)`,
        ).bind(
          row.id,
          row.user_id,
          row.key_hash,
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
      if (recovered === null) throw error
      const replay = parseIdempotentResponse<Omit<ApiKeyRow, 'key_hash'>>(recovered, 'api_key')
      if (recovered.resource_id !== replay.id || replay.user_id !== userId) {
        throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
      }
      return controlSuccess({
        ...replay,
        warning: 'This idempotent operation already completed; the API key is not shown again.',
      })
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
        `SELECT id, user_id, key_hash, name, enabled, expires_at_ms,
                last_used_at_ms, created_at_ms, updated_at_ms, group_id,
                key_prefix, auth_version, control_version, revoked_at_ms
           FROM api_keys
          WHERE user_id = ?
          ORDER BY created_at_ms DESC, id DESC
          LIMIT ? OFFSET ?`,
      ).bind(userId, pageSize, (page - 1) * pageSize),
    ])
    const totalValue = (countResult.results[0] as { total?: unknown } | undefined)?.total
    if (!Number.isSafeInteger(totalValue) || (totalValue as number) < 0) {
      throw new GatewayError(500, 'invalid_api_key_count', 'API key count is invalid', 'server_error')
    }
    const total = totalValue as number
    return controlSuccess({
      items: (rowsResult.results as unknown as ApiKeyRow[]).map(publicApiKey),
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
      'admin.api_keys.update.v1',
      idempotencyKey,
      { api_key_id: keyId, ...patch },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      const replay = parseIdempotentResponse<Omit<ApiKeyRow, 'key_hash'>>(previous, 'api_key')
      if (previous.resource_id !== replay.id || replay.id !== keyId) {
        throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
      }
      return controlSuccess(replay)
    }
    let row = await findApiKey(context.env, keyId)
    if (row === null) throw new GatewayError(404, 'api_key_not_found', 'API key was not found')

    const name = patch.name ?? row.name
    const groupId = patch.group_id ?? row.group_id
    if (groupId !== row.group_id) {
      const group = await context.env.DB.prepare('SELECT id, enabled FROM "groups" WHERE id = ?')
        .bind(groupId)
        .first<{ id: string; enabled: number }>()
      if (group === null) throw new GatewayError(404, 'group_not_found', 'Group was not found')
      if (group.enabled !== 1) {
        throw new GatewayError(409, 'group_disabled', 'Cannot bind an API key to a disabled group')
      }
    }
    const enabled = patch.enabled ?? row.enabled === 1
    if (row.revoked_at_ms !== null && enabled) {
      throw new GatewayError(409, 'api_key_revoked', 'A revoked API key cannot be re-enabled')
    }
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
      const update = context.env.DB.prepare(
        `UPDATE api_keys
            SET name = ?, group_id = ?, enabled = ?, expires_at_ms = ?,
                auth_version = ?,
                control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                updated_at_ms = ?
          WHERE id = ?`,
      )
        .bind(
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
      const safe = publicApiKey(row)
      try {
        await context.env.DB.batch([
          update,
          controlIdempotencyInsert(
            context.env,
            idempotency,
            'api_key',
            row.id,
            safe,
            now,
          ),
        ])
      } catch (error) {
        const replay = await recoverApiKeyUpdate(context.env, idempotency, keyId)
        if (replay !== null) return controlSuccess(replay)
        if (isControlVersionError(error)) {
          throw new GatewayError(409, 'api_key_update_conflict', 'API key changed concurrently; retry the update')
        }
        throw error
      }
      return controlSuccess(safe)
    }
    const safe = publicApiKey(row)
    try {
      await controlIdempotencyInsert(
        context.env,
        idempotency,
        'api_key',
        row.id,
        safe,
        Date.now(),
      ).run()
    } catch (error) {
      const replay = await recoverApiKeyUpdate(context.env, idempotency, keyId)
      if (replay !== null) return controlSuccess(replay)
      throw error
    }
    return controlSuccess(safe)
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
    patch.group_id = requireResourceId(requireString(body, 'group_id', 128), 'group')
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

async function findApiKey(env: Env, id: string): Promise<ApiKeyRow | null> {
  return env.DB.prepare(
    `SELECT id, user_id, key_hash, name, enabled, expires_at_ms,
            last_used_at_ms, created_at_ms, updated_at_ms, group_id,
            key_prefix, auth_version, control_version, revoked_at_ms
       FROM api_keys
      WHERE id = ?`,
  )
    .bind(id)
    .first<ApiKeyRow>()
}

async function recoverApiKeyUpdate(
  env: Env,
  idempotency: Awaited<ReturnType<typeof controlIdempotency>>,
  keyId: string,
): Promise<Omit<ApiKeyRow, 'key_hash'> | null> {
  const recovered = await findControlIdempotency(env, idempotency)
  if (recovered === null) return null
  const replay = parseIdempotentResponse<Omit<ApiKeyRow, 'key_hash'>>(recovered, 'api_key')
  if (recovered.resource_id !== replay.id || replay.id !== keyId) {
    throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
  }
  return replay
}

function isControlVersionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /CHECK constraint failed:.*control_version/i.test(message)
}

function publicApiKey(row: ApiKeyRow): Omit<ApiKeyRow, 'key_hash'> {
  const { key_hash: _keyHash, ...safe } = row
  return safe
}
