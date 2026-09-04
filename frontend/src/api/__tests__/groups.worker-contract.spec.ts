import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/api/client', () => ({ apiClient: { get } }))

import { getAvailable, getUserGroupRates } from '@/api/groups'

describe('user groups Cloudflare Worker contract', () => {
  beforeEach(() => get.mockReset())

  it('keeps available group UUIDs and Worker-provided multipliers intact', async () => {
    const group = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'OpenAI',
      description: null,
      platform: 'openai',
      rate_multiplier: 1.25,
      is_exclusive: false,
      status: 'active',
      subscription_type: 'standard'
    }
    get.mockResolvedValueOnce({ data: [group] })

    await expect(getAvailable()).resolves.toEqual([group])
    expect(get).toHaveBeenCalledWith('/groups/available')
  })

  it('returns UUID-keyed user rate overrides', async () => {
    const rates = { 'cccccccc-cccc-4ccc-8ccc-cccccccccccc': 0.8 }
    get.mockResolvedValueOnce({ data: rates })

    await expect(getUserGroupRates()).resolves.toEqual(rates)
  })
})
