import type { Context } from 'hono'
import { authenticateUserRequest } from '../auth/handler'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
} from '../control/idempotency'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  queryInteger,
  readJsonObject,
  requireIdempotencyKey,
  requireResourceId,
  requireSafeInteger,
  requireString,
} from '../control/http'
import type { Env } from '../env'
import { apiKeyDigest, randomToken } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { requireUserGroupAccess } from './groups'

type UserBindings = { Bindings: Env }

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

interface UpdateApiKeyPatch {
  name?: string
  group_id?: string
  expires_at_ms?: number | null
  enabled?: boolean
}

export async function listUserApiKeys(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 10, 1, 100)
    const [countResult, rowsResult] = await context.env.DB.batch([
      context.env.DB.prepare('SELECT COUNT(*) AS total FROM api_keys WHERE user_id = ?').bind(user.id),
      context.env.DB.prepare(
        `${apiKeySelect()} WHERE user_id = ?
         ORDER BY created_at_ms DESC, id DESC
         LIMIT ? OFFSET ?`,
      ).bind(user.id, pageSize, (page - 1) * pageSize),
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

export async function getUserApiKey(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const keyId = requireResourceId(context.req.param('id'), 'api_key')
    const row = await findOwnedApiKey(context.env, keyId, user.id)
    if (row === null) throw apiKeyNotFound()
    return controlSuccess(publicApiKey(row))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function createUserApiKey(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const input = parseCreateInput(await readJsonObject(context.req.raw))
    const idempotency = await controlIdempotency(
      `user.api_keys.create.v1:${user.id}`,
      idempotencyKey,
      input,
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      const replay = parseIdempotentResponse<Record<string, unknown>>(previous, 'api_key')
      if (previous.resource_id !== replay.id || replay.user_id !== user.id) {
        throw invalidIdempotencyRecord()
      }
      return controlSuccess({
        ...replay,
        warning: 'This operation already completed; the API key is not shown again.',
      })
    }

    await requireUserGroupAccess(context.env, user.id, input.group_id, 'create')

    const keyId = await deterministicUuid(
      'user.api_keys.create.v1',
      `${user.id}\u0000${idempotencyKey}`,
    )
    if (await findOwnedApiKey(context.env, keyId, user.id) !== null) {
      throw new GatewayError(
        409,
        'idempotency_record_missing',
        'API key exists without its idempotency record',
      )
    }
    const rawKey = `sk-sub2api-${randomToken(36)}`
    const keyHash = await apiKeyDigest(rawKey, requireApiKeyPepper(context.env))
    const now = Date.now()
    const row: ApiKeyRow = {
      id: keyId,
      user_id: user.id,
      key_hash: keyHash,
      name: input.name,
      enabled: 1,
      expires_at_ms: input.expires_at_ms,
      last_used_at_ms: null,
      created_at_ms: now,
      updated_at_ms: now,
      group_id: input.group_id,
      key_prefix: rawKey.slice(0, 16),
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
        apiKeyAuditInsert(
          context.env,
          user.id,
          user.session_id,
          'user.api_keys.create',
          row,
          now,
        ),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered === null) throw error
      const replay = parseIdempotentResponse<Record<string, unknown>>(recovered, 'api_key')
      if (recovered.resource_id !== replay.id || replay.user_id !== user.id) {
        throw invalidIdempotencyRecord()
      }
      return controlSuccess({
        ...replay,
        warning: 'This operation already completed; the API key is not shown again.',
      })
    }

    return controlSuccess({
      ...safe,
      key: rawKey,
      warning: 'The API key is shown once and is not persisted in plaintext. Keep it secret.',
    }, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updateUserApiKey(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const keyId = requireResourceId(context.req.param('id'), 'api_key')
    const patch = parseUpdatePatch(await readJsonObject(context.req.raw))
    let row = await findOwnedApiKey(context.env, keyId, user.id)
    if (row === null) throw apiKeyNotFound()

    const name = patch.name ?? row.name
    const groupId = patch.group_id ?? row.group_id
    const expiresAtMs = Object.hasOwn(patch, 'expires_at_ms')
      ? patch.expires_at_ms ?? null
      : row.expires_at_ms
    const enabled = patch.enabled ?? row.enabled === 1
    const reactivating = enabled && row.enabled !== 1
    if (enabled && row.revoked_at_ms !== null) {
      throw new GatewayError(409, 'api_key_revoked', 'A revoked API key cannot be re-enabled')
    }
    if (groupId !== row.group_id || reactivating) {
      await requireUserGroupAccess(context.env, user.id, groupId, 'bind')
    }

    const authChanged =
      groupId !== row.group_id ||
      expiresAtMs !== row.expires_at_ms ||
      enabled !== (row.enabled === 1)
    if (name === row.name && !authChanged) return controlSuccess(publicApiKey(row))
    const authVersion = row.auth_version + (authChanged ? 1 : 0)
    const controlVersion = row.control_version + 1
    if (!Number.isSafeInteger(authVersion)) {
      throw new GatewayError(409, 'auth_version_exhausted', 'API key auth version is exhausted')
    }
    if (!Number.isSafeInteger(controlVersion)) {
      throw new GatewayError(409, 'control_version_exhausted', 'API key control version is exhausted')
    }

    const now = Date.now()
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE api_keys
              SET name = ?, group_id = ?, enabled = ?, expires_at_ms = ?, auth_version = ?,
                  control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                  updated_at_ms = ?
            WHERE id = ? AND user_id = ?`,
        ).bind(
          name,
          groupId,
          enabled ? 1 : 0,
          expiresAtMs,
          authVersion,
          row.control_version,
          controlVersion,
          now,
          row.id,
          user.id,
        ),
        apiKeyAuditInsert(
          context.env,
          user.id,
          user.session_id,
          'user.api_keys.update',
          { id: row.id, group_id: groupId },
          now,
        ),
      ])
    } catch (error) {
      if (/CHECK constraint failed:.*control_version/i.test(errorMessage(error))) {
        throw new GatewayError(
          409,
          'api_key_update_conflict',
          'API key changed concurrently; retry the update',
        )
      }
      throw error
    }
    row = await findOwnedApiKey(context.env, keyId, user.id)
    if (row === null) {
      throw new GatewayError(
        503,
        'api_key_projection_failed',
        'API key update could not be read',
        'server_error',
      )
    }
    return controlSuccess(publicApiKey(row))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function revokeUserApiKey(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const keyId = requireResourceId(context.req.param('id'), 'api_key')
    let row = await findOwnedApiKey(context.env, keyId, user.id)
    if (row === null) throw apiKeyNotFound()
    if (row.revoked_at_ms !== null) return controlSuccess(publicApiKey(row))
    if (!Number.isSafeInteger(row.auth_version + 1)) {
      throw new GatewayError(409, 'auth_version_exhausted', 'API key auth version is exhausted')
    }
    if (!Number.isSafeInteger(row.control_version + 1)) {
      throw new GatewayError(409, 'control_version_exhausted', 'API key control version is exhausted')
    }

    const now = Date.now()
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE api_keys
              SET enabled = 0,
                  revoked_at_ms = CASE WHEN revoked_at_ms IS NULL THEN ? ELSE -1 END,
                  updated_at_ms = ?, auth_version = auth_version + 1,
                  control_version = control_version + 1
            WHERE id = ? AND user_id = ?`,
        ).bind(now, now, row.id, user.id),
        apiKeyAuditInsert(
          context.env,
          user.id,
          user.session_id,
          'user.api_keys.revoke',
          row,
          now,
        ),
      ])
    } catch (error) {
      if (/CHECK constraint failed:.*revoked_at_ms/i.test(errorMessage(error))) {
        const concurrent = await findOwnedApiKey(context.env, keyId, user.id)
        if (concurrent !== null && concurrent.revoked_at_ms !== null) {
          return controlSuccess(publicApiKey(concurrent))
        }
      }
      throw error
    }
    row = await findOwnedApiKey(context.env, keyId, user.id)
    if (row === null) {
      throw new GatewayError(
        503,
        'api_key_projection_failed',
        'API key revocation could not be read',
        'server_error',
      )
    }
    return controlSuccess(publicApiKey(row))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function apiKeySelect(): string {
  return `SELECT id, user_id, key_hash, name, enabled, expires_at_ms,
                 last_used_at_ms, created_at_ms, updated_at_ms, group_id,
                 key_prefix, auth_version, control_version, revoked_at_ms
            FROM api_keys`
}

function parseCreateInput(body: Record<string, unknown>): CreateApiKeyInput {
  return {
    name: requireString(body, 'name', 128),
    group_id: requireResourceId(requireString(body, 'group_id', 128), 'group'),
    expires_at_ms: parseExpiresAt(body),
  }
}

function parseUpdatePatch(body: Record<string, unknown>): UpdateApiKeyPatch {
  const patch: UpdateApiKeyPatch = {}
  if (Object.hasOwn(body, 'name')) patch.name = requireString(body, 'name', 128)
  if (Object.hasOwn(body, 'group_id')) {
    patch.group_id = requireResourceId(requireString(body, 'group_id', 128), 'group')
  }
  if (Object.hasOwn(body, 'expires_at') || Object.hasOwn(body, 'expires_at_ms')) {
    patch.expires_at_ms = parseExpiresAt(body)
  }
  if (Object.hasOwn(body, 'status')) {
    if (body.status !== 'active' && body.status !== 'inactive') {
      throw new GatewayError(400, 'invalid_status', 'status must be active or inactive')
    }
    patch.enabled = body.status === 'active'
  }
  return patch
}

function parseExpiresAt(body: Record<string, unknown>): number | null {
  if (Object.hasOwn(body, 'expires_at') && Object.hasOwn(body, 'expires_at_ms')) {
    throw new GatewayError(400, 'ambiguous_expires_at', 'Provide expires_at or expires_at_ms, not both')
  }
  let value: number | null
  if (Object.hasOwn(body, 'expires_at')) {
    const raw = body.expires_at
    if (raw === null || raw === '') return null
    if (
      typeof raw !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
    ) {
      throw new GatewayError(400, 'invalid_expires_at', 'expires_at must be an RFC3339 timestamp or null')
    }
    value = Date.parse(raw)
    if (!Number.isSafeInteger(value)) {
      throw new GatewayError(400, 'invalid_expires_at', 'expires_at must be an RFC3339 timestamp or null')
    }
  } else if (Object.hasOwn(body, 'expires_at_ms')) {
    value = body.expires_at_ms === null
      ? null
      : requireSafeInteger(body, 'expires_at_ms')
  } else {
    return null
  }
  if (value !== null && value <= Date.now() + 1_000) {
    throw new GatewayError(400, 'invalid_expires_at', 'expires_at must be in the future')
  }
  return value
}

function requireApiKeyPepper(env: Env): string {
  if (!env.API_KEY_PEPPER || new TextEncoder().encode(env.API_KEY_PEPPER).byteLength < 32) {
    throw new GatewayError(
      503,
      'api_key_secret_not_configured',
      'API key secret is not configured',
      'server_error',
    )
  }
  return env.API_KEY_PEPPER
}

async function findOwnedApiKey(env: Env, id: string, userId: string): Promise<ApiKeyRow | null> {
  return env.DB.prepare(`${apiKeySelect()} WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<ApiKeyRow>()
}

function apiKeyAuditInsert(
  env: Env,
  userId: string,
  sessionId: string,
  eventType: string,
  row: Pick<ApiKeyRow, 'id' | 'group_id'>,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO auth_audit_events (
       id, user_id, event_type, outcome, email_hash, ip_hash,
       session_id, metadata_json, occurred_at_ms
     ) VALUES (?, ?, ?, 'succeeded', NULL, NULL, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    userId,
    eventType,
    sessionId,
    JSON.stringify({ api_key_id: row.id, group_id: row.group_id }),
    now,
  )
}

function invalidIdempotencyRecord(): GatewayError {
  return new GatewayError(
    503,
    'invalid_idempotency_record',
    'Idempotency record is invalid',
    'server_error',
  )
}

function apiKeyNotFound(): GatewayError {
  return new GatewayError(404, 'api_key_not_found', 'API key was not found')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function publicApiKey(row: ApiKeyRow): Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    group_id: row.group_id,
    status: apiKeyStatus(row),
    key_prefix: row.key_prefix,
    expires_at: toIso(row.expires_at_ms),
    last_used_at: toIso(row.last_used_at_ms),
    created_at: new Date(row.created_at_ms).toISOString(),
    updated_at: new Date(row.updated_at_ms).toISOString(),
    revoked_at: toIso(row.revoked_at_ms),
  }
}

function apiKeyStatus(row: ApiKeyRow): 'active' | 'inactive' | 'expired' {
  if (row.revoked_at_ms !== null || row.enabled !== 1) return 'inactive'
  if (row.expires_at_ms !== null && row.expires_at_ms <= Date.now()) return 'expired'
  return 'active'
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}
