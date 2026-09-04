/**
 * Admin Users API endpoints
 * Handles user management for administrators
 */

import { apiClient } from '../client'
import { isCloudflareWorkerContractActive } from '@/utils/adminCapabilities'
import type { AdminUser, UpdateUserRequest, PaginatedResponse, ApiKey } from '@/types'

export type AdminUserId = string | number

type WorkerAdminUser = {
  id: string
  email: string
  display_name: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  balance_micros: number
  concurrency: number
  rpm_limit: number
  created_at_ms: number
  updated_at_ms: number
  [key: string]: unknown
}

function workerUserListParams(
  page: number,
  pageSize: number,
  filters?: {
    status?: 'active' | 'disabled'
    role?: 'admin' | 'user'
    search?: string
  }
): Record<string, string | number> {
  const params: Record<string, string | number> = { page, page_size: pageSize }
  if (filters?.status) params.status = filters.status
  if (filters?.role) params.role = filters.role
  const search = filters?.search?.trim()
  if (search) params.search = search
  return params
}

function timestampToIso(value: unknown): string {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ''
}

function adaptWorkerUser(value: WorkerAdminUser): AdminUser {
  return {
    ...value,
    // The legacy UI type is numeric, but Worker user IDs must remain UUIDs at runtime.
    id: value.id as unknown as number,
    username: value.display_name,
    balance: value.balance_micros / 1_000_000,
    concurrency: value.concurrency,
    rpm_limit: value.rpm_limit,
    created_at: timestampToIso(value.created_at_ms),
    updated_at: timestampToIso(value.updated_at_ms),
    notes: '',
    allowed_groups: null,
    balance_notify_enabled: false,
    balance_notify_threshold: null,
    balance_notify_extra_emails: [],
  } as AdminUser
}

function adaptUser(value: AdminUser): AdminUser {
  return isCloudflareWorkerContractActive()
    ? adaptWorkerUser(value as unknown as WorkerAdminUser)
    : value
}

function adaptUserPage(value: PaginatedResponse<AdminUser>): PaginatedResponse<AdminUser> {
  if (!isCloudflareWorkerContractActive()) return value
  return { ...value, items: value.items.map(adaptUser) }
}

function operationKey(prefix: string, resourceId?: AdminUserId): string {
  const requestId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return resourceId === undefined
    ? `${prefix}-${requestId}`
    : `${prefix}-${resourceId}-${requestId}`
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

let pendingWorkerCreate: { fingerprint: string; key: string } | null = null

async function workerCreateOperationKey(payload: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(payload))
  )
  const fingerprint = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
  if (pendingWorkerCreate?.fingerprint === fingerprint) return pendingWorkerCreate.key
  const key = operationKey('admin-user-create')
  pendingWorkerCreate = { fingerprint, key }
  return key
}

function dollarsToMicros(value: number, field: string): number {
  const scaled = value * 1_000_000
  const micros = Math.round(scaled)
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(micros) ||
    Math.abs(scaled - micros) > 1e-6
  ) {
    throw Object.assign(
      new Error(`${field} must be a non-negative amount with at most 6 decimal places`),
      { code: `invalid_${field}` }
    )
  }
  return micros
}

function workerCreatePayload(userData: {
  email: string
  password: string
  username?: string
  role?: 'admin' | 'user'
  balance?: number
  concurrency?: number
  rpm_limit?: number
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    email: userData.email,
    password: userData.password,
  }
  if (userData.username?.trim()) payload.display_name = userData.username.trim()
  if (userData.role !== undefined) payload.role = userData.role
  if (userData.balance !== undefined) {
    payload.balance_micros = dollarsToMicros(userData.balance, 'balance')
  }
  if (userData.concurrency !== undefined) payload.concurrency = userData.concurrency
  if (userData.rpm_limit !== undefined) payload.rpm_limit = userData.rpm_limit
  return payload
}

function workerUpdatePayload(updates: UpdateUserRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  if (updates.email !== undefined) payload.email = updates.email
  if (updates.password?.trim()) payload.password = updates.password
  if (updates.username?.trim()) payload.display_name = updates.username.trim()
  if (updates.role !== undefined) payload.role = updates.role
  if (updates.status !== undefined) payload.status = updates.status
  if (updates.concurrency !== undefined) payload.concurrency = updates.concurrency
  if (updates.rpm_limit !== undefined) payload.rpm_limit = updates.rpm_limit
  return payload
}

export interface AdminBindAuthIdentityChannelRequest {
  channel: string
  channel_app_id: string
  channel_subject: string
  metadata?: Record<string, unknown> | null
}

export interface AdminBindAuthIdentityRequest {
  provider_type: string
  provider_key: string
  provider_subject: string
  issuer?: string | null
  metadata?: Record<string, unknown> | null
  channel?: AdminBindAuthIdentityChannelRequest
}

export interface AdminBoundAuthIdentityChannel {
  channel: string
  channel_app_id: string
  channel_subject: string
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface AdminBoundAuthIdentity {
  user_id: number
  provider_type: string
  provider_key: string
  provider_subject: string
  verified_at?: string | null
  issuer?: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
  channel?: AdminBoundAuthIdentityChannel | null
}

export interface BatchUpdateUserLimitsRequest {
  user_ids: AdminUserId[]
  all?: boolean
  concurrency?: number
  rpm_limit?: number
}

export interface BatchUpdateUserLimitsResponse {
  affected: number
}

/**
 * List all users with pagination
 * @param page - Page number (default: 1)
 * @param pageSize - Items per page (default: 20)
 * @param filters - Optional filters (status, role, search, attributes)
 * @param options - Optional request options (signal)
 * @returns Paginated list of users
 */
export async function list(
  page: number = 1,
  pageSize: number = 20,
  filters?: {
    status?: 'active' | 'disabled'
    role?: 'admin' | 'user'
    search?: string
    group_name?: string         // fuzzy filter by allowed group name
    api_key_group_id?: number   // filter users by the group their API keys are bound to
    attributes?: Record<number, string>  // attributeId -> value
    include_subscriptions?: boolean
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  },
  options?: {
    signal?: AbortSignal
  }
): Promise<PaginatedResponse<AdminUser>> {
  if (isCloudflareWorkerContractActive()) {
    const { data } = await apiClient.get<PaginatedResponse<AdminUser>>('/admin/users', {
      params: workerUserListParams(page, pageSize, filters),
      signal: options?.signal
    })
    return adaptUserPage(data)
  }

  // Build params with attribute filters in attr[id]=value format
  const params: Record<string, any> = {
    page,
    page_size: pageSize,
    status: filters?.status,
    role: filters?.role,
    search: filters?.search,
    group_name: filters?.group_name,
    api_key_group_id: filters?.api_key_group_id,
    include_subscriptions: filters?.include_subscriptions,
    sort_by: filters?.sort_by,
    sort_order: filters?.sort_order
  }

  // Add attribute filters as attr[id]=value
  if (filters?.attributes) {
    for (const [attrId, value] of Object.entries(filters.attributes)) {
      if (value) {
        params[`attr[${attrId}]`] = value
      }
    }
  }
  const { data } = await apiClient.get<PaginatedResponse<AdminUser>>('/admin/users', {
    params,
    signal: options?.signal
  })
  return data
}

/**
 * Get user by ID
 * @param id - User ID
 * @param includeDeleted - Whether to include soft-deleted users
 * @returns User details
 */
export async function getById(id: AdminUserId, includeDeleted = false): Promise<AdminUser> {
  if (isCloudflareWorkerContractActive()) {
    const { data } = await apiClient.get<AdminUser>(`/admin/users/${id}`)
    return adaptUser(data)
  }
  const url = includeDeleted ? `/admin/users/${id}?include_deleted=true` : `/admin/users/${id}`
  const { data } = await apiClient.get<AdminUser>(url)
  return data
}

/**
 * Create new user
 * @param userData - User data (email, password, etc.)
 * @returns Created user
 */
export async function create(userData: {
  email: string
  password: string
  username?: string
  notes?: string
  role?: 'admin' | 'user'
  balance?: number
  concurrency?: number
  rpm_limit?: number
  allowed_groups?: number[] | null
}): Promise<AdminUser> {
  if (isCloudflareWorkerContractActive()) {
    const payload = workerCreatePayload(userData)
    const idempotencyKey = await workerCreateOperationKey(payload)
    const { data } = await apiClient.post<AdminUser>('/admin/users', payload, {
      headers: { 'Idempotency-Key': idempotencyKey }
    })
    pendingWorkerCreate = null
    return adaptUser(data)
  }
  const { data } = await apiClient.post<AdminUser>('/admin/users', userData)
  return data
}

/**
 * Update user
 * @param id - User ID
 * @param updates - Fields to update
 * @returns Updated user
 */
export async function update(id: AdminUserId, updates: UpdateUserRequest): Promise<AdminUser> {
  if (isCloudflareWorkerContractActive()) {
    const { data } = await apiClient.put<AdminUser>(
      `/admin/users/${id}`,
      workerUpdatePayload(updates),
      { headers: { 'Idempotency-Key': operationKey('admin-user-update', id) } }
    )
    return adaptUser(data)
  }
  const { data } = await apiClient.put<AdminUser>(`/admin/users/${id}`, updates)
  return data
}

/**
 * Delete user
 * @param id - User ID
 * @returns Success confirmation
 */
export async function deleteUser(id: number): Promise<{ message: string }> {
  const { data } = await apiClient.delete<{ message: string }>(`/admin/users/${id}`)
  return data
}

/**
 * Update user balance
 * @param id - User ID
 * @param balance - New balance
 * @param operation - Operation type ('set', 'add', 'subtract')
 * @param notes - Optional notes for the balance adjustment
 * @returns Updated user
 */
export async function updateBalance(
  id: AdminUserId,
  balance: number,
  operation: 'set' | 'add' | 'subtract' = 'set',
  notes?: string
): Promise<AdminUser> {
  if (isCloudflareWorkerContractActive()) {
    const micros = dollarsToMicros(balance, 'balance_adjustment')
    let amountDeltaMicros = operation === 'subtract' ? -micros : micros
    if (operation === 'set') {
      const current = await getById(id)
      const currentMicros = dollarsToMicros(current.balance, 'current_balance')
      amountDeltaMicros = micros - currentMicros
      if (amountDeltaMicros === 0) return current
    }
    const { data } = await apiClient.post<AdminUser>(`/admin/users/${id}/balance`, {
      amount_delta_micros: amountDeltaMicros,
    }, {
      headers: { 'Idempotency-Key': operationKey('admin-user-balance', id) }
    })
    return adaptUser(data)
  }
  const { data } = await apiClient.post<AdminUser>(`/admin/users/${id}/balance`, {
    balance,
    operation,
    notes: notes || ''
  })
  return data
}

/**
 * Update user concurrency
 * @param id - User ID
 * @param concurrency - New concurrency limit
 * @returns Updated user
 */
export async function updateConcurrency(id: AdminUserId, concurrency: number): Promise<AdminUser> {
  return update(id, { concurrency })
}

/** Overwrite concurrency and/or RPM limits for multiple users in one request. */
export async function batchUpdateLimits(
  request: BatchUpdateUserLimitsRequest
): Promise<BatchUpdateUserLimitsResponse> {
  if (isCloudflareWorkerContractActive()) {
    if (request.all === true) {
      throw Object.assign(
        new Error('Worker batch limit updates require explicit user IDs'),
        { code: 'worker_batch_all_not_supported' }
      )
    }
    if (request.concurrency === undefined && request.rpm_limit === undefined) {
      return { affected: 0 }
    }
    const uniqueIds = [...new Map(
      request.user_ids.map((id) => [String(id), id] as const)
    ).values()]
    for (const id of uniqueIds) {
      await update(id, {
        ...(request.concurrency === undefined ? {} : { concurrency: request.concurrency }),
        ...(request.rpm_limit === undefined ? {} : { rpm_limit: request.rpm_limit }),
      })
    }
    return { affected: uniqueIds.length }
  }
  const { data } = await apiClient.post<BatchUpdateUserLimitsResponse>(
    '/admin/users/batch-limits',
    request
  )
  return data
}

/**
 * Toggle user status
 * @param id - User ID
 * @param status - New status
 * @returns Updated user
 */
export async function toggleStatus(id: AdminUserId, status: 'active' | 'disabled'): Promise<AdminUser> {
  return update(id, { status })
}

/**
 * Get user's API keys
 * @param id - User ID
 * @returns List of user's API keys
 */
export async function getUserApiKeys(id: string | number): Promise<PaginatedResponse<ApiKey>> {
  const { data } = await apiClient.get<PaginatedResponse<ApiKey>>(`/admin/users/${id}/api-keys`)
  return data
}

/**
 * Get user's usage statistics
 * @param id - User ID
 * @param period - Time period
 * @returns User usage statistics
 */
export async function getUserUsageStats(
  id: number,
  period: string = 'month'
): Promise<{
  total_requests: number
  total_cost: number
  total_tokens: number
}> {
  const { data } = await apiClient.get<{
    total_requests: number
    total_cost: number
    total_tokens: number
  }>(`/admin/users/${id}/usage`, {
    params: { period }
  })
  return data
}

/**
 * Balance history item returned from the API
 */
export interface BalanceHistoryItem {
  id: number
  code: string
  type: string
  value: number
  status: string
  used_by: number | null
  used_at: string | null
  created_at: string
  group_id: number | null
  validity_days: number
  notes: string
  user?: { id: number; email: string } | null
  group?: { id: number; name: string } | null
}

// Balance history response extends pagination with total_recharged summary
export interface BalanceHistoryResponse extends PaginatedResponse<BalanceHistoryItem> {
  total_recharged: number
}

/**
 * Get user's balance/concurrency change history
 * @param id - User ID
 * @param page - Page number
 * @param pageSize - Items per page
 * @param type - Optional type filter (balance, affiliate_balance, admin_balance, concurrency, admin_concurrency, subscription)
 * @returns Paginated balance history with total_recharged
 */
export async function getUserBalanceHistory(
  id: number,
  page: number = 1,
  pageSize: number = 20,
  type?: string
): Promise<BalanceHistoryResponse> {
  const params: Record<string, any> = { page, page_size: pageSize }
  if (type) params.type = type
  const { data } = await apiClient.get<BalanceHistoryResponse>(
    `/admin/users/${id}/balance-history`,
    { params }
  )
  return data
}

/**
 * Replace user's exclusive group
 * @param userId - User ID
 * @param oldGroupId - Current group ID to replace
 * @param newGroupId - New group ID to replace with
 * @returns Number of migrated keys
 */
export async function replaceGroup(
  userId: number,
  oldGroupId: number,
  newGroupId: number
): Promise<{ migrated_keys: number }> {
  const { data } = await apiClient.post<{ migrated_keys: number }>(
    `/admin/users/${userId}/replace-group`,
    { old_group_id: oldGroupId, new_group_id: newGroupId }
  )
  return data
}

export async function bindUserAuthIdentity(
  userId: number,
  input: AdminBindAuthIdentityRequest
): Promise<AdminBoundAuthIdentity> {
  const { data } = await apiClient.post<AdminBoundAuthIdentity>(
    `/admin/users/${userId}/auth-identities`,
    input
  )
  return data
}

/**
 * Platform quota types
 */
export type PlatformQuotaPlatform = 'anthropic' | 'openai' | 'gemini' | 'antigravity' | 'grok'
export type PlatformQuotaWindow = 'daily' | 'weekly' | 'monthly'

export interface PlatformQuotaItem {
  platform: PlatformQuotaPlatform
  daily_limit_usd: number | null
  weekly_limit_usd: number | null
  monthly_limit_usd: number | null
  daily_usage_usd: number
  weekly_usage_usd: number
  monthly_usage_usd: number
  daily_window_start?: string | null
  weekly_window_start?: string | null
  monthly_window_start?: string | null
  daily_window_resets_at?: string | null
  weekly_window_resets_at?: string | null
  monthly_window_resets_at?: string | null
}

export interface PlatformQuotaUpdateItem {
  platform: PlatformQuotaPlatform
  daily_limit_usd: number | null
  weekly_limit_usd: number | null
  monthly_limit_usd: number | null
}

export interface PlatformQuotasResponse {
  platform_quotas: PlatformQuotaItem[]
}

/**
 * Get user's platform quotas
 */
export async function getPlatformQuotas(id: number): Promise<PlatformQuotasResponse> {
  const { data } = await apiClient.get<PlatformQuotasResponse>(
    `/admin/users/${id}/platform-quotas`
  )
  return data
}

/**
 * Replace user's platform quotas (全量替换)
 */
export async function updatePlatformQuotas(
  id: number,
  quotas: PlatformQuotaUpdateItem[]
): Promise<PlatformQuotasResponse> {
  const { data } = await apiClient.put<PlatformQuotasResponse>(
    `/admin/users/${id}/platform-quotas`,
    { quotas }
  )
  return data
}

/**
 * Reset a single (platform, window) usage immediately
 */
export async function resetPlatformQuotaWindow(
  id: number,
  platform: PlatformQuotaPlatform,
  window: PlatformQuotaWindow
): Promise<PlatformQuotasResponse> {
  const { data } = await apiClient.post<PlatformQuotasResponse>(
    `/admin/users/${id}/platform-quotas/reset`,
    { platform, window }
  )
  return data
}

export const usersAPI = {
  list,
  getById,
  create,
  update,
  delete: deleteUser,
  updateBalance,
  updateConcurrency,
  batchUpdateLimits,
  toggleStatus,
  getUserApiKeys,
  getUserUsageStats,
  getUserBalanceHistory,
  replaceGroup,
  bindUserAuthIdentity,
  getPlatformQuotas,
  updatePlatformQuotas,
  resetPlatformQuotaWindow,
}

export default usersAPI
