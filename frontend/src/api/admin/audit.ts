/** Worker-native, read-only administrative audit event API. */

import { apiClient } from '../client'

export type AuditCategory = 'settings' | 'rbac' | 'auth' | 'payment'
export type AuditOutcome = 'succeeded' | 'failed' | 'blocked' | 'recorded'

export interface AuditLog {
  category: AuditCategory
  event_id: string
  action: string
  outcome: AuditOutcome
  actor_user_id: string | null
  actor_session_id_masked: string | null
  origin: string
  resource_type: string
  resource_id: string
  resource_version: number | null
  occurred_at_ms: number
  occurred_at: string
  metadata?: Record<string, unknown>
}

export interface AuditLogQuery {
  limit?: number
  cursor?: string
  category?: AuditCategory
  action?: string
  outcome?: AuditOutcome
  actor_user_id?: string
  resource_type?: string
  resource_id?: string
  start_time?: string
  end_time?: string
}

export interface AuditLogListResponse {
  items: AuditLog[]
  has_more: boolean
  next_cursor: string | null
}

export async function list(params: AuditLogQuery = {}): Promise<AuditLogListResponse> {
  const { data } = await apiClient.get<AuditLogListResponse>('/admin/audit/events', { params })
  return data
}

export async function get(category: AuditCategory, eventId: string): Promise<AuditLog> {
  const { data } = await apiClient.get<AuditLog>(
    `/admin/audit/events/${encodeURIComponent(category)}/${encodeURIComponent(eventId)}`
  )
  return data
}

export const auditAPI = { list, get }

export default auditAPI
