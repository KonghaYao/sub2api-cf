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

describe('admin accounts Worker transport capabilities', () => {
  beforeEach(() => {
    vi.resetModules()
    post.mockReset()
    put.mockReset()
    deleteRequest.mockReset()
    get.mockReset()
    post.mockResolvedValue({ data: {} })
    put.mockResolvedValue({ data: {} })
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '33333333-3333-4333-8333-333333333333'
    )
  })

  it('sends only non-empty Worker-supported list filters', async () => {
    get.mockResolvedValueOnce({ data: { items: [], total: 0, page: 1, page_size: 20, pages: 0 } })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { list } = await import('@/api/admin/accounts')

    await list(1, 20, {
      platform: '',
      status: '',
      type: 'oauth',
      group: 'legacy-group',
      search: '  ',
      include_scheduler_score: '1',
    })

    expect(get).toHaveBeenCalledWith('/admin/accounts', {
      params: { page: 1, page_size: 20 },
      signal: undefined,
    })
  })

  it('never sends proxy or TLS fingerprint fields on create', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { create } = await import('@/api/admin/accounts')

    post.mockResolvedValueOnce({
      data: {
        id: 'account-uuid',
        name: 'primary',
        platform: 'openai',
        protocol: 'openai',
        auth_scheme: 'bearer',
        base_url: 'https://api.openai.com/v1',
        enabled: true,
        max_concurrency: 4,
        control_version: 0,
        created_at_ms: 1_788_451_200_000,
        updated_at_ms: 1_788_451_200_000,
        group_links: [],
        model_capabilities: [{ model_id: 'model-1', responses: true }],
      },
    })

    const account = await create({
      name: 'primary',
      platform: 'openai',
      protocol: 'openai',
      auth_scheme: 'bearer',
      type: 'apikey',
      base_url: 'https://api.openai.com/v1',
      api_key: 'secret-key',
      enabled: true,
      max_concurrency: 4,
      group_links: [],
      model_capabilities: [{ model_id: 'model-1', responses: true }],
      proxy_id: 9,
      extra: {
        enable_tls_fingerprint: true,
        tls_fingerprint_profile_id: 2,
      },
    } as never)

    expect(post).toHaveBeenCalledWith('/admin/accounts', {
      name: 'primary',
      platform: 'openai',
      protocol: 'openai',
      auth_scheme: 'bearer',
      type: 'apikey',
      base_url: 'https://api.openai.com/v1',
      api_key: 'secret-key',
      enabled: true,
      max_concurrency: 4,
      group_links: [],
      model_capabilities: [{ model_id: 'model-1', responses: true }],
    }, {
      headers: {
        'Idempotency-Key': 'admin-account-create-33333333-3333-4333-8333-333333333333',
      },
    })
    expect(account.id).toBe('account-uuid')
    expect(account.type).toBe('apikey')
    expect(account.concurrency).toBe(4)
  })

  it('reuses a Worker create idempotency key after an ambiguous failure', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { create } = await import('@/api/admin/accounts')
    const request = {
      name: 'retryable',
      platform: 'openai',
      protocol: 'openai',
      auth_scheme: 'bearer',
      type: 'apikey',
      base_url: 'https://api.openai.com/v1',
      api_key: 'secret-key',
      enabled: true,
      max_concurrency: 4,
      group_links: [{ group_id: 'group-1', priority: 0, weight: 1 }],
      model_capabilities: [{ model_id: 'model-1', responses: true }],
    }
    post.mockRejectedValueOnce(new Error('response lost'))
    post.mockResolvedValueOnce({ data: {} })

    await expect(create(request as never)).rejects.toThrow('response lost')
    await create(request as never)

    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0]?.[2]).toEqual(post.mock.calls[1]?.[2])
  })

  it('never sends proxy or fingerprint fields on update', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { update } = await import('@/api/admin/accounts')

    await update(1, {
      proxy_id: 0,
      name: 'updated',
      expected_control_version: 7,
      extra: { utls: 'chrome', ja3: 'fingerprint', keep: 'yes' },
    } as never)

    expect(put).toHaveBeenCalledWith('/admin/accounts/1', {
      name: 'updated',
      expected_control_version: 7,
    }, {
      headers: { 'If-Match': '"7"' },
    })
  })

  it('uses the UUID and control version when disabling a Worker account', async () => {
    deleteRequest.mockResolvedValueOnce({ data: { id: 'account-uuid', auth_scheme: 'bearer' } })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { deleteAccount } = await import('@/api/admin/accounts')

    await deleteAccount('account-uuid', 8)

    expect(deleteRequest).toHaveBeenCalledWith('/admin/accounts/account-uuid', {
      headers: { 'If-Match': '"8"' },
    })
  })
})
