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
      is_exclusive: false,
      subscription_type: 'subscription',
      daily_limit_usd: 10,
      weekly_limit_usd: null
    })

    expect(put).toHaveBeenCalledWith(`/admin/groups/${id}`, {
      name: 'Renamed',
      enabled: false,
      rate_multiplier_ppm: 800_000,
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
})
