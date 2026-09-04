/**
 * Redeem code API endpoints
 * Handles redeem code redemption for users
 */

import { apiClient } from './client'
import type { RedeemCodeRequest } from '@/types'

export interface RedeemHistoryItem {
  id: string | number
  code: string
  type: string
  value: number
  status: string
  used_at: string | null
  created_at: string
  // Notes from admin for admin_balance/admin_concurrency types
  notes?: string
  // Subscription-specific fields
  group_id?: string | number
  validity_days?: number
  group?: {
    id: string | number
    name: string
  }
}

interface PendingRedeemOperation {
  idempotencyKey: string
  createdAt: number
}

const PENDING_OPERATION_TTL_MS = 15 * 60_000
const pendingRedeemOperations = new Map<string, PendingRedeemOperation>()

function normalizedCode(code: string): string {
  return code.trim().toUpperCase()
}

function operationFor(code: string): PendingRedeemOperation {
  const now = Date.now()
  for (const [candidate, operation] of pendingRedeemOperations) {
    if (operation.createdAt + PENDING_OPERATION_TTL_MS <= now) {
      pendingRedeemOperations.delete(candidate)
    }
  }
  const existing = pendingRedeemOperations.get(code)
  if (existing) return existing
  const requestID = globalThis.crypto?.randomUUID?.()
    ?? `${now}-${Math.random().toString(36).slice(2)}`
  const operation = {
    idempotencyKey: `user-redeem-${requestID}`,
    createdAt: now
  }
  pendingRedeemOperations.set(code, operation)
  return operation
}

function isDefinitiveClientFailure(error: unknown): boolean {
  const candidate = error as {
    status?: unknown
    response?: { status?: unknown }
  } | null
  const status = candidate?.status ?? candidate?.response?.status
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429
}

/**
 * Redeem a code
 * @param code - Redeem code string
 * @returns Redemption result with updated balance or concurrency
 */
export async function redeem(code: string): Promise<{
  message: string
  type: string
  value: number
  new_balance?: number
  new_concurrency?: number
}> {
  const normalized = normalizedCode(code)
  const payload: RedeemCodeRequest = { code: normalized }
  const operation = operationFor(normalized)

  try {
    const { data } = await apiClient.post<{
      message: string
      type: string
      value: number
      new_balance?: number
      new_concurrency?: number
    }>('/redeem', payload, {
      headers: { 'Idempotency-Key': operation.idempotencyKey }
    })
    pendingRedeemOperations.delete(normalized)
    return data
  } catch (error) {
    // Keep the key after an ambiguous transport/server failure so an explicit
    // retry resumes the same financial operation instead of starting another.
    if (isDefinitiveClientFailure(error)) pendingRedeemOperations.delete(normalized)
    throw error
  }
}

/**
 * Get user's redemption history
 * @returns List of redeemed codes
 */
export async function getHistory(): Promise<RedeemHistoryItem[]> {
  const { data } = await apiClient.get<RedeemHistoryItem[]>('/redeem/history')
  return data
}

export const redeemAPI = {
  redeem,
  getHistory
}

export default redeemAPI
