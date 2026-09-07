import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('@/api/client', () => ({ apiClient: { get, post } }))

import {
  getById,
  getDashboardApiKeysUsage,
  getMyErrorDetail,
  listMyErrorRequests,
  query,
} from '@/api/usage'

describe('usage Explorer Worker contract', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
  })

  it('uses cursor pagination and opaque filters without legacy page or sort params', async () => {
    const response = { items: [], has_more: true, next_cursor: 'next-opaque' }
    get.mockResolvedValueOnce({ data: response })

    await expect(query({
      limit: 25,
      cursor: 'cursor-opaque',
      api_key_id: 'key_01HZZ',
      group_id: 'group_01HZZ',
      model: 'gpt-5',
      request_type: 'stream',
      native_compaction_v2: false,
      billing_mode: 'token',
    })).resolves.toEqual(response)

    expect(get).toHaveBeenCalledWith('/usage', {
      params: {
        limit: 25,
        cursor: 'cursor-opaque',
        api_key_id: 'key_01HZZ',
        group_id: 'group_01HZZ',
        model: 'gpt-5',
        request_type: 'stream',
        native_compaction_v2: false,
        billing_mode: 'token',
      },
    })
  })

  it('uses the original offset error-list contract and encoded opaque IDs for details', async () => {
    get.mockResolvedValue({ data: {} })

    await getById('usage/id 1')
    await listMyErrorRequests({
      page: 2,
      page_size: 10,
      api_key_id: 'key/1',
      category: 'quota',
      sort_by: 'status_code',
      sort_order: 'asc',
    })
    await getMyErrorDetail('error/id 1')

    expect(get).toHaveBeenCalledWith('/usage/usage%2Fid%201')
    expect(get).toHaveBeenCalledWith('/usage/errors', {
      params: {
        page: 2,
        page_size: 10,
        api_key_id: 'key/1',
        category: 'quota',
        sort_by: 'status_code',
        sort_order: 'asc',
      },
    })
    expect(get).toHaveBeenCalledWith('/usage/errors/error%2Fid%201')
  })

  it('posts opaque key batches', async () => {
    post.mockResolvedValue({ data: { stats: {} } })
    await expect(getDashboardApiKeysUsage(['key-1'])).resolves.toEqual({ stats: {} })
    expect(post).toHaveBeenCalledWith(
      '/usage/dashboard/api-keys-usage',
      { api_key_ids: ['key-1'] },
      { signal: undefined },
    )
  })
})
