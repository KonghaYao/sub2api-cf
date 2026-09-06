/**
 * Admin operation audit log API.
 *
 * The audit log is admin-only (not exposed to end users). It records
 * management-plane operations with masked header credentials and redacted
 * request bodies. Entries cannot be deleted individually; the whole log can
 * only be cleared with a fresh TOTP verification.
 */

import { apiClient } from '../client'
import type { PaginatedResponse } from '@/types'

export interface AuditLog {
  id: number
  created_at: string
  actor_user_id?: string | number
  actor_email: string
  actor_role: string
  auth_method: 'jwt' | 'admin_api_key'
  credential_masked: string
  action: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  request_id: string
  client_ip: string
  user_agent: string
  request_body?: string
  status_code: number
  latency_ms: number
  extra?: Record<string, unknown>
}

export interface AuditLogQuery {
  page?: number
  page_size?: number
  start_time?: string
  end_time?: string
  actor_user_id?: string | number
  actor_email?: string
  auth_method?: string
  action?: string
  method?: string
  client_ip?: string
  success?: string
  q?: string
}

export type AuditLogListResponse = PaginatedResponse<AuditLog>

/** List audit logs (paginated, filterable). */
export async function list(params: AuditLogQuery): Promise<AuditLogListResponse> {
  const { data } = await apiClient.get('/admin/audit-logs', { params })
  return data
}

/** Get a single audit log entry (includes the redacted request body). */
export async function get(id: number): Promise<AuditLog> {
  const { data } = await apiClient.get(`/admin/audit-logs/${id}`)
  return data
}

/**
 * Clear all audit logs. The Worker currently returns the explicit
 * audit_log_clear_not_migrated error until fresh-TOTP deletion is implemented.
 */
export async function clear(totpCode: string): Promise<{ deleted: number }> {
  const { data } = await apiClient.post('/admin/audit-logs/clear', { totp_code: totpCode })
  return data
}

export const auditAPI = { list, get, clear }

export default auditAPI
