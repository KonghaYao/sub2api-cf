import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('@/api/client', () => ({ apiClient: { get, post } }))

import {
  enable,
  getStatus,
  regenerateRecoveryCodes,
  stepUp,
} from '@/api/totp'

describe('TOTP recovery-code Worker contract', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
  })

  it('keeps the remaining-code count and one-time enable handoff', async () => {
    get.mockResolvedValueOnce({ data: {
      enabled: true,
      enabled_at: 1_700_000_000,
      feature_enabled: true,
      recovery_codes_remaining: 9,
    } })
    post.mockResolvedValueOnce({ data: {
      success: true,
      recovery_codes: ['ABCD-EFGH-JKMN-PQRS'],
    } })

    await expect(getStatus()).resolves.toMatchObject({ recovery_codes_remaining: 9 })
    expect(get).toHaveBeenCalledWith('/user/totp/status')
    await expect(enable({ totp_code: '123456', setup_token: 'setup-token' })).resolves.toEqual({
      success: true,
      recovery_codes: ['ABCD-EFGH-JKMN-PQRS'],
    })
  })

  it('selects exactly one step-up credential field and rotates via the Worker route', async () => {
    post
      .mockResolvedValueOnce({ data: { verified: true, expires_in: 900 } })
      .mockResolvedValueOnce({ data: { verified: true, expires_in: 900 } })
      .mockResolvedValueOnce({ data: {
        success: true,
        recovery_codes: ['BCDE-FGHJ-KMNP-QRST'],
      } })

    await stepUp('123456')
    expect(post).toHaveBeenNthCalledWith(1, '/user/totp/step-up', { code: '123456' })
    await stepUp('ABCD-EFGH-JKMN-PQRS')
    expect(post).toHaveBeenNthCalledWith(2, '/user/totp/step-up', {
      recovery_code: 'ABCD-EFGH-JKMN-PQRS',
    })
    await expect(regenerateRecoveryCodes()).resolves.toMatchObject({
      recovery_codes: ['BCDE-FGHJ-KMNP-QRST'],
    })
    expect(post).toHaveBeenNthCalledWith(3, '/user/totp/recovery-codes/regenerate', {})
  })
})
