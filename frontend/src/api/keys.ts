/**
 * API Keys management endpoints
 * Handles CRUD operations for user API keys
 */

import { apiClient } from './client'
import { isCloudflareWorkerContractActive } from '@/utils/adminCapabilities'
import type { ApiKey, CreateApiKeyRequest, UpdateApiKeyRequest, PaginatedResponse } from '@/types'

export class WorkerFeatureNotSupportedError extends Error {
  readonly code = 'worker_feature_not_supported'

  constructor(feature: string) {
    super(`${feature} is not available in the Cloudflare Worker version`)
    this.name = 'WorkerFeatureNotSupportedError'
  }
}

function operationKey(scope: string): string {
  const requestID = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${scope}-${requestID}`
}

const keyControlVersions = new Map<string, number>()
const pendingWorkerUpdates = new Map<string, string>()

const WORKER_LIMIT_FIELDS = {
  quota: 'quota_micros',
  rate_limit_5h: 'rate_limit_5h_micros',
  rate_limit_1d: 'rate_limit_1d_micros',
  rate_limit_7d: 'rate_limit_7d_micros'
} as const

type ApiKeyLimitField = keyof typeof WORKER_LIMIT_FIELDS
type ApiKeyRawLimitField = typeof WORKER_LIMIT_FIELDS[ApiKeyLimitField]

export type ApiKeyMonetaryBaseline = Partial<
  Pick<ApiKey, ApiKeyLimitField | ApiKeyRawLimitField>
>

export interface ApiKeyUpdateOptions {
  expectedControlVersion?: number
  /**
   * Projection originally loaded for the edit form. Unchanged display values
   * reuse its raw micros so large limits survive a read/edit/write round trip.
   */
  monetaryBaseline?: ApiKeyMonetaryBaseline
}

function invalidAmount(field: string): Error {
  return Object.assign(
    new Error(`${field} must be a non-negative amount with at most 6 decimal places`),
    { code: `invalid_${field}` }
  )
}

/** Convert USD to integer micros without silently rounding user input. */
function dollarsToMicros(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw invalidAmount(field)

  // Number#toString returns the shortest decimal that round-trips to the
  // supplied number. Parse that decimal as integers so valid six-place inputs
  // are never rejected due to an intermediate IEEE-754 multiplication.
  const decimal = value.toString()
  if (/[eE]/.test(decimal)) throw invalidAmount(field)
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal)
  if (match === null) throw invalidAmount(field)
  const fraction = match[2] ?? ''
  if (fraction.slice(6).replace(/0/g, '').length > 0) throw invalidAmount(field)

  const micros = BigInt(match[1]) * 1_000_000n
    + BigInt(fraction.slice(0, 6).padEnd(6, '0') || '0')
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidAmount(field)
  return Number(micros)
}

function microsToDollars(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw Object.assign(new Error(`Worker returned an invalid ${field}`), {
      code: 'invalid_worker_api_key_projection'
    })
  }
  return (value as number) / 1_000_000
}

function millisToIso(value: unknown, field: string): string | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw Object.assign(new Error(`Worker returned an invalid ${field}`), {
      code: 'invalid_worker_api_key_projection'
    })
  }
  const date = new Date(value as number)
  if (!Number.isFinite(date.getTime())) {
    throw Object.assign(new Error(`Worker returned an invalid ${field}`), {
      code: 'invalid_worker_api_key_projection'
    })
  }
  return date.toISOString()
}

function rememberKey(key: ApiKey): void {
  if (Number.isSafeInteger(key.control_version) && key.control_version! >= 0) {
    keyControlVersions.set(String(key.id), key.control_version!)
  }
}

function adaptWorkerKey(key: ApiKey): ApiKey {
  if (!isCloudflareWorkerContractActive()) return key
  const raw = key as ApiKey & Record<string, unknown>
  const adapted = { ...key }
  for (const [workerField, uiField] of [
    ['quota_micros', 'quota'],
    ['quota_used_micros', 'quota_used'],
    ['rate_limit_5h_micros', 'rate_limit_5h'],
    ['rate_limit_1d_micros', 'rate_limit_1d'],
    ['rate_limit_7d_micros', 'rate_limit_7d'],
    ['usage_5h_micros', 'usage_5h'],
    ['usage_1d_micros', 'usage_1d'],
    ['usage_7d_micros', 'usage_7d']
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, workerField)) {
      adapted[uiField] = microsToDollars(raw[workerField], workerField)
    }
  }
  for (const [workerField, uiField] of [
    ['window_5h_start_ms', 'window_5h_start'],
    ['window_1d_start_ms', 'window_1d_start'],
    ['window_7d_start_ms', 'window_7d_start'],
    ['reset_5h_at_ms', 'reset_5h_at'],
    ['reset_1d_at_ms', 'reset_1d_at'],
    ['reset_7d_at_ms', 'reset_7d_at']
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, workerField)) {
      adapted[uiField] = millisToIso(raw[workerField], workerField)
    }
  }
  rememberKey(adapted)
  return adapted
}

function adaptWorkerPage(page: PaginatedResponse<ApiKey>): PaginatedResponse<ApiKey> {
  if (!isCloudflareWorkerContractActive()) return page
  return { ...page, items: page.items.map(adaptWorkerKey) }
}

function workerAmountPayload(
  payload: Record<string, unknown>,
  field: ApiKeyLimitField,
  value: number | undefined,
  baseline?: ApiKeyMonetaryBaseline
): void {
  if (value === undefined) return
  const rawField = WORKER_LIMIT_FIELDS[field]
  const baselineDisplay = baseline?.[field]
  const baselineMicros = baseline?.[rawField]
  payload[rawField] =
    typeof baselineDisplay === 'number' &&
    value === baselineDisplay &&
    typeof baselineMicros === 'number' &&
    Number.isSafeInteger(baselineMicros) &&
    baselineMicros >= 0
      ? baselineMicros
      : dollarsToMicros(value, field)
}

function requireControlVersion(id: string | number, supplied?: number): number {
  const version = supplied ?? keyControlVersions.get(String(id))
  if (!Number.isSafeInteger(version) || version! < 0) {
    throw Object.assign(new Error('Reload this API key before changing it'), {
      code: 'api_key_version_not_loaded'
    })
  }
  return version!
}

function workerUpdateFingerprint(
  id: string | number,
  version: number,
  payload: Record<string, unknown>
): string {
  return JSON.stringify([String(id), version, Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))])
}

/**
 * List all API keys for current user
 * @param page - Page number (default: 1)
 * @param pageSize - Items per page (default: 10)
 * @param filters - Optional filter parameters
 * @param options - Optional request options
 * @returns Paginated list of API keys
 */
export async function list(
  page: number = 1,
  pageSize: number = 10,
  filters?: {
    search?: string
    status?: string
    group_id?: number | string
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  },
  options?: {
    signal?: AbortSignal
  }
): Promise<PaginatedResponse<ApiKey>> {
  const { data } = await apiClient.get<PaginatedResponse<ApiKey>>('/keys', {
    params: { page, page_size: pageSize, ...filters },
    signal: options?.signal
  })
  return adaptWorkerPage(data)
}

/**
 * Get API key by ID
 * @param id - API key ID
 * @returns API key details
 */
export async function getById(id: string | number): Promise<ApiKey> {
  const { data } = await apiClient.get<ApiKey>(`/keys/${id}`)
  return adaptWorkerKey(data)
}

/**
 * Create new API key
 * @param name - Key name
 * @param groupId - Optional group ID
 * @param customKey - Optional custom key value
 * @param ipWhitelist - Optional IP whitelist
 * @param ipBlacklist - Optional IP blacklist
 * @param quota - Optional quota limit in USD (0 = unlimited)
 * @param expiresInDays - Optional days until expiry (undefined = never expires)
 * @param rateLimitData - Optional rate limit fields
 * @returns Created API key
 */
export async function create(
  name: string,
  groupId?: string | number | null,
  customKey?: string,
  ipWhitelist?: string[],
  ipBlacklist?: string[],
  quota?: number,
  expiresInDays?: number,
  rateLimitData?: { rate_limit_5h?: number; rate_limit_1d?: number; rate_limit_7d?: number }
): Promise<ApiKey> {
  if (!isCloudflareWorkerContractActive()) {
    const payload = { name } as CreateApiKeyRequest
    if (groupId !== undefined) payload.group_id = groupId as number | string
    if (customKey) payload.custom_key = customKey
    if (ipWhitelist?.length) payload.ip_whitelist = ipWhitelist
    if (ipBlacklist?.length) payload.ip_blacklist = ipBlacklist
    if (quota !== undefined && quota > 0) payload.quota = quota
    if (expiresInDays !== undefined && expiresInDays > 0) payload.expires_in_days = expiresInDays
    if (rateLimitData?.rate_limit_5h && rateLimitData.rate_limit_5h > 0) {
      payload.rate_limit_5h = rateLimitData.rate_limit_5h
    }
    if (rateLimitData?.rate_limit_1d && rateLimitData.rate_limit_1d > 0) {
      payload.rate_limit_1d = rateLimitData.rate_limit_1d
    }
    if (rateLimitData?.rate_limit_7d && rateLimitData.rate_limit_7d > 0) {
      payload.rate_limit_7d = rateLimitData.rate_limit_7d
    }
    const { data } = await apiClient.post<ApiKey>('/keys', payload)
    return data
  }

  if (customKey) throw new WorkerFeatureNotSupportedError('Custom API keys')
  if (ipWhitelist?.length || ipBlacklist?.length) {
    throw new WorkerFeatureNotSupportedError('API key IP restrictions')
  }
  if (groupId === undefined || groupId === null || String(groupId).length === 0) {
    throw new Error('group_id is required')
  }

  const payload: Record<string, unknown> = { name, group_id: String(groupId) }
  workerAmountPayload(payload, 'quota', quota)
  workerAmountPayload(payload, 'rate_limit_5h', rateLimitData?.rate_limit_5h)
  workerAmountPayload(payload, 'rate_limit_1d', rateLimitData?.rate_limit_1d)
  workerAmountPayload(payload, 'rate_limit_7d', rateLimitData?.rate_limit_7d)
  if (expiresInDays !== undefined && expiresInDays > 0) {
    payload.expires_at_ms = Date.now() + Math.ceil(expiresInDays * 24 * 60 * 60 * 1000)
  }

  const { data } = await apiClient.post<ApiKey>('/keys', payload, {
    headers: { 'Idempotency-Key': operationKey('user-api-key-create') }
  })
  return adaptWorkerKey(data)
}

/**
 * Update API key
 * @param id - API key ID
 * @param updates - Fields to update
 * @returns Updated API key
 */
export async function update(
  id: string | number,
  updates: UpdateApiKeyRequest,
  control?: number | ApiKeyUpdateOptions
): Promise<ApiKey> {
  if (!isCloudflareWorkerContractActive()) {
    const { data } = await apiClient.put<ApiKey>(`/keys/${id}`, updates)
    return data
  }

  const unsupported = [
    'ip_whitelist',
    'ip_blacklist'
  ].filter((field) => Object.prototype.hasOwnProperty.call(updates, field))
  if (unsupported.length > 0) {
    throw new WorkerFeatureNotSupportedError(`API key fields: ${unsupported.join(', ')}`)
  }

  const payload: Record<string, unknown> = {}
  if (updates.name !== undefined) payload.name = updates.name
  if (updates.group_id === null) {
    throw new WorkerFeatureNotSupportedError('Unbinding an API key from its group')
  }
  if (updates.group_id !== undefined) payload.group_id = String(updates.group_id)
  if (updates.status !== undefined) payload.status = updates.status
  if (updates.expires_at !== undefined) {
    const expiresAtMs = updates.expires_at ? Date.parse(updates.expires_at) : null
    if (expiresAtMs !== null && !Number.isSafeInteger(expiresAtMs)) {
      throw Object.assign(new Error('expires_at must be a valid timestamp'), {
        code: 'invalid_expires_at'
      })
    }
    payload.expires_at_ms = expiresAtMs
  }
  const options = typeof control === 'number'
    ? { expectedControlVersion: control }
    : (control ?? {})
  workerAmountPayload(payload, 'quota', updates.quota, options.monetaryBaseline)
  workerAmountPayload(payload, 'rate_limit_5h', updates.rate_limit_5h, options.monetaryBaseline)
  workerAmountPayload(payload, 'rate_limit_1d', updates.rate_limit_1d, options.monetaryBaseline)
  workerAmountPayload(payload, 'rate_limit_7d', updates.rate_limit_7d, options.monetaryBaseline)
  if (updates.reset_quota !== undefined) payload.reset_quota = updates.reset_quota
  if (updates.reset_rate_limit_usage !== undefined) {
    payload.reset_rate_limit_usage = updates.reset_rate_limit_usage
  }

  const version = requireControlVersion(id, options.expectedControlVersion)
  const fingerprint = workerUpdateFingerprint(id, version, payload)
  let idempotencyKey = pendingWorkerUpdates.get(fingerprint)
  if (idempotencyKey === undefined) {
    idempotencyKey = operationKey(`user-api-key-update-${id}`)
    pendingWorkerUpdates.set(fingerprint, idempotencyKey)
  }
  const { data } = await apiClient.put<ApiKey>(`/keys/${id}`, payload, {
    headers: {
      'Idempotency-Key': idempotencyKey,
      'If-Match': `"${version}"`
    }
  })
  pendingWorkerUpdates.delete(fingerprint)
  return adaptWorkerKey(data)
}

/**
 * Delete API key
 * @param id - API key ID
 * @returns Success confirmation
 */
export async function deleteKey(id: string | number): Promise<ApiKey> {
  const { data } = await apiClient.delete<ApiKey>(`/keys/${id}`)
  return adaptWorkerKey(data)
}

/**
 * Toggle API key status (active/inactive)
 * @param id - API key ID
 * @param status - New status
 * @returns Updated API key
 */
export async function toggleStatus(
  id: string | number,
  status: 'active' | 'inactive',
  expectedControlVersion?: number
): Promise<ApiKey> {
  return update(id, { status }, expectedControlVersion)
}

export const keysAPI = {
  list,
  getById,
  create,
  update,
  delete: deleteKey,
  toggleStatus
}

export default keysAPI
