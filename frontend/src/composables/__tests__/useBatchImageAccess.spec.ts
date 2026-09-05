import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const accessMocks = vi.hoisted(() => ({
  listKeys: vi.fn(),
  listGroups: vi.fn(),
}))

vi.mock('@/api/keys', () => ({
  keysAPI: { list: accessMocks.listKeys },
}))
vi.mock('@/api/groups', () => ({
  userGroupsAPI: { getAvailable: accessMocks.listGroups },
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ isAuthenticated: true }),
}))

import { keyAllowsBatchImage, useBatchImageAccess } from '@/composables/useBatchImageAccess'
import type { ApiKey } from '@/types'
import type { AvailableUserGroup } from '@/api/groups'
import { setCloudflareWorkerContractActive } from '@/utils/adminCapabilities'

const eligibleGroup: AvailableUserGroup = {
  id: 'group-gemini',
  name: 'Gemini images',
  description: null,
  platform: 'gemini',
  rate_multiplier: 1,
  is_exclusive: false,
  status: 'active',
  subscription_type: 'standard',
  allow_image_generation: true,
  allow_batch_image_generation: true,
}

function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key-1',
    user_id: 'user-1',
    key_prefix: 'sk-abc',
    name: 'Images',
    group_id: eligibleGroup.id,
    status: 'active',
    ip_whitelist: [],
    ip_blacklist: [],
    last_used_at: null,
    last_used_ip: null,
    quota: 0,
    quota_used: 0,
    expires_at: null,
    created_at: '',
    updated_at: '',
    current_concurrency: 0,
    rate_limit_5h: 0,
    rate_limit_1d: 0,
    rate_limit_7d: 0,
    usage_5h: 0,
    usage_1d: 0,
    usage_7d: 0,
    window_5h_start: null,
    window_1d_start: null,
    window_7d_start: null,
    reset_5h_at: null,
    reset_1d_at: null,
    reset_7d_at: null,
    ...overrides,
  }
}

describe('batch image access eligibility', () => {
  beforeEach(() => {
    accessMocks.listKeys.mockReset()
    accessMocks.listGroups.mockReset()
  })

  afterEach(() => setCloudflareWorkerContractActive(true))

  it('joins a Worker key to its available group and does not require plaintext', () => {
    setCloudflareWorkerContractActive(true)
    expect(keyAllowsBatchImage(apiKey(), [eligibleGroup])).toBe(true)
  })

  it('rejects missing, disabled, and non-Gemini group matches', () => {
    setCloudflareWorkerContractActive(true)
    expect(keyAllowsBatchImage(apiKey(), [])).toBe(false)
    expect(keyAllowsBatchImage(apiKey(), [{ ...eligibleGroup, allow_batch_image_generation: false }])).toBe(false)
    expect(keyAllowsBatchImage(apiKey(), [{ ...eligibleGroup, platform: 'openai' }])).toBe(false)
  })

  it('continues requiring the one-time plaintext key for the legacy gateway', () => {
    setCloudflareWorkerContractActive(false)
    expect(keyAllowsBatchImage(apiKey(), [eligibleGroup])).toBe(false)
    expect(keyAllowsBatchImage(apiKey({ key: 'sk-gateway' }), [eligibleGroup])).toBe(true)
  })

  it('loads available groups and joins key rows that have no embedded group', async () => {
    setCloudflareWorkerContractActive(true)
    accessMocks.listGroups.mockResolvedValueOnce([eligibleGroup])
    accessMocks.listKeys.mockResolvedValueOnce({
      items: [apiKey({ group: undefined })],
      page: 1,
      page_size: 100,
      total: 1,
      pages: 1,
    })

    const { refreshBatchImageAccess } = useBatchImageAccess()
    await expect(refreshBatchImageAccess(true)).resolves.toBe(true)
    expect(accessMocks.listGroups).toHaveBeenCalledOnce()
    expect(accessMocks.listKeys).toHaveBeenCalledWith(1, 100, {
      status: 'active',
      sort_by: 'created_at',
      sort_order: 'desc',
    })
  })
})
