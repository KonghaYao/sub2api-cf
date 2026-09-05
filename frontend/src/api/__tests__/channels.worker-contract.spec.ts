import { beforeEach, describe, expect, it, vi } from 'vitest'

const { deleteRequest, get, post, put } = vi.hoisted(() => ({
  deleteRequest: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiClient: { delete: deleteRequest, get, post, put },
}))

describe('channels Cloudflare Worker contract', () => {
  beforeEach(async () => {
    vi.resetModules()
    deleteRequest.mockReset()
    get.mockReset()
    post.mockReset()
    put.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '66666666-6666-4666-8666-666666666666',
    )
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
  })

  it('keeps available-channel group UUIDs as strings', async () => {
    get.mockResolvedValueOnce({
      data: [{
        name: 'Primary',
        description: '',
        platforms: [{
          platform: 'openai',
          groups: [{
            id: 'group-uuid',
            name: 'OpenAI',
            platform: 'openai',
            subscription_type: 'standard',
            rate_multiplier: 1,
            peak_rate_enabled: false,
            peak_start: '',
            peak_end: '',
            peak_rate_multiplier: 1,
            is_exclusive: false,
          }],
          supported_models: [],
        }],
      }],
    })
    const { getAvailable } = await import('@/api/channels')

    const channels = await getAvailable()

    expect(channels[0].platforms[0].groups[0].id).toBe('group-uuid')
    expect(get).toHaveBeenCalledWith('/channels/available', { signal: undefined })
  })

  it('adapts exact Worker prices and remembers the channel control version', async () => {
    get.mockResolvedValueOnce({
      data: {
        items: [{
          id: 'channel-uuid',
          name: 'Primary',
          description: 'Main channel',
          status: 'disabled',
          billing_model_source: 'channel_mapped',
          restrict_models: true,
          features_config: {},
          group_ids: ['group-uuid'],
          model_pricing: [{
            id: 'pricing-uuid',
            platform: 'openai',
            models: ['gpt-5'],
            billing_mode: 'token',
            input_micros_per_million: 1_000_000,
            output_micros_per_million: 2_000_000,
            cache_write_micros_per_million: null,
            cache_write_1h_micros_per_million: null,
            cache_read_micros_per_million: 250_000,
            fast_multiplier_ppm: 1_250_000,
            flex_multiplier_ppm: null,
            image_input_micros_per_million: null,
            image_output_micros_per_million: null,
            per_request_micros: null,
            intervals: [{
              id: 'interval-uuid',
              min_tokens: 0,
              max_tokens: 200_000,
              tier_label: 'standard',
              input_micros_per_million: 800_000,
              output_micros_per_million: 1_600_000,
              cache_write_micros_per_million: null,
              cache_write_1h_micros_per_million: null,
              cache_read_micros_per_million: null,
              input_multiplier_ppm: 800_000,
              output_multiplier_ppm: null,
              cache_write_multiplier_ppm: null,
              cache_read_multiplier_ppm: null,
              per_request_micros: null,
              sort_order: 0,
            }],
            time_pricing: {
              timezone: 'UTC',
              weekdays_only: false,
              periods: [{ start_time: '09:00', end_time: '11:00', multiplier_ppm: 1_500_000 }],
            },
          }],
          model_mapping: {},
          apply_pricing_to_account_stats: false,
          account_stats_pricing_rules: [],
          control_version: 4,
          created_at: '2026-09-03T16:00:00.000Z',
          updated_at: '2026-09-03T16:01:00.000Z',
        }],
        total: 1,
        page: 1,
        page_size: 20,
        pages: 1,
      },
    })
    const { list } = await import('@/api/admin/channels')

    const result = await list()

    expect(result.items[0]).toMatchObject({
      id: 'channel-uuid',
      status: 'disabled',
      group_ids: ['group-uuid'],
      created_at: '2026-09-03T16:00:00.000Z',
      updated_at: '2026-09-03T16:01:00.000Z',
      model_pricing: [{
        input_price: 0.000001,
        output_price: 0.000002,
        cache_read_price: 0.00000025,
        fast_multiplier: 1.25,
        time_pricing: {
          timezone: 'UTC',
          weekdays_only: false,
          periods: [{ start_time: '09:00', end_time: '11:00', multiplier: 1.5 }],
        },
        intervals: [expect.objectContaining({
          input_price: 0.0000008,
          output_price: 0.0000016,
          input_multiplier: 0.8,
        })],
      }],
    })
  })

  it('writes exact Worker units and concurrency headers while dropping unsupported stats rules', async () => {
    post.mockResolvedValueOnce({ data: {
      id: 'channel-uuid', name: 'Primary', description: '', status: 'active',
      billing_model_source: 'channel_mapped', restrict_models: false,
      features_config: {}, group_ids: ['group-uuid'], model_pricing: [],
      model_mapping: {}, apply_pricing_to_account_stats: false,
      account_stats_pricing_rules: [], control_version: 0,
      created_at: '2026-09-03T16:00:00.000Z', updated_at: '2026-09-03T16:00:00.000Z',
    } })
    const { create } = await import('@/api/admin/channels')

    await create({
      name: 'Primary',
      group_ids: ['group-uuid'],
      model_pricing: [{
        platform: 'openai', models: ['gpt-5'], billing_mode: 'token',
        input_price: 0.000001, output_price: 0.000002,
        cache_write_price: null, cache_write_1h_price: null,
        cache_read_price: 0.00000025, fast_multiplier: 1.25,
        flex_multiplier: null, image_input_price: null, image_output_price: null,
        per_request_price: null, intervals: [], time_pricing: {
          timezone: 'UTC', weekdays_only: false,
          periods: [{ start_time: '09:00', end_time: '11:00', multiplier: 1.5 }],
        },
      }],
      apply_pricing_to_account_stats: true,
      account_stats_pricing_rules: [{ name: 'legacy only', group_ids: [], account_ids: [], pricing: [] }],
    })

    expect(post).toHaveBeenCalledWith('/admin/channels', {
      name: 'Primary',
      group_ids: ['group-uuid'],
      model_pricing: [expect.objectContaining({
        input_micros_per_million: 1_000_000,
        output_micros_per_million: 2_000_000,
        cache_read_micros_per_million: 250_000,
        fast_multiplier_ppm: 1_250_000,
        time_pricing: {
          timezone: 'UTC', weekdays_only: false,
          periods: [{ start_time: '09:00', end_time: '11:00', multiplier_ppm: 1_500_000 }],
        },
      })],
    }, {
      headers: {
        'Idempotency-Key': 'admin-channel-create-66666666-6666-4666-8666-666666666666',
      },
    })
  })

  it('uses the loaded Worker version for update and delete', async () => {
    const workerChannel = {
      id: 'channel-uuid', name: 'Primary', description: '', status: 'active',
      billing_model_source: 'channel_mapped', restrict_models: false,
      features_config: {}, group_ids: [], model_pricing: [], model_mapping: {},
      apply_pricing_to_account_stats: false, account_stats_pricing_rules: [],
      control_version: 7, created_at: '1970-01-01T00:00:00.001Z', updated_at: '1970-01-01T00:00:00.001Z',
    }
    get.mockResolvedValueOnce({ data: workerChannel })
    put.mockResolvedValueOnce({ data: { ...workerChannel, name: 'Renamed', control_version: 8 } })
    deleteRequest.mockResolvedValueOnce({ data: { ...workerChannel, status: 'disabled', control_version: 9 } })
    const channels = await import('@/api/admin/channels')
    await channels.getById('channel-uuid')

    await channels.update('channel-uuid', { name: 'Renamed' })
    expect(put).toHaveBeenCalledWith('/admin/channels/channel-uuid', { name: 'Renamed' }, {
      headers: {
        'Idempotency-Key': 'admin-channel-update-66666666-6666-4666-8666-666666666666',
        'If-Match': '"7"',
      },
    })

    await channels.remove('channel-uuid')
    expect(deleteRequest).toHaveBeenCalledWith('/admin/channels/channel-uuid', {
      headers: {
        'Idempotency-Key': 'admin-channel-delete-66666666-6666-4666-8666-666666666666',
        'If-Match': '"8"',
      },
    })
  })

  it('rejects prices that cannot be represented by an exact Worker micro-unit', async () => {
    const { create } = await import('@/api/admin/channels')

    await expect(create({
      name: 'Fractional micro',
      model_pricing: [{
        platform: 'openai', models: ['gpt-5'], billing_mode: 'per_request',
        input_price: null, output_price: null, cache_write_price: null,
        cache_read_price: null, image_input_price: null, image_output_price: null,
        per_request_price: 0.0000004, intervals: [], time_pricing: null,
      }],
    })).rejects.toMatchObject({ code: 'invalid_channel_price' })
    expect(post).not.toHaveBeenCalled()
  })

  it('preserves the legacy transport contract when Worker mode is disabled', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(false)
    post.mockResolvedValueOnce({ data: { id: 12, name: 'Legacy' } })
    const { create } = await import('@/api/admin/channels')
    const request = { name: 'Legacy', group_ids: [42] }

    await create(request)

    expect(post).toHaveBeenCalledWith('/admin/channels', request)
  })
})
