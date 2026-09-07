/**
 * Admin Users API endpoints
 * Handles user management for administrators
 */

import { apiClient } from '../client'
import { isCloudflareWorkerContractActive } from '@/utils/adminCapabilities'
import type {
  AdminUser,
  UpdateUserRequest,
  PaginatedResponse,
  ApiKey,
  UserSubscription,
} from '@/types'

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
  allowed_groups?: string[]
  group_rates?: Record<string, number>
  restrict_public_groups?: boolean | number
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
    group_name?: string
    api_key_group_id?: string | number
    attributes?: Record<number, string>
    include_subscriptions?: boolean
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  }
): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = { page, page_size: pageSize }
  if (filters?.status) params.status = filters.status
  if (filters?.role) params.role = filters.role
  const search = filters?.search?.trim()
  if (search) params.search = search
  if (filters?.group_name !== undefined) params.group_name = filters.group_name
  if (filters?.api_key_group_id !== undefined) {
    params.api_key_group_id = filters.api_key_group_id
  }
  if (filters?.attributes) {
    for (const [attributeId, value] of Object.entries(filters.attributes)) {
      if (value) params[`attr[${attributeId}]`] = value
    }
  }
  if (filters?.include_subscriptions !== undefined) {
    params.include_subscriptions = filters.include_subscriptions
  }
  if (filters?.sort_by) params.sort_by = filters.sort_by
  if (filters?.sort_order) params.sort_order = filters.sort_order
  return params
}

function timestampToIso(value: unknown): string {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ''
}

function nullableTimestampToIso(value: unknown): string | null {
  return value === null ? null : timestampToIso(value)
}

function workerMicrosToDollars(value: unknown): number {
  const micros = Number(value)
  return Number.isFinite(micros) ? micros / 1_000_000 : 0
}

function adaptWorkerSubscription(value: Record<string, unknown>): UserSubscription {
  const adapted: Record<string, unknown> = { ...value }
  for (const [workerField, legacyField] of [
    ['starts_at_ms', 'starts_at'],
    ['expires_at_ms', 'expires_at'],
    ['daily_window_start_ms', 'daily_window_start'],
    ['weekly_window_start_ms', 'weekly_window_start'],
    ['monthly_window_start_ms', 'monthly_window_start'],
    ['revoked_at_ms', 'revoked_at'],
    ['created_at_ms', 'created_at'],
    ['updated_at_ms', 'updated_at'],
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(value, workerField)) {
      adapted[legacyField] = nullableTimestampToIso(value[workerField])
    }
  }
  for (const [workerField, legacyField] of [
    ['daily_used_micros', 'daily_usage_usd'],
    ['weekly_used_micros', 'weekly_usage_usd'],
    ['monthly_used_micros', 'monthly_usage_usd'],
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(value, workerField)) {
      adapted[legacyField] = workerMicrosToDollars(value[workerField])
    }
  }
  return adapted as unknown as UserSubscription
}

function adaptWorkerUser(value: WorkerAdminUser): AdminUser {
  const subscriptions = Array.isArray(value.subscriptions)
    ? value.subscriptions.map((subscription) =>
        adaptWorkerSubscription(subscription as Record<string, unknown>))
    : undefined
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
    ...(Object.prototype.hasOwnProperty.call(value, 'last_active_at_ms')
      ? { last_active_at: nullableTimestampToIso(value.last_active_at_ms) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'last_used_at_ms')
      ? { last_used_at: nullableTimestampToIso(value.last_used_at_ms) }
      : {}),
    ...(subscriptions === undefined ? {} : { subscriptions }),
    notes: '',
    allowed_groups: value.allowed_groups ?? [],
    group_rates: value.group_rates,
    restrict_public_groups: value.restrict_public_groups === true || value.restrict_public_groups === 1,
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
  allowed_groups?: Array<string | number> | null
  restrict_public_groups?: boolean
  group_rates?: Record<string | number, number | null>
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
  if (userData.allowed_groups !== undefined) {
    payload.allowed_groups = userData.allowed_groups?.map(String) ?? null
  }
  if (userData.restrict_public_groups !== undefined) {
    payload.restrict_public_groups = userData.restrict_public_groups
  }
  if (userData.group_rates !== undefined) payload.group_rates = userData.group_rates
  return payload
}

function workerUpdatePayload(
  updates: UpdateUserRequest,
  expectedControlVersion?: number,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  if (expectedControlVersion !== undefined) {
    payload.expected_control_version = expectedControlVersion
  }
  if (updates.email !== undefined) payload.email = updates.email
  if (updates.password?.trim()) payload.password = updates.password
  if (updates.username?.trim()) payload.display_name = updates.username.trim()
  if (updates.role !== undefined) payload.role = updates.role
  if (updates.status !== undefined) payload.status = updates.status
  if (updates.concurrency !== undefined) payload.concurrency = updates.concurrency
  if (updates.rpm_limit !== undefined) payload.rpm_limit = updates.rpm_limit
  if (updates.allowed_groups !== undefined) payload.allowed_groups = updates.allowed_groups?.map(String)
  if (updates.restrict_public_groups !== undefined) {
    payload.restrict_public_groups = updates.restrict_public_groups
  }
  if (updates.group_rates !== undefined) payload.group_rates = updates.group_rates
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
    api_key_group_id?: string | number   // filter users by the group their API keys are bound to
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
export async function update(
  id: AdminUserId,
  updates: UpdateUserRequest,
  expectedControlVersion?: number,
): Promise<AdminUser> {
  if (isCloudflareWorkerContractActive()) {
    const { data } = await apiClient.put<AdminUser>(
      `/admin/users/${id}`,
      workerUpdatePayload(updates, expectedControlVersion),
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
    const { data } = await apiClient.post<BatchUpdateUserLimitsResponse>(
      '/admin/users/batch-limits',
      {
        user_ids: request.user_ids.map(String),
        ...(request.concurrency === undefined ? {} : { concurrency: request.concurrency }),
        ...(request.rpm_limit === undefined ? {} : { rpm_limit: request.rpm_limit }),
      },
      { headers: { 'Idempotency-Key': operationKey('admin-user-batch-limits') } },
    )
    return data
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
  if (isCloudflareWorkerContractActive()) {
    data.items = data.items.map((key) => {
      const prefix = key.key_prefix ?? ''
      return {
        ...key,
        // Worker storage is deliberately one-way: the full secret only exists in
        // the create response. Preserve the original modal's string contract with
        // an explicitly masked value built from the non-secret prefix.
        key: typeof key.key === 'string' ? key.key : `${prefix}${'*'.repeat(8)}`,
      }
    })
  }
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
  id: AdminUserId
  code: string
  type: string
  value: number
  status: string
  used_by: AdminUserId | null
  used_at: string | null
  created_at: string
  group_id: number | null
  validity_days: number
  notes: string
  user?: { id: AdminUserId; email: string } | null
  group?: { id: number; name: string } | null
  amount_delta_micros?: number
  gross_amount_micros?: number
  spend_debt_delta_micros?: number
  balance_after_micros?: number
  spend_debt_after_micros?: number
}

// Balance history response extends pagination with total_recharged summary
export interface BalanceHistoryResponse extends PaginatedResponse<BalanceHistoryItem> {
  total_recharged: number
  history_complete?: boolean
  history_available_from?: string
}

interface WorkerFinancialEvent {
  event_id: string
  user_id: string
  state_version: number
  event_type: 'opening_balance' | 'balance_adjustment' | 'settlement'
  source_type: string
  source_id: string
  request_id: string | null
  amount_delta_micros: number
  gross_amount_micros: number
  spend_debt_delta_micros: number
  balance_after_micros: number
  spend_debt_after_micros: number
  occurred_at_ms: number
}

interface WorkerBalanceHistoryResponse {
  items: WorkerFinancialEvent[]
  total: number
  limit: number
  has_more: boolean
  next_cursor: string | null
  total_recharged_micros: number
  history_complete: boolean
  history_available_from_ms: number
}

const workerBalanceHistoryCursors = new Map<string, Map<number, string | null>>()

/**
 * Get user's balance/concurrency change history
 * @param id - User ID
 * @param page - Page number
 * @param pageSize - Items per page
 * @param type - Optional type filter (balance, affiliate_balance, admin_balance, concurrency, admin_concurrency, subscription)
 * @returns Paginated balance history with total_recharged
 */
export async function getUserBalanceHistory(
  id: AdminUserId,
  page: number = 1,
  pageSize: number = 20,
  type?: string
): Promise<BalanceHistoryResponse> {
  if (isCloudflareWorkerContractActive()) {
    const cursorKey = `${String(id)}\u0000${type ?? ''}\u0000${pageSize}`
    let cursors = workerBalanceHistoryCursors.get(cursorKey)
    if (page === 1) {
      cursors = new Map([[1, null]])
      workerBalanceHistoryCursors.set(cursorKey, cursors)
    }
    const cursor = cursors?.get(page)
    if (cursor === undefined) {
      throw Object.assign(
        new Error('Worker balance history pages must be traversed in order'),
        { code: 'balance_history_cursor_unavailable' }
      )
    }
    const params: Record<string, string | number> = { limit: pageSize }
    if (type) params.type = type
    if (cursor !== null) params.cursor = cursor
    const { data } = await apiClient.get<WorkerBalanceHistoryResponse>(
      `/admin/users/${id}/balance-history`,
      { params }
    )
    if (data.next_cursor !== null) cursors?.set(page + 1, data.next_cursor)
    else cursors?.delete(page + 1)
    return {
      items: data.items.map(adaptWorkerFinancialEvent),
      total: data.total,
      page,
      page_size: data.limit,
      pages: data.total === 0 ? 0 : Math.ceil(data.total / data.limit),
      total_recharged: data.total_recharged_micros / 1_000_000,
      history_complete: data.history_complete,
      history_available_from: timestampToIso(data.history_available_from_ms),
    }
  }
  const params: Record<string, any> = { page, page_size: pageSize }
  if (type) params.type = type
  const { data } = await apiClient.get<BalanceHistoryResponse>(
    `/admin/users/${id}/balance-history`,
    { params }
  )
  return data
}

function adaptWorkerFinancialEvent(event: WorkerFinancialEvent): BalanceHistoryItem {
  const occurredAt = timestampToIso(event.occurred_at_ms)
  return {
    id: event.event_id,
    code: event.source_id,
    type: event.source_type === 'admin_adjustment'
      ? 'admin_balance'
      : event.source_type === 'affiliate_transfer' ||
          event.source_type === 'affiliate_refund_clawback'
        ? 'affiliate_balance'
        : 'balance',
    value: event.amount_delta_micros / 1_000_000,
    status: 'used',
    used_by: null,
    used_at: occurredAt,
    created_at: occurredAt,
    group_id: null,
    validity_days: 0,
    notes: '',
    user: null,
    group: null,
    amount_delta_micros: event.amount_delta_micros,
    gross_amount_micros: event.gross_amount_micros,
    spend_debt_delta_micros: event.spend_debt_delta_micros,
    balance_after_micros: event.balance_after_micros,
    spend_debt_after_micros: event.spend_debt_after_micros,
  }
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
  schema_version?: 1
  control_version?: number
  platform_quotas: PlatformQuotaItem[]
  updated_at_ms?: number
}

/**
 * Get user's platform quotas
 */
export async function getPlatformQuotas(id: AdminUserId): Promise<PlatformQuotasResponse> {
  const { data } = await apiClient.get<PlatformQuotasResponse>(
    `/admin/users/${id}/platform-quotas`
  )
  return data
}

/**
 * Replace user's platform quotas (全量替换)
 */
export async function updatePlatformQuotas(
  id: AdminUserId,
  quotas: PlatformQuotaUpdateItem[],
  expectedControlVersion?: number,
): Promise<PlatformQuotasResponse> {
  const config = quotaMutationConfig(
    'admin-user-platform-quotas', id, expectedControlVersion,
  )
  const { data } = await apiClient.put<PlatformQuotasResponse>(
    `/admin/users/${id}/platform-quotas`, { quotas }, config,
  )
  return data
}

/**
 * Reset a single (platform, window) usage immediately
 */
export async function resetPlatformQuotaWindow(
  id: AdminUserId,
  platform: PlatformQuotaPlatform,
  window: PlatformQuotaWindow,
  expectedControlVersion?: number,
): Promise<PlatformQuotasResponse> {
  const config = quotaMutationConfig(
    'admin-user-platform-quota-reset', id, expectedControlVersion,
  )
  const { data } = await apiClient.post<PlatformQuotasResponse>(
    `/admin/users/${id}/platform-quotas/reset`,
    { platform, window },
    config,
  )
  return data
}

function quotaMutationConfig(
  prefix: string,
  id: AdminUserId,
  expectedControlVersion?: number,
): { headers: Record<string, string> } | undefined {
  if (!isCloudflareWorkerContractActive()) return undefined
  if (!Number.isSafeInteger(expectedControlVersion) || (expectedControlVersion as number) < 0) {
    throw Object.assign(new Error('Reload platform quotas before changing them.'), {
      code: 'platform_quota_control_version_required',
    })
  }
  return { headers: {
    'Idempotency-Key': operationKey(prefix, id),
    'If-Match': `"${expectedControlVersion}"`,
  } }
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
