import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get } = vi.hoisted(() => ({
  get: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiClient: { get },
}))

import { getUsageSummary } from '@/api/admin/groups'
import { setCloudflareWorkerContractActive } from '@/utils/adminCapabilities'

describe('admin group usage summary API', () => {
  beforeEach(() => {
    setCloudflareWorkerContractActive(false)
    get.mockReset()
    get.mockResolvedValue({ data: [] })
  })

  it('preserves Worker opaque group IDs and actual cost values', async () => {
    setCloudflareWorkerContractActive(true)
    const summary = [{ group_id: 'group-opaque', today_cost: 1.25, yesterday_cost: 5, total_cost: 10.25 }]
    get.mockResolvedValue({ data: summary })
    await expect(getUsageSummary()).resolves.toEqual(summary)
    expect(get).toHaveBeenCalledWith('/admin/groups/usage-summary')
  })

  it('does not send browser timezone parameters', async () => {
    const summary = [
      { group_id: 1, today_cost: 1.25, yesterday_cost: 2.5, total_cost: 9.75 },
    ]
    get.mockResolvedValue({ data: summary })

    await expect(getUsageSummary()).resolves.toEqual(summary)

    expect(get).toHaveBeenCalledWith('/admin/groups/usage-summary')
  })
})
