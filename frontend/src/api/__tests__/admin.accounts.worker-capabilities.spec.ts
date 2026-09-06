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

  it('forwards every account-list filter and sort field to the Worker unchanged', async () => {
    get.mockResolvedValueOnce({ data: { items: [], total: 0, page: 1, page_size: 20, pages: 0 } })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { list } = await import('@/api/admin/accounts')

    await list(1, 20, {
      platform: 'toString',
      status: '',
      type: 'oauth',
      group: 'worker-group',
      search: '  ',
      include_scheduler_score: '1',
      sort_by: 'rate_multiplier',
      sort_order: 'desc',
    })

    expect(get).toHaveBeenCalledWith('/admin/accounts', {
      params: {
        page: 1,
        page_size: 20,
        platform: 'toString',
        status: '',
        type: 'oauth',
        group: 'worker-group',
        search: '  ',
        include_scheduler_score: '1',
        sort_by: 'rate_multiplier',
        sort_order: 'desc',
      },
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

  it('preserves compatibility fields already projected by the Worker', async () => {
    const projected = {
      id: 'account-opaque-id',
      name: 'Preserved projection',
      platform: 'openai',
      protocol: 'openai',
      auth_scheme: 'bearer',
      base_url: 'https://worker.example/v1',
      enabled: true,
      max_concurrency: 4,
      type: 'oauth',
      credentials: { base_url: 'https://compat.example/v1', organization: null },
      provider_config: { region: 'test-region', nullable: null },
      proxy_id: 'opaque-proxy',
      concurrency: 9,
      priority: 7,
      status: 'error',
      error_message: 'preserved health error',
      last_used_at: '2026-09-06T01:02:03.000Z',
      expires_at: 1_900_000_000,
      auto_pause_on_expired: true,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-02T00:00:00.000Z',
      group_ids: ['compat-group'],
      group_links: [{ group_id: 'canonical-group', priority: 2, weight: 1 }],
      schedulable: false,
      rate_limited_at: '2026-09-06T02:00:00.000Z',
      rate_limit_reset_at: '2026-09-06T03:00:00.000Z',
      overload_until: '2026-09-06T04:00:00.000Z',
      temp_unschedulable_until: '2026-09-06T05:00:00.000Z',
      temp_unschedulable_reason: 'maintenance',
      session_window_start: '2026-09-06T00:00:00.000Z',
      session_window_end: '2026-09-06T05:00:00.000Z',
      session_window_status: 'rejected',
    }
    get.mockResolvedValueOnce({ data: projected })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { getById } = await import('@/api/admin/accounts')

    await expect(getById('account-opaque-id')).resolves.toMatchObject(projected)
  })

  it('does not expose plaintext secrets from a Worker account response', async () => {
    get.mockResolvedValueOnce({
      data: {
        id: 'account-opaque-id',
        name: 'Safe projection',
        platform: 'openai',
        protocol: 'openai',
        auth_scheme: 'bearer',
        base_url: 'https://api.openai.com/v1',
        api_key: 'top-level-secret',
        credentials: {
          base_url: 'https://api.openai.com/v1',
          api_key: 'nested-secret',
          access_token: 'nested-access-token',
          organization: 'safe-organization',
        },
        credentials_status: { has_api_key: true },
        enabled: true,
        max_concurrency: 4,
        group_links: [],
      },
    })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { getById } = await import('@/api/admin/accounts')

    const account = await getById('account-opaque-id')
    expect(JSON.stringify(account)).not.toContain('top-level-secret')
    expect(JSON.stringify(account)).not.toContain('nested-secret')
    expect(JSON.stringify(account)).not.toContain('nested-access-token')
    expect(account.credentials).toEqual({
      base_url: 'https://api.openai.com/v1',
      organization: 'safe-organization',
    })
    expect(account.credentials_status).toEqual({ has_api_key: true })
  })

  it('forwards a complex original account DTO to Worker create without dropping UI fields', async () => {
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

    const request = {
      name: 'primary',
      platform: 'openai',
      protocol: 'openai',
      auth_scheme: 'bearer',
      type: 'apikey',
      base_url: 'https://api.openai.com/v1',
      api_key: 'secret-key',
      credentials: {
        base_url: 'https://legacy-openai.example/v1',
        api_key: 'legacy-secret-key',
        organization: null,
      },
      enabled: true,
      max_concurrency: 4,
      concurrency: 7,
      rate_multiplier: 1.25,
      notes: null,
      group_ids: ['group-legacy'],
      group_links: [{ group_id: 'group-1', priority: 2, weight: 3 }],
      model_capabilities: [{ model_id: 'model-1', responses: true, embeddings: false }],
      proxy_id: null,
      extra: {
        enable_tls_fingerprint: true,
        tls_fingerprint_profile_id: 2,
        nullable_override: null,
      },
    }
    const account = await create(request as never)

    expect(post).toHaveBeenCalledWith('/admin/accounts', request, {
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

  it('keeps the Worker Codex provider_config and UI-only fields', async () => {
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
    expect(post.mock.calls[0]?.[1]).toHaveProperty('notes', 'legacy-only')
  })

  it('forwards original update fields and clear values while moving only CAS metadata to the header', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { update } = await import('@/api/admin/accounts')

    const request = {
      proxy_id: null,
      name: 'updated',
      expected_control_version: 7,
      notes: null,
      credentials: { api_key: '', organization: null },
      extra: { utls: null, ja3: '', keep: 'yes' },
      group_ids: [],
      group_links: [{ group_id: 'group-2', priority: 0, weight: 1 }],
      model_capabilities: [{ model_id: 'model-2', responses: false }],
    }
    await update('account-opaque-id', request as never)

    expect(put).toHaveBeenCalledWith('/admin/accounts/account-opaque-id', {
      proxy_id: null,
      name: 'updated',
      notes: null,
      credentials: { api_key: '', organization: null },
      extra: { utls: null, ja3: '', keep: 'yes' },
      group_ids: [],
      group_links: [{ group_id: 'group-2', priority: 0, weight: 1 }],
      model_capabilities: [{ model_id: 'model-2', responses: false }],
    }, {
      headers: { 'If-Match': '"7"' },
    })
  })

  it('forwards complete account DTOs through Worker batch create and redacts returned secrets', async () => {
    const request = [{
      name: 'batch account',
      platform: 'openai',
      type: 'apikey',
      credentials: { base_url: 'https://batch.example/v1', api_key: 'request-secret' },
      notes: null,
      proxy_id: null,
      group_ids: ['group-opaque'],
      extra: { utls: null, retained: 'yes' },
    }]
    post.mockResolvedValueOnce({
      data: {
        success: 1,
        failed: 0,
        results: [{
          success: true,
          account: {
            id: 'account-opaque-id',
            name: 'batch account',
            platform: 'openai',
            protocol: 'openai',
            auth_scheme: 'bearer',
            enabled: true,
            max_concurrency: 4,
            credentials: { base_url: 'https://batch.example/v1', api_key: 'response-secret' },
            credentials_status: { has_api_key: true },
          },
        }],
      },
    })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { batchCreate } = await import('@/api/admin/accounts')

    const result = await batchCreate(request as never)

    expect(post).toHaveBeenCalledWith('/admin/accounts/batch', { accounts: request })
    expect(result.results[0]?.account?.id).toBe('account-opaque-id')
    expect(JSON.stringify(result)).not.toContain('response-secret')
    expect(result.results[0]?.account?.credentials_status).toEqual({ has_api_key: true })
  })

  it('forwards Worker bulk update fields and opaque account IDs unchanged', async () => {
    const request = {
      account_ids: ['account-a', 'account-b'],
      notes: null,
      proxy_id: null,
      credentials: { api_key: '', organization: null },
      extra: { ja3: '', retained: 'yes' },
    }
    post.mockResolvedValueOnce({ data: { success: 2, failed: 0, results: [] } })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { bulkUpdate } = await import('@/api/admin/accounts')

    await bulkUpdate(request)

    expect(post).toHaveBeenCalledWith('/admin/accounts/bulk-update', request)
  })

  it('keeps opaque account IDs and explicit credential clear values in batch updates', async () => {
    const request = {
      account_ids: ['account-a', 'account-b'],
      field: 'api_key',
      value: null,
    }
    post.mockResolvedValueOnce({ data: { success: 2, failed: 0, results: [] } })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { batchUpdateCredentials } = await import('@/api/admin/accounts')

    await batchUpdateCredentials(request)

    expect(post).toHaveBeenCalledWith('/admin/accounts/batch-update-credentials', request)
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

  it('queues exact per-model synthetic probe targets with retry-stable idempotency', async () => {
    const response = {
      total: 2,
      queued: 1,
      failed: 1,
      queued_ids: ['account-1'],
      failed_ids: ['account-2'],
      results: [
        {
          account_id: 'account-1', expected_control_version: 7,
          model_id: 'model-1', capability: 'responses', success: true,
          generation: 3, job_id: 'account-1:synthetic:model-1:responses:3',
        },
        {
          account_id: 'account-2', expected_control_version: 4,
          model_id: 'model-2', capability: 'embeddings', success: false,
          error: { code: 'account_version_conflict', message: 'Account changed; reload it and retry' },
        },
      ],
    }
    post.mockResolvedValueOnce({ data: response })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { queueSyntheticProbes } = await import('@/api/admin/accounts')
    const targets = response.results.map(({ success: _success, generation: _generation, job_id: _jobId, error: _error, ...target }) => target)

    await expect(queueSyntheticProbes(targets as never)).resolves.toEqual(response)
    expect(post).toHaveBeenCalledWith(
      '/admin/accounts/synthetic-probes',
      { targets },
      { headers: { 'Idempotency-Key': 'admin-account-synthetic-probes-33333333-3333-4333-8333-333333333333' } },
    )
  })

  it('rejects empty, duplicate and oversized synthetic targets before transport', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { queueSyntheticProbes } = await import('@/api/admin/accounts')
    const target = {
      account_id: 'account-1', expected_control_version: 7,
      model_id: 'model-1', capability: 'responses',
    }

    await expect(queueSyntheticProbes([])).rejects.toThrow(/between 1 and 25/)
    await expect(queueSyntheticProbes([target, target] as never)).rejects.toThrow(/duplicate/)
    await expect(queueSyntheticProbes(Array.from({ length: 26 }, (_, index) => ({
      ...target, model_id: `model-${index}`,
    })) as never)).rejects.toThrow(/between 1 and 25/)
    expect(post).not.toHaveBeenCalled()
  })

  it('reuses the synthetic probe idempotency key after an ambiguous failure', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { queueSyntheticProbes } = await import('@/api/admin/accounts')
    const targets = [{
      account_id: 'account-1', expected_control_version: 7,
      model_id: 'model-1', capability: 'responses',
    }]
    post
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ data: { total: 1, queued: 1, failed: 0, queued_ids: ['account-1'], failed_ids: [], results: [] } })

    await expect(queueSyntheticProbes(targets as never)).rejects.toThrow('response lost')
    await queueSyntheticProbes(targets as never)

    expect(post.mock.calls[0]?.[2]).toEqual(post.mock.calls[1]?.[2])
  })

  it('sends opaque, versioned batch-delete targets with a retry-safe idempotency key', async () => {
    post.mockResolvedValueOnce({
      data: { total: 2, success: 2, failed: 0, success_ids: ['account-a', 'account-b'], failed_ids: [] },
    })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { batchDelete } = await import('@/api/admin/accounts')
    const targets = [
      { id: 'account-a', control_version: 7 },
      { id: 'account-b', control_version: 2 },
    ]

    await expect(batchDelete(targets)).resolves.toMatchObject({ success_ids: ['account-a', 'account-b'] })
    expect(post).toHaveBeenCalledWith(
      '/admin/accounts/batch-delete',
      { accounts: [
        { id: 'account-a', expected_control_version: 7 },
        { id: 'account-b', expected_control_version: 2 },
      ] },
      { headers: { 'Idempotency-Key': 'admin-account-batch-delete-33333333-3333-4333-8333-333333333333' } },
    )
  })

  it('sends Worker OAuth refresh with account CAS and an idempotency key', async () => {
    post.mockResolvedValueOnce({ data: { id: 'account-oauth', enabled: true, max_concurrency: 1, group_links: [] } })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { refreshCredentials } = await import('@/api/admin/accounts')

    await refreshCredentials('account-oauth', 4)
    expect(post).toHaveBeenCalledWith(
      '/admin/accounts/account-oauth/refresh',
      {},
      { headers: {
        'If-Match': '"4"',
        'Idempotency-Key': 'admin-account-oauth-refresh-33333333-3333-4333-8333-333333333333',
      } },
    )
  })

  it('sends Worker OAuth batch refresh with all account versions', async () => {
    post.mockResolvedValueOnce({ data: { total: 2, success: 2, failed: 0 } })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { batchRefresh } = await import('@/api/admin/accounts')

    await batchRefresh([{ id: 'account-a', control_version: 2 }, { id: 'account-b', control_version: 5 }])
    expect(post).toHaveBeenCalledWith(
      '/admin/accounts/batch-refresh',
      { accounts: [
        { id: 'account-a', expected_control_version: 2 },
        { id: 'account-b', expected_control_version: 5 },
      ] },
      { headers: { 'Idempotency-Key': 'admin-account-oauth-batch-refresh-33333333-3333-4333-8333-333333333333' }, timeout: 120000 },
    )
  })

  it('sends Worker batch status reset with opaque IDs, CAS, and idempotency', async () => {
    post.mockResolvedValueOnce({ data: { total: 2, success: 2, failed: 0 } })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { batchClearError } = await import('@/api/admin/accounts')

    await batchClearError([{ id: 'account-a', control_version: 2 }, { id: 'account-b', control_version: 5 }])
    expect(post).toHaveBeenCalledWith(
      '/admin/accounts/batch-clear-error',
      { accounts: [
        { id: 'account-a', expected_control_version: 2 },
        { id: 'account-b', expected_control_version: 5 },
      ] },
      { headers: { 'Idempotency-Key': 'admin-account-batch-clear-status-33333333-3333-4333-8333-333333333333' } },
    )
  })

  it('rejects unversioned or duplicate Worker batch-delete targets before transport', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { batchDelete } = await import('@/api/admin/accounts')

    await expect(batchDelete(['account-a'])).rejects.toThrow(/control versions/)
    await expect(batchDelete([
      { id: 'account-a', control_version: 1 },
      { id: 'account-a', control_version: 1 },
    ])).rejects.toThrow(/unique ids/)
    expect(post).not.toHaveBeenCalled()
  })

  it('passes the opaque synthetic history cursor without decoding it', async () => {
    const page = {
      items: [{
        id: 'history-1', job_id: 'job-1', account_id: 'account-1', model_id: 'model-1',
        capability: 'responses', generation: 2, outcome: 'failed',
        error_code: 'upstream_http_error', upstream_status: 429, latency_ms: 87,
        alert_transition: 'firing', checked_at_ms: 1_788_451_260_000,
      }],
      has_more: true,
      next_cursor: 'eyJ2IjoxLCJjaGVja2VkX2F0X21zIjoxfQ',
    }
    get.mockResolvedValueOnce({ data: page })
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { listSyntheticProbeHistory } = await import('@/api/admin/accounts')

    await expect(listSyntheticProbeHistory({
      account_id: 'account-1', model_id: 'model-1', capability: 'responses',
      limit: 10, cursor: page.next_cursor,
    })).resolves.toEqual(page)
    expect(get).toHaveBeenCalledWith('/admin/accounts/synthetic-probes/history', {
      params: {
        account_id: 'account-1', model_id: 'model-1', capability: 'responses',
        limit: 10, cursor: page.next_cursor,
      },
    })
  })
})
