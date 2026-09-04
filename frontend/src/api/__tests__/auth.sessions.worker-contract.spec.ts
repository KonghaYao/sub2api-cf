import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post, del } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  del: vi.fn()
}))

vi.mock('@/api/client', () => ({
  apiClient: { get, post, delete: del }
}))

import { getSessions, revokeOtherSessions, revokeSession } from '@/api/auth'

describe('auth sessions Cloudflare Worker contract', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
    del.mockReset()
  })

  it('preserves the Worker session projection', async () => {
    const response = {
      items: [{
        id: 'session-current',
        current: true,
        created_at: '2026-09-04T00:00:00.000Z',
        access_expires_at: '2026-09-04T00:15:00.000Z',
        refresh_expires_at: '2026-10-04T00:00:00.000Z'
      }],
      total: 1
    }
    get.mockResolvedValueOnce({ data: response })

    await expect(getSessions()).resolves.toEqual(response)
    expect(get).toHaveBeenCalledWith('/auth/sessions')
  })

  it('encodes a session id and exposes the revoke-others operation', async () => {
    del.mockResolvedValueOnce({ data: {} })
    post.mockResolvedValueOnce({ data: {} })

    await revokeSession('session/with spaces')
    await revokeOtherSessions()

    expect(del).toHaveBeenCalledWith('/auth/sessions/session%2Fwith%20spaces')
    expect(post).toHaveBeenCalledWith('/auth/sessions/revoke-others')
  })
})
