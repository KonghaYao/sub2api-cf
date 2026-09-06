/**
 * Admin Groups API endpoints
 * Handles API key group management for administrators
 */

import { apiClient } from '../client'
import { isCloudflareWorkerContractActive } from '@/utils/adminCapabilities'
import type {
  AdminGroup,
  GroupPlatform,
  CompositeModelRoute,
  CompositeModelRouteInput,
  CompositeRoutePreviewRequest,
  CompositeRouteDecision,
  CreateGroupRequest,
  UpdateGroupRequest,
  PaginatedResponse
} from '@/types'

export interface LiveCapability {
  supported: boolean
  reason?: string
}

type WorkerGroupProjection = AdminGroup & {
  id: string | number
  control_version: number
  enabled?: boolean
  rate_multiplier_ppm?: number
  catalog_mode?: 'all_routable' | 'allowlist'
  group_type?: 'standard' | 'subscription'
  daily_quota_micros?: number | null
  weekly_quota_micros?: number | null
  monthly_quota_micros?: number | null
  image_rate_multiplier_ppm?: number
  batch_image_discount_multiplier_ppm?: number
  batch_image_hold_multiplier_ppm?: number
  image_price_1k_micros?: number | null
  image_price_2k_micros?: number | null
  image_price_4k_micros?: number | null
}

const groupControlVersions = new Map<string, number>()
const compositeRouteControlVersions = new Map<string, number>()

export class WorkerGroupFeatureNotSupportedError extends Error {
  readonly code = 'worker_feature_not_supported'

  constructor(feature: string) {
    super(`${feature} is not supported by the Cloudflare Worker contract`)
    this.name = 'WorkerGroupFeatureNotSupportedError'
  }
}

function requireLegacyGroupFeature(feature: string): void {
  if (isCloudflareWorkerContractActive()) {
    throw new WorkerGroupFeatureNotSupportedError(feature)
  }
}

function rememberGroup(group: AdminGroup): void {
  const projection = group as WorkerGroupProjection
  if (Number.isSafeInteger(projection.control_version) && projection.control_version >= 0) {
    groupControlVersions.set(String(projection.id), projection.control_version)
  }
}

function rememberGroups(groups: AdminGroup[]): void {
  groups.forEach(rememberGroup)
}

function newControlOperationKey(scope: string): string {
  const requestID = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${scope}-${requestID}`
}

function requireGroupControlVersion(id: string | number): number {
  const version = groupControlVersions.get(String(id))
  if (version === undefined) {
    throw Object.assign(
      new Error('Reload this group before changing it'),
      { code: 'group_version_not_loaded' }
    )
  }
  return version
}

function quotaUsdToMicros(value: number | null, field: string): number | null {
  if (value === null) return null
  const micros = Math.round(value * 1_000_000)
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(micros)) {
    throw Object.assign(
      new Error(`${field} must be a non-negative amount representable in USD micros`),
      { code: 'invalid_group_quota' }
    )
  }
  return micros
}

function multiplierToPpm(value: number, field: string): number {
  const ppm = Math.round(value * 1_000_000)
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(ppm)) {
    throw Object.assign(new Error(`${field} must be a non-negative multiplier`), {
      code: `invalid_${field}`
    })
  }
  return ppm
}

function adaptWorkerGroup(group: AdminGroup): AdminGroup {
  const projection = group as WorkerGroupProjection
  const adapted = { ...group } as AdminGroup
  if (Number.isSafeInteger(projection.rate_multiplier_ppm) && projection.rate_multiplier_ppm! >= 0) {
    adapted.rate_multiplier = projection.rate_multiplier_ppm! / 1_000_000
  }
  if (projection.group_type !== undefined) adapted.subscription_type = projection.group_type
  for (const [workerField, legacyField] of [
    ['daily_quota_micros', 'daily_limit_usd'],
    ['weekly_quota_micros', 'weekly_limit_usd'],
    ['monthly_quota_micros', 'monthly_limit_usd']
  ] as const) {
    const value = projection[workerField]
    if (value === null) adapted[legacyField] = null
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      adapted[legacyField] = value / 1_000_000
    }
  }
  for (const [workerField, legacyField] of [
    ['image_rate_multiplier_ppm', 'image_rate_multiplier'],
    ['batch_image_discount_multiplier_ppm', 'batch_image_discount_multiplier'],
    ['batch_image_hold_multiplier_ppm', 'batch_image_hold_multiplier']
  ] as const) {
    const value = projection[workerField]
    if (Number.isSafeInteger(value) && value! >= 0) adapted[legacyField] = value! / 1_000_000
  }
  for (const [workerField, legacyField] of [
    ['image_price_1k_micros', 'image_price_1k'],
    ['image_price_2k_micros', 'image_price_2k'],
    ['image_price_4k_micros', 'image_price_4k']
  ] as const) {
    const value = projection[workerField]
    if (value === null) adapted[legacyField] = null
    else if (Number.isSafeInteger(value) && value! >= 0) adapted[legacyField] = value! / 1_000_000
  }
  return adapted
}

function appendWorkerImagePolicy(
  payload: Record<string, unknown>,
  group: CreateGroupRequest | UpdateGroupRequest
): void {
  for (const field of [
    'allow_image_generation',
    'allow_batch_image_generation',
    'image_rate_independent'
  ] as const) {
    if (group[field] !== undefined) payload[field] = group[field]
  }
  for (const [legacyField, workerField] of [
    ['image_rate_multiplier', 'image_rate_multiplier_ppm'],
    ['batch_image_discount_multiplier', 'batch_image_discount_multiplier_ppm'],
    ['batch_image_hold_multiplier', 'batch_image_hold_multiplier_ppm']
  ] as const) {
    const value = group[legacyField]
    if (value !== undefined) payload[workerField] = multiplierToPpm(value, legacyField)
  }
  for (const [legacyField, workerField] of [
    ['image_price_1k', 'image_price_1k_micros'],
    ['image_price_2k', 'image_price_2k_micros'],
    ['image_price_4k', 'image_price_4k_micros']
  ] as const) {
    const value = group[legacyField]
    if (value !== undefined) {
      // The retained edit form uses -1 as its explicit "clear configured
      // price" sentinel. D1 uses NULL for the same state.
      payload[workerField] = value === -1 ? null : quotaUsdToMicros(value, legacyField)
    }
  }
}

// Preserve all original fields; only replace fields with explicit unit/name mappings.
function groupPassthrough(group: CreateGroupRequest | UpdateGroupRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...group }
  for (const field of ["rate_multiplier", "subscription_type", "daily_limit_usd", "weekly_limit_usd", "monthly_limit_usd", "image_rate_multiplier", "batch_image_discount_multiplier", "batch_image_hold_multiplier", "image_price_1k", "image_price_2k", "image_price_4k", "status"]) delete payload[field]
  return payload
}

function workerCreateGroupPayload(group: CreateGroupRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = groupPassthrough(group)
  if (group.description !== undefined) payload.description = group.description
  if (group.platform !== undefined) payload.platform = group.platform
  if (group.rate_multiplier !== undefined) {
    payload.rate_multiplier_ppm = Math.round(group.rate_multiplier * 1_000_000)
  }
  if (group.rpm_limit !== undefined) payload.rpm_limit = group.rpm_limit
  if (group.is_exclusive !== undefined) payload.is_exclusive = group.is_exclusive
  if (group.subscription_type !== undefined) payload.group_type = group.subscription_type
  if (group.daily_limit_usd !== undefined) {
    payload.daily_quota_micros = quotaUsdToMicros(group.daily_limit_usd, 'daily_limit_usd')
  }
  if (group.weekly_limit_usd !== undefined) {
    payload.weekly_quota_micros = quotaUsdToMicros(group.weekly_limit_usd, 'weekly_limit_usd')
  }
  if (group.monthly_limit_usd !== undefined) {
    payload.monthly_quota_micros = quotaUsdToMicros(group.monthly_limit_usd, 'monthly_limit_usd')
  }
  appendWorkerImagePolicy(payload, group)
  return payload
}

function workerUpdateGroupPayload(group: UpdateGroupRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = groupPassthrough(group)
  if (group.name !== undefined) payload.name = group.name
  if (group.description !== undefined) payload.description = group.description
  if (group.platform !== undefined) payload.platform = group.platform
  if (group.status !== undefined) payload.enabled = group.status === 'active'
  if (group.rate_multiplier !== undefined) {
    payload.rate_multiplier_ppm = Math.round(group.rate_multiplier * 1_000_000)
  }
  if (group.rpm_limit !== undefined) payload.rpm_limit = group.rpm_limit
  if (group.is_exclusive !== undefined) payload.is_exclusive = group.is_exclusive
  if (group.subscription_type !== undefined) payload.group_type = group.subscription_type
  if (group.daily_limit_usd !== undefined) {
    payload.daily_quota_micros = quotaUsdToMicros(group.daily_limit_usd, 'daily_limit_usd')
  }
  if (group.weekly_limit_usd !== undefined) {
    payload.weekly_quota_micros = quotaUsdToMicros(group.weekly_limit_usd, 'weekly_limit_usd')
  }
  if (group.monthly_limit_usd !== undefined) {
    payload.monthly_quota_micros = quotaUsdToMicros(group.monthly_limit_usd, 'monthly_limit_usd')
  }
  appendWorkerImagePolicy(payload, group)
  const workerFields = group as UpdateGroupRequest & {
    enabled?: boolean
    sort_order?: number
    catalog_mode?: 'all_routable' | 'allowlist'
  }
  if (workerFields.enabled !== undefined) payload.enabled = workerFields.enabled
  if (workerFields.sort_order !== undefined) payload.sort_order = workerFields.sort_order
  if (workerFields.catalog_mode !== undefined) payload.catalog_mode = workerFields.catalog_mode
  return payload
}

/**
 * List all groups with pagination
 * @param page - Page number (default: 1)
 * @param pageSize - Items per page (default: 20)
 * @param filters - Optional filters (platform, status, is_exclusive, search)
 * @returns Paginated list of groups
 */
export async function list(
  page: number = 1,
  pageSize: number = 20,
  filters?: {
    platform?: GroupPlatform
    status?: 'active' | 'inactive'
    is_exclusive?: boolean
    search?: string
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  },
  options?: {
    signal?: AbortSignal
  }
): Promise<PaginatedResponse<AdminGroup>> {
  if (isCloudflareWorkerContractActive() && pageSize > 100) {
    const { data } = await apiClient.get<AdminGroup[]>('/admin/groups/all', {
      params: {
        include_inactive: true,
        ...(filters?.platform ? { platform: filters.platform } : {})
      },
      signal: options?.signal
    })
    const normalizedSearch = filters?.search?.trim().toLowerCase()
    const items = data.map(adaptWorkerGroup).filter((group) => {
      if (filters?.status && group.status !== filters.status) return false
      if (filters?.is_exclusive !== undefined && group.is_exclusive !== filters.is_exclusive) return false
      if (normalizedSearch && !group.name.toLowerCase().includes(normalizedSearch)) return false
      return true
    })
    rememberGroups(items)
    return {
      items,
      total: items.length,
      page: 1,
      page_size: items.length,
      pages: items.length === 0 ? 0 : 1
    }
  }

  const params = isCloudflareWorkerContractActive()
    ? {
        page,
        page_size: pageSize,
        ...(filters?.platform ? { platform: filters.platform } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
        ...(filters?.is_exclusive === undefined ? {} : { is_exclusive: filters.is_exclusive }),
        ...(filters?.search?.trim() ? { search: filters.search.trim() } : {}),
        ...(filters?.sort_by ? { sort_by: filters.sort_by } : {}),
        ...(filters?.sort_order ? { sort_order: filters.sort_order } : {})
      }
    : {
        page,
        page_size: pageSize,
        ...filters
      }
  const { data } = await apiClient.get<PaginatedResponse<AdminGroup>>('/admin/groups', {
    params,
    signal: options?.signal
  })
  const result = { ...data, items: data.items.map(adaptWorkerGroup) }
  rememberGroups(result.items)
  return result
}

/**
 * Get all active groups (without pagination)
 * @param platform - Optional platform filter
 * @returns List of all active groups
 */
export async function getAll(platform?: GroupPlatform): Promise<AdminGroup[]> {
  const { data } = await apiClient.get<AdminGroup[]>('/admin/groups/all', {
    params: platform ? { platform } : undefined
  })
  const groups = data.map(adaptWorkerGroup)
  rememberGroups(groups)
  return groups
}

/**
 * Get ALL groups including disabled ones — used by the API Key group filter so
 * that admins can filter users whose keys are still bound to a now-disabled group.
 */
export async function getAllIncludingInactive(): Promise<AdminGroup[]> {
  const { data } = await apiClient.get<AdminGroup[]>('/admin/groups/all', {
    params: { include_inactive: true }
  })
  const groups = data.map(adaptWorkerGroup)
  rememberGroups(groups)
  return groups
}

/**
 * Get active groups by platform
 * @param platform - Platform to filter by
 * @returns List of groups for the specified platform
 */
export async function getByPlatform(platform: GroupPlatform): Promise<AdminGroup[]> {
  return getAll(platform)
}

/** 获取当前 Sub2API 服务端的 Live 运行环境能力。 */
export async function getLiveCapability(): Promise<LiveCapability> {
  requireLegacyGroupFeature('Live capability discovery')
  const { data } = await apiClient.get<LiveCapability>('/admin/groups/live-capability')
  return data
}

/**
 * Get group by ID
 * @param id - Group ID
 * @returns Group details
 */
export async function getById(id: string | number): Promise<AdminGroup> {
  const { data } = await apiClient.get<AdminGroup>(`/admin/groups/${id}`)
  const group = adaptWorkerGroup(data)
  rememberGroup(group)
  return group
}

/**
 * Get candidate models for custom /v1/models list.
 * id=0 returns platform default models for create flow.
 */
export async function getModelsListCandidates(
  id: number,
  platform?: GroupPlatform
): Promise<string[]> {
  const { data } = await apiClient.get<{ models: string[] }>(
    `/admin/groups/${id}/models-list-candidates`,
    {
      params: platform ? { platform } : undefined
    }
  )
  return data.models || []
}

/**
 * Create new group
 * @param groupData - Group data
 * @returns Created group
 */
export async function create(groupData: CreateGroupRequest): Promise<AdminGroup> {
  const { data } = await apiClient.post<AdminGroup>(
    '/admin/groups',
    workerCreateGroupPayload(groupData),
    { headers: { 'Idempotency-Key': newControlOperationKey('admin-group-create') } }
  )
  const group = adaptWorkerGroup(data)
  rememberGroup(group)
  return group
}

/**
 * Duplicate a group on the server so configuration that is not present in the
 * list response is preserved. Keep the operation key after ambiguous failures
 * so a retry replays the original operation instead of creating another group.
 */
const duplicateOperationKeys = new Map<string, string>()

interface DuplicateOperationScope {
  adminID: string
  key: string
}

function getCurrentAdminID(): string | null {
  try {
    const rawUser = globalThis.localStorage?.getItem('auth_user')
    if (!rawUser) return null

    const user: unknown = JSON.parse(rawUser)
    if (typeof user !== 'object' || user === null) return null

    const id = (user as { id?: unknown }).id
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) return id
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null
    return String(id)
  } catch {
    return null
  }
}

function duplicateOperationScope(id: number): DuplicateOperationScope | null {
  const adminID = getCurrentAdminID()
  if (!adminID) return null

  return {
    adminID,
    key: `sub2api:admin:group-duplicate:${adminID}:${id}`
  }
}

function getStoredDuplicateOperationKey(storageKey: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(storageKey) ?? null
  } catch {
    return null
  }
}

function storeDuplicateOperationKey(storageKey: string, key: string | null): void {
  try {
    if (key) globalThis.sessionStorage?.setItem(storageKey, key)
    else globalThis.sessionStorage?.removeItem(storageKey)
  } catch {
    // In-memory retry protection still works when browser storage is unavailable.
  }
}

export async function duplicate(id: number): Promise<AdminGroup> {
  const scope = duplicateOperationScope(id)
  let idempotencyKey = scope
    ? duplicateOperationKeys.get(scope.key) ?? getStoredDuplicateOperationKey(scope.key)
    : null
  if (!idempotencyKey) {
    const requestID = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    idempotencyKey = `group-duplicate-${scope?.adminID ?? 'unknown-admin'}-${id}-${requestID}`
  }
  if (scope) {
    duplicateOperationKeys.set(scope.key, idempotencyKey)
    storeDuplicateOperationKey(scope.key, idempotencyKey)
  }

  const { data } = await apiClient.post<AdminGroup>(`/admin/groups/${id}/duplicate`, undefined, {
    headers: { 'Idempotency-Key': idempotencyKey }
  })

  if (scope) {
    duplicateOperationKeys.delete(scope.key)
    storeDuplicateOperationKey(scope.key, null)
  }
  rememberGroup(data)
  return adaptWorkerGroup(data)
}

/**
 * Update group
 * @param id - Group ID
 * @param updates - Fields to update
 * @returns Updated group
 */
export async function update(id: string | number, updates: UpdateGroupRequest): Promise<AdminGroup> {
  const version = requireGroupControlVersion(id)
  const { data } = await apiClient.put<AdminGroup>(
    `/admin/groups/${id}`,
    workerUpdateGroupPayload(updates),
    {
      headers: {
        'Idempotency-Key': newControlOperationKey('admin-group-update'),
        'If-Match': `"${version}"`
      }
    }
  )
  const group = adaptWorkerGroup(data)
  rememberGroup(group)
  return group
}

/**
 * Delete group
 * @param id - Group ID
 * @returns Success confirmation
 */
export async function deleteGroup(id: string | number): Promise<AdminGroup> {
  const version = requireGroupControlVersion(id)
  const { data } = await apiClient.delete<AdminGroup>(`/admin/groups/${id}`, {
    headers: {
      'Idempotency-Key': newControlOperationKey('admin-group-disable'),
      'If-Match': `"${version}"`
    }
  })
  const group = adaptWorkerGroup(data)
  rememberGroup(group)
  return group
}

/**
 * Toggle group status
 * @param id - Group ID
 * @param status - New status
 * @returns Updated group
 */
export async function toggleStatus(id: string | number, status: 'active' | 'inactive'): Promise<AdminGroup> {
  return update(id, { status })
}

/**
 * Get group statistics
 * @param id - Group ID
 * @returns Group usage statistics
 */
export async function getStats(id: number): Promise<{
  total_api_keys: number
  active_api_keys: number
  total_requests: number
  total_cost: number
}> {
  requireLegacyGroupFeature('Group statistics')
  const { data } = await apiClient.get<{
    total_api_keys: number
    active_api_keys: number
    total_requests: number
    total_cost: number
  }>(`/admin/groups/${id}/stats`)
  return data
}

/**
 * Get API keys in a group
 * @param id - Group ID
 * @param page - Page number
 * @param pageSize - Items per page
 * @returns Paginated list of API keys in the group
 */
export async function getGroupApiKeys(
  id: number,
  page: number = 1,
  pageSize: number = 20
): Promise<PaginatedResponse<any>> {
  requireLegacyGroupFeature('Group API key listing')
  const { data } = await apiClient.get<PaginatedResponse<any>>(`/admin/groups/${id}/api-keys`, {
    params: { page, page_size: pageSize }
  })
  return data
}

export async function listCompositeRoutes(id: string | number): Promise<CompositeModelRoute[]> {
  const { data } = await apiClient.get<CompositeModelRoute[]>(`/admin/groups/${id}/composite-routes`)
  for (const route of data as Array<CompositeModelRoute & { control_version?: number }>) {
    if (Number.isSafeInteger(route.control_version)) compositeRouteControlVersions.set(String(route.id), route.control_version!)
  }
  return data
}

export async function createCompositeRoute(
  id: string | number,
  route: CompositeModelRouteInput
): Promise<CompositeModelRoute> {
  const { data } = await apiClient.post<CompositeModelRoute>(
    `/admin/groups/${id}/composite-routes`,
    route,
    isCloudflareWorkerContractActive() ? { headers: { 'Idempotency-Key': newControlOperationKey('composite-route-create') } } : undefined
  )
  return data
}

export async function updateCompositeRoute(
  id: string | number,
  routeId: string | number,
  route: CompositeModelRouteInput
): Promise<CompositeModelRoute> {
  const { data } = await apiClient.put<CompositeModelRoute>(
    `/admin/groups/${id}/composite-routes/${routeId}`,
    isCloudflareWorkerContractActive()
      ? { ...route, expected_control_version: requireCompositeRouteControlVersion(routeId) }
      : route,
    isCloudflareWorkerContractActive() ? { headers: { 'Idempotency-Key': newControlOperationKey('composite-route-update') } } : undefined
  )
  return data
}

export async function deleteCompositeRoute(
  id: string | number,
  routeId: string | number,
): Promise<{ message: string }> {
  const { data } = await apiClient.delete<{ message: string }>(
    `/admin/groups/${id}/composite-routes/${routeId}`,
    isCloudflareWorkerContractActive()
      ? { data: { expected_control_version: requireCompositeRouteControlVersion(routeId) }, headers: { 'Idempotency-Key': newControlOperationKey('composite-route-delete') } }
      : undefined
  )
  return data
}

function requireCompositeRouteControlVersion(id: string | number): number {
  const version = compositeRouteControlVersions.get(String(id))
  if (version === undefined) throw Object.assign(new Error('Reload this route before changing it'), { code: 'composite_route_version_not_loaded' })
  return version
}

export async function previewCompositeRoute(
  id: string | number,
  request: CompositeRoutePreviewRequest
): Promise<CompositeRouteDecision> {
  const { data } = await apiClient.post<CompositeRouteDecision>(
    `/admin/groups/${id}/composite-routes/preview`,
    request
  )
  return data
}

/**
 * Rate multiplier entry for a user in a group
 */
export interface GroupRateMultiplierEntry {
  user_id: string | number
  user_name: string
  user_email: string
  user_notes: string
  user_status: string
  rate_multiplier?: number | null
  rpm_override?: number | null
  control_version?: number
}

/**
 * Get rate multipliers for users in a group
 * @param id - Group ID
 * @returns List of user rate multiplier entries
 */
export async function getGroupRateMultipliers(id: string | number): Promise<GroupRateMultiplierEntry[]> {
  const { data } = await apiClient.get<GroupRateMultiplierEntry[]>(
    `/admin/groups/${id}/rate-multipliers`
  )
  return data
}

/**
 * Update group sort orders
 * @param updates - Array of { id, sort_order } objects
 * @returns Success confirmation
 */
export async function updateSortOrder(
  updates: Array<{ id: number; sort_order: number }>
): Promise<{ message: string }> {
  if (isCloudflareWorkerContractActive()) {
    const { data } = await apiClient.put<{ message: string; updates: Array<{ id: string; control_version: number }> }>(
      '/admin/groups/sort-order',
      { updates: updates.map(update => ({ ...update, id: String(update.id), control_version: requireGroupControlVersion(update.id) })) },
      { headers: { 'Idempotency-Key': newControlOperationKey('group-sort') } },
    )
    for (const update of data.updates) groupControlVersions.set(update.id, update.control_version)
    return { message: data.message }
  }
  const { data } = await apiClient.put<{ message: string }>('/admin/groups/sort-order', {
    updates
  })
  return data
}

/**
 * Clear all rate multipliers for a group
 * @param id - Group ID
 * @returns Success confirmation
 */
export async function clearGroupRateMultipliers(id: string | number): Promise<{ message: string }> {
  const workerContract = isCloudflareWorkerContractActive()
  const { data } = await apiClient.delete<{ message: string; control_version?: number }>(
    `/admin/groups/${id}/rate-multipliers`,
    workerContract
      ? {
          data: { expected_control_version: requireGroupControlVersion(id) },
          headers: { 'Idempotency-Key': newControlOperationKey('admin-group-rate-clear') }
        }
      : undefined
  )
  if (workerContract && Number.isSafeInteger(data.control_version)) {
    groupControlVersions.set(String(id), data.control_version!)
  }
  return data
}

/**
 * Batch set rate multipliers for users in a group
 * Only touches rate_multiplier column; preserves rpm_override on existing rows.
 */
export async function batchSetGroupRateMultipliers(
  id: string | number,
  entries: Array<{ user_id: string | number; rate_multiplier: number }>
): Promise<{ message: string }> {
  const workerContract = isCloudflareWorkerContractActive()
  const { data } = await apiClient.put<{ message: string; control_version?: number }>(
    `/admin/groups/${id}/rate-multipliers`,
    workerContract
      ? {
          entries: entries.map((entry) => ({ ...entry, user_id: String(entry.user_id) })),
          expected_control_version: requireGroupControlVersion(id)
        }
      : { entries },
    workerContract
      ? { headers: { 'Idempotency-Key': newControlOperationKey('admin-group-rate-put') } }
      : undefined
  )
  if (workerContract && Number.isSafeInteger(data.control_version)) {
    groupControlVersions.set(String(id), data.control_version!)
  }
  return data
}

/**
 * RPM override entry for a user in a group
 */
export interface GroupRPMOverrideEntry {
  user_id: string | number
  user_name: string
  user_email: string
  user_notes: string
  user_status: string
  rpm_override: number
}

/**
 * Get RPM overrides for users in a group (subset of rate-multipliers endpoint).
 */
export async function getGroupRPMOverrides(id: number): Promise<GroupRPMOverrideEntry[]> {
  if (isCloudflareWorkerContractActive()) {
    const { data } = await apiClient.get<GroupRPMOverrideEntry[]>(
      `/admin/groups/${id}/rpm-overrides`
    )
    return data
  }
  const { data } = await apiClient.get<GroupRateMultiplierEntry[]>(
    `/admin/groups/${id}/rate-multipliers`
  )
  return data
    .filter(e => e.rpm_override != null)
    .map(e => ({
      user_id: e.user_id,
      user_name: e.user_name,
      user_email: e.user_email,
      user_notes: e.user_notes,
      user_status: e.user_status,
      rpm_override: e.rpm_override as number
    }))
}

/**
 * Batch set RPM overrides for users in a group.
 * Worker PUT replaces the group's complete override collection; an empty
 * collection clears it. The legacy endpoint still preserves rate_multiplier.
 */
export async function batchSetGroupRPMOverrides(
  id: string | number,
  entries: Array<{ user_id: string | number; rpm_override: number }>
): Promise<{ message: string }> {
  const workerContract = isCloudflareWorkerContractActive()
  const { data } = await apiClient.put<{ message: string }>(
    `/admin/groups/${id}/rpm-overrides`,
    {
      entries: workerContract
        ? entries.map((entry) => ({ ...entry, user_id: String(entry.user_id) }))
        : entries
    },
    workerContract
      ? { headers: { 'Idempotency-Key': newControlOperationKey('admin-group-rpm-put') } }
      : undefined
  )
  return data
}

/**
 * Clear all RPM overrides for a group (preserves rate_multiplier).
 */
export async function clearGroupRPMOverrides(id: string | number): Promise<{ message: string }> {
  const workerContract = isCloudflareWorkerContractActive()
  const { data } = await apiClient.delete<{ message: string }>(
    `/admin/groups/${id}/rpm-overrides`,
    workerContract
      ? { headers: { 'Idempotency-Key': newControlOperationKey('admin-group-rpm-clear') } }
      : undefined
  )
  return data
}

/**
 * Get usage summary (today + yesterday + cumulative cost) for all groups
 * @returns Array of group usage summaries
 */
export async function getUsageSummary(): Promise<
  { group_id: number; today_cost: number; yesterday_cost: number; total_cost: number }[]
> {
  const { data } = await apiClient.get<
    { group_id: number; today_cost: number; yesterday_cost: number; total_cost: number }[]
  >('/admin/groups/usage-summary')
  return data
}

/**
 * Get capacity summary (concurrency/sessions/RPM) for all active groups
 */
export async function getCapacitySummary(): Promise<
  { group_id: number | string; concurrency_status?: 'known' | 'unknown'; concurrency_used: number | null; concurrency_max: number; sessions_status?: 'known' | 'unknown'; sessions_used: number | null; sessions_max: number | null; rpm_status?: 'known' | 'unknown'; rpm_used: number | null; rpm_max: number | null }[]
> {
  const { data } = await apiClient.get<
    { group_id: number; concurrency_used: number; concurrency_max: number; sessions_used: number; sessions_max: number; rpm_used: number; rpm_max: number }[]
  >('/admin/groups/capacity-summary')
  return data
}

export const groupsAPI = {
  list,
  getAll,
  getByPlatform,
  getAllIncludingInactive,
  getLiveCapability,
  getById,
  getModelsListCandidates,
  create,
  duplicate,
  update,
  delete: deleteGroup,
  toggleStatus,
  getStats,
  getGroupApiKeys,
  listCompositeRoutes,
  createCompositeRoute,
  updateCompositeRoute,
  deleteCompositeRoute,
  previewCompositeRoute,
  getGroupRateMultipliers,
  clearGroupRateMultipliers,
  batchSetGroupRateMultipliers,
  getGroupRPMOverrides,
  clearGroupRPMOverrides,
  batchSetGroupRPMOverrides,
  updateSortOrder,
  getUsageSummary,
  getCapacitySummary
}

export default groupsAPI
