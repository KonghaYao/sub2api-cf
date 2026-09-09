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

  it('adapts and updates group model output-token fields with Worker concurrency headers', async () => {
    get.mockResolvedValueOnce({
      data: [{
        group_id: 42,
        model_id: 7,
        public_name: 'gpt-test',
        upstream_name: 'gpt-test',
        endpoint: 'responses',
        enabled: true,
        catalog_visible: true,
        sort_order: 0,
        max_output_tokens: '65536',
        default_max_output_tokens: '32768',
        control_version: '3'
      }]
    })
    put.mockResolvedValueOnce({
      data: {
        group_id: '42', model_id: '7', public_name: 'gpt-test', upstream_name: 'gpt-test',
        endpoint: 'responses', enabled: true, catalog_visible: true, sort_order: 0,
        max_output_tokens: 65536, default_max_output_tokens: 32768, control_version: 4
      }
    })
    const { listGroupModels, updateGroupModel } = await import('@/api/admin/groups')

    const [model] = await listGroupModels(42)
    expect(model).toMatchObject({
      group_id: '42', model_id: '7', max_output_tokens: 65536,
      default_max_output_tokens: 32768, control_version: 3
    })
    await updateGroupModel(42, model, {
      max_output_tokens: 65536,
      default_max_output_tokens: 32768
    })

    expect(put).toHaveBeenCalledWith(
      '/admin/groups/42/models/7',
      { max_output_tokens: 65536, default_max_output_tokens: 32768, expected_control_version: 3 },
      { headers: { 'Idempotency-Key': expect.stringContaining('admin-group-model-put-') } }
    )
  })

  it('publishes a group model price with the model concurrency version', async () => {
    post.mockResolvedValueOnce({
      data: {
        id: 'price-1', group_id: '42', model_id: '7', version: 1, active: true,
        input_micros_per_million: 1_000_000, output_micros_per_million: 2_000_000,
        cache_read_micros_per_million: 100_000, per_request_micros: 0,
        minimum_reservation_micros: 1
      }
    })
    const { publishGroupModelPrice } = await import('@/api/admin/groups')
    const model = {
      group_id: '42', model_id: '7', public_name: 'gpt-test', upstream_name: 'gpt-test',
      endpoint: 'responses', enabled: true, catalog_visible: true, sort_order: 0,
      max_output_tokens: 65536, default_max_output_tokens: 32768, price: null, control_version: 3
    }

    await publishGroupModelPrice(42, model, {
      input_micros_per_million: 1_000_000,
      output_micros_per_million: 2_000_000,
      cache_read_micros_per_million: 100_000,
      per_request_micros: 0,
      minimum_reservation_micros: 1
    })

    expect(post).toHaveBeenCalledWith(
      '/admin/groups/42/models/7/prices',
      {
        input_micros_per_million: 1_000_000,
        output_micros_per_million: 2_000_000,
        cache_read_micros_per_million: 100_000,
        per_request_micros: 0,
        minimum_reservation_micros: 1,
        expected_control_version: 3
      },
      { headers: { 'Idempotency-Key': expect.stringContaining('admin-group-model-price-publish-') } }
    )
  })

  it('preserves advanced fields and explicit clears in create and update payloads', async () => {
    const projection = { id: 'group-opaque', name: 'Full', control_version: 0 }
    post.mockResolvedValue({ data: projection })
    put.mockResolvedValue({ data: { ...projection, control_version: 1 } })
    const { create, update } = await import('@/api/admin/groups')
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    await create({ name: 'Full', max_reasoning_effort: 'high', supported_model_scopes: ['text'], allow_live: true })
    expect(post.mock.calls[0][1]).toMatchObject({ max_reasoning_effort: 'high', supported_model_scopes: ['text'], allow_live: true })
    await update('group-opaque' as unknown as number, { supported_model_scopes: [], model_routing: null })
    expect(put.mock.calls[0][1]).toMatchObject({ supported_model_scopes: [], model_routing: null })
  })

  it.each(['openai', 'anthropic'] as const)('strips dispatch form fields while preserving nested config for %s create and update', async (platform) => {
    const projection = { id: 'dispatch-group', name: 'Dispatch', control_version: 0 }
    post.mockResolvedValue({ data: projection })
    put.mockResolvedValue({ data: { ...projection, control_version: 1 } })
    const { create, update } = await import('@/api/admin/groups')
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const config = {
      opus_mapped_model: 'gpt-5.4',
      sonnet_mapped_model: 'gpt-5.3-codex',
      haiku_mapped_model: 'gpt-5.4-mini',
      exact_model_mappings: { 'claude-opus-4-6': 'gpt-5.4' }
    }
    // GroupsView spreads these local form fields alongside the serialized config.
    const form = {
      name: 'Dispatch', platform,
      ...config,
      exact_model_mappings: [{ claude_model: 'claude-opus-4-6', target_model: 'gpt-5.4' }],
      messages_dispatch_model_config: platform === 'openai' ? config : undefined
    }
    await create(form)
    await update('dispatch-group', form)
    for (const payload of [post.mock.calls[0][1], put.mock.calls[0][1]]) {
      for (const field of Object.keys(config)) expect(payload).not.toHaveProperty(field)
      expect(payload.messages_dispatch_model_config).toEqual(form.messages_dispatch_model_config)
      expect(payload.name).toBe('Dispatch')
    }
  })

  it('omits empty legacy filters from the bounded Worker list request', async () => {
    get.mockResolvedValueOnce({
      data: { items: [], total: 0, page: 1, page_size: 20, pages: 0 }
    })
    const { list } = await import('@/api/admin/groups')
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)

    await list(1, 20, { status: '' as 'active' })

    expect(get).toHaveBeenCalledWith('/admin/groups', {
      params: { page: 1, page_size: 20 },
      signal: undefined
    })
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

  it('sorts opaque IDs with loaded versions and remembers the returned versions', async () => {
    const groups = await import('@/api/admin/groups')
    post.mockResolvedValueOnce({ data: { id: 'opaque-group', name: 'Sort', control_version: 3 } })
    await groups.create({ name: 'Sort' })
    put.mockResolvedValue({ data: { message: 'saved', updates: [{ id: 'opaque-group', control_version: 4 }] } })
    await groups.updateSortOrder([{ id: 'opaque-group' as unknown as number, sort_order: 2 }])
    expect(put.mock.calls[0][1]).toEqual({ updates: [{ id: 'opaque-group', sort_order: 2, control_version: 3 }] })
    await groups.updateSortOrder([{ id: 'opaque-group' as unknown as number, sort_order: 1 }])
    expect(put.mock.calls[1][1]).toEqual({ updates: [{ id: 'opaque-group', sort_order: 1, control_version: 4 }] })
  })

  it('loads group keys with opaque IDs and original pagination on Worker', async () => {
    const result = { items: [{ id: 'key-opaque', group_id: 'group-opaque' }], total: 1, page: 2, page_size: 10, pages: 1 }
    get.mockResolvedValueOnce({ data: result })
    const groups = await import('@/api/admin/groups')
    expect(await groups.getGroupApiKeys('group-opaque', 2, 10)).toEqual(result)
    expect(get).toHaveBeenCalledWith('/admin/groups/group-opaque/api-keys', { params: { page: 2, page_size: 10 } })
  })

  it('blocks only group routes that the Worker does not implement', async () => {
    const groups = await import('@/api/admin/groups')

    await expect(groups.getLiveCapability()).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(groups.getStats(1)).rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    expect(get).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
    expect(deleteRequest).not.toHaveBeenCalled()
  })

  it('uses the Worker composite-route endpoints with cached route CAS versions', async () => {
    const route = {
      id: 'route-opaque', public_model: 'gpt-public', match_type: 'exact',
      target_platform: 'openai', upstream_model: 'gpt-upstream', endpoint: 'responses',
      priority: 10, enabled: true, notes: '', control_version: 4,
    }
    get.mockResolvedValueOnce({ data: [route] })
    post.mockResolvedValue({ data: route })
    put.mockResolvedValueOnce({ data: { ...route, control_version: 5 } })
    deleteRequest.mockResolvedValueOnce({ data: { message: 'Composite route deleted successfully' } })
    const groups = await import('@/api/admin/groups')

    await groups.listCompositeRoutes('group-opaque')
    await groups.previewCompositeRoute('group-opaque', { model: 'gpt-public', endpoint: 'responses' } as never)
    await groups.updateCompositeRoute('group-opaque', 'route-opaque', route as never)
    await groups.deleteCompositeRoute('group-opaque', 'route-opaque')

    expect(get).toHaveBeenCalledWith('/admin/groups/group-opaque/composite-routes')
    expect(post).toHaveBeenCalledWith('/admin/groups/group-opaque/composite-routes/preview', {
      model: 'gpt-public', endpoint: 'responses',
    })
    expect(put).toHaveBeenCalledWith('/admin/groups/group-opaque/composite-routes/route-opaque', {
      ...route, expected_control_version: 4,
    }, { headers: { 'Idempotency-Key': 'composite-route-update-33333333-3333-4333-8333-333333333333' } })
    expect(deleteRequest).toHaveBeenCalledWith('/admin/groups/group-opaque/composite-routes/route-opaque', {
      data: { expected_control_version: 4 },
      headers: { 'Idempotency-Key': 'composite-route-delete-33333333-3333-4333-8333-333333333333' },
    })
  })

  it('keeps null capacity dimensions explicit instead of coercing them to zero', async () => {
    get.mockResolvedValueOnce({ data: [{ group_id: 'opaque', concurrency_status: 'known', concurrency_used: 2,
      concurrency_max: 4, sessions_status: 'unknown', sessions_used: null, sessions_max: null,
      rpm_status: 'unknown', rpm_used: null, rpm_max: null }] })
    const { getCapacitySummary } = await import('@/api/admin/groups')
    await expect(getCapacitySummary()).resolves.toMatchObject([{ group_id: 'opaque', sessions_used: null, rpm_used: null }])
    expect(get).toHaveBeenCalledWith('/admin/groups/capacity-summary')
  })
})
