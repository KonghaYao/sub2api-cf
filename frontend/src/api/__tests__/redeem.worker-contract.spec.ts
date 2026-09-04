import { beforeEach, describe, expect, it, vi } from 'vitest'

const { post } = vi.hoisted(() => ({ post: vi.fn() }))

vi.mock('@/api/client', () => ({
  apiClient: { post }
}))

describe('redeem Cloudflare Worker contract', () => {
  beforeEach(() => {
    vi.resetModules()
    post.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '44444444-4444-4444-8444-444444444444'
    )
  })

  it('normalizes the code and sends the required idempotency key', async () => {
    post.mockResolvedValueOnce({
      data: { message: 'ok', type: 'balance', value: 10, new_balance: 15 }
    })
    const { redeem } = await import('@/api/redeem')

    await expect(redeem(' pro-30-days ')).resolves.toMatchObject({ type: 'balance', value: 10 })
    expect(post).toHaveBeenCalledWith('/redeem', { code: 'PRO-30-DAYS' }, {
      headers: {
        'Idempotency-Key': 'user-redeem-44444444-4444-4444-8444-444444444444'
      }
    })
  })

  it('reuses the operation key after an ambiguous failure', async () => {
    post
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ data: { message: 'ok', type: 'subscription', value: 30 } })
    const { redeem } = await import('@/api/redeem')

    await expect(redeem('PRO-30-DAYS')).rejects.toThrow('connection reset')
    await expect(redeem('pro-30-days')).resolves.toMatchObject({ type: 'subscription' })
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0]?.[2]).toEqual(post.mock.calls[1]?.[2])
  })
})
