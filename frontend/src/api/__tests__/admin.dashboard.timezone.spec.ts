import { beforeEach, describe, expect, it, vi } from 'vitest'
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../client', () => ({ apiClient: { get, post } }))
vi.mock('../../utils/format', () => ({ getBrowserTimeZone: () => 'Asia/Shanghai' }))
import {
  getBatchUsersUsage,
  getBatchApiKeysUsage,
  getSnapshotV2,
  getUserBreakdown,
} from '../admin/dashboard'

describe('admin dashboard batch usage timezone', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
    post.mockResolvedValue({ data: { stats: {} } })
  })

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

  it('keeps UUID groups clickable while sending the real Worker group ID on drilldown', async () => {
    const groupId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    get
      .mockResolvedValueOnce({
        data: {
          generated_at: '2026-09-07T00:00:00.000Z',
          start_date: '2026-09-07',
          end_date: '2026-09-07',
          granularity: 'day',
          groups: [{
            group_id: groupId,
            group_name: 'Worker group',
            requests: 1,
            total_tokens: 2,
            cost: 0,
            actual_cost: 0,
          }],
        },
      })
      .mockResolvedValueOnce({
        data: { users: [], start_date: '2026-09-07', end_date: '2026-09-07' },
      })

    const snapshot = await getSnapshotV2()
    const displayId = snapshot.groups?.[0].group_id
    expect(displayId).toEqual(expect.any(Number))
    expect(displayId).toBeGreaterThan(0)

    await getUserBreakdown({ group_id: displayId })
    expect(get).toHaveBeenLastCalledWith('/admin/dashboard/user-breakdown', {
      params: { group_id: groupId },
    })
  })
})
