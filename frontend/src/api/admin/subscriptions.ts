/**
 * Admin Subscriptions API endpoints
 * Handles user subscription management for administrators
 */

import { apiClient } from '../client'
import type {
  UserSubscription,
  SubscriptionProgress,
  AssignSubscriptionRequest,
  BulkAssignSubscriptionRequest,
  ExtendSubscriptionRequest,
  PaginatedResponse
} from '@/types'

type WorkerSubscription = UserSubscription & { control_version?: number }

export interface BulkAssignSubscriptionResult {
  success_count: number
  created_count: number
  reused_count: number
  failed_count: number
  subscriptions: UserSubscription[]
  errors: string[]
  statuses?: Record<string, 'created' | 'reused' | 'failed'>
}

const subscriptionControlVersions = new Map<string, number>()
const pendingOperationKeys = new Map<string, string>()

function rememberSubscription(subscription: WorkerSubscription): void {
  if (
    Number.isSafeInteger(subscription.control_version) &&
    subscription.control_version! >= 0
  ) {
    subscriptionControlVersions.set(String(subscription.id), subscription.control_version!)
  }
}

function rememberSubscriptions(subscriptions: WorkerSubscription[]): void {
  subscriptions.forEach(rememberSubscription)
}

function requireSubscriptionControlVersion(id: string | number): number {
  const version = subscriptionControlVersions.get(String(id))
  if (version === undefined) {
    throw Object.assign(
      new Error('Reload this subscription before changing it'),
      { code: 'subscription_version_not_loaded' }
    )
  }
  return version
}

function operationKey(scope: string, target: string): { cacheKey: string; value: string } {
  const cacheKey = `${scope}:${target}`
  const existing = pendingOperationKeys.get(cacheKey)
  if (existing) return { cacheKey, value: existing }
  const requestID = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const value = `${scope}-${requestID}`
  pendingOperationKeys.set(cacheKey, value)
  return { cacheKey, value }
}

function completeOperation(cacheKey: string): void {
  pendingOperationKeys.delete(cacheKey)
}

/**
 * List all subscriptions with pagination
 * @param page - Page number (default: 1)
 * @param pageSize - Items per page (default: 20)
 * @param filters - Optional filters (status, user_id, group_id, sort_by, sort_order)
 * @returns Paginated list of subscriptions
 */
export async function list(
  page: number = 1,
  pageSize: number = 20,
  filters?: {
    status?: 'active' | 'expired' | 'revoked' | 'suspended'
    user_id?: string | number
    group_id?: string | number
    platform?: string
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  },
  options?: {
    signal?: AbortSignal
  }
): Promise<PaginatedResponse<UserSubscription>> {
  const { data } = await apiClient.get<PaginatedResponse<WorkerSubscription>>(
    '/admin/subscriptions',
    {
      params: {
        page,
        page_size: pageSize,
        ...filters
      },
      signal: options?.signal
    }
  )
  rememberSubscriptions(data.items)
  return data
}

/**
 * Get subscription by ID
 * @param id - Subscription ID
 * @returns Subscription details
 */
export async function getById(id: string | number): Promise<UserSubscription> {
  const { data } = await apiClient.get<WorkerSubscription>(`/admin/subscriptions/${id}`)
  rememberSubscription(data)
  return data
}

/**
 * Get subscription progress
 * @param id - Subscription ID
 * @returns Subscription progress with usage stats
 */
export async function getProgress(id: string | number): Promise<SubscriptionProgress> {
  const { data } = await apiClient.get<SubscriptionProgress>(`/admin/subscriptions/${id}/progress`)
  return data
}

/**
 * Assign subscription to user
 * @param request - Assignment request
 * @returns Created subscription
 */
export async function assign(request: AssignSubscriptionRequest): Promise<UserSubscription> {
  const operation = operationKey(
    'admin-subscription-assign',
    `${request.user_id}:${request.group_id}`
  )
  const { data } = await apiClient.post<WorkerSubscription>(
    '/admin/subscriptions/assign',
    request,
    { headers: { 'Idempotency-Key': operation.value } }
  )
  rememberSubscription(data)
  completeOperation(operation.cacheKey)
  return data
}

/**
 * Bulk assign subscriptions to multiple users
 * @param request - Bulk assignment request
 * @returns Created subscriptions
 */
export async function bulkAssign(
  request: BulkAssignSubscriptionRequest
): Promise<BulkAssignSubscriptionResult> {
  const operation = operationKey(
    'admin-subscription-bulk-assign',
    `${request.group_id}:${request.user_ids.map(String).sort().join(',')}`
  )
  const { data } = await apiClient.post<BulkAssignSubscriptionResult>(
    '/admin/subscriptions/bulk-assign',
    request,
    { headers: { 'Idempotency-Key': operation.value } }
  )
  rememberSubscriptions(data.subscriptions)
  completeOperation(operation.cacheKey)
  return data
}

/**
 * Extend subscription validity
 * @param id - Subscription ID
 * @param request - Extension request with days
 * @returns Updated subscription
 */
export async function extend(
  id: string | number,
  request: ExtendSubscriptionRequest
): Promise<UserSubscription> {
  const expected = requireSubscriptionControlVersion(id)
  const operation = operationKey('admin-subscription-extend', String(id))
  const { data } = await apiClient.post<WorkerSubscription>(
    `/admin/subscriptions/${id}/extend`,
    { ...request, expected_control_version: expected },
    {
      headers: {
        'Idempotency-Key': operation.value,
        'If-Match': `"${expected}"`
      }
    }
  )
  rememberSubscription(data)
  completeOperation(operation.cacheKey)
  return data
}

/**
 * Revoke subscription
 * @param id - Subscription ID
 * @returns Success confirmation
 */
export async function revoke(id: string | number): Promise<{ message: string }> {
  const expected = requireSubscriptionControlVersion(id)
  const operation = operationKey('admin-subscription-revoke', String(id))
  const { data } = await apiClient.post<{ message: string }>(
    `/admin/subscriptions/${id}/revoke`,
    { expected_control_version: expected },
    {
      headers: {
        'Idempotency-Key': operation.value,
        'If-Match': `"${expected}"`
      }
    }
  )
  subscriptionControlVersions.set(String(id), expected + 1)
  completeOperation(operation.cacheKey)
  return data
}

/**
 * Restore revoked subscription
 * @param id - Subscription ID
 * @returns Restored subscription
 */
export async function restore(id: string | number): Promise<UserSubscription> {
  const expected = requireSubscriptionControlVersion(id)
  const operation = operationKey('admin-subscription-restore', String(id))
  const { data } = await apiClient.post<WorkerSubscription>(
    `/admin/subscriptions/${id}/restore`,
    { expected_control_version: expected },
    {
      headers: {
        'Idempotency-Key': operation.value,
        'If-Match': `"${expected}"`
      }
    }
  )
  rememberSubscription(data)
  completeOperation(operation.cacheKey)
  return data
}

/**
 * Reset daily, weekly, and/or monthly usage quota for a subscription
 * @param id - Subscription ID
 * @param options - Which windows to reset
 * @returns Updated subscription
 */
export async function resetQuota(
  id: string | number,
  options: { daily: boolean; weekly: boolean; monthly: boolean }
): Promise<UserSubscription> {
  const expected = requireSubscriptionControlVersion(id)
  const operation = operationKey('admin-subscription-reset-quota', String(id))
  const { data } = await apiClient.post<WorkerSubscription>(
    `/admin/subscriptions/${id}/reset-quota`,
    { ...options, expected_control_version: expected },
    {
      headers: {
        'Idempotency-Key': operation.value,
        'If-Match': `"${expected}"`
      }
    }
  )
  rememberSubscription(data)
  completeOperation(operation.cacheKey)
  return data
}

/**
 * List subscriptions by group
 * @param groupId - Group ID
 * @param page - Page number
 * @param pageSize - Items per page
 * @returns Paginated list of subscriptions in the group
 */
export async function listByGroup(
  groupId: string | number,
  page: number = 1,
  pageSize: number = 20
): Promise<PaginatedResponse<UserSubscription>> {
  const { data } = await apiClient.get<PaginatedResponse<WorkerSubscription>>(
    `/admin/groups/${groupId}/subscriptions`,
    {
      params: { page, page_size: pageSize }
    }
  )
  rememberSubscriptions(data.items)
  return data
}

/**
 * List subscriptions by user
 * @param userId - User ID
 * @param page - Page number
 * @param pageSize - Items per page
 * @returns Paginated list of user's subscriptions
 */
export async function listByUser(
  userId: string | number,
  page: number = 1,
  pageSize: number = 20
): Promise<PaginatedResponse<UserSubscription>> {
  const { data } = await apiClient.get<PaginatedResponse<WorkerSubscription>>(
    `/admin/users/${userId}/subscriptions`,
    {
      params: { page, page_size: pageSize }
    }
  )
  rememberSubscriptions(data.items)
  return data
}

export const subscriptionsAPI = {
  list,
  getById,
  getProgress,
  assign,
  bulkAssign,
  extend,
  revoke,
  restore,
  resetQuota,
  listByGroup,
  listByUser
}

export default subscriptionsAPI
