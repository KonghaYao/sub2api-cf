import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('@/api/client', () => ({ apiClient: { get, post } }))

describe('affiliate Worker contract', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '44444444-4444-4444-8444-444444444444',
    )
  })

  it('keeps Worker UUIDs and makes transfer retries idempotent', async () => {
    get.mockResolvedValueOnce({ data: { user_id: 'user-uuid', aff_code: 'AFFCODE' } })
    post.mockResolvedValueOnce({
      data: {
        transferred_quota: 5,
        transferred_micros: 5_000_000,
        balance: 20,
        balance_micros: 20_000_000,
        transfer_id: 'transfer-uuid',
        idempotent: false,
      },
    })
    const { getAffiliateDetail, transferAffiliateQuota } = await import('@/api/user')

    await getAffiliateDetail()
    await expect(transferAffiliateQuota()).resolves.toMatchObject({
      transfer_id: 'transfer-uuid',
    })

    expect(post).toHaveBeenCalledWith('/user/aff/transfer', undefined, {
      headers: {
        'Idempotency-Key': 'affiliate-transfer-44444444-4444-4444-8444-444444444444',
      },
    })
  })
})
