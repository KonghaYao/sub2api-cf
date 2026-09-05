import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ apiClient: { get } }))

describe('user-visible Worker platform quota and model plaza contracts', () => {
  beforeEach(() => get.mockReset())

  it('preserves the versioned owner quota response for the dashboard', async () => {
    const payload = {
      schema_version: 1,
      control_version: 2,
      updated_at_ms: 100,
      platform_quotas: [{
        platform: 'openai', daily_limit_usd: 5, weekly_limit_usd: null,
        monthly_limit_usd: 30, daily_usage_usd: 1,
        weekly_usage_usd: 1, monthly_usage_usd: 1,
      }],
    }
    get.mockResolvedValueOnce({ data: payload })
    const { getMyPlatformQuotas } = await import('@/api/user')

    await expect(getMyPlatformQuotas()).resolves.toEqual(payload)
    expect(get).toHaveBeenCalledWith('/user/platform-quotas')
  })

  it('preserves opaque group IDs and public model aliases from the plaza', async () => {
    const payload = {
      description: 'Worker pricing',
      groups: [{
        id: 'group-uuid', name: 'Public', description: '', platform: 'openai',
        subscription_type: 'standard', rate_multiplier: 1,
        peak_rate_enabled: false, peak_start: '', peak_end: '', peak_rate_multiplier: 1,
        is_exclusive: false, image_rate_independent: false, image_rate_multiplier: 1,
        long_context_pricing_enabled: false,
        models: [{ name: 'friendly-alias', platform: 'openai', pricing: null, official_pricing: null }],
      }],
    }
    get.mockResolvedValueOnce({ data: payload })
    const { getModelPlaza } = await import('@/api/modelPlaza')
    const controller = new AbortController()

    await expect(getModelPlaza({ signal: controller.signal })).resolves.toEqual(payload)
    expect(get).toHaveBeenCalledWith('/model-plaza', { signal: controller.signal })
  })
})
