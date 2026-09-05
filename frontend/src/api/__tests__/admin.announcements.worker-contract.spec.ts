import { beforeEach, describe, expect, it, vi } from 'vitest'

const { post, put, del } = vi.hoisted(() => ({
  post: vi.fn(), put: vi.fn(), del: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiClient: { post, put, delete: del },
}))

describe('admin announcement Worker mutation contract', () => {
  beforeEach(() => {
    post.mockReset()
    put.mockReset()
    del.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '55555555-5555-4555-8555-555555555555',
    )
  })

  it('sends idempotency keys and CAS versions for mutations', async () => {
    post.mockResolvedValueOnce({ data: { id: 'announcement-1', control_version: 1 } })
    put.mockResolvedValueOnce({ data: { id: 'announcement-1', control_version: 2 } })
    del.mockResolvedValueOnce({ data: { message: 'ok' } })
    const announcements = await import('@/api/admin/announcements')
    const payload = {
      title: 'Notice', content: 'Content', targeting: { any_of: [] },
    }

    await announcements.create(payload)
    await announcements.update('announcement-1', { title: 'Updated' }, 1)
    await announcements.deleteAnnouncement('announcement-1', 2)

    expect(post).toHaveBeenCalledWith('/admin/announcements', payload, {
      headers: {
        'Idempotency-Key': 'admin-announcement-create-55555555-5555-4555-8555-555555555555',
      },
    })
    expect(put).toHaveBeenCalledWith('/admin/announcements/announcement-1', {
      title: 'Updated', expected_control_version: 1,
    }, {
      headers: {
        'Idempotency-Key': 'admin-announcement-update-announcement-1-55555555-5555-4555-8555-555555555555',
        'If-Match': '"1"',
      },
    })
    expect(del).toHaveBeenCalledWith('/admin/announcements/announcement-1', {
      headers: {
        'Idempotency-Key': 'admin-announcement-delete-announcement-1-55555555-5555-4555-8555-555555555555',
        'If-Match': '"2"',
      },
    })
  })
})
