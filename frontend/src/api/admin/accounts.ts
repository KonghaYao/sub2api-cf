/**
 * Admin Accounts API endpoints
 * Handles AI platform account management for administrators
 */

import { apiClient } from '../client'
import { getBrowserTimeZone } from '@/utils/format'
import {
  isCloudflareWorkerContractActive,
} from '@/utils/adminCapabilities'
import type {
  Account,
  CreateAccountRequest,
  UpdateAccountRequest,
  PaginatedResponse,
  AccountUsageInfo,
  WindowStats,
  ClaudeModel,
  AccountUsageStatsResponse,
  TempUnschedulableStatus,
  AdminDataPayload,
  AdminDataImportResult,
  CodexSessionImportRequest,
  CodexSessionImportResult,
  OpenAICodexPATCreateRequest,
  CheckMixedChannelRequest,
  CheckMixedChannelResponse,
  UpstreamBillingProbeResult,
  UpstreamBillingProbeSettings,
  UpstreamBillingRatesResponse,
  OllamaCloudUsageSettings,
  OllamaCloudUsageState
} from '@/types'

function operationKey(prefix: string): string {
  const requestID = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${requestID}`
}

let pendingWorkerCreate: { fingerprint: string; key: string } | null = null

const ACCOUNT_SECRET_FIELDS = new Set([
  'api_key',
  'access_token',
  'refresh_token',
  'id_token',
  'session_key',
  'cookie',
  'aws_secret_access_key',
  'aws_session_token',
  'service_account_json',
  'service_account',
  'private_key',
  'agent_private_key',
])

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

async function workerCreateOperationKey(payload: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(payload))
  )
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (pendingWorkerCreate?.fingerprint === fingerprint) return pendingWorkerCreate.key
  const key = operationKey('admin-account-create')
  pendingWorkerCreate = { fingerprint, key }
  return key
}

const pendingWorkerOperationKeys = new Map<string, string>()

async function workerOperationKey(prefix: string, payload: unknown): Promise<{ cacheKey: string; key: string }> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(payload))
  )
  const fingerprint = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
  const cacheKey = `${prefix}:${fingerprint}`
  const pending = pendingWorkerOperationKeys.get(cacheKey)
  if (pending) return { cacheKey, key: pending }
  const key = operationKey(prefix)
  if (pendingWorkerOperationKeys.size >= 32) {
    const oldest = pendingWorkerOperationKeys.keys().next().value
    if (oldest !== undefined) pendingWorkerOperationKeys.delete(oldest)
  }
  pendingWorkerOperationKeys.set(cacheKey, key)
  return { cacheKey, key }
}

function workerAccountListParams(
  page: number,
  pageSize: number,
  filters?: Record<string, unknown>
): Record<string, string | number> {
  return { page, page_size: pageSize, ...filters } as Record<string, string | number>
}

function redactAccountSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAccountSecrets)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !ACCOUNT_SECRET_FIELDS.has(key.toLowerCase()))
      .map(([key, item]) => [key, redactAccountSecrets(item)])
  )
}

function adaptAccount(account: Account): Account {
  if (!isCloudflareWorkerContractActive()) return account
  const value = redactAccountSecrets(account) as Record<string, unknown>

  const groupLinks = Array.isArray(value.group_links)
    ? value.group_links as Array<{ group_id?: unknown; priority?: unknown }>
    : []
  const createdAt = Number(value.created_at_ms)
  const updatedAt = Number(value.updated_at_ms)
  const enabled = value.enabled === true
  const adapted: Record<string, unknown> = { ...value }
  const fallback = (key: string, fallbackValue: unknown) => {
    if (!Object.prototype.hasOwnProperty.call(adapted, key)) adapted[key] = fallbackValue
  }

  fallback('type', value.credential_kind === 'oauth' ? 'oauth' : value.credential_kind === 'setup_token' ? 'setup-token' : 'apikey')
  fallback('credentials', { base_url: typeof value.base_url === 'string' ? value.base_url : '' })
  fallback('provider_config', {})
  fallback('proxy_id', null)
  fallback('concurrency', Number(value.max_concurrency) || 1)
  fallback('priority', Number(groupLinks[0]?.priority) || 0)
  fallback('status', enabled ? 'active' : 'inactive')
  fallback('error_message', typeof value.last_health_error === 'string' ? value.last_health_error : null)
  fallback('last_used_at', null)
  fallback('expires_at', null)
  fallback('auto_pause_on_expired', false)
  fallback('created_at', Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : '')
  fallback('updated_at', Number.isFinite(updatedAt) ? new Date(updatedAt).toISOString() : '')
  fallback('group_ids', groupLinks
    .filter((link) => typeof link.group_id === 'string' || typeof link.group_id === 'number')
    .map((link) => link.group_id))
  fallback('schedulable', enabled)
  fallback('rate_limited_at', null)
  fallback('rate_limit_reset_at', null)
  fallback('overload_until', null)
  fallback('temp_unschedulable_until', null)
  fallback('temp_unschedulable_reason', null)
  fallback('session_window_start', null)
  fallback('session_window_end', null)
  fallback('session_window_status', null)
  return adapted as unknown as Account
}

function adaptAccountList(response: PaginatedResponse<Account>): PaginatedResponse<Account> {
  return { ...response, items: response.items.map(adaptAccount) }
}

/**
 * List all accounts with pagination
 * @param page - Page number (default: 1)
 * @param pageSize - Items per page (default: 20)
 * @param filters - Optional filters
 * @returns Paginated list of accounts
 */
export async function list(
  page: number = 1,
  pageSize: number = 20,
  filters?: {
    platform?: string
    type?: string
    status?: string
    group?: string
    search?: string
    privacy_mode?: string
    lite?: string
    include_scheduler_score?: string
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  },
  options?: {
    signal?: AbortSignal
  }
): Promise<PaginatedResponse<Account>> {
  const { data } = await apiClient.get<PaginatedResponse<Account>>('/admin/accounts', {
    params: workerAccountListParams(page, pageSize, filters),
    signal: options?.signal
  })
  return adaptAccountList(data)
}

export interface AccountListWithEtagResult {
  notModified: boolean
  etag: string | null
  data: PaginatedResponse<Account> | null
}

export interface AccountUpstreamBillingRatesWithEtagResult {
  notModified: boolean
  etag: string | null
  data: UpstreamBillingRatesResponse | null
}

export async function getUpstreamBillingRatesWithEtag(
  page: number = 1,
  pageSize: number = 20,
  filters?: {
    platform?: string
    type?: string
    status?: string
    group?: string
    search?: string
    privacy_mode?: string
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  },
  options?: {
    signal?: AbortSignal
    etag?: string | null
  }
): Promise<AccountUpstreamBillingRatesWithEtagResult> {
  const headers: Record<string, string> = {}
  if (options?.etag) headers['If-None-Match'] = options.etag

  const response = await apiClient.get<UpstreamBillingRatesResponse>('/admin/accounts/upstream-billing-rates', {
    params: { page, page_size: pageSize, ...filters },
    headers,
    signal: options?.signal,
    validateStatus: (status) => (status >= 200 && status < 300) || status === 304
  })

  const etagHeader = typeof response.headers?.etag === 'string' ? response.headers.etag : null
  if (response.status === 304) return { notModified: true, etag: etagHeader, data: null }
  return { notModified: false, etag: etagHeader, data: response.data }
}

export async function listWithEtag(
  page: number = 1,
  pageSize: number = 20,
  filters?: {
    platform?: string
    type?: string
    status?: string
    group?: string
    search?: string
    privacy_mode?: string
    lite?: string
    include_scheduler_score?: string
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  },
  options?: {
    signal?: AbortSignal
    etag?: string | null
  }
): Promise<AccountListWithEtagResult> {
  const headers: Record<string, string> = {}
  if (options?.etag) {
    headers['If-None-Match'] = options.etag
  }

  const response = await apiClient.get<PaginatedResponse<Account>>('/admin/accounts', {
    params: workerAccountListParams(page, pageSize, filters),
    headers,
    signal: options?.signal,
    validateStatus: (status) => (status >= 200 && status < 300) || status === 304
  })

  const etagHeader = typeof response.headers?.etag === 'string' ? response.headers.etag : null
  if (response.status === 304) {
    return {
      notModified: true,
      etag: etagHeader,
      data: null
    }
  }

  return {
    notModified: false,
    etag: etagHeader,
    data: adaptAccountList(response.data)
  }
}

/**
 * Get account by ID
 * @param id - Account ID
 * @returns Account details
 */
export async function getById(id: number | string): Promise<Account> {
  const { data } = await apiClient.get<Account>(`/admin/accounts/${id}`)
  return adaptAccount(data)
}

/**
 * Create new account
 * @param accountData - Account data
 * @returns Created account
 */
export async function create(accountData: CreateAccountRequest): Promise<Account> {
  const workerContract = isCloudflareWorkerContractActive()
  const payload = accountData
  const idempotencyKey = workerContract ? await workerCreateOperationKey(payload) : null
  const { data } = await apiClient.post<Account>('/admin/accounts', payload, idempotencyKey
    ? { headers: { 'Idempotency-Key': idempotencyKey }, timeout: 60000 }
    : undefined)
  if (workerContract) pendingWorkerCreate = null
  return adaptAccount(data)
}

/**
 * Duplicate an account while keeping credentials on the server.
 * @param id - Source account ID
 * @returns Newly created account
 */
const duplicateOperationKeys = new Map<number, string>()

function duplicateOperationStorageKey(id: number): string {
  return `sub2api:admin:account-duplicate:${id}`
}

function getStoredDuplicateOperationKey(id: number): string | null {
  try {
    return globalThis.sessionStorage?.getItem(duplicateOperationStorageKey(id)) ?? null
  } catch {
    return null
  }
}

function storeDuplicateOperationKey(id: number, key: string | null): void {
  try {
    if (key) globalThis.sessionStorage?.setItem(duplicateOperationStorageKey(id), key)
    else globalThis.sessionStorage?.removeItem(duplicateOperationStorageKey(id))
  } catch {
    // In-memory retry protection still works when browser storage is unavailable.
  }
}

export async function duplicate(id: number): Promise<Account> {
  let idempotencyKey = duplicateOperationKeys.get(id) ?? getStoredDuplicateOperationKey(id)
  if (!idempotencyKey) {
    const requestID = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    idempotencyKey = `account-duplicate-${id}-${requestID}`
  }
  duplicateOperationKeys.set(id, idempotencyKey)
  storeDuplicateOperationKey(id, idempotencyKey)
  const { data } = await apiClient.post<Account>(`/admin/accounts/${id}/duplicate`, undefined, {
    headers: { 'Idempotency-Key': idempotencyKey }
  })
  duplicateOperationKeys.delete(id)
  storeDuplicateOperationKey(id, null)
  return data
}

/**
 * Update account
 * @param id - Account ID
 * @param updates - Fields to update
 * @returns Updated account
 */
export async function update(
  id: number | string,
  updates: UpdateAccountRequest,
  expectedControlVersion?: number,
): Promise<Account> {
  const workerContract = isCloudflareWorkerContractActive()
  const updateRecord = updates as unknown as Record<string, unknown>
  const expectedVersion = expectedControlVersion ?? updateRecord.expected_control_version
  const payload = workerContract
    ? Object.fromEntries(Object.entries(updateRecord).filter(([key, value]) =>
        key !== 'expected_control_version' &&
        // Worker 'error' is a derived health status, not an editable enabled state.
        !(key === 'status' && value === 'error'),
      ))
    : updates
  const { data } = await apiClient.put<Account>(
    `/admin/accounts/${id}`,
    payload,
    workerContract && Number.isSafeInteger(expectedVersion)
      ? { headers: { 'If-Match': `"${expectedVersion}"` } }
      : undefined
  )
  return adaptAccount(data)
}

/**
 * Check mixed-channel risk for account-group binding.
 */
export async function checkMixedChannelRisk(
  payload: CheckMixedChannelRequest
): Promise<CheckMixedChannelResponse> {
  const { data } = await apiClient.post<CheckMixedChannelResponse>('/admin/accounts/check-mixed-channel', payload)
  return data
}

/**
 * Delete account
 * @param id - Account ID
 * @returns Success confirmation
 */
export async function deleteAccount(
  id: number | string,
  expectedControlVersion?: number
): Promise<Account | { message: string }> {
  const { data } = await apiClient.delete<Account | { message: string }>(
    `/admin/accounts/${id}`,
    isCloudflareWorkerContractActive() && Number.isSafeInteger(expectedControlVersion)
      ? { headers: { 'If-Match': `"${expectedControlVersion}"` } }
      : undefined
  )
  return 'id' in data ? adaptAccount(data as Account) : data
}

/**
 * Toggle account status
 * @param id - Account ID
 * @param status - New status
 * @returns Updated account
 */
export async function toggleStatus(id: number, status: 'active' | 'inactive'): Promise<Account> {
  return update(id, { status })
}

/**
 * Test account connectivity
 * @param id - Account ID
 * @returns Test result
 */
export interface AccountTestResult {
  success: boolean
  message: string
  latency_ms?: number
}

export interface WorkerAccountTestResult extends AccountTestResult {
  id: number | string
  health_status?: 'unknown' | 'healthy' | 'unhealthy'
  last_checked_at_ms?: number | null
  last_latency_ms?: number | null
  last_health_error?: string | null
  config_version?: number
  control_version?: number
  updated_at?: string
  updated_at_ms?: number
}

export async function testAccount(id: number | string): Promise<AccountTestResult | WorkerAccountTestResult> {
  if (isCloudflareWorkerContractActive()) {
    const { data: workerValue } = await apiClient.post<Record<string, unknown>>(`/admin/accounts/${id}/test`)
    const success = workerValue.health_status === 'healthy'
    const error = typeof workerValue.last_health_error === 'string'
      ? workerValue.last_health_error
      : null
    return {
      id: typeof workerValue.id === 'string' || typeof workerValue.id === 'number'
        ? workerValue.id
        : id,
      success,
      message: error ?? (success ? 'Account connectivity test succeeded' : 'Account connectivity test failed'),
      ...(workerValue.health_status === 'unknown'
        || workerValue.health_status === 'healthy'
        || workerValue.health_status === 'unhealthy'
        ? { health_status: workerValue.health_status }
        : {}),
      ...(workerValue.last_checked_at_ms === null || Number.isFinite(Number(workerValue.last_checked_at_ms))
        ? { last_checked_at_ms: workerValue.last_checked_at_ms === null ? null : Number(workerValue.last_checked_at_ms) }
        : {}),
      ...(workerValue.last_latency_ms === null || Number.isFinite(Number(workerValue.last_latency_ms))
        ? { last_latency_ms: workerValue.last_latency_ms === null ? null : Number(workerValue.last_latency_ms) }
        : {}),
      ...(workerValue.last_health_error === null || typeof workerValue.last_health_error === 'string'
        ? { last_health_error: workerValue.last_health_error }
        : {}),
      ...(typeof workerValue.config_version === 'number' && Number.isSafeInteger(workerValue.config_version)
        ? { config_version: workerValue.config_version }
        : {}),
      ...(typeof workerValue.control_version === 'number' && Number.isSafeInteger(workerValue.control_version)
        ? { control_version: workerValue.control_version }
        : {}),
      ...(typeof workerValue.updated_at === 'string'
        ? { updated_at: workerValue.updated_at }
        : {}),
      ...(typeof workerValue.updated_at_ms === 'number' && Number.isFinite(workerValue.updated_at_ms)
        ? { updated_at_ms: workerValue.updated_at_ms }
        : {}),
      ...(Number.isFinite(Number(workerValue.last_latency_ms))
        ? { latency_ms: Number(workerValue.last_latency_ms) }
        : {}),
    }
  }
  const { data } = await apiClient.post<AccountTestResult>(`/admin/accounts/${id}/test`)
  return data
}

/**
 * Refresh account credentials
 * @param id - Account ID
 * @returns Updated account
 */
export async function refreshCredentials(
  id: number | string,
  expectedControlVersion?: number,
): Promise<Account> {
  const workerContract = isCloudflareWorkerContractActive()
  if (workerContract && !Number.isSafeInteger(expectedControlVersion)) {
    throw new Error('Worker credential refresh requires an account control version')
  }
  const operation = workerContract
    ? await workerOperationKey('admin-account-oauth-refresh', { id: String(id), expected_control_version: expectedControlVersion })
    : null
  const { data } = await apiClient.post<Account>(`/admin/accounts/${id}/refresh`, workerContract ? {} : undefined, workerContract
    ? { headers: { 'If-Match': `"${expectedControlVersion}"`, 'Idempotency-Key': operation!.key }, timeout: 60000 }
    : undefined)
  if (operation) pendingWorkerOperationKeys.delete(operation.cacheKey)
  return adaptAccount(data)
}

/**
 * Apply OAuth credentials after re-authorization.
 *
 * Unlike `update()`, this endpoint:
 * - never overwrites the whole `extra` JSONB (merges incrementally instead),
 *   so persistent settings like `base_rpm`, `window_cost_limit`, `max_sessions`,
 *   `quota_*` and `privacy_mode` are preserved
 * - clears the account error and invalidates the token cache server-side
 */
export async function applyOAuthCredentials(
  id: number | string,
  payload: {
    type: 'oauth' | 'setup-token'
    credentials: Record<string, unknown>
    extra?: Record<string, unknown>
  }
): Promise<Account> {
  const { data } = await apiClient.post<Account>(
    `/admin/accounts/${id}/apply-oauth-credentials`,
    payload
  )
  return adaptAccount(data)
}

/**
 * Get account usage statistics
 * @param id - Account ID
 * @param days - Number of days (default: 30)
 * @param timezone - IANA timezone used to define daily statistic boundaries
 * @returns Account usage statistics with history, summary, and models
 */
export async function getStats(
  id: number | string,
  days: number = 30,
  timezone: string = getBrowserTimeZone()
): Promise<AccountUsageStatsResponse> {
  const { data } = await apiClient.get<AccountUsageStatsResponse>(`/admin/accounts/${id}/stats`, {
    params: { days, timezone }
  })
  return data
}

/**
 * Clear account error
 * @param id - Account ID
 * @returns Updated account
 */
export async function clearError(id: number): Promise<Account> {
  const { data } = await apiClient.post<Account>(`/admin/accounts/${id}/clear-error`)
  return data
}

/**
 * Get account usage information (5h/7d window)
 * @param id - Account ID
 * @returns Account usage info
 */
export async function getUsage(id: number | string, source?: 'passive' | 'active', force?: boolean): Promise<AccountUsageInfo> {
  const params: Record<string, string> = {}
  if (source) params.source = source
  if (force) params.force = 'true'
  const { data } = await apiClient.get<AccountUsageInfo>(`/admin/accounts/${id}/usage`, {
    params: Object.keys(params).length > 0 ? params : undefined,
    ...(isCloudflareWorkerContractActive() ? { timeout: 60000 } : {})
  })
  return data
}

export interface BatchAccountUsageResponse {
  usage: Record<string, AccountUsageInfo>
  errors: Record<string, string>
}

export async function getBatchUsage(accountIds: Array<number | string>, force?: boolean): Promise<BatchAccountUsageResponse> {
  const { data } = await apiClient.post<BatchAccountUsageResponse>('/admin/accounts/usage/batch', {
    account_ids: accountIds,
    force: force === true
  }, isCloudflareWorkerContractActive() ? { timeout: 180000 } : undefined)
  return data
}

/**
 * Clear account rate limit status
 * @param id - Account ID
 * @returns Updated account
 */
export async function clearRateLimit(id: number): Promise<Account> {
  const { data } = await apiClient.post<Account>(
    `/admin/accounts/${id}/clear-rate-limit`
  )
  return data
}

/**
 * Recover account runtime state in one call
 * @param id - Account ID
 * @returns Updated account
 */
export async function recoverState(id: number): Promise<Account> {
  const { data } = await apiClient.post<Account>(`/admin/accounts/${id}/recover-state`)
  return data
}

/**
 * Reset account quota usage
 * @param id - Account ID
 * @returns Updated account
 */
export async function resetAccountQuota(id: number): Promise<Account> {
  const { data } = await apiClient.post<Account>(
    `/admin/accounts/${id}/reset-quota`
  )
  return data
}

/**
 * Get temporary unschedulable status
 * @param id - Account ID
 * @returns Status with detail state if active
 */
export async function getTempUnschedulableStatus(id: number | string): Promise<TempUnschedulableStatus> {
  const { data } = await apiClient.get<TempUnschedulableStatus>(
    `/admin/accounts/${id}/temp-unschedulable`
  )
  return data
}

/**
 * Reset temporary unschedulable status
 * @param id - Account ID
 * @returns Success confirmation
 */
export async function resetTempUnschedulable(id: number | string): Promise<{ message: string }> {
  const { data } = await apiClient.delete<{ message: string }>(
    `/admin/accounts/${id}/temp-unschedulable`
  )
  return data
}

/**
 * Generate OAuth authorization URL
 * @param endpoint - API endpoint path
 * @param config - Proxy configuration
 * @returns Auth URL and session ID
 */
export async function generateAuthUrl(
  endpoint: string,
  config: { proxy_id?: number | string; redirect_uri?: string }
): Promise<{ auth_url: string; session_id: string }> {
  const { data } = await apiClient.post<{ auth_url: string; session_id: string }>(endpoint, config)
  return data
}

/**
 * Exchange authorization code for tokens
 * @param endpoint - API endpoint path
 * @param exchangeData - Session ID, code, and optional proxy config
 * @returns Token information
 */
export async function exchangeCode(
  endpoint: string,
  exchangeData: { session_id: string; code: string; state?: string; proxy_id?: number | string; redirect_uri?: string }
): Promise<Record<string, unknown>> {
  const { data } = await apiClient.post<Record<string, unknown>>(
    endpoint,
    exchangeData,
    { timeout: 60000 }
  )
  return data
}

/**
 * Batch create accounts
 * @param accounts - Array of account data
 * @returns Results of batch creation
 */
export async function batchCreate(accounts: CreateAccountRequest[]): Promise<{
  success: number
  failed: number
  results: Array<{ success: boolean; name?: string; id?: number | string; account?: Account; error?: string }>
}> {
  const operation = isCloudflareWorkerContractActive() ? await workerOperationKey('admin-account-batch-create', { accounts }) : null
  const { data } = await apiClient.post<{
    success: number
    failed: number
    results: Array<{ success: boolean; name?: string; id?: number | string; account?: Account; error?: string }>
  }>('/admin/accounts/batch', { accounts }, operation ? { headers: { 'Idempotency-Key': operation.key }, timeout: 120000 } : undefined)
  if (operation) pendingWorkerOperationKeys.delete(operation.cacheKey)
  return {
    ...data,
    results: data.results.map((result) => result.account === undefined
      ? result
      : { ...result, account: adaptAccount(result.account) })
  }
}

/**
 * Batch update credentials fields for multiple accounts
 * @param request - Batch update request containing account IDs, field name, and value
 * @returns Results of batch update
 */
export async function batchUpdateCredentials(request: {
  account_ids: Array<number | string>
  field: string
  value: any
}): Promise<{
  success: number
  failed: number
  results: Array<{ account_id: number | string; success: boolean; error?: string }>
}> {
  const { data } = await apiClient.post<{
    success: number
    failed: number
    results: Array<{ account_id: number | string; success: boolean; error?: string }>
  }>('/admin/accounts/batch-update-credentials', request)
  return data
}

interface BulkUpdateResult<AccountID extends number | string> {
  success: number
  failed: number
  success_ids?: AccountID[]
  failed_ids?: AccountID[]
  long_context_inherited_count?: number
  results: Array<{ account_id: AccountID; success: boolean; error?: string }>
}

/**
 * Bulk update multiple accounts
 * @param accountIds - Array of account IDs
 * @param updates - Fields to update
 * @returns Success confirmation
 */
export async function bulkUpdate<AccountID extends number | string>(
  accountIdsOrPayload: AccountID[],
  updates?: Record<string, unknown>
): Promise<BulkUpdateResult<AccountID>>
export async function bulkUpdate(
  accountIdsOrPayload: Record<string, unknown>,
  updates?: Record<string, unknown>
): Promise<BulkUpdateResult<number | string>>
export async function bulkUpdate(
  accountIdsOrPayload: Array<number | string> | Record<string, unknown>,
  updates?: Record<string, unknown>
): Promise<BulkUpdateResult<number | string>> {
  const payload = Array.isArray(accountIdsOrPayload)
    ? {
        account_ids: accountIdsOrPayload,
        ...(updates ?? {})
      }
    : accountIdsOrPayload
  if (isCloudflareWorkerContractActive()) return workerBulkEdit(payload)
  const { data } = await apiClient.post<BulkUpdateResult<number | string>>(
    '/admin/accounts/bulk-update',
    payload
  )
  return data
}

// Snapshot before any mutation so filtered edits cannot skip accounts as they
// leave the filter. Keep uncertain attempts for retries with the same versions.
const pendingBulkEditPlans = new Map<string, Array<WorkerAccountOperationTarget & { selection_error?: string }>>()
async function workerBulkEdit(payload: Record<string, unknown>): Promise<BulkUpdateResult<number | string>> {
  const { account_ids: ids, filters, ...updates } = payload
  if (ids !== undefined && !Array.isArray(ids)) throw new Error('account_ids must be an array')
  if (ids === undefined && (!filters || typeof filters !== 'object' || Array.isArray(filters))) throw new Error('Provide accounts or filters')
  const operation = await workerOperationKey('admin-account-general-edit', payload)
  let targets = pendingBulkEditPlans.get(operation.cacheKey)
  if (!targets) {
    targets = []
    if (Array.isArray(ids)) {
      for (const id of [...new Set(ids as Array<number | string>)]) {
        try {
          const account = await getById(id)
          targets.push({ id, control_version: account.control_version! })
        } catch (error) {
          targets.push({ id, control_version: 0, selection_error: error instanceof Error ? error.message : 'Account could not be loaded' })
        }
      }
    } else {
      for (let page = 1; ; page += 1) {
        const response = await list(page, 100, filters as Parameters<typeof list>[2])
        targets.push(...response.items.map(account => ({ id: account.id, control_version: account.control_version! })))
        if (page >= response.pages) break
        if (!response.items.length) throw new Error('Account list changed while selecting bulk targets; retry')
      }
    }
    targets = [...new Map(targets.map(target => [String(target.id), target])).values()]
    for (const target of targets) workerOperationAccounts([target])
    if (pendingBulkEditPlans.size >= 32) pendingBulkEditPlans.delete(pendingBulkEditPlans.keys().next().value!)
    pendingBulkEditPlans.set(operation.cacheKey, targets)
  }
  const results: BulkUpdateResult<number | string>['results'] = []
  let uncertain = false
  // One account per invocation isolates D1 query budgets for group/credential edits.
  // There is no UI selection cap, and the original partial-success result is retained.
  for (const target of targets) {
    if (target.selection_error) {
      results.push({ account_id: target.id, success: false, error: target.selection_error })
      continue
    }
    try {
      const { data } = await apiClient.post<BulkUpdateResult<number | string>>('/admin/accounts/bulk-update',
        { accounts: workerOperationAccounts([target]), updates }, { headers: { 'Idempotency-Key': operation.key } })
      if (data.results.length !== 1 || String(data.results[0].account_id) !== String(target.id)) throw new Error('Invalid bulk edit result')
      results.push(...data.results)
    } catch (error) {
      uncertain = true
      results.push({ account_id: target.id, success: false, error: error instanceof Error ? error.message : 'Account update failed' })
    }
  }
  if (!uncertain) {
    pendingBulkEditPlans.delete(operation.cacheKey)
    pendingWorkerOperationKeys.delete(operation.cacheKey)
  }
  const success_ids = results.filter(result => result.success).map(result => result.account_id)
  const failed_ids = results.filter(result => !result.success).map(result => result.account_id)
  return { success: success_ids.length, failed: failed_ids.length, success_ids, failed_ids, results }
}

export interface WorkerAccountOperationTarget {
  id: number | string
  control_version: number
}

export interface WorkerAccountOperationError {
  code: 'account_not_found' | 'account_version_conflict' | 'account_disabled'
  message: string
}

export interface WorkerAccountBulkStatusResult {
  total: number
  success: number
  failed: number
  success_ids: string[]
  failed_ids: string[]
  results: Array<{
    account_id: string
    success: boolean
    control_version?: number
    enabled?: boolean
    schedulable?: boolean
    error?: WorkerAccountOperationError
  }>
}

export interface WorkerAccountHealthProbeBatchResult {
  total: number
  queued: number
  failed: number
  queued_ids: string[]
  failed_ids: string[]
  results: Array<{
    account_id: string
    success: boolean
    control_version?: number
    job_id?: string
    generation?: number
    error?: WorkerAccountOperationError
  }>
}

export type WorkerSyntheticProbeCapability = 'chat_completions' | 'responses' | 'embeddings'

export interface WorkerSyntheticProbeTarget {
  account_id: string
  expected_control_version: number
  model_id: string
  capability: WorkerSyntheticProbeCapability
}

export type WorkerSyntheticProbeTargetErrorCode =
  | 'account_not_found'
  | 'account_version_conflict'
  | 'account_disabled'
  | 'account_model_not_available'
  | 'account_model_capability_not_enabled'

export interface WorkerSyntheticProbeTargetResult extends WorkerSyntheticProbeTarget {
  success: boolean
  generation?: number
  job_id?: string
  error?: {
    code: WorkerSyntheticProbeTargetErrorCode
    message: string
  }
}

export interface WorkerSyntheticProbeBatchResult {
  total: number
  queued: number
  failed: number
  queued_ids: string[]
  failed_ids: string[]
  results: WorkerSyntheticProbeTargetResult[]
}

export type WorkerSyntheticProbeErrorCode =
  | 'provider_configuration_unavailable'
  | 'upstream_timeout'
  | 'upstream_transport_failed'
  | 'upstream_http_error'
  | 'upstream_invalid_response'

export interface WorkerSyntheticProbeHistoryItem {
  id: string
  job_id: string
  account_id: string
  model_id: string
  capability: WorkerSyntheticProbeCapability
  generation: number
  outcome: 'succeeded' | 'failed'
  error_code: WorkerSyntheticProbeErrorCode | null
  upstream_status: number | null
  latency_ms: number
  alert_transition: 'firing' | 'resolved' | null
  checked_at_ms: number
}

export interface WorkerSyntheticProbeHistoryPage {
  items: WorkerSyntheticProbeHistoryItem[]
  has_more: boolean
  next_cursor: string | null
}

export interface WorkerSyntheticProbeHistoryParams {
  account_id?: string
  model_id?: string
  capability?: WorkerSyntheticProbeCapability
  cursor?: string
  limit?: number
}

function workerOperationAccounts(accounts: WorkerAccountOperationTarget[], maxAccounts = 25) {
  if (accounts.length === 0 || accounts.length > maxAccounts) {
    throw new Error(`Worker account operations require between 1 and ${maxAccounts} accounts`)
  }
  const seen = new Set<string>()
  return accounts.map((account) => {
    const id = String(account.id)
    if (!id || seen.has(id) || !Number.isSafeInteger(account.control_version) || account.control_version < 0) {
      throw new Error('Worker account operation targets must have unique ids and control versions')
    }
    seen.add(id)
    return { id, expected_control_version: account.control_version }
  })
}

export async function bulkSetEnabled(
  accounts: WorkerAccountOperationTarget[],
  enabled: boolean
): Promise<WorkerAccountBulkStatusResult> {
  const payload = { accounts: workerOperationAccounts(accounts), enabled }
  const operation = await workerOperationKey('admin-account-bulk-status', payload)
  const { data } = await apiClient.post<WorkerAccountBulkStatusResult>(
    '/admin/accounts/bulk-update',
    payload,
    { headers: { 'Idempotency-Key': operation.key } }
  )
  pendingWorkerOperationKeys.delete(operation.cacheKey)
  return data
}

export async function bulkSetSchedulable(
  accounts: WorkerAccountOperationTarget[],
  schedulable: boolean
): Promise<WorkerAccountBulkStatusResult> {
  const payload = { accounts: workerOperationAccounts(accounts), schedulable }
  const operation = await workerOperationKey('admin-account-bulk-schedulable', payload)
  const { data } = await apiClient.post<WorkerAccountBulkStatusResult>(
    '/admin/accounts/bulk-update',
    payload,
    { headers: { 'Idempotency-Key': operation.key } }
  )
  pendingWorkerOperationKeys.delete(operation.cacheKey)
  return data
}

export async function queueHealthProbes(
  accounts: WorkerAccountOperationTarget[]
): Promise<WorkerAccountHealthProbeBatchResult> {
  const payload = { accounts: workerOperationAccounts(accounts) }
  const operation = await workerOperationKey('admin-account-health-probes', payload)
  const { data } = await apiClient.post<WorkerAccountHealthProbeBatchResult>(
    '/admin/accounts/health-probes',
    payload,
    { headers: { 'Idempotency-Key': operation.key } }
  )
  pendingWorkerOperationKeys.delete(operation.cacheKey)
  return data
}

function syntheticProbeTargets(targets: WorkerSyntheticProbeTarget[]): WorkerSyntheticProbeTarget[] {
  if (targets.length === 0 || targets.length > 25) {
    throw new Error('Worker synthetic probe operations require between 1 and 25 targets')
  }

  const capabilities: WorkerSyntheticProbeCapability[] = ['chat_completions', 'responses', 'embeddings']
  const seen = new Set<string>()
  return targets.map((target) => {
    if (!target.account_id.trim() || !target.model_id.trim()
      || !Number.isSafeInteger(target.expected_control_version) || target.expected_control_version < 0
      || !capabilities.includes(target.capability)) {
      throw new Error('Worker synthetic probe targets must include a valid account, model, capability, and control version')
    }
    const identity = `${target.account_id}\u0000${target.model_id}\u0000${target.capability}`
    if (seen.has(identity)) throw new Error('Worker synthetic probe targets must not contain duplicate targets')
    seen.add(identity)
    return {
      account_id: target.account_id,
      expected_control_version: target.expected_control_version,
      model_id: target.model_id,
      capability: target.capability,
    }
  })
}

export async function queueSyntheticProbes(
  targets: WorkerSyntheticProbeTarget[]
): Promise<WorkerSyntheticProbeBatchResult> {
  const payload = { targets: syntheticProbeTargets(targets) }
  const operation = await workerOperationKey('admin-account-synthetic-probes', payload)
  const { data } = await apiClient.post<WorkerSyntheticProbeBatchResult>(
    '/admin/accounts/synthetic-probes',
    payload,
    { headers: { 'Idempotency-Key': operation.key } }
  )
  pendingWorkerOperationKeys.delete(operation.cacheKey)
  return data
}

export async function listSyntheticProbeHistory(
  params: WorkerSyntheticProbeHistoryParams = {}
): Promise<WorkerSyntheticProbeHistoryPage> {
  const query: WorkerSyntheticProbeHistoryParams = {}
  if (params.account_id !== undefined) query.account_id = params.account_id
  if (params.model_id !== undefined) query.model_id = params.model_id
  if (params.capability !== undefined) query.capability = params.capability
  if (params.cursor !== undefined) query.cursor = params.cursor
  if (params.limit !== undefined) query.limit = params.limit
  const { data } = await apiClient.get<WorkerSyntheticProbeHistoryPage>(
    '/admin/accounts/synthetic-probes/history',
    { params: query }
  )
  return data
}

/**
 * Get account today statistics
 * @param id - Account ID
 * @returns Today's stats (requests, tokens, cost)
 */
export async function getTodayStats(id: number | string): Promise<WindowStats> {
  const { data } = await apiClient.get<WindowStats>(`/admin/accounts/${id}/today-stats`)
  return data
}

export interface BatchTodayStatsResponse {
  stats: Record<string, WindowStats>
}

/**
 * 批量获取多个账号的今日统计
 * @param accountIds - 账号 ID 列表
 * @returns 以账号 ID（字符串）为键的统计映射
 */
export async function getBatchTodayStats(accountIds: Array<number | string>): Promise<BatchTodayStatsResponse> {
  const { data } = await apiClient.post<BatchTodayStatsResponse>('/admin/accounts/today-stats/batch', {
    account_ids: accountIds
  })
  return data
}

/**
 * Set account schedulable status
 * @param id - Account ID
 * @param schedulable - Whether the account should participate in scheduling
 * @returns Updated account
 */
export async function setSchedulable(id: number | string, schedulable: boolean, expectedControlVersion?: number): Promise<Account> {
  const { data } = await apiClient.post<Account>(`/admin/accounts/${id}/schedulable`, { schedulable },
    isCloudflareWorkerContractActive() && Number.isSafeInteger(expectedControlVersion)
      ? { headers: { 'If-Match': `"${expectedControlVersion}"` } }
      : undefined
  )
  return adaptAccount(data)
}

/**
 * Get available models for an account
 * @param id - Account ID
 * @returns List of available models for this account
 */
export interface AccountModelCapabilityInput {
  model_id: string
  chat_completions: boolean
  responses: boolean
  embeddings: boolean
  image_generation: boolean
}

export async function setModelCapability(account: Account, input: AccountModelCapabilityInput): Promise<Account> {
  const { data } = await apiClient.put<Account>(`/admin/accounts/${account.id}/models/${input.model_id}`, {
    ...input,
    expected_control_version: (account as any).control_version,
  })
  return adaptAccount(data)
}

export async function getAvailableModels(id: number | string): Promise<ClaudeModel[]> {
  const { data } = await apiClient.get<ClaudeModel[]>(`/admin/accounts/${id}/models`)
  return data
}

export interface SyncUpstreamModelsResult {
  models: string[]
  metadata?: Record<string, UpstreamModelMetadata>
  warnings?: UpstreamModelSyncWarning[]
}

export interface UpstreamModelSyncWarning {
  code: string
  message: string
}

export interface UpstreamModelMetadata {
  id: string
  display_name?: string
  description?: string
  reasoning?: boolean
  default_reasoning_level?: string
  supported_reasoning_levels?: string[]
  input_modalities?: string[]
  context_window?: number
  max_output_tokens?: number
}

/**
 * Sync live supported models from the account's upstream model-list endpoint
 * @param id - Account ID
 * @returns List of model IDs returned by the upstream
 */
export async function syncUpstreamModels(id: number | string): Promise<SyncUpstreamModelsResult> {
  const { data } = await apiClient.post<SyncUpstreamModelsResult>(`/admin/accounts/${id}/models/sync-upstream`)
  return data
}

export interface SyncUpstreamPreviewParams {
  project_id?: string
  provider_config?: Record<string, unknown>
  access_token?: string
  platform: string
  type: string
  base_url?: string
  api_key: string
  model_mapping?: Record<string, string>
}

/**
 * Preview upstream models without a saved account (create-flow)
 * @param params - Connection credentials
 * @returns List of model IDs returned by the upstream
 */
export async function syncUpstreamModelsPreview(params: SyncUpstreamPreviewParams): Promise<SyncUpstreamModelsResult> {
  const { data } = await apiClient.post<SyncUpstreamModelsResult>('/admin/accounts/models/sync-upstream-preview', params)
  return data
}

export interface CRSPreviewAccount {
  crs_account_id: string
  kind: string
  name: string
  platform: string
  type: string
}

export interface PreviewFromCRSResult {
  new_accounts: CRSPreviewAccount[]
  existing_accounts: CRSPreviewAccount[]
}

export async function previewFromCrs(params: {
  base_url: string
  username: string
  password: string
}): Promise<PreviewFromCRSResult> {
  const { data } = await apiClient.post<PreviewFromCRSResult>('/admin/accounts/sync/crs/preview', params)
  return data
}

export async function syncFromCrs(params: {
  base_url: string
  username: string
  password: string
  sync_proxies?: boolean
  selected_account_ids?: string[]
}): Promise<{
  created: number
  updated: number
  skipped: number
  failed: number
  items: Array<{
    crs_account_id: string
    kind: string
    name: string
    action: string
    error?: string
  }>
}> {
  const { data } = await apiClient.post<{
    created: number
    updated: number
    skipped: number
    failed: number
    items: Array<{
      crs_account_id: string
      kind: string
      name: string
      action: string
      error?: string
    }>
  }>('/admin/accounts/sync/crs', params, {
    timeout: 180000 // 180s timeout: sync refreshes each existing account's OAuth token serially
  })
  return data
}

export async function exportData(options?: {
  ids?: number[]
  filters?: {
    platform?: string
    type?: string
    status?: string
    group?: string
    privacy_mode?: string
    search?: string
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  }
  includeProxies?: boolean
}): Promise<AdminDataPayload> {
  const params: Record<string, string> = {}
  if (options?.ids && options.ids.length > 0) {
    params.ids = options.ids.join(',')
  } else if (options?.filters) {
    const { platform, type, status, group, privacy_mode, search, sort_by, sort_order } = options.filters
    if (platform) params.platform = platform
    if (type) params.type = type
    if (status) params.status = status
    if (group) params.group = group
    if (privacy_mode) params.privacy_mode = privacy_mode
    if (search) params.search = search
    if (sort_by) params.sort_by = sort_by
    if (sort_order) params.sort_order = sort_order
  }
  if (options?.includeProxies === false) {
    params.include_proxies = 'false'
  }
  const { data } = await apiClient.get<AdminDataPayload>('/admin/accounts/data', { params })
  return data
}

export async function importData(payload: {
  data: AdminDataPayload
  skip_default_group_bind?: boolean
}): Promise<AdminDataImportResult> {
  const { data } = await apiClient.post<AdminDataImportResult>('/admin/accounts/data', {
    data: payload.data,
    skip_default_group_bind: payload.skip_default_group_bind
  })
  return data
}

export async function importCodexSession(payload: CodexSessionImportRequest): Promise<CodexSessionImportResult> {
  const operation = isCloudflareWorkerContractActive()
    ? await workerOperationKey('admin-codex-import', payload) : null
  const { data } = await apiClient.post<CodexSessionImportResult>('/admin/accounts/import/codex-session', payload, {
    timeout: 120000,
    ...(operation ? { headers: { 'Idempotency-Key': operation.key } } : {})
  })
  if (operation) pendingWorkerOperationKeys.delete(operation.cacheKey)
  return data
}

export async function createOpenAICodexPAT(payload: OpenAICodexPATCreateRequest): Promise<Account> {
  const { data } = await apiClient.post<Account>('/admin/openai/create-from-codex-pat', payload)
  return data
}

/**
 * Get Antigravity default model mapping from backend
 * @returns Default model mapping (from -> to)
 */
export async function getAntigravityDefaultModelMapping(): Promise<Record<string, string>> {
  const { data } = await apiClient.get<Record<string, string>>(
    '/admin/accounts/antigravity/default-model-mapping'
  )
  return data
}

/**
 * Refresh OpenAI token using refresh token
 * @param refreshToken - The refresh token
 * @param proxyId - Optional proxy ID
 * @returns Token information including access_token, email, etc.
 */
export async function refreshOpenAIToken(
  refreshToken: string,
  proxyId?: number | string | null,
  endpoint: string = '/admin/openai/refresh-token',
  clientId?: string
): Promise<Record<string, unknown>> {
  const payload: { refresh_token: string; proxy_id?: number | string; client_id?: string } = {
    refresh_token: refreshToken
  }
  if (proxyId) {
    payload.proxy_id = proxyId
  }
  if (clientId) {
    payload.client_id = clientId
  }
  const { data } = await apiClient.post<Record<string, unknown>>(endpoint, payload, { timeout: 60000 })
  return data
}

/**
 * Batch operation result type
 */
export interface BatchOperationResult {
  total: number
  success: number
  failed: number
  success_ids?: Array<number | string>
  failed_ids?: Array<number | string>
  errors?: Array<{ account_id: number | string; error: string }>
  warnings?: Array<{ account_id: number | string; warning: string }>
}

/**
 * Revert account proxy to original before fallback
 * @param id - Account ID
 * @returns Success confirmation
 */
export async function revertProxyFallback(id: number): Promise<{ message: string }> {
  const { data } = await apiClient.post<{ message: string }>(`/admin/accounts/${id}/revert-proxy-fallback`)
  return data
}

/**
 * Delete multiple accounts with bounded server-side concurrency.
 */
export async function batchDelete(
  accountIds: Array<number | string> | WorkerAccountOperationTarget[]
): Promise<BatchOperationResult> {
  if (!isCloudflareWorkerContractActive()) {
    const { data } = await apiClient.post<BatchOperationResult>('/admin/accounts/batch-delete', {
      account_ids: accountIds
    })
    return data
  }
  if (!accountIds.every((account): account is WorkerAccountOperationTarget =>
    typeof account === 'object' && account !== null && 'control_version' in account,
  )) {
    throw new Error('Worker batch deletion requires account control versions')
  }
  const payload = { accounts: workerOperationAccounts(accountIds, 500) }
  const operation = await workerOperationKey('admin-account-batch-delete', payload)
  const { data } = await apiClient.post<BatchOperationResult>('/admin/accounts/batch-delete', payload, {
    headers: { 'Idempotency-Key': operation.key }
  })
  pendingWorkerOperationKeys.delete(operation.cacheKey)
  return data
}

/**
 * Batch clear account errors
 * @param accountIds - Array of account IDs
 * @returns Batch operation result
 */
export async function batchClearError(
  accountIds: Array<number | string> | WorkerAccountOperationTarget[],
): Promise<BatchOperationResult> {
  if (isCloudflareWorkerContractActive()) {
    if (!accountIds.every((account): account is WorkerAccountOperationTarget =>
      typeof account === 'object' && account !== null && 'control_version' in account,
    )) {
      throw new Error('Worker batch status reset requires account control versions')
    }
    const payload = { accounts: workerOperationAccounts(accountIds) }
    const operation = await workerOperationKey('admin-account-batch-clear-status', payload)
    const { data } = await apiClient.post<BatchOperationResult>('/admin/accounts/batch-clear-error', payload, {
      headers: { 'Idempotency-Key': operation.key },
    })
    pendingWorkerOperationKeys.delete(operation.cacheKey)
    return data
  }
  const { data } = await apiClient.post<BatchOperationResult>('/admin/accounts/batch-clear-error', {
    account_ids: accountIds
  })
  return data
}

/**
 * Batch refresh account credentials
 * @param accountIds - Array of account IDs
 * @returns Batch operation result
 */
export async function batchRefresh(
  accountIds: Array<number | string> | WorkerAccountOperationTarget[],
): Promise<BatchOperationResult> {
  if (!isCloudflareWorkerContractActive()) {
    const { data } = await apiClient.post<BatchOperationResult>('/admin/accounts/batch-refresh', {
      account_ids: accountIds,
    }, { timeout: 120000 })
    return data
  }
  if (!accountIds.every((account): account is WorkerAccountOperationTarget =>
    typeof account === 'object' && account !== null && 'control_version' in account,
  )) {
    throw new Error('Worker batch credential refresh requires account control versions')
  }
  const payload = { accounts: workerOperationAccounts(accountIds) }
  const operation = await workerOperationKey('admin-account-oauth-batch-refresh', payload)
  const { data } = await apiClient.post<BatchOperationResult>('/admin/accounts/batch-refresh', payload, {
    headers: { 'Idempotency-Key': operation.key }, timeout: 180000,
  })
  pendingWorkerOperationKeys.delete(operation.cacheKey)
  return data
}

/**
 * Set privacy for an Antigravity OAuth account
 * @param id - Account ID
 * @returns Updated account
 */
export async function setPrivacy(id: number | string): Promise<Account> {
  const { data } = await apiClient.post<Account>(`/admin/accounts/${id}/set-privacy`)
  return adaptAccount(data)
}

/**
 * OpenAI / Codex rate-limit reset feature: query and reset upstream usage.
 */
export interface OpenAIRateLimitWindow {
  used_percent: number
  limit_window_seconds: number
  reset_after_seconds: number
  reset_at: number
}

export interface OpenAIRateLimit {
  allowed: boolean
  limit_reached: boolean
  primary_window?: OpenAIRateLimitWindow | null
  secondary_window?: OpenAIRateLimitWindow | null
}

export interface OpenAIAdditionalRateLimit {
  limit_name: string
  metered_feature: string
  rate_limit?: OpenAIRateLimit | null
}

export interface OpenAIRateLimitResetCreditDetail {
  expires_at?: string
}

export interface OpenAIRateLimitResetCredits {
  available_count: number
  credits?: OpenAIRateLimitResetCreditDetail[]
}

export interface OpenAIQuotaUsage {
  user_id?: string
  account_id?: string
  email?: string
  plan_type?: string
  rate_limit?: OpenAIRateLimit | null
  additional_rate_limits?: OpenAIAdditionalRateLimit[]
  rate_limit_reset_credits?: OpenAIRateLimitResetCredits | null
  fetched_at: number
}

export interface OpenAIQuotaResetCredit {
  id?: string
  reset_type?: string
  status?: string
  granted_at?: string
  expires_at?: string
  redeem_started_at?: string
  redeemed_at?: string
}

export interface OpenAIQuotaResetResult {
  code: string
  credit?: OpenAIQuotaResetCredit | null
  windows_reset: number
  quota?: OpenAIQuotaUsage | null
  account?: Account | null
  cache_refreshed: boolean
  account_state_recovered: boolean
  warning_code?:
    | 'reset_credit_cache_refresh_failed'
    | 'account_state_recovery_failed'
    | 'account_state_refresh_failed'
}

/** Usage payload plus whether the reset-credit snapshot was persisted. */
export interface OpenAIQuotaRefreshResult extends OpenAIQuotaUsage {
  cache_persisted: boolean
}

/**
 * Query the upstream quota AND persist the reset-credit snapshot on the account
 * so the card can be rehydrated without an upstream round-trip. It is a POST
 * because it writes account state (and must therefore be audited).
 *
 * The read-only `GET /admin/openai/accounts/:id/quota` endpoint still exists for
 * API consumers; the panel always wants the snapshot persisted, so it has no
 * client binding here.
 */
export async function refreshOpenAIQuota(id: number): Promise<OpenAIQuotaRefreshResult> {
  const { data } = await apiClient.post<OpenAIQuotaRefreshResult>(
    `/admin/openai/accounts/${id}/quota/refresh`
  )
  return data
}

/**
 * Consume one rate-limit-reset credit for an OpenAI/Codex OAuth account.
 *
 * The credit is non-refundable and the endpoint chains an upstream reset with an
 * upstream re-query, so it needs a larger budget than the default client
 * timeout: aborting locally would report a successful consumption as a failure
 * and invite a retry that spends a second credit.
 */
export async function resetOpenAIQuota(id: number): Promise<OpenAIQuotaResetResult> {
  const { data } = await apiClient.post<OpenAIQuotaResetResult>(
    `/admin/openai/accounts/${id}/reset-quota`,
    undefined,
    { timeout: 90_000 }
  )
  return data
}

export interface SparkShadowCreatePayload {
  name?: string
  priority?: number
  concurrency?: number
  group_ids?: number[]
}

export async function createSparkShadow(parentId: number, payload: SparkShadowCreatePayload): Promise<Account> {
  const { data } = await apiClient.post<Account>(`/admin/accounts/${parentId}/shadow`, payload)
  return data
}

export async function getUpstreamBillingProbeSettings(): Promise<UpstreamBillingProbeSettings> {
  const { data } = await apiClient.get<UpstreamBillingProbeSettings>('/admin/accounts/upstream-billing-probe/settings')
  return data
}

export async function updateUpstreamBillingProbeSettings(
  settings: UpstreamBillingProbeSettings
): Promise<UpstreamBillingProbeSettings> {
  const { data } = await apiClient.put<UpstreamBillingProbeSettings>(
    '/admin/accounts/upstream-billing-probe/settings',
    settings
  )
  return data
}

export async function setUpstreamBillingProbeEnabled(id: number, enabled: boolean): Promise<void> {
  await apiClient.put(`/admin/accounts/${id}/upstream-billing-probe`, { enabled })
}

export async function probeUpstreamBilling(id: number): Promise<UpstreamBillingProbeResult> {
  const { data } = await apiClient.post<UpstreamBillingProbeResult>(`/admin/accounts/${id}/upstream-billing-probe`)
  return data
}

export async function probeUpstreamBillingBatch(accountIds: number[]): Promise<UpstreamBillingProbeResult[]> {
  const { data } = await apiClient.post<{ results: UpstreamBillingProbeResult[] }>(
    '/admin/accounts/upstream-billing-probe/batch',
    { account_ids: accountIds },
    { timeout: 90000 }
  )
  return data.results
}

export async function getOllamaCloudUsageSettings(): Promise<OllamaCloudUsageSettings> {
  const { data } = await apiClient.get<OllamaCloudUsageSettings>('/admin/accounts/ollama-cloud-usage/settings')
  return data
}

export async function updateOllamaCloudUsageSettings(
  settings: OllamaCloudUsageSettings
): Promise<OllamaCloudUsageSettings> {
  const { data } = await apiClient.put<OllamaCloudUsageSettings>(
    '/admin/accounts/ollama-cloud-usage/settings',
    settings
  )
  return data
}

export async function getOllamaCloudUsage(id: number | string): Promise<OllamaCloudUsageState> {
  const { data } = await apiClient.get<OllamaCloudUsageState>(`/admin/accounts/${id}/ollama-cloud-usage`)
  return data
}

export async function saveOllamaCloudUsageSession(id: number | string, session: string): Promise<OllamaCloudUsageState> {
  const { data } = await apiClient.put<OllamaCloudUsageState>(`/admin/accounts/${id}/ollama-cloud-usage/session`, {
    session
  })
  return data
}

export async function deleteOllamaCloudUsageSession(id: number | string): Promise<OllamaCloudUsageState> {
  const { data } = await apiClient.delete<OllamaCloudUsageState>(`/admin/accounts/${id}/ollama-cloud-usage/session`)
  return data
}

export async function setOllamaCloudUsageAutoRefresh(id: number | string, enabled: boolean): Promise<OllamaCloudUsageState> {
  const { data } = await apiClient.put<OllamaCloudUsageState>(`/admin/accounts/${id}/ollama-cloud-usage/auto-refresh`, {
    enabled
  })
  return data
}

export async function refreshOllamaCloudUsage(id: number | string): Promise<OllamaCloudUsageState> {
  const { data } = await apiClient.post<OllamaCloudUsageState>(`/admin/accounts/${id}/ollama-cloud-usage/refresh`)
  return data
}

export const accountsAPI = {
  list,
  listWithEtag,
  getUpstreamBillingRatesWithEtag,
  getById,
  create,
  duplicate,
  update,
  checkMixedChannelRisk,
  delete: deleteAccount,
  toggleStatus,
  testAccount,
  refreshCredentials,
  applyOAuthCredentials,
  getStats,
  clearError,
  getUsage,
  getBatchUsage,
  getTodayStats,
  getBatchTodayStats,
  clearRateLimit,
  recoverState,
  resetAccountQuota,
  getTempUnschedulableStatus,
  resetTempUnschedulable,
  setSchedulable,
  getAvailableModels,
  setModelCapability,
  syncUpstreamModels,
  syncUpstreamModelsPreview,
  generateAuthUrl,
  exchangeCode,
  refreshOpenAIToken,
  batchCreate,
  batchUpdateCredentials,
  bulkUpdate,
  bulkSetEnabled,
  bulkSetSchedulable,
  queueHealthProbes,
  queueSyntheticProbes,
  listSyntheticProbeHistory,
  previewFromCrs,
  syncFromCrs,
  exportData,
  importData,
  importCodexSession,
  createOpenAICodexPAT,
  getAntigravityDefaultModelMapping,
  batchDelete,
  batchClearError,
  batchRefresh,
  setPrivacy,
  revertProxyFallback,
  refreshOpenAIQuota,
  resetOpenAIQuota,
  createSparkShadow,
  getUpstreamBillingProbeSettings,
  updateUpstreamBillingProbeSettings,
  setUpstreamBillingProbeEnabled,
  probeUpstreamBilling,
  probeUpstreamBillingBatch,
  getOllamaCloudUsageSettings,
  updateOllamaCloudUsageSettings,
  getOllamaCloudUsage,
  saveOllamaCloudUsageSession,
  deleteOllamaCloudUsageSession,
  setOllamaCloudUsageAutoRefresh,
  refreshOllamaCloudUsage
}

export default accountsAPI
