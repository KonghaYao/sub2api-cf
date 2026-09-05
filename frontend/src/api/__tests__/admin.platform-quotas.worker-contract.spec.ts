import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, put } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))
vi.mock('@/api/client', () => ({ apiClient: { get, put } }))

describe('admin platform quota defaults Worker contract', () => {
  beforeEach(() => {
    get.mockReset()
    put.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '22222222-2222-4222-8222-222222222222'
    )
  })

  it('reads and CAS-replaces the five-platform signup matrix', async () => {
    const current = {
      schema_version: 1 as const,
      control_version: 3,
      platform_quotas: {
        anthropic: { daily_limit_usd: null, weekly_limit_usd: null, monthly_limit_usd: null },
        openai: { daily_limit_usd: 2, weekly_limit_usd: 10, monthly_limit_usd: 30 },
        gemini: { daily_limit_usd: null, weekly_limit_usd: null, monthly_limit_usd: null },
        antigravity: { daily_limit_usd: null, weekly_limit_usd: null, monthly_limit_usd: null },
        grok: { daily_limit_usd: null, weekly_limit_usd: null, monthly_limit_usd: null },
      },
      updated_at_ms: 100,
    }
    get.mockResolvedValueOnce({ data: current })
    put.mockResolvedValueOnce({ data: { ...current, control_version: 4 } })
    const { getPlatformQuotaDefaults, updatePlatformQuotaDefaults } =
      await import('@/api/admin/platformQuotas')

    const loaded = await getPlatformQuotaDefaults()
    const result = await updatePlatformQuotaDefaults(loaded.platform_quotas, loaded.control_version)

    expect(get).toHaveBeenCalledWith('/admin/platform-quota-defaults')
    expect(put).toHaveBeenCalledWith('/admin/platform-quota-defaults', {
      platform_quotas: current.platform_quotas,
    }, { headers: {
      'Idempotency-Key': 'admin-platform-quota-defaults-22222222-2222-4222-8222-222222222222',
      'If-Match': '"3"',
    } })
    expect(result.control_version).toBe(4)
  })
})
