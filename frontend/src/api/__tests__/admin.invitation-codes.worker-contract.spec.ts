import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post, put, del } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiClient: { get, post, put, delete: del },
}))

describe('admin invitation-code Worker contract', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
    put.mockReset()
    del.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '44444444-4444-4444-8444-444444444444',
    )
  })

  it('lists and reads usages with opaque UUID resources', async () => {
    get
      .mockResolvedValueOnce({ data: { items: [], total: 0, page: 2, page_size: 10, pages: 0 } })
      .mockResolvedValueOnce({ data: { items: [], total: 0, page: 1, page_size: 20, pages: 0 } })
    const invitationCodes = await import('@/api/admin/invitationCodes')

    await invitationCodes.listInvitationCodes({
      page: 2,
      page_size: 10,
      status: 'active',
      search: 'TEAM',
    })
    await invitationCodes.listInvitationCodeUsages('invite-uuid', { page: 1, page_size: 20 })

    expect(get).toHaveBeenNthCalledWith(1, '/admin/invitation-codes', {
      params: { page: 2, page_size: 10, status: 'active', search: 'TEAM' },
    })
    expect(get).toHaveBeenNthCalledWith(
      2,
      '/admin/invitation-codes/invite-uuid/usages',
      { params: { page: 1, page_size: 20 } },
    )
  })

  it('sends idempotency and CAS metadata for create, update, and delete', async () => {
    const code = {
      id: 'invite-uuid',
      code: 'TEAM-2026',
      max_uses: 5,
      used_count: 0,
      status: 'active' as const,
      expires_at: null,
      notes: null,
      control_version: 0,
      created_at: '2026-09-05T00:00:00.000Z',
      updated_at: '2026-09-05T00:00:00.000Z',
    }
    post.mockResolvedValueOnce({ data: code })
    put.mockResolvedValueOnce({ data: { ...code, status: 'disabled', control_version: 1 } })
    del.mockResolvedValueOnce({ data: { message: 'Invitation code deleted successfully' } })
    const invitationCodes = await import('@/api/admin/invitationCodes')

    await invitationCodes.createInvitationCode({ code: 'TEAM-2026', max_uses: 5 })
    await invitationCodes.updateInvitationCode('invite-uuid', 0, { status: 'disabled' })
    await invitationCodes.deleteInvitationCode('invite-uuid', 1)

    expect(post).toHaveBeenCalledWith(
      '/admin/invitation-codes',
      { code: 'TEAM-2026', max_uses: 5 },
      {
        headers: {
          'Idempotency-Key': 'admin-invitation-code-create-44444444-4444-4444-8444-444444444444',
        },
      },
    )
    expect(put).toHaveBeenCalledWith(
      '/admin/invitation-codes/invite-uuid',
      { status: 'disabled', expected_control_version: 0 },
      {
        headers: {
          'Idempotency-Key': 'admin-invitation-code-update-invite-uuid-44444444-4444-4444-8444-444444444444',
          'If-Match': '"0"',
        },
      },
    )
    expect(del).toHaveBeenCalledWith('/admin/invitation-codes/invite-uuid', {
      data: { expected_control_version: 1 },
      headers: {
        'Idempotency-Key': 'admin-invitation-code-delete-invite-uuid-44444444-4444-4444-8444-444444444444',
        'If-Match': '"1"',
      },
    })
  })
})
