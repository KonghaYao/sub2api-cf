/**
 * Admin API Keys API endpoints
 * Handles API key management for administrators
 */

import { apiClient } from '../client'
import type { ApiKey } from '@/types'

function operationKey(scope: string, resourceId: string | number): string {
  const requestId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${scope}-${resourceId}-${requestId}`
}

export interface UpdateApiKeyGroupResult {
  api_key: ApiKey
  auto_granted_group_access: boolean
  granted_group_id?: string | number
  granted_group_name?: string
}

/**
 * Update an API key's group binding
 * @param id - API Key ID
 * @param groupId - Group UUID, or null to request unbinding on compatible backends
 * @returns Updated API key with auto-grant info
 */
export async function updateApiKeyGroup(
  id: string | number,
  groupId: string | number | null
): Promise<UpdateApiKeyGroupResult> {
  const { data } = await apiClient.put<UpdateApiKeyGroupResult>(
    `/admin/api-keys/${id}`,
    { group_id: groupId },
    { headers: { 'Idempotency-Key': operationKey('admin-api-key-group', id) } }
  )
  return data
}

export async function revokeApiKey(id: string | number): Promise<ApiKey> {
  const { data } = await apiClient.delete<ApiKey>(`/admin/api-keys/${id}`, {
    headers: { 'Idempotency-Key': operationKey('admin-api-key-revoke', id) },
  })
  return data
}

export const apiKeysAPI = {
  updateApiKeyGroup,
  revokeApiKey,
}

export default apiKeysAPI
