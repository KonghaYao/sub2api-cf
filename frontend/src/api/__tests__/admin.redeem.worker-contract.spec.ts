import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post, deleteRequest } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  deleteRequest: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiClient: { get, post, delete: deleteRequest },
}))

describe('admin redeem code Cloudflare Worker contract', () => {
  beforeEach(() => {
    vi.resetModules()
    get.mockReset()
    post.mockReset()
    deleteRequest.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '55555555-5555-4555-8555-555555555555',
    )
  })

  it('generates every admin redeem-code type with the original value contract', async () => {
    post.mockResolvedValueOnce({
      data: [{
        id: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
        code: 'AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD',
        type: 'balance',
        value: 1.234567,
        value_micros: 1_234_567,
        status: 'unused',
        control_version: 0,
      }],
    })
    const { generate } = await import('@/api/admin/redeem')

    await expect(generate(1, 'balance', 1.234567)).resolves.toHaveLength(1)
    expect(post).toHaveBeenCalledWith('/admin/redeem-codes/generate', {
      count: 1,
      type: 'balance',
      value_micros: 1_234_567,
    }, {
      headers: {
        'Idempotency-Key': 'admin-redeem-generate-55555555-5555-4555-8555-555555555555',
      },
    })

    post.mockResolvedValueOnce({ data: [{
      id: 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb',
      code: 'EEEEEEEE-FFFFFFFF-11111111-22222222',
      type: 'concurrency',
      value: 3,
      status: 'unused',
      control_version: 0,
    }] })
    await expect(generate(1, 'concurrency', 3)).resolves.toHaveLength(1)
    expect(post).toHaveBeenNthCalledWith(2, '/admin/redeem-codes/generate', {
      count: 1,
      type: 'concurrency',
      value: 3,
    }, {
      headers: {
        'Idempotency-Key': 'admin-redeem-generate-55555555-5555-4555-8555-555555555555',
      },
    })

    post.mockResolvedValueOnce({ data: [{
      id: 'cccccccc-cccc-5ccc-8ccc-cccccccccccc',
      code: '33333333-44444444-55555555-66666666',
      type: 'invitation',
      value: 0,
      status: 'unused',
      control_version: 0,
    }] })
    await expect(generate(1, 'invitation', 0)).resolves.toHaveLength(1)
    expect(post).toHaveBeenNthCalledWith(3, '/admin/redeem-codes/generate', {
      count: 1,
      type: 'invitation',
      value: 0,
    }, {
      headers: {
        'Idempotency-Key': 'admin-redeem-generate-55555555-5555-4555-8555-555555555555',
      },
    })
  })

  it('exports the current filters as a CSV blob', async () => {
    const csv = new Blob(['id,code,type\n1,CODE,balance\n'], { type: 'text/csv' })
    get.mockResolvedValueOnce({ data: csv })
    const { exportCodes } = await import('@/api/admin/redeem')

    await expect(exportCodes({ status: 'disabled', type: 'invitation' })).resolves.toBe(csv)
    expect(get).toHaveBeenCalledWith('/admin/redeem-codes/export', {
      params: { status: 'disabled', type: 'invitation' },
      responseType: 'blob',
    })
  })

  it('uses listed control versions for idempotent expire, batch update, and delete', async () => {
    const first = {
      id: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
      code: 'AAAAAAAA…',
      type: 'balance', value: 1, status: 'unused', used_by: null, used_at: null,
      created_at: '2026-09-04T00:00:00.000Z', control_version: 2,
    }
    const second = { ...first, id: 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb', control_version: 4 }
    get.mockResolvedValueOnce({ data: {
      items: [first, second], total: 2, page: 1, page_size: 20, pages: 1,
    } })
    post
      .mockResolvedValueOnce({ data: { ...first, status: 'expired', control_version: 3 } })
      .mockResolvedValueOnce({ data: { updated: 2, message: 'ok' } })
    deleteRequest.mockResolvedValueOnce({ data: { deleted: 1, id: first.id, message: 'ok' } })
    const api = await import('@/api/admin/redeem')

    await api.list()
    await api.expire(first.id)
    expect(post).toHaveBeenNthCalledWith(1, `/admin/redeem-codes/${first.id}/expire`, {}, {
      headers: {
        'Idempotency-Key': 'admin-redeem-expire-55555555-5555-4555-8555-555555555555',
        'If-Match': '"2"',
      },
    })

    await api.batchUpdate([second.id], { status: 'disabled', notes: 'campaign' })
    expect(post).toHaveBeenNthCalledWith(2, '/admin/redeem-codes/batch-update', {
      ids: [second.id],
      expected_control_versions: { [second.id]: 4 },
      fields: { status: 'disabled', notes: 'campaign' },
    }, {
      headers: {
        'Idempotency-Key': 'admin-redeem-batch-update-55555555-5555-4555-8555-555555555555',
      },
    })

    await api.deleteCode(first.id)
    expect(deleteRequest).toHaveBeenCalledWith(`/admin/redeem-codes/${first.id}`, {
      headers: {
        'Idempotency-Key': 'admin-redeem-delete-55555555-5555-4555-8555-555555555555',
        'If-Match': '"3"',
      },
    })
  })
})
