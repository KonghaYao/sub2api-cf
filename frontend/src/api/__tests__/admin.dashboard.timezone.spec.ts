import { beforeEach, describe, expect, it, vi } from 'vitest'
const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../client', () => ({ apiClient: { post } }))
vi.mock('../../utils/format', () => ({ getBrowserTimeZone: () => 'Asia/Shanghai' }))
import { getBatchUsersUsage, getBatchApiKeysUsage } from '../admin/dashboard'

describe('admin dashboard batch usage timezone', () => {
  beforeEach(() => { post.mockReset(); post.mockResolvedValue({ data: { stats: {} } }) })

  it('uses the same local day as the dashboard for batched user costs', async () => {
    await getBatchUsersUsage([1, 2])
    expect(post).toHaveBeenCalledWith('/admin/dashboard/users-usage', { user_ids: [1, 2] }, {
      params: { timezone: 'Asia/Shanghai' },
    })
  })

  it('uses the same local day as the dashboard for batched key costs', async () => {
    await getBatchApiKeysUsage([3])
    expect(post).toHaveBeenCalledWith('/admin/dashboard/api-keys-usage', { api_key_ids: [3] }, {
      params: { timezone: 'Asia/Shanghai' },
    })
  })
})
