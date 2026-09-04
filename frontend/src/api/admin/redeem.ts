/**
 * Admin Redeem Codes API endpoints
 * Handles redeem code generation and management for administrators
 */

import { apiClient } from '../client'
import type {
  RedeemCode,
  GenerateRedeemCodesRequest,
  BatchUpdateRedeemCodeFields,
  RedeemCodeType,
  PaginatedResponse
} from '@/types'

type WorkerRedeemCode = RedeemCode & {
  id: string | number
  value_micros?: number
  control_version: number
}

const redeemCodeControlVersions = new Map<string, number>()
export const REDEEM_CODE_BATCH_LIMIT = 50

function rememberCode(code: RedeemCode): void {
  const worker = code as WorkerRedeemCode
  if (Number.isSafeInteger(worker.control_version) && worker.control_version >= 0) {
    redeemCodeControlVersions.set(String(worker.id), worker.control_version)
  }
}

function rememberCodes(codes: RedeemCode[]): void {
  codes.forEach(rememberCode)
}

function operationKey(scope: string): string {
  const requestID = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${scope}-${requestID}`
}

function requireControlVersion(id: string | number): number {
  const version = redeemCodeControlVersions.get(String(id))
  if (version === undefined) {
    throw Object.assign(new Error('Reload this redeem code before changing it'), {
      code: 'redeem_code_version_not_loaded'
    })
  }
  return version
}

function usdToMicros(value: number): number {
  const micros = Math.round(value * 1_000_000)
  if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(micros)) {
    throw Object.assign(new Error('value must be a positive amount representable in USD micros'), {
      code: 'invalid_redeem_code_value'
    })
  }
  return micros
}

/**
 * List all redeem codes with pagination
 * @param page - Page number (default: 1)
 * @param pageSize - Items per page (default: 20)
 * @param filters - Optional filters
 * @returns Paginated list of redeem codes
 */
export async function list(
  page: number = 1,
  pageSize: number = 20,
  filters?: {
    type?: RedeemCodeType
    status?: 'active' | 'used' | 'expired' | 'unused' | 'disabled'
    search?: string
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  },
  options?: {
    signal?: AbortSignal
  }
): Promise<PaginatedResponse<RedeemCode>> {
  const { data } = await apiClient.get<PaginatedResponse<RedeemCode>>('/admin/redeem-codes', {
    params: {
      page,
      page_size: pageSize,
      ...filters
    },
    signal: options?.signal
  })
  rememberCodes(data.items)
  return data
}

/**
 * Get redeem code by ID
 * @param id - Redeem code ID
 * @returns Redeem code details
 */
export async function getById(id: string | number): Promise<RedeemCode> {
  const { data } = await apiClient.get<RedeemCode>(`/admin/redeem-codes/${id}`)
  rememberCode(data)
  return data
}

/**
 * Generate new redeem codes
 * @param count - Number of codes to generate
 * @param type - Type of redeem code
 * @param value - Value of the code
 * @param groupId - Group ID (required for subscription type)
 * @param validityDays - Validity days (for subscription type)
 * @param expiresInDays - Days before the code itself expires
 * @returns Array of generated redeem codes
 */
export async function generate(
  count: number,
  type: RedeemCodeType,
  value: number,
  groupId?: string | number | null,
  validityDays?: number,
  expiresInDays?: number | null
): Promise<RedeemCode[]> {
  if (type !== 'balance' && type !== 'subscription') {
    throw Object.assign(
      new Error('Cloudflare Worker supports only balance and subscription redeem codes'),
      { code: 'unsupported_redeem_code_type' }
    )
  }
  const payload: GenerateRedeemCodesRequest & { value_micros: number } = {
    count,
    type,
    value_micros: type === 'balance' ? usdToMicros(value) : 0
  }

  // 订阅类型专用字段
  if (type === 'subscription') {
    if (groupId === null || groupId === undefined || String(groupId).trim() === '') {
      throw Object.assign(new Error('group_id is required for subscription redeem codes'), {
        code: 'invalid_group_id'
      })
    }
    payload.group_id = String(groupId)
    if (validityDays && validityDays > 0) {
      payload.validity_days = validityDays
    }
  }
  if (expiresInDays && expiresInDays > 0) {
    payload.expires_in_days = expiresInDays
  }

  const { data } = await apiClient.post<RedeemCode[]>('/admin/redeem-codes/generate', payload, {
    headers: { 'Idempotency-Key': operationKey('admin-redeem-generate') }
  })
  rememberCodes(data)
  return data
}

/**
 * Delete redeem code
 * @param id - Redeem code ID
 * @returns Success confirmation
 */
export async function deleteCode(id: string | number): Promise<{
  id: string
  deleted: number
  message: string
}> {
  const version = requireControlVersion(id)
  const { data } = await apiClient.delete<{
    id: string
    deleted: number
    message: string
  }>(`/admin/redeem-codes/${id}`, {
    headers: {
      'Idempotency-Key': operationKey('admin-redeem-delete'),
      'If-Match': `"${version}"`
    }
  })
  redeemCodeControlVersions.delete(String(id))
  return data
}

/**
 * Batch delete redeem codes
 * @param ids - Array of redeem code IDs
 * @returns Success confirmation
 */
export async function batchDelete(ids: Array<string | number>): Promise<{
  deleted: number
  message: string
}> {
  requireBatchSize(ids)
  const workerIDs = ids.map(String)
  const expected_control_versions = Object.fromEntries(
    workerIDs.map((id) => [id, requireControlVersion(id)])
  )
  const { data } = await apiClient.post<{
    deleted: number
    message: string
  }>('/admin/redeem-codes/batch-delete', { ids: workerIDs, expected_control_versions }, {
    headers: { 'Idempotency-Key': operationKey('admin-redeem-batch-delete') }
  })
  workerIDs.forEach((id) => redeemCodeControlVersions.delete(id))
  return data
}

/**
 * Batch update selected redeem code fields
 * @param ids - Array of redeem code IDs
 * @param fields - Field collection to update
 * @returns Updated count
 */
export async function batchUpdate(
  ids: Array<string | number>,
  fields: BatchUpdateRedeemCodeFields
): Promise<{
  updated: number
  message: string
}> {
  requireBatchSize(ids)
  if (fields.status !== undefined) {
    throw Object.assign(new Error('Redeem code status cannot be batch updated on Cloudflare Worker'), {
      code: 'unsupported_redeem_code_batch_status'
    })
  }
  if (fields.group_id === null) {
    throw Object.assign(new Error('Subscription group cannot be cleared from a redeem code'), {
      code: 'invalid_group_id'
    })
  }
  const workerIDs = ids.map(String)
  const expected_control_versions = Object.fromEntries(
    workerIDs.map((id) => [id, requireControlVersion(id)])
  )
  const workerFields = {
    ...fields,
    ...(fields.group_id === undefined ? {} : { group_id: String(fields.group_id) })
  }
  const { data } = await apiClient.post<{
    updated: number
    message: string
  }>('/admin/redeem-codes/batch-update', {
    ids: workerIDs,
    expected_control_versions,
    fields: workerFields
  }, {
    headers: { 'Idempotency-Key': operationKey('admin-redeem-batch-update') }
  })
  workerIDs.forEach((id) => {
    redeemCodeControlVersions.set(id, expected_control_versions[id] + 1)
  })
  return data
}

function requireBatchSize(ids: Array<string | number>): void {
  if (ids.length < 1 || ids.length > REDEEM_CODE_BATCH_LIMIT) {
    throw Object.assign(
      new Error(`Select between 1 and ${REDEEM_CODE_BATCH_LIMIT} redeem codes per batch`),
      { code: 'invalid_redeem_code_batch_size' }
    )
  }
}

/**
 * Expire redeem code
 * @param id - Redeem code ID
 * @returns Updated redeem code
 */
export async function expire(id: string | number): Promise<RedeemCode> {
  const version = requireControlVersion(id)
  const { data } = await apiClient.post<RedeemCode>(`/admin/redeem-codes/${id}/expire`, {}, {
    headers: {
      'Idempotency-Key': operationKey('admin-redeem-expire'),
      'If-Match': `"${version}"`
    }
  })
  rememberCode(data)
  return data
}

/**
 * Get redeem code statistics
 * @returns Statistics about redeem codes
 */
export async function getStats(): Promise<{
  total_codes: number
  active_codes: number
  used_codes: number
  expired_codes: number
  total_value_distributed: number
  by_type: Partial<Record<RedeemCodeType, number>>
}> {
  const { data } = await apiClient.get<{
    total_codes: number
    active_codes: number
    used_codes: number
    expired_codes: number
    total_value_distributed: number
    by_type: Partial<Record<RedeemCodeType, number>>
  }>('/admin/redeem-codes/stats')
  return data
}

export const redeemAPI = {
  list,
  getById,
  generate,
  delete: deleteCode,
  batchDelete,
  batchUpdate,
  expire,
  getStats
}

export default redeemAPI
