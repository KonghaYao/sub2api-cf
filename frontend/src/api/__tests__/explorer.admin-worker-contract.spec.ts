import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('@/api/client', () => ({ apiClient: { get, post } }))

describe('admin Explorer Worker contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    get.mockReset()
    post.mockReset()
  })

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

  it('resolves and reopens errors with CAS and an idempotency key', async () => {
    post.mockResolvedValue({
      data: {
        id: 'error/id 1', resolved: true, resolved_at: '2026-09-05T00:00:00.000Z',
        resolved_by_user_id: 'admin-1', control_version: 43,
      },
    })
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(
      '11111111-1111-4111-8111-111111111111',
    ).mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
    const ops = await import('@/api/admin/ops')

    await ops.updateErrorResolution('request', 'error/id 1', 'resolve', 42)
    await ops.updateErrorResolution('upstream', 'error/id 1', 'reopen', 43)

    expect(post).toHaveBeenNthCalledWith(
      1,
      '/admin/ops/request-errors/error%2Fid%201/resolve',
      { expected_control_version: 42 },
      {
        headers: {
          'If-Match': '"42"',
          'Idempotency-Key':
            'admin-ops-error-resolve-11111111-1111-4111-8111-111111111111',
        },
      },
    )
    expect(post).toHaveBeenNthCalledWith(
      2,
      '/admin/ops/upstream-errors/error%2Fid%201/reopen',
      { expected_control_version: 43 },
      {
        headers: {
          'If-Match': '"43"',
          'Idempotency-Key':
            'admin-ops-error-reopen-22222222-2222-4222-8222-222222222222',
        },
      },
    )
  })

  it('reuses the resolution idempotency key after an ambiguous response loss', async () => {
    post.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({
      data: {
        id: 'error-1', resolved: true, resolved_at: '2026-09-05T00:00:00.000Z',
        resolved_by_user_id: 'admin-1', control_version: 8,
      },
    })
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(
      '33333333-3333-4333-8333-333333333333',
    )
    const ops = await import('@/api/admin/ops')

    await expect(ops.updateErrorResolution('request', 'error-1', 'resolve', 7))
      .rejects.toThrow('response lost')
    await ops.updateErrorResolution('request', 'error-1', 'resolve', 7)

    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0]?.[2]).toEqual(post.mock.calls[1]?.[2])
    expect(post.mock.calls[1]?.[2]?.headers?.['Idempotency-Key']).toBe(
      'admin-ops-error-resolve-33333333-3333-4333-8333-333333333333',
    )
  })

  it('rotates the resolution idempotency key after a definitive outcome', async () => {
    post.mockRejectedValueOnce({ status: 409, code: 'request_observation_changed' })
      .mockResolvedValue({
        data: {
          id: 'error-2', resolved: true, resolved_at: '2026-09-05T00:00:00.000Z',
          resolved_by_user_id: 'admin-1', control_version: 4,
        },
      })
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('44444444-4444-4444-8444-444444444444')
      .mockReturnValueOnce('55555555-5555-4555-8555-555555555555')
      .mockReturnValueOnce('66666666-6666-4666-8666-666666666666')
    const ops = await import('@/api/admin/ops')

    await expect(ops.updateErrorResolution('request', 'error-2', 'resolve', 3)).rejects.toMatchObject({
      status: 409,
      code: 'request_observation_changed',
    })
    await ops.updateErrorResolution('request', 'error-2', 'resolve', 3)
    await ops.updateErrorResolution('request', 'error-2', 'resolve', 3)

    expect(post.mock.calls.map((call) => call[2]?.headers?.['Idempotency-Key'])).toEqual([
      'admin-ops-error-resolve-44444444-4444-4444-8444-444444444444',
      'admin-ops-error-resolve-55555555-5555-4555-8555-555555555555',
      'admin-ops-error-resolve-66666666-6666-4666-8666-666666666666',
    ])
  })

  it('retains the resolution idempotency key after status zero and server errors', async () => {
    post.mockRejectedValueOnce({ status: 0, code: 'network_error' })
      .mockRejectedValueOnce({ status: 503, code: 'internal_error' })
      .mockResolvedValueOnce({
        data: {
          id: 'error-4', resolved: true, resolved_at: '2026-09-05T00:00:00.000Z',
          resolved_by_user_id: 'admin-1', control_version: 6,
        },
      })
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(
      '99999999-9999-4999-8999-999999999999',
    )
    const ops = await import('@/api/admin/ops')

    await expect(ops.updateErrorResolution('request', 'error-4', 'resolve', 5))
      .rejects.toMatchObject({ status: 0 })
    await expect(ops.updateErrorResolution('request', 'error-4', 'resolve', 5))
      .rejects.toMatchObject({ status: 503 })
    await ops.updateErrorResolution('request', 'error-4', 'resolve', 5)

    expect(post.mock.calls.map((call) => call[2]?.headers?.['Idempotency-Key'])).toEqual([
      'admin-ops-error-resolve-99999999-9999-4999-8999-999999999999',
      'admin-ops-error-resolve-99999999-9999-4999-8999-999999999999',
      'admin-ops-error-resolve-99999999-9999-4999-8999-999999999999',
    ])
  })

  it('expires an ambiguous resolution operation after five minutes', async () => {
    post.mockRejectedValue(new Error('response lost'))
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(301_001)
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('77777777-7777-4777-8777-777777777777')
      .mockReturnValueOnce('88888888-8888-4888-8888-888888888888')
    const ops = await import('@/api/admin/ops')

    await expect(ops.updateErrorResolution('upstream', 'error-3', 'reopen', 11))
      .rejects.toThrow('response lost')
    await expect(ops.updateErrorResolution('upstream', 'error-3', 'reopen', 11))
      .rejects.toThrow('response lost')

    expect(post.mock.calls.map((call) => call[2]?.headers?.['Idempotency-Key'])).toEqual([
      'admin-ops-error-reopen-77777777-7777-4777-8777-777777777777',
      'admin-ops-error-reopen-88888888-8888-4888-8888-888888888888',
    ])
  })
})
