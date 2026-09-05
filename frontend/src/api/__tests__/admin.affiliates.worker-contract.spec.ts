import { beforeEach, describe, expect, it, vi } from 'vitest'

const { post, put, del } = vi.hoisted(() => ({
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiClient: { post, put, delete: del },
}))

describe('admin affiliate Worker mutation contract', () => {
  beforeEach(() => {
    post.mockReset()
    put.mockReset()
    del.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '44444444-4444-4444-8444-444444444444',
    )
  })

  it('uses idempotency and CAS headers for single-user mutations', async () => {
    put.mockResolvedValueOnce({ data: { user_id: 'user-uuid', control_version: 4 } })
    del.mockResolvedValueOnce({ data: { user_id: 'user-uuid', control_version: 5 } })
    const affiliates = await import('@/api/admin/affiliates')

    await affiliates.updateUserSettings(
      'user-uuid',
      { aff_rebate_rate_percent: 12.5 },
      3,
    )
    await affiliates.clearUserSettings('user-uuid', 4)

    expect(put).toHaveBeenCalledWith('/admin/affiliates/users/user-uuid', {
      aff_rebate_rate_percent: 12.5,
      expected_control_version: 3,
    }, {
      headers: {
        'Idempotency-Key': 'admin-affiliate-update-user-uuid-44444444-4444-4444-8444-444444444444',
        'If-Match': '"3"',
      },
    })
    expect(del).toHaveBeenCalledWith('/admin/affiliates/users/user-uuid', {
      data: { expected_control_version: 4 },
      headers: {
        'Idempotency-Key': 'admin-affiliate-clear-user-uuid-44444444-4444-4444-8444-444444444444',
        'If-Match': '"4"',
      },
    })
  })

  it('sends the selected users version map for atomic batch updates', async () => {
    post.mockResolvedValueOnce({
      data: { affected: 2, control_versions: { first: 2, second: 8 } },
    })
    const affiliates = await import('@/api/admin/affiliates')

    await affiliates.batchSetRate({
      user_ids: ['first', 'second'],
      aff_rebate_rate_percent: 20,
      expected_control_versions: { first: 1, second: 7 },
    })

    expect(post).toHaveBeenCalledWith('/admin/affiliates/users/batch-rate', {
      user_ids: ['first', 'second'],
      aff_rebate_rate_percent: 20,
      expected_control_versions: { first: 1, second: 7 },
    }, {
      headers: {
        'Idempotency-Key': 'admin-affiliate-batch-rate-44444444-4444-4444-8444-444444444444',
      },
    })
  })
})
