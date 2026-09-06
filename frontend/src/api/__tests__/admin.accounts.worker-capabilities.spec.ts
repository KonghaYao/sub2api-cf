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
      platform: 'toString',
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

  it.each(['openai', 'anthropic', 'gemini', 'codex'])(
    'forwards the supported %s Worker platform filter',
    async (platform) => {
      get.mockResolvedValueOnce({ data: { items: [], total: 0, page: 1, page_size: 20, pages: 0 } })
      const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
      setCloudflareWorkerContractActive(true)
      const { list } = await import('@/api/admin/accounts')

      await list(1, 20, { platform })

      expect(get).toHaveBeenCalledWith('/admin/accounts', {
        params: { page: 1, page_size: 20, platform },
        signal: undefined,
      })
    }
  )

  it.each([
    ['openai', 'openai', 'bearer'],
    ['anthropic', 'anthropic', 'x-api-key'],
    ['gemini', 'gemini', 'x-goog-api-key'],
    ['codex', 'codex', 'bearer'],
  ] as const)(
    'adapts the %s Worker account tuple without losing provider metadata',
    async (platform, protocol, authScheme) => {
      get.mockResolvedValueOnce({
        data: {
          id: `${platform}-uuid`,
          name: `${platform} primary`,
          platform,
          protocol,
          auth_scheme: authScheme,
          base_url: `https://${platform}.example.test`,
          provider_config: platform === 'codex' ? { account_id: 'acct_codex' } : {},
          provider_account_metadata: {
            quota: { status: 'unsupported', value: null },
            tier: { status: 'unsupported', value: null },
            privacy: { status: 'unsupported', value: null },
          },
          enabled: true,
          max_concurrency: 6,
          rate_multiplier: 1.25,
          control_version: 3,
          created_at_ms: 1_788_451_200_000,
          updated_at_ms: 1_788_451_260_000,
          group_links: [{ group_id: `${platform}-group`, priority: 2, weight: 1 }],
          model_capabilities: [{ model_id: `${platform}-model`, responses: true }],
        },
      })
      const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
      setCloudflareWorkerContractActive(true)
      const { getById } = await import('@/api/admin/accounts')

      const account = await getById(`${platform}-uuid`)

      expect(account).toMatchObject({
        id: `${platform}-uuid`,
        platform,
        protocol,
        auth_scheme: authScheme,
        provider_config: platform === 'codex' ? { account_id: 'acct_codex' } : {},
        type: 'apikey',
        concurrency: 6,
        rate_multiplier: 1.25,
        priority: 2,
        status: 'active',
        group_ids: [`${platform}-group`],
        provider_account_metadata: {
          quota: { status: 'unsupported', value: null },
          tier: { status: 'unsupported', value: null },
          privacy: { status: 'unsupported', value: null },
        },
      })
      expect(account).not.toHaveProperty('quota_limit')
    }
  )

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

  it('keeps the Worker Codex provider_config while removing unsupported fields', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { create } = await import('@/api/admin/accounts')
    post.mockResolvedValueOnce({ data: {} })

    await create({
      name: 'codex primary',
      platform: 'codex',
      protocol: 'codex',
      auth_scheme: 'bearer',
      type: 'apikey',
      base_url: 'https://chatgpt.com',
      api_key: 'secret-key',
      provider_config: { account_id: 'acct_codex' },
      notes: 'legacy-only',
    } as never)

    expect(post.mock.calls[0]?.[1]).toMatchObject({
      platform: 'codex',
      provider_config: { account_id: 'acct_codex' },
    })
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('notes')
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
    }, {
      headers: { 'If-Match': '"7"' },
    })
  })

  it('does not expose the absent per-account schedulable route in Worker mode', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { setSchedulable } = await import('@/api/admin/accounts')

    await expect(setSchedulable(7, false)).rejects.toThrow('not supported by the Worker contract')
    expect(post).not.toHaveBeenCalled()
  })

  it('sends versioned Worker bulk status and health probe operations with idempotency keys', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { bulkSetEnabled, queueHealthProbes } = await import('@/api/admin/accounts')
    post.mockResolvedValue({ data: { results: [] } })
    const accounts = [
      { id: 'account-a', control_version: 2 },
      { id: 'account-b', control_version: 4 },
    ]

    await bulkSetEnabled(accounts, false)
    await queueHealthProbes(accounts)

    expect(post).toHaveBeenNthCalledWith(1, '/admin/accounts/bulk-update', {
      accounts: [
        { id: 'account-a', expected_control_version: 2 },
        { id: 'account-b', expected_control_version: 4 },
      ],
      enabled: false,
    }, { headers: { 'Idempotency-Key': 'admin-account-bulk-status-33333333-3333-4333-8333-333333333333' } })
    expect(post).toHaveBeenNthCalledWith(2, '/admin/accounts/health-probes', {
      accounts: [
        { id: 'account-a', expected_control_version: 2 },
        { id: 'account-b', expected_control_version: 4 },
      ],
    }, { headers: { 'Idempotency-Key': 'admin-account-health-probes-33333333-3333-4333-8333-333333333333' } })
  })

  it('reuses the Worker batch operation key after an ambiguous failure', async () => {
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { bulkSetEnabled } = await import('@/api/admin/accounts')
    const accounts = [{ id: 'account-a', control_version: 2 }]
    post.mockRejectedValueOnce(new Error('response lost'))
    post.mockResolvedValueOnce({ data: { results: [] } })

    await expect(bulkSetEnabled(accounts, false)).rejects.toThrow('response lost')
    await bulkSetEnabled(accounts, false)

    expect(post.mock.calls[0]?.[2]).toEqual(post.mock.calls[1]?.[2])
  })

  it('preserves the public decimal account billing multiplier on Worker update', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { update } = await import('@/api/admin/accounts')

    await update('account-uuid', {
      rate_multiplier: 1.375,
      expected_control_version: 9,
    } as never)

    expect(put).toHaveBeenCalledWith('/admin/accounts/account-uuid', {
      rate_multiplier: 1.375,
    }, {
      headers: { 'If-Match': '"9"' },
    })
  })

  it('requests account statistics with a Worker UUID without numeric coercion', async () => {
    get.mockResolvedValueOnce({ data: { history: [], summary: {}, models: [] } })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { getStats } = await import('@/api/admin/accounts')

    await getStats('account-uuid', 30, 'Asia/Shanghai')

    expect(get).toHaveBeenCalledWith('/admin/accounts/account-uuid/stats', {
      params: { days: 30, timezone: 'Asia/Shanghai' },
    })
  })

  it('returns the partial Worker health-check snapshot and preserves its UUID', async () => {
    post.mockResolvedValueOnce({
      data: {
        id: 'codex-uuid',
        config_version: 3,
        control_version: 4,
        health_status: 'healthy',
        last_checked_at_ms: 1_788_451_260_000,
        last_latency_ms: 37,
        last_health_error: null,
      },
    })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { testAccount } = await import('@/api/admin/accounts')

    const result = await testAccount('codex-uuid')

    expect(post).toHaveBeenCalledWith('/admin/accounts/codex-uuid/test')
    expect(result).toMatchObject({
      id: 'codex-uuid',
      config_version: 3,
      control_version: 4,
      health_status: 'healthy',
      success: true,
      latency_ms: 37,
    })
    expect(result).not.toHaveProperty('name')
    expect(result).not.toHaveProperty('platform')
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
