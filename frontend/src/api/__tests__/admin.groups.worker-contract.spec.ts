import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post, put, deleteRequest } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  deleteRequest: vi.fn()
}))

vi.mock('@/api/client', () => ({
  apiClient: { get, post, put, delete: deleteRequest }
}))

describe('admin groups Cloudflare Worker contract', () => {
  beforeEach(() => {
    vi.resetModules()
    get.mockReset()
    post.mockReset()
    put.mockReset()
    deleteRequest.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '33333333-3333-4333-8333-333333333333'
    )
  })

  it('creates with an idempotency key and translates the legacy multiplier', async () => {
    const created = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      name: 'Primary',
      description: null,
      platform: 'openai',
      enabled: true,
      status: 'active',
      sort_order: 0,
      rate_multiplier_ppm: 1_250_000,
      rpm_limit: 60,
      catalog_mode: 'all_routable',
      group_type: 'subscription',
      is_exclusive: true,
      daily_quota_micros: 10_250_000,
      weekly_quota_micros: null,
      monthly_quota_micros: 120_000_000,
      control_version: 0
    }
    post.mockResolvedValueOnce({ data: created })
    const { create } = await import('@/api/admin/groups')

    await expect(create({
      name: 'Primary',
      description: null,
      platform: 'openai',
      rate_multiplier: 1.25,
      rpm_limit: 60,
      is_exclusive: true,
      subscription_type: 'subscription',
      daily_limit_usd: 10.25,
      weekly_limit_usd: null,
      monthly_limit_usd: 120
    })).resolves.toEqual({
      ...created,
      rate_multiplier: 1.25,
      subscription_type: 'subscription',
      daily_limit_usd: 10.25,
      weekly_limit_usd: null,
      monthly_limit_usd: 120
    })

    expect(post).toHaveBeenCalledWith('/admin/groups', {
      name: 'Primary',
      description: null,
      platform: 'openai',
      rate_multiplier_ppm: 1_250_000,
      rpm_limit: 60,
      is_exclusive: true,
      group_type: 'subscription',
      daily_quota_micros: 10_250_000,
      weekly_quota_micros: null,
      monthly_quota_micros: 120_000_000
    }, {
      headers: {
        'Idempotency-Key': 'admin-group-create-33333333-3333-4333-8333-333333333333'
      }
    })
  })

  it('round-trips image task policy and exact image prices through Worker integer fields', async () => {
    const created = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      name: 'Gemini Images',
      platform: 'gemini',
      enabled: true,
      status: 'active',
      rate_multiplier_ppm: 1_000_000,
      group_type: 'standard',
      is_exclusive: false,
      allow_image_generation: true,
      allow_batch_image_generation: true,
      image_rate_independent: true,
      image_rate_multiplier_ppm: 1_250_000,
      batch_image_discount_multiplier_ppm: 500_000,
      batch_image_hold_multiplier_ppm: 600_000,
      image_price_1k_micros: 20_000,
      image_price_2k_micros: 30_000,
      image_price_4k_micros: null,
      control_version: 0
    }
    post.mockResolvedValueOnce({ data: created })
    const { create } = await import('@/api/admin/groups')

    await expect(create({
      name: 'Gemini Images',
      platform: 'gemini',
      is_exclusive: false,
      allow_image_generation: true,
      allow_batch_image_generation: true,
      image_rate_independent: true,
      image_rate_multiplier: 1.25,
      batch_image_discount_multiplier: 0.5,
      batch_image_hold_multiplier: 0.6,
      image_price_1k: 0.02,
      image_price_2k: 0.03,
      image_price_4k: null
    })).resolves.toMatchObject({
      allow_image_generation: true,
      allow_batch_image_generation: true,
      image_rate_multiplier: 1.25,
      batch_image_discount_multiplier: 0.5,
      batch_image_hold_multiplier: 0.6,
      image_price_1k: 0.02,
      image_price_2k: 0.03,
      image_price_4k: null
    })

    expect(post).toHaveBeenCalledWith('/admin/groups', expect.objectContaining({
      allow_image_generation: true,
      allow_batch_image_generation: true,
      image_rate_independent: true,
      image_rate_multiplier_ppm: 1_250_000,
      batch_image_discount_multiplier_ppm: 500_000,
      batch_image_hold_multiplier_ppm: 600_000,
      image_price_1k_micros: 20_000,
      image_price_2k_micros: 30_000,
      image_price_4k_micros: null
    }), expect.any(Object))
  })

  it('uses the listed control version for updates and only sends supported fields', async () => {
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    get.mockResolvedValueOnce({
      data: {
        items: [{ id, name: 'Primary', control_version: 4 }],
        total: 1,
        page: 1,
        page_size: 20,
        pages: 1
      }
    })
    put.mockResolvedValueOnce({ data: { id, name: 'Renamed', control_version: 5 } })
    const { list, update } = await import('@/api/admin/groups')
    await list()

    await update(id, {
      name: 'Renamed',
      status: 'inactive',
      rate_multiplier: 0.8,
      rpm_limit: 90,
      is_exclusive: false,
      subscription_type: 'subscription',
      daily_limit_usd: 10,
      weekly_limit_usd: null
    })

    expect(put).toHaveBeenCalledWith(`/admin/groups/${id}`, {
      name: 'Renamed',
      enabled: false,
      rate_multiplier_ppm: 800_000,
      rpm_limit: 90,
      is_exclusive: false,
      group_type: 'subscription',
      daily_quota_micros: 10_000_000,
      weekly_quota_micros: null
    }, {
      headers: {
        'Idempotency-Key': 'admin-group-update-33333333-3333-4333-8333-333333333333',
        'If-Match': '"4"'
      }
    })
  })

  it('rejects invalid quota amounts before sending a request', async () => {
    const { create } = await import('@/api/admin/groups')

    await expect(create({
      name: 'Invalid quota',
      subscription_type: 'subscription',
      daily_limit_usd: -1
    })).rejects.toMatchObject({ code: 'invalid_group_quota' })
    expect(post).not.toHaveBeenCalled()
  })

  it('uses the dedicated idempotent Worker contract for per-user RPM overrides', async () => {
    get.mockResolvedValueOnce({
      data: [{
        user_id: 'user-uuid',
        user_name: 'Alice',
        user_email: 'alice@example.test',
        user_notes: '',
        user_status: 'active',
        rpm_override: 120,
      }],
    })
    put.mockResolvedValueOnce({ data: { message: 'RPM overrides updated', updated: 1 } })
    deleteRequest.mockResolvedValueOnce({ data: { message: 'RPM overrides cleared', deleted: 1 } })
    const {
      batchSetGroupRPMOverrides,
      clearGroupRPMOverrides,
      getGroupRPMOverrides,
    } = await import('@/api/admin/groups')

    await expect(getGroupRPMOverrides(7)).resolves.toHaveLength(1)
    await batchSetGroupRPMOverrides(7, [{ user_id: 42, rpm_override: 120 }])
    await clearGroupRPMOverrides(7)

    expect(get).toHaveBeenCalledWith('/admin/groups/7/rpm-overrides')
    expect(put).toHaveBeenCalledWith('/admin/groups/7/rpm-overrides', {
      entries: [{ user_id: '42', rpm_override: 120 }],
    }, {
      headers: {
        'Idempotency-Key': 'admin-group-rpm-put-33333333-3333-4333-8333-333333333333',
      },
    })
    expect(deleteRequest).toHaveBeenCalledWith('/admin/groups/7/rpm-overrides', {
      headers: {
        'Idempotency-Key': 'admin-group-rpm-clear-33333333-3333-4333-8333-333333333333',
      },
    })
  })

  it('soft-disables with the cached version instead of expecting a legacy message', async () => {
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    get.mockResolvedValueOnce({ data: { id, name: 'Primary', control_version: 2 } })
    deleteRequest.mockResolvedValueOnce({
      data: { id, name: 'Primary', enabled: false, status: 'inactive', control_version: 3 }
    })
    const { deleteGroup, getById } = await import('@/api/admin/groups')
    await getById(id)

    await expect(deleteGroup(id)).resolves.toMatchObject({ id, status: 'inactive' })
    expect(deleteRequest).toHaveBeenCalledWith(`/admin/groups/${id}`, {
      headers: {
        'Idempotency-Key': 'admin-group-disable-33333333-3333-4333-8333-333333333333',
        'If-Match': '"2"'
      }
    })
  })

  it('blocks every legacy-only group route before an HTTP request is sent', async () => {
    const groups = await import('@/api/admin/groups')

    await expect(groups.getLiveCapability()).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.duplicate(1)).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.getStats(1)).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.getGroupApiKeys(1)).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.listCompositeRoutes(1)).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.createCompositeRoute(1, {} as never)).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.updateCompositeRoute(1, 2, {} as never)).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.deleteCompositeRoute(1, 2)).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.previewCompositeRoute(1, {} as never)).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.getGroupRateMultipliers(1)).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.clearGroupRateMultipliers(1)).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.batchSetGroupRateMultipliers(1, [])).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.updateSortOrder([])).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.getUsageSummary()).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.getCapacitySummary()).rejects.toMatchObject({ code: 'worker_feature_not_supported' })

    expect(get).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
    expect(deleteRequest).not.toHaveBeenCalled()
  })
})
