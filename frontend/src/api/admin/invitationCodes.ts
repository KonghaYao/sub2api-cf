import { apiClient } from '../client'

export type InvitationCodeStatus = 'active' | 'disabled'

export interface InvitationCode {
  id: string
  code: string
  max_uses: number
  used_count: number
  status: InvitationCodeStatus
  expires_at: string | null
  notes: string | null
  control_version: number
  created_at: string
  updated_at: string
}

export interface InvitationCodeUsage {
  id: string
  invitation_code_id: string
  user_id: string
  used_at: string
  user: {
    id: string
    email: string
    username: string | null
  }
}

export interface InvitationCodeListResponse {
  items: InvitationCode[]
  total: number
  page: number
  page_size: number
  pages: number
}

export interface InvitationCodeUsageListResponse {
  items: InvitationCodeUsage[]
  total: number
  page: number
  page_size: number
  pages: number
}

export interface CreateInvitationCodeInput {
  code?: string
  max_uses?: number
  expires_at?: number | null
  notes?: string
}

export interface UpdateInvitationCodeInput {
  code?: string
  max_uses?: number
  status?: InvitationCodeStatus
  expires_at?: number | null
  notes?: string
}

function idempotencyKey(scope: string): string {
  const requestId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${scope}-${requestId}`
}

export async function listInvitationCodes(params: {
  page?: number
  page_size?: number
  status?: InvitationCodeStatus
  search?: string
} = {}): Promise<InvitationCodeListResponse> {
  const { data } = await apiClient.get<InvitationCodeListResponse>('/admin/invitation-codes', {
    params,
  })
  return data
}

export async function getInvitationCode(id: string): Promise<InvitationCode> {
  const { data } = await apiClient.get<InvitationCode>(`/admin/invitation-codes/${id}`)
  return data
}

export async function createInvitationCode(
  input: CreateInvitationCodeInput,
): Promise<InvitationCode> {
  const { data } = await apiClient.post<InvitationCode>('/admin/invitation-codes', input, {
    headers: { 'Idempotency-Key': idempotencyKey('admin-invitation-code-create') },
  })
  return data
}

export async function updateInvitationCode(
  id: string,
  expectedControlVersion: number,
  input: UpdateInvitationCodeInput,
): Promise<InvitationCode> {
  const { data } = await apiClient.put<InvitationCode>(
    `/admin/invitation-codes/${id}`,
    { ...input, expected_control_version: expectedControlVersion },
    {
      headers: {
        'If-Match': `"${expectedControlVersion}"`,
        'Idempotency-Key': idempotencyKey(`admin-invitation-code-update-${id}`),
      },
    },
  )
  return data
}

export async function deleteInvitationCode(
  id: string,
  expectedControlVersion: number,
): Promise<{ message: string }> {
  const { data } = await apiClient.delete<{ message: string }>(
    `/admin/invitation-codes/${id}`,
    {
      data: { expected_control_version: expectedControlVersion },
      headers: {
        'If-Match': `"${expectedControlVersion}"`,
        'Idempotency-Key': idempotencyKey(`admin-invitation-code-delete-${id}`),
      },
    },
  )
  return data
}

export async function listInvitationCodeUsages(
  id: string,
  params: { page?: number; page_size?: number } = {},
): Promise<InvitationCodeUsageListResponse> {
  const { data } = await apiClient.get<InvitationCodeUsageListResponse>(
    `/admin/invitation-codes/${id}/usages`,
    { params },
  )
  return data
}

export const invitationCodesAPI = {
  list: listInvitationCodes,
  get: getInvitationCode,
  create: createInvitationCode,
  update: updateInvitationCode,
  delete: deleteInvitationCode,
  listUsages: listInvitationCodeUsages,
}

export default invitationCodesAPI
