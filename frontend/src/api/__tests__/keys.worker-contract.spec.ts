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

import { create, deleteKey, getById, list, update } from '@/api/keys'
import { setCloudflareWorkerContractActive } from '@/utils/adminCapabilities'

const KEY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const GROUP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function workerKey(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    user_id: USER_ID,
    group_id: GROUP_ID,
    name: 'primary',
    status: 'active',
    key_prefix: 'sk-sub2api-abcd',
    control_version: 4,
    quota_micros: 12_345_678,
    quota_used_micros: 2_500_001,
    rate_limit_5h_micros: 5_000_000,
    rate_limit_1d_micros: 20_000_000,
    rate_limit_7d_micros: 80_000_000,
    usage_5h_micros: 1_000_001,
    usage_1d_micros: 2_000_002,
    usage_7d_micros: 3_000_003,
    window_5h_start_ms: 1_800_000_000_000,
    window_1d_start_ms: null,
    window_7d_start_ms: 1_800_000_100_000,
    reset_5h_at_ms: 1_800_018_000_000,
    reset_1d_at_ms: null,
    reset_7d_at_ms: 1_800_604_900_000,
    ...overrides
  }
}

describe('user API keys Cloudflare Worker contract', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
    put.mockReset()
    deleteRequest.mockReset()
    setCloudflareWorkerContractActive(true)
    vi.restoreAllMocks()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111'
    )
  })

  it('keeps UUID identifiers and projects every monetary/window field to the legacy USD UI model', async () => {
    get.mockResolvedValueOnce({
      data: { items: [workerKey()], total: 1, page: 1, page_size: 10, pages: 1 }
    })

    const response = await list()

    expect(response.items[0]).toMatchObject({
      id: KEY_ID,
      user_id: USER_ID,
      group_id: GROUP_ID,
      quota: 12.345678,
      quota_used: 2.500001,
      rate_limit_5h: 5,
      rate_limit_1d: 20,
      rate_limit_7d: 80,
      usage_5h: 1.000001,
      usage_1d: 2.000002,
      usage_7d: 3.000003,
      window_5h_start: new Date(1_800_000_000_000).toISOString(),
      window_1d_start: null,
      window_7d_start: new Date(1_800_000_100_000).toISOString(),
      reset_5h_at: new Date(1_800_018_000_000).toISOString(),
      reset_1d_at: null,
      reset_7d_at: new Date(1_800_604_900_000).toISOString(),
      control_version: 4
    })
  })

  it('round-trips unchanged MAX_SAFE micros from a loaded edit baseline without losing one micro', async () => {
    const rawLimits = {
      quota_micros: Number.MAX_SAFE_INTEGER,
      rate_limit_5h_micros: Number.MAX_SAFE_INTEGER - 1,
      rate_limit_1d_micros: Number.MAX_SAFE_INTEGER - 2,
      rate_limit_7d_micros: Number.MAX_SAFE_INTEGER - 3
    }
    get.mockResolvedValueOnce({
      data: { items: [workerKey(rawLimits)], total: 1, page: 1, page_size: 10, pages: 1 }
    })
    put.mockResolvedValueOnce({ data: workerKey({ ...rawLimits, control_version: 5 }) })
    const loaded = (await list()).items[0]

    await update(KEY_ID, {
      quota: loaded.quota,
      rate_limit_5h: loaded.rate_limit_5h,
      rate_limit_1d: loaded.rate_limit_1d,
      rate_limit_7d: loaded.rate_limit_7d
    }, { expectedControlVersion: 4, monetaryBaseline: loaded })

    expect(loaded.quota).toBe(9_007_199_254.740992)
    expect(put.mock.calls[0][1]).toEqual(rawLimits)
  })

  it('converts only a changed limit while preserving every unchanged raw window limit', async () => {
    const rawLimits = {
      quota_micros: Number.MAX_SAFE_INTEGER,
      rate_limit_5h_micros: Number.MAX_SAFE_INTEGER - 1,
      rate_limit_1d_micros: Number.MAX_SAFE_INTEGER - 2,
      rate_limit_7d_micros: Number.MAX_SAFE_INTEGER - 3
    }
    get.mockResolvedValueOnce({ data: workerKey(rawLimits) })
    put.mockResolvedValueOnce({ data: workerKey({ ...rawLimits, quota_micros: 1_000_001 }) })
    const loaded = await getById(KEY_ID)

    await update(KEY_ID, {
      quota: 1.000001,
      rate_limit_5h: loaded.rate_limit_5h,
      rate_limit_1d: loaded.rate_limit_1d,
      rate_limit_7d: loaded.rate_limit_7d
    }, { expectedControlVersion: 4, monetaryBaseline: loaded })

    expect(put.mock.calls[0][1]).toEqual({
      quota_micros: 1_000_001,
      rate_limit_5h_micros: Number.MAX_SAFE_INTEGER - 1,
      rate_limit_1d_micros: Number.MAX_SAFE_INTEGER - 2,
      rate_limit_7d_micros: Number.MAX_SAFE_INTEGER - 3
    })
  })

  it('remembers the version returned by a UUID detail lookup for a later CAS update', async () => {
    get.mockResolvedValueOnce({ data: workerKey() })
    put.mockResolvedValueOnce({ data: workerKey({ name: 'renamed', control_version: 5 }) })

    await getById(KEY_ID)
    await update(KEY_ID, { name: 'renamed' })

    expect(get).toHaveBeenCalledWith(`/keys/${KEY_ID}`)
    expect(put).toHaveBeenCalledWith(
      `/keys/${KEY_ID}`,
      { name: 'renamed' },
      {
        headers: {
          'Idempotency-Key': `user-api-key-update-${KEY_ID}-11111111-1111-4111-8111-111111111111`,
          'If-Match': '"4"'
        }
      }
    )
  })

  it('creates all supported limits as exact integer micros and preserves explicit unlimited zeros', async () => {
    post.mockResolvedValueOnce({ data: workerKey({ key: 'sk-sub2api-secret', control_version: 0 }) })

    await create(
      'primary',
      GROUP_ID,
      undefined,
      undefined,
      undefined,
      12.345678,
      undefined,
      { rate_limit_5h: 0.000001, rate_limit_1d: 0, rate_limit_7d: 70.000001 }
    )

    expect(post).toHaveBeenCalledWith('/keys', {
      name: 'primary',
      group_id: GROUP_ID,
      quota_micros: 12_345_678,
      rate_limit_5h_micros: 1,
      rate_limit_1d_micros: 0,
      rate_limit_7d_micros: 70_000_001
    }, {
      headers: {
        'Idempotency-Key': 'user-api-key-create-11111111-1111-4111-8111-111111111111'
      }
    })
  })

  it('maps disabled-form zeros to explicit unlimited micros on create and update', async () => {
    post.mockResolvedValueOnce({ data: workerKey({ control_version: 0 }) })
    put.mockResolvedValueOnce({ data: workerKey({ control_version: 5 }) })

    await create('unlimited', GROUP_ID, undefined, undefined, undefined, 0, undefined, {
      rate_limit_5h: 0,
      rate_limit_1d: 0,
      rate_limit_7d: 0
    })
    await update(KEY_ID, {
      quota: 0,
      rate_limit_5h: 0,
      rate_limit_1d: 0,
      rate_limit_7d: 0
    }, 4)

    const unlimited = {
      quota_micros: 0,
      rate_limit_5h_micros: 0,
      rate_limit_1d_micros: 0,
      rate_limit_7d_micros: 0
    }
    expect(post.mock.calls[0][1]).toMatchObject(unlimited)
    expect(put.mock.calls[0][1]).toEqual(unlimited)
  })

  it('parses a valid six-place decimal without IEEE-754 multiplication drift', async () => {
    post.mockResolvedValueOnce({ data: workerKey({ control_version: 0 }) })

    await create('precise', GROUP_ID, undefined, undefined, undefined, 0.000123)

    expect(post.mock.calls[0][1]).toMatchObject({ quota_micros: 123 })
  })

  it('accepts the largest representable decimal below the safe-micros boundary', async () => {
    post.mockResolvedValueOnce({ data: workerKey({ control_version: 0 }) })

    await create('boundary', GROUP_ID, undefined, undefined, undefined, 9_007_199_254.74099)

    expect(post.mock.calls[0][1]).toMatchObject({ quota_micros: 9_007_199_254_740_990 })
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
    ['sub-micro', 0.0000001],
    ['underflowed sub-micro', Number.MIN_VALUE],
    ['fractional micro', 1.0000001],
    ['unsafe micros', (Number.MAX_SAFE_INTEGER + 1) / 1_000_000]
  ])('rejects %s USD values rather than rounding or overflowing them', async (_label, value) => {
    await expect(create('primary', GROUP_ID, undefined, undefined, undefined, value))
      .rejects.toMatchObject({ code: 'invalid_quota' })
    expect(post).not.toHaveBeenCalled()
  })

  it('updates limits and reset operations with explicit CAS and a stable retry key', async () => {
    const updates = {
      quota: 99.000001,
      rate_limit_5h: 5,
      rate_limit_1d: 10,
      rate_limit_7d: 0,
      reset_quota: true,
      reset_rate_limit_usage: true
    }
    put.mockRejectedValueOnce(new Error('ambiguous network failure'))
    await expect(update(KEY_ID, updates, 4)).rejects.toThrow('ambiguous network failure')
    const firstHeaders = put.mock.calls[0][2].headers

    put.mockResolvedValueOnce({ data: workerKey({ control_version: 5 }) })
    await update(KEY_ID, updates, 4)

    expect(put.mock.calls[1][1]).toEqual({
      quota_micros: 99_000_001,
      rate_limit_5h_micros: 5_000_000,
      rate_limit_1d_micros: 10_000_000,
      rate_limit_7d_micros: 0,
      reset_quota: true,
      reset_rate_limit_usage: true
    })
    expect(put.mock.calls[1][2]).toEqual({ headers: firstHeaders })
    expect(firstHeaders).toMatchObject({ 'If-Match': '"4"' })
  })

  it('requires a loaded or explicitly supplied control version before a Worker update', async () => {
    await expect(update('new-unseen-key', { quota: 1 }))
      .rejects.toMatchObject({ code: 'api_key_version_not_loaded' })
    expect(put).not.toHaveBeenCalled()
  })

  it('still rejects Worker-only unsupported custom keys and IP restrictions', async () => {
    await expect(create('primary', GROUP_ID, 'custom-secret'))
      .rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    await expect(update(KEY_ID, { ip_whitelist: ['127.0.0.1'] }, 4))
      .rejects.toMatchObject({ code: 'worker_feature_not_supported' })
    expect(post).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
  })

  it('returns the revoked key projection from the existing delete route', async () => {
    const revoked = workerKey({ status: 'inactive', revoked_at: '2026-09-04T00:00:00.000Z' })
    deleteRequest.mockResolvedValueOnce({ data: revoked })

    await expect(deleteKey(KEY_ID)).resolves.toMatchObject({ id: KEY_ID, status: 'inactive' })
    expect(deleteRequest).toHaveBeenCalledWith(`/keys/${KEY_ID}`)
  })

  it('keeps legacy Go create/update payloads and responses unchanged when Worker mode is off', async () => {
    setCloudflareWorkerContractActive(false)
    const legacy = { id: 7, name: 'legacy' }
    post.mockResolvedValueOnce({ data: legacy })
    put.mockResolvedValueOnce({ data: legacy })

    await create('legacy', 9, 'custom', ['10.0.0.1'], ['10.0.0.2'], 2.5, 30, {
      rate_limit_5h: 1,
      rate_limit_1d: 2,
      rate_limit_7d: 3
    })
    await update(7, { quota: 8, reset_quota: true }, 999)

    expect(post).toHaveBeenCalledWith('/keys', {
      name: 'legacy',
      group_id: 9,
      custom_key: 'custom',
      ip_whitelist: ['10.0.0.1'],
      ip_blacklist: ['10.0.0.2'],
      quota: 2.5,
      expires_in_days: 30,
      rate_limit_5h: 1,
      rate_limit_1d: 2,
      rate_limit_7d: 3
    })
    expect(put).toHaveBeenCalledWith('/keys/7', { quota: 8, reset_quota: true })
  })
})
