import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post, put, del } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiClient: { get, post, put, delete: del },
}))

describe('admin promo Worker mutation contract', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
    put.mockReset()
    del.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '33333333-3333-4333-8333-333333333333',
    )
  })

  it('uses UUID resources and idempotency/CAS headers for mutations', async () => {
    const created = {
      id: 'promo-uuid',
      code: 'HELLO',
      bonus_amount: 2.5,
      max_uses: 3,
      used_count: 0,
      status: 'active' as const,
      expires_at: null,
      notes: null,
      control_version: 0,
      created_at: '2026-09-05T00:00:00.000Z',
      updated_at: '2026-09-05T00:00:00.000Z',
    }
    post.mockResolvedValueOnce({ data: created })
    put.mockResolvedValueOnce({ data: { ...created, status: 'disabled', control_version: 1 } })
    del.mockResolvedValueOnce({ data: { message: 'Promo code deleted successfully' } })
    const promo = await import('@/api/admin/promo')

    await promo.create({ code: 'HELLO', bonus_amount: 2.5, max_uses: 3 })
    await promo.update('promo-uuid', {
      status: 'disabled',
      expected_control_version: 0,
    })
    await promo.deleteCode('promo-uuid', 1)

    expect(post).toHaveBeenCalledWith('/admin/promo-codes', {
      code: 'HELLO', bonus_amount: 2.5, max_uses: 3,
    }, {
      headers: {
        'Idempotency-Key': 'admin-promo-create-33333333-3333-4333-8333-333333333333',
      },
    })
    expect(put).toHaveBeenCalledWith('/admin/promo-codes/promo-uuid', {
      status: 'disabled', expected_control_version: 0,
    }, {
      headers: {
        'Idempotency-Key': 'admin-promo-update-promo-uuid-33333333-3333-4333-8333-333333333333',
        'If-Match': '"0"',
      },
    })
    expect(del).toHaveBeenCalledWith('/admin/promo-codes/promo-uuid', {
      headers: {
        'Idempotency-Key': 'admin-promo-delete-promo-uuid-33333333-3333-4333-8333-333333333333',
        'If-Match': '"1"',
      },
    })
  })
})
