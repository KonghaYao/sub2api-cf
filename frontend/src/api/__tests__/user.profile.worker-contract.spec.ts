import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, put, post, del } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  del: vi.fn()
}))

vi.mock('@/api/client', () => ({ apiClient: { get, put, post, delete: del } }))

import {
  changePassword,
  getProfile,
  removeNotifyEmail,
  toggleNotifyEmail,
  updateProfile,
  verifyNotifyEmail
} from '@/api/user'

describe('user profile Cloudflare Worker contract', () => {
  beforeEach(() => {
    get.mockReset()
    put.mockReset()
    post.mockReset()
    del.mockReset()
  })

  it('uses the Worker profile endpoint and preserves its public-user projection', async () => {
    const profile = {
      id: 'user-1', username: 'Alice', email: 'alice@example.test', avatar_url: null,
      role: 'user', balance: 0, concurrency: 0, status: 'active', allowed_groups: null,
      balance_notify_enabled: false, balance_notify_threshold: null, balance_notify_extra_emails: [],
      notification_preferences_version: 2,
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

  it('carries the notification preference CAS version on every mutating email request', async () => {
    const profile = { id: 'user-1', notification_preferences_version: 4 }
    post.mockResolvedValueOnce({ data: profile })
    put.mockResolvedValueOnce({ data: profile })
    del.mockResolvedValueOnce({ data: profile })

    await expect(verifyNotifyEmail('alerts@example.test', '123456', 3)).resolves.toEqual(profile)
    expect(post).toHaveBeenCalledWith('/user/notify-email/verify', {
      email: 'alerts@example.test',
      code: '123456',
      notification_preferences_version: 3
    })

    await expect(toggleNotifyEmail('alerts@example.test', true, 3)).resolves.toEqual(profile)
    expect(put).toHaveBeenCalledWith('/user/notify-email/toggle', {
      email: 'alerts@example.test',
      disabled: true,
      notification_preferences_version: 3
    })

    await expect(removeNotifyEmail('alerts@example.test', 3)).resolves.toEqual(profile)
    expect(del).toHaveBeenCalledWith('/user/notify-email', {
      data: { email: 'alerts@example.test', notification_preferences_version: 3 }
    })
  })
})
