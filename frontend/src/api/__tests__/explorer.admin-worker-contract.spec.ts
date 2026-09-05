import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/api/client', () => ({ apiClient: { get } }))

describe('admin Explorer Worker contract', () => {
  beforeEach(() => get.mockReset())

  it('lists usage with keyset pagination and opaque resource filters', async () => {
    const response = {
      items: [{
        id: 'obs_01HZZ', created_at: '2026-09-05T00:00:00.000Z', request_id: 'req_1',
        user_id: 'user_01HZZ', api_key_id: 'key_01HZZ', account_id: 'account_01HZZ',
        group_id: 'group_01HZZ', model: 'gpt-5', input_tokens: 10, output_tokens: 2,
        cache_read_tokens: 3, amount_micros: 12500, stream: true, request_type: 2,
      }],
      has_more: false,
      next_cursor: null,
    }
    get.mockResolvedValueOnce({ data: response })
    const { list } = await import('@/api/admin/usage')

    const page = await list({
      limit: 50,
      cursor: 'usage-cursor',
      user_id: 'user_01HZZ',
      api_key_id: 'key_01HZZ',
    })

    expect(page).toEqual(response)

    expect(get).toHaveBeenCalledWith('/admin/usage', {
      params: {
        limit: 50,
        cursor: 'usage-cursor',
        user_id: 'user_01HZZ',
        api_key_id: 'key_01HZZ',
      },
      signal: undefined,
    })
  })

  it('lists requests/errors by cursor and URL-encodes opaque detail IDs', async () => {
    get.mockResolvedValue({ data: { items: [], has_more: false, next_cursor: null } })
    const ops = await import('@/api/admin/ops')

    await ops.listRequestDetails({ limit: 10, cursor: 'req-cursor', group_id: 'group_01HZZ' })
    await ops.listRequestErrors({ limit: 10, cursor: 'err-cursor' })
    await ops.getRequestErrorDetail('error/id 1')
    await ops.listRequestErrorUpstreamErrors('error/id 1', { limit: 10, cursor: 'related-cursor' })

    expect(get).toHaveBeenCalledWith('/admin/ops/requests', {
      params: { limit: 10, cursor: 'req-cursor', group_id: 'group_01HZZ' },
    })
    expect(get).toHaveBeenCalledWith('/admin/ops/request-errors', {
      params: { limit: 10, cursor: 'err-cursor' },
    })
    expect(get).toHaveBeenCalledWith('/admin/ops/request-errors/error%2Fid%201')
    expect(get).toHaveBeenCalledWith(
      '/admin/ops/request-errors/error%2Fid%201/upstream-errors',
      { params: { limit: 10, cursor: 'related-cursor' } },
    )
  })
})
