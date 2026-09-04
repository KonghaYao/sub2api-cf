import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, put } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))

vi.mock('@/api/client', () => ({ apiClient: { get, put } }))

import { changePassword, getProfile, updateProfile } from '@/api/user'

describe('user profile Cloudflare Worker contract', () => {
  beforeEach(() => {
    get.mockReset()
    put.mockReset()
  })

  it('uses the Worker profile endpoint and preserves its public-user projection', async () => {
    const profile = {
      id: 'user-1', username: 'Alice', email: 'alice@example.test', avatar_url: null,
      role: 'user', balance: 0, concurrency: 0, status: 'active', allowed_groups: null,
      balance_notify_enabled: false, balance_notify_threshold: null, balance_notify_extra_emails: [],
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    }
    get.mockResolvedValueOnce({ data: profile })

    await expect(getProfile()).resolves.toEqual(profile)
    expect(get).toHaveBeenCalledWith('/user/profile')
  })

  it('sends display edits and avatar data URLs to the Worker profile update endpoint', async () => {
    const profile = { id: 'user-1', username: 'Alice', avatar_url: '/api/v1/user/avatar/user-1?v=4' }
    put.mockResolvedValueOnce({ data: profile })

    await expect(updateProfile({ username: 'Alice', avatar_url: 'data:image/png;base64,AQID' })).resolves.toEqual(profile)
    expect(put).toHaveBeenCalledWith('/user', {
      username: 'Alice', avatar_url: 'data:image/png;base64,AQID',
    })
  })

  it('uses the Worker password route and old/new field names', async () => {
    put.mockResolvedValueOnce({ data: { message: 'Password changed successfully' } })

    await expect(changePassword('old password', 'new password')).resolves.toEqual({ message: 'Password changed successfully' })
    expect(put).toHaveBeenCalledWith('/user/password', {
      old_password: 'old password', new_password: 'new password',
    })
  })
})
