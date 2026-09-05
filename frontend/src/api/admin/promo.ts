/**
 * Admin Promo Codes API endpoints
 */

import { apiClient } from '../client'
import type {
  PromoCode,
  PromoCodeUsage,
  CreatePromoCodeRequest,
  UpdatePromoCodeRequest,
  BasePaginationResponse
} from '@/types'

export async function list(
  page: number = 1,
  pageSize: number = 20,
  filters?: {
    status?: string
    search?: string
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  },
  options?: {
    signal?: AbortSignal
  }
): Promise<BasePaginationResponse<PromoCode>> {
  const { data } = await apiClient.get<BasePaginationResponse<PromoCode>>('/admin/promo-codes', {
    params: { page, page_size: pageSize, ...filters },
    signal: options?.signal
  })
  return data
}

function mutationHeaders(scope: string, controlVersion?: number) {
  return {
    'Idempotency-Key': `${scope}-${globalThis.crypto.randomUUID()}`,
    ...(controlVersion === undefined ? {} : { 'If-Match': `"${controlVersion}"` }),
  }
}

export async function getById(id: string | number): Promise<PromoCode> {
  const { data } = await apiClient.get<PromoCode>(`/admin/promo-codes/${id}`)
  return data
}

export async function create(request: CreatePromoCodeRequest): Promise<PromoCode> {
  const { data } = await apiClient.post<PromoCode>('/admin/promo-codes', request, {
    headers: mutationHeaders('admin-promo-create'),
  })
  return data
}

export async function update(id: string | number, request: UpdatePromoCodeRequest): Promise<PromoCode> {
  const { data } = await apiClient.put<PromoCode>(`/admin/promo-codes/${id}`, request, {
    headers: mutationHeaders(`admin-promo-update-${id}`, request.expected_control_version),
  })
  return data
}

export async function deleteCode(
  id: string | number,
  controlVersion?: number,
): Promise<{ message: string }> {
  const { data } = await apiClient.delete<{ message: string }>(`/admin/promo-codes/${id}`, {
    headers: mutationHeaders(`admin-promo-delete-${id}`, controlVersion),
  })
  return data
}

export async function getUsages(
  id: string | number,
  page: number = 1,
  pageSize: number = 20
): Promise<BasePaginationResponse<PromoCodeUsage>> {
  const { data } = await apiClient.get<BasePaginationResponse<PromoCodeUsage>>(
    `/admin/promo-codes/${id}/usages`,
    { params: { page, page_size: pageSize } }
  )
  return data
}

const promoAPI = {
  list,
  getById,
  create,
  update,
  delete: deleteCode,
  getUsages
}

export default promoAPI
