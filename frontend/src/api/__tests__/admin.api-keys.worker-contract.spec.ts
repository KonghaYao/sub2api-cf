import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, put } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))

vi.mock('@/api/client', () => ({
  apiClient: { get, put }
}))

import { updateApiKeyGroup } from '@/api/admin/apiKeys'
import { getUserApiKeys } from '@/api/admin/users'

describe('admin API key Cloudflare Worker contract', () => {
  beforeEach(() => {
    get.mockReset()
    put.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111'
    )
  })

  it('preserves hydrated group data when the API key modal reloads', async () => {
    const result = {
      items: [{
        id: 'key-1',
        key_prefix: 'sk-sub2api-safe',
        group_id: 'group-2',
        group: {
          id: 'group-2',
          name: 'Exclusive',
          platform: 'openai',
          subscription_type: 'standard',
          rate_multiplier: 1.25,
          is_exclusive: true,
          status: 'active'
        }
      }],
      total: 1,
      page: 1,
      page_size: 20,
      pages: 1
    }
    get.mockResolvedValueOnce({ data: result })

    await expect(getUserApiKeys('user-1')).resolves.toEqual({
      ...result,
      items: [{ ...result.items[0], key: 'sk-sub2api-safe********' }]
    })
    expect(get).toHaveBeenCalledWith('/admin/users/user-1/api-keys')
  })

  it('sends an idempotency key and preserves the wrapped update response', async () => {
    const result = {
      api_key: { id: 'key-1', group_id: 'group-2', status: 'active' },
      auto_granted_group_access: true,
      granted_group_id: 'group-2',
      granted_group_name: 'Exclusive'
    }
    put.mockResolvedValueOnce({ data: result })

    await expect(updateApiKeyGroup('key-1', 'group-2')).resolves.toEqual(result)
    expect(put).toHaveBeenCalledWith(
      '/admin/api-keys/key-1',
      { group_id: 'group-2' },
      {
        headers: {
          'Idempotency-Key':
            'admin-api-key-group-key-1-11111111-1111-4111-8111-111111111111'
        }
      }
    )
  })

  it('passes null through so an administrator can clear the binding', async () => {
    const result = {
      api_key: { id: 'key-1', group_id: null, status: 'active' },
      auto_granted_group_access: false
    }
    put.mockResolvedValueOnce({ data: result })

    await expect(updateApiKeyGroup('key-1', null)).resolves.toEqual(result)
    expect(put.mock.calls[0][1]).toEqual({ group_id: null })
    expect(put.mock.calls[0][2]?.headers?.['Idempotency-Key']).toMatch(
      /^admin-api-key-group-key-1-/
    )
  })
})
