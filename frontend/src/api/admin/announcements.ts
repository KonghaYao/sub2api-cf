/**
 * Admin Announcements API endpoints
 */

import { apiClient } from '../client'
import type {
  Announcement,
  AnnouncementUserReadStatus,
  BasePaginationResponse,
  CreateAnnouncementRequest,
  UpdateAnnouncementRequest
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
): Promise<BasePaginationResponse<Announcement>> {
  const { data } = await apiClient.get<BasePaginationResponse<Announcement>>('/admin/announcements', {
    params: { page, page_size: pageSize, ...filters },
    signal: options?.signal
  })
  return data
}

type AnnouncementId = string | number

function mutationHeaders(action: string, id?: AnnouncementId, version?: number) {
  const suffix = id === undefined ? '' : `-${id}`
  return {
    'Idempotency-Key': `admin-announcement-${action}${suffix}-${crypto.randomUUID()}`,
    ...(version === undefined ? {} : { 'If-Match': `"${version}"` })
  }
}

export async function getById(id: AnnouncementId): Promise<Announcement> {
  const { data } = await apiClient.get<Announcement>(`/admin/announcements/${id}`)
  return data
}

export async function create(request: CreateAnnouncementRequest): Promise<Announcement> {
  const { data } = await apiClient.post<Announcement>('/admin/announcements', request, {
    headers: mutationHeaders('create')
  })
  return data
}

export async function update(
  id: AnnouncementId,
  request: UpdateAnnouncementRequest,
  expectedControlVersion: number
): Promise<Announcement> {
  const { data } = await apiClient.put<Announcement>(`/admin/announcements/${id}`, {
    ...request,
    expected_control_version: expectedControlVersion
  }, {
    headers: mutationHeaders('update', id, expectedControlVersion)
  })
  return data
}

export async function deleteAnnouncement(
  id: AnnouncementId,
  expectedControlVersion: number
): Promise<{ message: string }> {
  const { data } = await apiClient.delete<{ message: string }>(`/admin/announcements/${id}`, {
    headers: mutationHeaders('delete', id, expectedControlVersion)
  })
  return data
}

export async function getReadStatus(
  id: AnnouncementId,
  page: number = 1,
  pageSize: number = 20,
  filters?: {
    search?: string
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  },
  options?: {
    signal?: AbortSignal
  }
): Promise<BasePaginationResponse<AnnouncementUserReadStatus>> {
  const { data } = await apiClient.get<BasePaginationResponse<AnnouncementUserReadStatus>>(
    `/admin/announcements/${id}/read-status`,
    {
      params: { page, page_size: pageSize, ...filters },
      signal: options?.signal
    }
  )
  return data
}

const announcementsAPI = {
  list,
  getById,
  create,
  update,
  delete: deleteAnnouncement,
  getReadStatus
}

export default announcementsAPI
