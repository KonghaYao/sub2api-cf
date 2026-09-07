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
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
  requireSafeInteger,
  requireString,
} from '../control/http'
import type { Env } from '../env'
import { apiKeyDigest, randomToken } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { normalizeIpPolicyList, parseStoredIpPolicy } from '../gateway/ip-policy'
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
  last_used_ip?: string | null
  created_at_ms: number
  updated_at_ms: number
  group_id: string
  key_prefix: string
  auth_version: number
  control_version: number
  revoked_at_ms: number | null
  quota_micros: number
  quota_used_micros: number
  rate_limit_5h_micros: number
  rate_limit_1d_micros: number
  rate_limit_7d_micros: number
  usage_5h_micros: number
  usage_1d_micros: number
  usage_7d_micros: number
  window_5h_start_ms: number | null
  window_1d_start_ms: number | null
  window_7d_start_ms: number | null
  quota_reset_epoch: number
  rate_limit_reset_epoch: number
  ip_allowlist_json: string
  ip_denylist_json: string
}

interface CreateApiKeyInput {
  name: string
  group_id: string
  expires_at_ms: number | null
  quota_micros: number
  rate_limit_5h_micros: number
  rate_limit_1d_micros: number
  rate_limit_7d_micros: number
  custom_key?: string
  ip_whitelist: string[]
  ip_blacklist: string[]
}

interface UpdateApiKeyPatch {
  name?: string
  group_id?: string
  expires_at_ms?: number | null
  enabled?: boolean
  quota_micros?: number
  rate_limit_5h_micros?: number
  rate_limit_1d_micros?: number
  rate_limit_7d_micros?: number
  reset_quota?: boolean
  reset_rate_limit_usage?: boolean
  ip_whitelist?: string[]
  ip_blacklist?: string[]
}

type ApiKeyListStatus = 'active' | 'inactive' | 'expired' | 'quota_exhausted'
type ApiKeyListSort = keyof typeof API_KEY_LIST_SORT_COLUMNS
type ApiKeyListSortOrder = 'asc' | 'desc'

interface ApiKeyListQuery {
  search?: string
  status?: ApiKeyListStatus
  groupId?: string | null
  sortBy: ApiKeyListSort
  sortOrder: ApiKeyListSortOrder
}

const API_KEY_BODY_LIMIT_BYTES = 16 * 1024
const API_KEY_LIST_SEARCH_MAXIMUM = 100
const API_KEY_LIST_SORT_COLUMNS = {
  id: 'id',
  name: 'name COLLATE NOCASE',
  status: 'enabled',
  expires_at: 'expires_at_ms',
  last_used_at: 'last_used_at_ms',
  created_at: 'created_at_ms',
} as const

export async function listUserApiKeys(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 10, 1, 100)
    const query = parseApiKeyListQuery(context)
    const { where, values } = apiKeyListWhere(user.id, query)
    const direction = query.sortOrder.toUpperCase()
    const sortColumn = API_KEY_LIST_SORT_COLUMNS[query.sortBy]
    const stableOrder = query.sortBy === 'id' ? '' : `, id ${direction}`
    const [countResult, rowsResult] = await context.env.DB.batch([
      context.env.DB.prepare(`SELECT COUNT(*) AS total FROM api_keys ${where}`).bind(...values),
      context.env.DB.prepare(
        `${apiKeySelect()} ${where}
         ORDER BY ${sortColumn} ${direction}${stableOrder}
         LIMIT ? OFFSET ?`,
      ).bind(...values, pageSize, (page - 1) * pageSize),
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

function parseApiKeyListQuery(context: Context<UserBindings>): ApiKeyListQuery {
  const search = optionalApiKeyListValue(
    context.req.query('search'),
    'search',
    API_KEY_LIST_SEARCH_MAXIMUM,
  )
  const statusRaw = optionalApiKeyListValue(context.req.query('status'), 'status', 16)
  if (statusRaw !== undefined && !['active', 'inactive', 'expired', 'quota_exhausted'].includes(statusRaw)) {
    throw new GatewayError(400, 'invalid_status', 'status must be active, inactive, expired, or quota_exhausted')
  }
  const groupRaw = optionalApiKeyListValue(context.req.query('group_id'), 'group_id', 128)
  const sortByRaw = optionalApiKeyListValue(context.req.query('sort_by'), 'sort_by', 32)
  if (
    sortByRaw !== undefined &&
    !Object.hasOwn(API_KEY_LIST_SORT_COLUMNS, sortByRaw)
  ) {
    throw new GatewayError(
      400,
      'invalid_sort_by',
      `sort_by must be one of: ${Object.keys(API_KEY_LIST_SORT_COLUMNS).join(', ')}`,
    )
  }
  const sortOrderRaw = optionalApiKeyListValue(context.req.query('sort_order'), 'sort_order', 4)
  if (sortOrderRaw !== undefined && sortOrderRaw !== 'asc' && sortOrderRaw !== 'desc') {
    throw new GatewayError(400, 'invalid_sort_order', 'sort_order must be asc or desc')
  }
  return {
    ...(search === undefined ? {} : { search }),
    ...(statusRaw === undefined ? {} : { status: statusRaw as ApiKeyListStatus }),
    ...(groupRaw === undefined
      ? {}
      : { groupId: groupRaw === '0' ? null : requireResourceId(groupRaw, 'group') }),
    sortBy: (sortByRaw ?? 'created_at') as ApiKeyListSort,
    sortOrder: (sortOrderRaw ?? 'desc') as ApiKeyListSortOrder,
  }
}

function optionalApiKeyListValue(
  raw: string | undefined,
  name: string,
  maximum: number,
): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = raw.trim()
  if (value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GatewayError(400, `invalid_${name}`, `${name} is invalid`)
  }
  return value
}

function apiKeyListWhere(
  userId: string,
  query: ApiKeyListQuery,
): { where: string; values: unknown[] } {
  const conditions = ['user_id = ?', 'revoked_at_ms IS NULL']
  const values: unknown[] = [userId]
  if (query.search !== undefined) {
    const literal = `%${escapeLikePattern(query.search)}%`
    conditions.push(
      `(name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR key_prefix LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
    )
    values.push(literal, literal)
  }
  // Match publicApiKey's precedence: disabled, expired, quota exhausted, active.
  // Filtering the stored enabled flag alone misclassifies expired/exhausted keys.
  if (query.status === 'inactive') {
    conditions.push('enabled = 0')
  } else if (query.status !== undefined) {
    conditions.push('enabled = 1')
    if (query.status === 'expired') {
      conditions.push('expires_at_ms IS NOT NULL AND expires_at_ms <= ?')
    } else {
      conditions.push('(expires_at_ms IS NULL OR expires_at_ms > ?)')
      conditions.push(query.status === 'quota_exhausted'
        ? 'quota_micros > 0 AND quota_used_micros >= quota_micros'
        : '(quota_micros = 0 OR quota_used_micros < quota_micros)')
    }
    values.push(Date.now())
  }
  if (query.groupId === null) {
    conditions.push('group_id IS NULL')
  } else if (query.groupId !== undefined) {
    conditions.push('group_id = ?')
    values.push(query.groupId)
  }
  return { where: `WHERE ${conditions.join(' AND ')}`, values }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
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
    const input = parseCreateInput(await readJsonObject(context.req.raw, API_KEY_BODY_LIMIT_BYTES))
    const pepper = requireApiKeyPepper(context.env)
    const customKeyHash = input.custom_key === undefined
      ? undefined
      : await apiKeyDigest(input.custom_key, pepper)
    const idempotency = await controlIdempotency(
      `user.api_keys.create.v1:${user.id}`,
      idempotencyKey,
      customKeyHash === undefined
        ? input
        : { ...input, custom_key: undefined, custom_key_digest: customKeyHash },
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
    const rawKey = input.custom_key ?? `sk-sub2api-${randomToken(36)}`
    const keyHash = customKeyHash ?? await apiKeyDigest(rawKey, pepper)
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
      key_prefix: input.custom_key === undefined ? rawKey.slice(0, 16) : rawKey.slice(0, 8),
      auth_version: 1,
      control_version: 0,
      revoked_at_ms: null,
      quota_micros: input.quota_micros,
      quota_used_micros: 0,
      rate_limit_5h_micros: input.rate_limit_5h_micros,
      rate_limit_1d_micros: input.rate_limit_1d_micros,
      rate_limit_7d_micros: input.rate_limit_7d_micros,
      usage_5h_micros: 0,
      usage_1d_micros: 0,
      usage_7d_micros: 0,
      window_5h_start_ms: null,
      window_1d_start_ms: null,
      window_7d_start_ms: null,
      quota_reset_epoch: 0,
      rate_limit_reset_epoch: 0,
      ip_allowlist_json: JSON.stringify(input.ip_whitelist),
      ip_denylist_json: JSON.stringify(input.ip_blacklist),
    }
    const safe = publicApiKey(row)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO api_keys (
             id, user_id, key_hash, name, enabled, expires_at_ms,
             last_used_at_ms, created_at_ms, updated_at_ms,
             group_id, key_prefix, auth_version, revoked_at_ms,
             quota_micros, rate_limit_5h_micros,
             rate_limit_1d_micros, rate_limit_7d_micros,
             ip_allowlist_json, ip_denylist_json
           ) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?)`,
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
          input.quota_micros,
          input.rate_limit_5h_micros,
          input.rate_limit_1d_micros,
          input.rate_limit_7d_micros,
          row.ip_allowlist_json,
          row.ip_denylist_json,
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
      if (recovered === null) {
        if (isApiKeyDigestConflict(error)) {
          throw new GatewayError(409, 'api_key_exists', 'API key already exists')
        }
        throw error
      }
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
    const body = await readJsonObject(context.req.raw, API_KEY_BODY_LIMIT_BYTES)
    const patch = parseUpdatePatch(body)
    const expectedControlVersion = requireExpectedControlVersion(context.req.raw, body)
    let row = await findOwnedApiKey(context.env, keyId, user.id)
    if (row === null) throw apiKeyNotFound()
    assertApiKeyControlVersion(row.control_version, expectedControlVersion)

    const name = patch.name ?? row.name
    const groupId = patch.group_id ?? row.group_id
    const expiresAtMs = Object.hasOwn(patch, 'expires_at_ms')
      ? patch.expires_at_ms ?? null
      : row.expires_at_ms
    const enabled = patch.enabled ?? row.enabled === 1
    const quotaMicros = patch.quota_micros ?? row.quota_micros
    const rateLimit5hMicros = patch.rate_limit_5h_micros ?? row.rate_limit_5h_micros
    const rateLimit1dMicros = patch.rate_limit_1d_micros ?? row.rate_limit_1d_micros
    const rateLimit7dMicros = patch.rate_limit_7d_micros ?? row.rate_limit_7d_micros
    const resetQuota = patch.reset_quota === true
    const resetRateLimitUsage = patch.reset_rate_limit_usage === true
    const ipWhitelist = patch.ip_whitelist ?? storedPolicy(row.ip_allowlist_json, 'ip_allowlist_json')
    const ipBlacklist = patch.ip_blacklist ?? storedPolicy(row.ip_denylist_json, 'ip_denylist_json')
    assertResetEpochAvailable(row.quota_reset_epoch, resetQuota, 'quota_reset_epoch')
    assertResetEpochAvailable(
      row.rate_limit_reset_epoch,
      resetRateLimitUsage,
      'rate_limit_reset_epoch',
    )
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
      enabled !== (row.enabled === 1) ||
      !samePolicy(ipWhitelist, storedPolicy(row.ip_allowlist_json, 'ip_allowlist_json')) ||
      !samePolicy(ipBlacklist, storedPolicy(row.ip_denylist_json, 'ip_denylist_json'))
    const monetaryChanged =
      quotaMicros !== row.quota_micros ||
      rateLimit5hMicros !== row.rate_limit_5h_micros ||
      rateLimit1dMicros !== row.rate_limit_1d_micros ||
      rateLimit7dMicros !== row.rate_limit_7d_micros ||
      resetQuota ||
      resetRateLimitUsage
    if (name === row.name && !authChanged && !monetaryChanged) {
      return controlSuccess(publicApiKey(row))
    }
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
                  quota_micros = ?,
                  rate_limit_5h_micros = ?, rate_limit_1d_micros = ?, rate_limit_7d_micros = ?,
                  quota_used_micros = CASE WHEN ? THEN 0 ELSE quota_used_micros END,
                  usage_5h_micros = CASE WHEN ? THEN 0 ELSE usage_5h_micros END,
                  usage_1d_micros = CASE WHEN ? THEN 0 ELSE usage_1d_micros END,
                  usage_7d_micros = CASE WHEN ? THEN 0 ELSE usage_7d_micros END,
                  window_5h_start_ms = CASE WHEN ? THEN NULL ELSE window_5h_start_ms END,
                  window_1d_start_ms = CASE WHEN ? THEN NULL ELSE window_1d_start_ms END,
                  window_7d_start_ms = CASE WHEN ? THEN NULL ELSE window_7d_start_ms END,
                  quota_reset_epoch = CASE WHEN ? THEN quota_reset_epoch + 1 ELSE quota_reset_epoch END,
                  rate_limit_reset_epoch = CASE WHEN ? THEN rate_limit_reset_epoch + 1 ELSE rate_limit_reset_epoch END,
                  ip_allowlist_json = ?, ip_denylist_json = ?,
                  control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                  updated_at_ms = ?
            WHERE id = ? AND user_id = ?`,
        ).bind(
          name,
          groupId,
          enabled ? 1 : 0,
          expiresAtMs,
          authVersion,
          quotaMicros,
          rateLimit5hMicros,
          rateLimit1dMicros,
          rateLimit7dMicros,
          resetQuota ? 1 : 0,
          resetRateLimitUsage ? 1 : 0,
          resetRateLimitUsage ? 1 : 0,
          resetRateLimitUsage ? 1 : 0,
          resetRateLimitUsage ? 1 : 0,
          resetRateLimitUsage ? 1 : 0,
          resetRateLimitUsage ? 1 : 0,
          resetQuota ? 1 : 0,
          resetRateLimitUsage ? 1 : 0,
          JSON.stringify(ipWhitelist),
          JSON.stringify(ipBlacklist),
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
          412,
          'control_version_conflict',
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

    const tombstoneHash = await apiKeyDigest(
      `revoked-api-key:v1\u0000${row.id}\u0000${row.key_hash}`,
      requireApiKeyPepper(context.env),
    )
    const now = Date.now()
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE api_keys
              SET key_hash = ?, enabled = 0,
                  revoked_at_ms = CASE WHEN revoked_at_ms IS NULL THEN ? ELSE -1 END,
                  updated_at_ms = ?, auth_version = auth_version + 1,
                  control_version = control_version + 1
            WHERE id = ? AND user_id = ?`,
        ).bind(tombstoneHash, now, now, row.id, user.id),
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
                 key_prefix, auth_version, control_version, revoked_at_ms,
                 quota_micros, quota_used_micros,
                 rate_limit_5h_micros, rate_limit_1d_micros, rate_limit_7d_micros,
                 usage_5h_micros, usage_1d_micros, usage_7d_micros,
                 window_5h_start_ms, window_1d_start_ms, window_7d_start_ms,
                 quota_reset_epoch, rate_limit_reset_epoch,
                 (SELECT observation.client_ip FROM request_observations observation
                   WHERE observation.api_key_id = api_keys.id AND observation.user_id = api_keys.user_id
                     AND observation.client_ip IS NOT NULL AND observation.client_ip <> ''
                   ORDER BY observation.occurred_at_ms DESC, observation.id DESC
                   LIMIT 1) AS last_used_ip,
                 ip_allowlist_json, ip_denylist_json
            FROM api_keys`
}

function parseCreateInput(body: Record<string, unknown>): CreateApiKeyInput {
  rejectLegacyMonetaryFields(body)
  rejectServerManagedMonetaryFields(body)
  const customKey = parseCustomKey(body)
  return {
    name: requireString(body, 'name', 128),
    group_id: requireResourceId(requireString(body, 'group_id', 128), 'group'),
    expires_at_ms: parseExpiresAt(body),
    quota_micros: optionalMonetaryLimit(body, 'quota_micros'),
    rate_limit_5h_micros: optionalMonetaryLimit(body, 'rate_limit_5h_micros'),
    rate_limit_1d_micros: optionalMonetaryLimit(body, 'rate_limit_1d_micros'),
    rate_limit_7d_micros: optionalMonetaryLimit(body, 'rate_limit_7d_micros'),
    ...(customKey === undefined ? {} : { custom_key: customKey }),
    ip_whitelist: optionalIpPolicy(body, 'ip_whitelist'),
    ip_blacklist: optionalIpPolicy(body, 'ip_blacklist'),
  }
}

function parseUpdatePatch(body: Record<string, unknown>): UpdateApiKeyPatch {
  if (Object.hasOwn(body, 'custom_key')) {
    throw new GatewayError(400, 'custom_key_create_only', 'custom_key is accepted only when creating an API key')
  }
  rejectLegacyMonetaryFields(body)
  rejectServerManagedMonetaryFields(body)
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
  for (const field of MONETARY_LIMIT_FIELDS) {
    if (Object.hasOwn(body, field)) patch[field] = requireSafeInteger(body, field)
  }
  if (Object.hasOwn(body, 'reset_quota')) {
    if (typeof body.reset_quota !== 'boolean') {
      throw new GatewayError(400, 'invalid_reset_quota', 'reset_quota must be a boolean')
    }
    patch.reset_quota = body.reset_quota
  }
  if (Object.hasOwn(body, 'reset_rate_limit_usage')) {
    if (typeof body.reset_rate_limit_usage !== 'boolean') {
      throw new GatewayError(
        400,
        'invalid_reset_rate_limit_usage',
        'reset_rate_limit_usage must be a boolean',
      )
    }
    patch.reset_rate_limit_usage = body.reset_rate_limit_usage
  }
  if (Object.hasOwn(body, 'ip_whitelist')) {
    patch.ip_whitelist = normalizeIpPolicyList(body.ip_whitelist, 'ip_whitelist')
  }
  if (Object.hasOwn(body, 'ip_blacklist')) {
    patch.ip_blacklist = normalizeIpPolicyList(body.ip_blacklist, 'ip_blacklist')
  }
  return patch
}

function parseCustomKey(body: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(body, 'custom_key') || body.custom_key === undefined || body.custom_key === null || body.custom_key === '') {
    return undefined
  }
  if (typeof body.custom_key !== 'string') {
    throw new GatewayError(400, 'invalid_custom_key', 'custom_key must be a string')
  }
  if (body.custom_key.length < 24) {
    throw new GatewayError(400, 'api_key_too_short', 'custom_key must contain at least 24 characters')
  }
  if (body.custom_key.length > 128) {
    throw new GatewayError(400, 'api_key_too_long', 'custom_key must contain at most 128 characters')
  }
  if (!/^[A-Za-z0-9_-]+$/.test(body.custom_key)) {
    throw new GatewayError(
      400,
      'api_key_invalid_chars',
      'custom_key may contain only letters, numbers, underscores, and hyphens',
    )
  }
  if (new Set(body.custom_key).size < 8) {
    throw new GatewayError(
      400,
      'api_key_low_entropy',
      'custom_key must contain at least 8 distinct characters',
    )
  }
  return body.custom_key
}

function optionalIpPolicy(
  body: Record<string, unknown>,
  field: 'ip_whitelist' | 'ip_blacklist',
): string[] {
  return Object.hasOwn(body, field) ? normalizeIpPolicyList(body[field], field) : []
}

const MONETARY_LIMIT_FIELDS = [
  'quota_micros',
  'rate_limit_5h_micros',
  'rate_limit_1d_micros',
  'rate_limit_7d_micros',
] as const

const LEGACY_MONETARY_FIELDS = [
  'quota',
  'quota_used',
  'rate_limit_5h',
  'rate_limit_1d',
  'rate_limit_7d',
  'usage_5h',
  'usage_1d',
  'usage_7d',
] as const

const SERVER_MANAGED_MONETARY_FIELDS = [
  'quota_used_micros',
  'usage_5h_micros',
  'usage_1d_micros',
  'usage_7d_micros',
  'window_5h_start_ms',
  'window_1d_start_ms',
  'window_7d_start_ms',
  'quota_reset_epoch',
  'rate_limit_reset_epoch',
] as const

function optionalMonetaryLimit(
  body: Record<string, unknown>,
  field: typeof MONETARY_LIMIT_FIELDS[number],
): number {
  return Object.hasOwn(body, field) ? requireSafeInteger(body, field) : 0
}

function rejectLegacyMonetaryFields(body: Record<string, unknown>): void {
  const field = LEGACY_MONETARY_FIELDS.find((candidate) => Object.hasOwn(body, candidate))
  if (field !== undefined) {
    throw new GatewayError(
      400,
      'legacy_monetary_field_not_supported',
      `${field} is not supported; use the corresponding integer _micros field`,
    )
  }
}

function rejectServerManagedMonetaryFields(body: Record<string, unknown>): void {
  const field = SERVER_MANAGED_MONETARY_FIELDS.find((candidate) => Object.hasOwn(body, candidate))
  if (field !== undefined) {
    throw new GatewayError(400, `invalid_${field}`, `${field} is managed by the Worker`)
  }
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

function isApiKeyDigestConflict(error: unknown): boolean {
  return /UNIQUE constraint failed:\s*api_keys\.key_hash/i.test(errorMessage(error))
}

function storedPolicy(
  value: string,
  field: 'ip_allowlist_json' | 'ip_denylist_json',
): string[] {
  return parseStoredIpPolicy(value, field).map((rule) => rule.canonical)
}

function samePolicy(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((rule, index) => rule === right[index])
}

function publicApiKey(row: ApiKeyRow): Record<string, unknown> {
  const windows = effectiveRateLimitWindows(row, Date.now())
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    group_id: row.group_id,
    status: apiKeyStatus(row),
    key_prefix: row.key_prefix,
    control_version: row.control_version,
    quota_micros: row.quota_micros,
    quota_used_micros: row.quota_used_micros,
    rate_limit_5h_micros: row.rate_limit_5h_micros,
    rate_limit_1d_micros: row.rate_limit_1d_micros,
    rate_limit_7d_micros: row.rate_limit_7d_micros,
    usage_5h_micros: windows['5h'].usage_micros,
    usage_1d_micros: windows['1d'].usage_micros,
    usage_7d_micros: windows['7d'].usage_micros,
    window_5h_start_ms: windows['5h'].window_start_ms,
    window_1d_start_ms: windows['1d'].window_start_ms,
    window_7d_start_ms: windows['7d'].window_start_ms,
    reset_5h_at_ms: windows['5h'].reset_at_ms,
    reset_1d_at_ms: windows['1d'].reset_at_ms,
    reset_7d_at_ms: windows['7d'].reset_at_ms,
    quota_reset_epoch: row.quota_reset_epoch,
    rate_limit_reset_epoch: row.rate_limit_reset_epoch,
    rate_limit_windows: windows,
    expires_at: toIso(row.expires_at_ms),
    last_used_at: toIso(row.last_used_at_ms),
    created_at: new Date(row.created_at_ms).toISOString(),
    updated_at: new Date(row.updated_at_ms).toISOString(),
    revoked_at: toIso(row.revoked_at_ms),
    ip_whitelist: storedPolicy(row.ip_allowlist_json, 'ip_allowlist_json'),
    ip_blacklist: storedPolicy(row.ip_denylist_json, 'ip_denylist_json'),
    last_used_ip: row.last_used_ip ?? null,
  }
}

function apiKeyStatus(row: ApiKeyRow): 'active' | 'inactive' | 'expired' | 'quota_exhausted' {
  if (row.revoked_at_ms !== null || row.enabled !== 1) return 'inactive'
  if (row.expires_at_ms !== null && row.expires_at_ms <= Date.now()) return 'expired'
  if (row.quota_micros > 0 && row.quota_used_micros >= row.quota_micros) {
    return 'quota_exhausted'
  }
  return 'active'
}

const RATE_LIMIT_WINDOW_MS = {
  '5h': 5 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
} as const

interface EffectiveRateLimitWindow {
  usage_micros: number
  window_start_ms: number | null
  reset_at_ms: number | null
}

function effectiveRateLimitWindows(
  row: ApiKeyRow,
  now: number,
): Record<keyof typeof RATE_LIMIT_WINDOW_MS, EffectiveRateLimitWindow> {
  return {
    '5h': effectiveRateLimitWindow(row.usage_5h_micros, row.window_5h_start_ms, RATE_LIMIT_WINDOW_MS['5h'], now),
    '1d': effectiveRateLimitWindow(row.usage_1d_micros, row.window_1d_start_ms, RATE_LIMIT_WINDOW_MS['1d'], now),
    '7d': effectiveRateLimitWindow(row.usage_7d_micros, row.window_7d_start_ms, RATE_LIMIT_WINDOW_MS['7d'], now),
  }
}

function effectiveRateLimitWindow(
  usage: number,
  start: number | null,
  duration: number,
  now: number,
): EffectiveRateLimitWindow {
  if (start === null || start <= now - duration) {
    return { usage_micros: 0, window_start_ms: null, reset_at_ms: null }
  }
  return { usage_micros: usage, window_start_ms: start, reset_at_ms: start + duration }
}

function assertApiKeyControlVersion(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new GatewayError(412, 'control_version_conflict', 'API key changed; reload it and retry')
  }
}

function assertResetEpochAvailable(epoch: number, reset: boolean, field: string): void {
  if (reset && epoch >= Number.MAX_SAFE_INTEGER) {
    throw new GatewayError(409, `${field}_exhausted`, `${field} is exhausted`)
  }
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}
