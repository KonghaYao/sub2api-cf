/**
 * Admin User Attributes API endpoints
 * Handles user custom attribute definitions and values
 */

import { apiClient } from '../client'
import { isCloudflareWorkerContractActive } from '@/utils/adminCapabilities'
import type {
  UserAttributeDefinition,
  UserAttributeValue,
  CreateUserAttributeRequest,
  UpdateUserAttributeRequest,
  UserAttributeValuesMap
} from '@/types'

export type UserAttributeId = string | number
export type UserAttributeUserId = string | number

function operationKey(scope: string, resourceId?: UserAttributeId): string {
  const requestId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return resourceId === undefined ? `${scope}-${requestId}` : `${scope}-${resourceId}-${requestId}`
}

function workerMutationHeaders(scope: string, controlVersion?: number) {
  if (controlVersion !== undefined && (!Number.isSafeInteger(controlVersion) || controlVersion < 0)) {
    throw new Error('A valid control version is required for this Worker mutation')
  }
  return {
    'Idempotency-Key': operationKey(scope),
    ...(controlVersion === undefined ? {} : { 'If-Match': `"${controlVersion}"` })
  }
}

function requireWorkerControlVersion(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Reload this resource before changing it: its Worker control version is unavailable')
  }
  return value
}

/**
 * Get all attribute definitions
 */
export async function listDefinitions(): Promise<UserAttributeDefinition[]> {
  const { data } = await apiClient.get<UserAttributeDefinition[]>('/admin/user-attributes')
  return data
}

/**
 * Get enabled attribute definitions only
 */
export async function listEnabledDefinitions(): Promise<UserAttributeDefinition[]> {
  const { data } = await apiClient.get<UserAttributeDefinition[]>('/admin/user-attributes', {
    params: { enabled: true }
  })
  return data
}

/**
 * Create a new attribute definition
 */
export async function createDefinition(
  request: CreateUserAttributeRequest
): Promise<UserAttributeDefinition> {
  const { data } = isCloudflareWorkerContractActive()
    ? await apiClient.post<UserAttributeDefinition>('/admin/user-attributes', request, {
      headers: workerMutationHeaders('admin-user-attribute-create')
    })
    : await apiClient.post<UserAttributeDefinition>('/admin/user-attributes', request)
  return data
}

/**
 * Update an attribute definition
 */
export async function updateDefinition(
  id: UserAttributeId,
  request: UpdateUserAttributeRequest,
  controlVersion?: number,
): Promise<UserAttributeDefinition> {
  const worker = isCloudflareWorkerContractActive()
  const expected = worker ? requireWorkerControlVersion(controlVersion) : undefined
  const { data } = worker
    ? await apiClient.put<UserAttributeDefinition>(`/admin/user-attributes/${id}`, {
      ...request, expected_control_version: expected
    }, { headers: workerMutationHeaders(`admin-user-attribute-update-${id}`, expected) })
    : await apiClient.put<UserAttributeDefinition>(`/admin/user-attributes/${id}`, request)
  return data
}

/**
 * Delete an attribute definition
 */
export async function deleteDefinition(id: UserAttributeId, controlVersion?: number): Promise<{ message: string }> {
  const worker = isCloudflareWorkerContractActive()
  const expected = worker ? requireWorkerControlVersion(controlVersion) : undefined
  const { data } = worker
    ? await apiClient.delete<{ message: string }>(`/admin/user-attributes/${id}`, {
      data: { expected_control_version: expected }, headers: workerMutationHeaders(`admin-user-attribute-delete-${id}`, expected)
    })
    : await apiClient.delete<{ message: string }>(`/admin/user-attributes/${id}`)
  return data
}

/**
 * Reorder attribute definitions
 */
export async function reorderDefinitions(ids: UserAttributeId[], controlVersion?: number): Promise<{ message: string }> {
  const worker = isCloudflareWorkerContractActive()
  const expected = worker ? requireWorkerControlVersion(controlVersion) : undefined
  const { data } = worker
    ? await apiClient.put<{ message: string }>('/admin/user-attributes/reorder', {
      ids, expected_control_version: expected
    }, { headers: workerMutationHeaders('admin-user-attribute-reorder', expected) })
    : await apiClient.put<{ message: string }>('/admin/user-attributes/reorder', { ids })
  return data
}

/**
 * Get user's attribute values
 */
export async function getUserAttributeValues(userId: UserAttributeUserId): Promise<UserAttributeValue[]> {
  const { data } = await apiClient.get<UserAttributeValue[]>(
    `/admin/users/${userId}/attributes`
  )
  return data
}

/**
 * Update user's attribute values (batch)
 */
export async function updateUserAttributeValues(
  userId: UserAttributeUserId,
  values: UserAttributeValuesMap,
  controlVersion?: number,
): Promise<{ message: string }> {
  const worker = isCloudflareWorkerContractActive()
  const expected = worker ? requireWorkerControlVersion(controlVersion) : undefined
  const { data } = worker
    ? await apiClient.put<{ message: string }>(`/admin/users/${userId}/attributes`, {
      values, expected_control_version: expected
    }, { headers: workerMutationHeaders(`admin-user-attribute-values-${userId}`, expected) })
    : await apiClient.put<{ message: string }>(`/admin/users/${userId}/attributes`, { values })
  return data
}

/**
 * Batch response type
 */
export interface BatchUserAttributesResponse {
  attributes: Record<string, Record<string, string>>
}

/**
 * Get attribute values for multiple users
 */
export async function getBatchUserAttributes(
  userIds: UserAttributeUserId[]
): Promise<BatchUserAttributesResponse> {
  const { data } = await apiClient.post<BatchUserAttributesResponse>(
    '/admin/user-attributes/batch',
    { user_ids: userIds }
  )
  return data
}

export const userAttributesAPI = {
  listDefinitions,
  listEnabledDefinitions,
  createDefinition,
  updateDefinition,
  deleteDefinition,
  reorderDefinitions,
  getUserAttributeValues,
  updateUserAttributeValues,
  getBatchUserAttributes
}

export default userAttributesAPI
