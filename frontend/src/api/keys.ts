/**
 * API Keys management endpoints
 * Handles CRUD operations for user API keys
 */

import { apiClient } from './client'
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
  return data
}

/**
 * Get API key by ID
 * @param id - API key ID
 * @returns API key details
 */
export async function getById(id: string): Promise<ApiKey> {
  const { data } = await apiClient.get<ApiKey>(`/keys/${id}`)
  return data
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
  groupId?: string | null,
  customKey?: string,
  ipWhitelist?: string[],
  ipBlacklist?: string[],
  quota?: number,
  expiresInDays?: number,
  rateLimitData?: { rate_limit_5h?: number; rate_limit_1d?: number; rate_limit_7d?: number }
): Promise<ApiKey> {
  if (customKey) throw new WorkerFeatureNotSupportedError('Custom API keys')
  if (ipWhitelist?.length || ipBlacklist?.length) {
    throw new WorkerFeatureNotSupportedError('API key IP restrictions')
  }
  if (quota !== undefined && quota > 0) {
    throw new WorkerFeatureNotSupportedError('Per-key quota limits')
  }
  if (
    (rateLimitData?.rate_limit_5h ?? 0) > 0 ||
    (rateLimitData?.rate_limit_1d ?? 0) > 0 ||
    (rateLimitData?.rate_limit_7d ?? 0) > 0
  ) {
    throw new WorkerFeatureNotSupportedError('Per-key rate limits')
  }
  if (!groupId) throw new Error('group_id is required')

  const payload: CreateApiKeyRequest = { name, group_id: groupId }
  if (expiresInDays !== undefined && expiresInDays > 0) {
    payload.expires_at_ms = Date.now() + Math.ceil(expiresInDays * 24 * 60 * 60 * 1000)
  }

  const { data } = await apiClient.post<ApiKey>('/keys', payload, {
    headers: { 'Idempotency-Key': operationKey('user-api-key-create') }
  })
  return data
}

/**
 * Update API key
 * @param id - API key ID
 * @param updates - Fields to update
 * @returns Updated API key
 */
export async function update(id: string, updates: UpdateApiKeyRequest): Promise<ApiKey> {
  const unsupported = [
    'ip_whitelist',
    'ip_blacklist',
    'quota',
    'reset_quota',
    'rate_limit_5h',
    'rate_limit_1d',
    'rate_limit_7d',
    'reset_rate_limit_usage'
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
    payload.expires_at_ms = updates.expires_at ? Date.parse(updates.expires_at) : null
  }

  const { data } = await apiClient.put<ApiKey>(`/keys/${id}`, payload)
  return data
}

/**
 * Delete API key
 * @param id - API key ID
 * @returns Success confirmation
 */
export async function deleteKey(id: string): Promise<ApiKey> {
  const { data } = await apiClient.delete<ApiKey>(`/keys/${id}`)
  return data
}

/**
 * Toggle API key status (active/inactive)
 * @param id - API key ID
 * @param status - New status
 * @returns Updated API key
 */
export async function toggleStatus(id: string, status: 'active' | 'inactive'): Promise<ApiKey> {
  return update(id, { status })
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
