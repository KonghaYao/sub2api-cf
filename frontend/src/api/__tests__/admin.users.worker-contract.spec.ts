import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post, put } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  apiClient: { get, post, put },
}))

const WORKER_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKER_USER = {
  id: WORKER_USER_ID,
  email: 'alice@example.com',
  display_name: 'Alice',
  role: 'user',
  status: 'active',
  balance_micros: 12_500_000,
  concurrency: 7,
  rpm_limit: 120,
  state_version: 2,
  control_version: 3,
  created_at_ms: 1_788_393_600_000,
  updated_at_ms: 1_788_480_000_000,
}

describe('admin users Cloudflare Worker contract', () => {
  beforeEach(async () => {
    vi.resetModules()
    get.mockReset()
    post.mockReset()
    put.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111'
    )
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('maps Worker list fields and UUIDs while sending only supported filters', async () => {
    get.mockResolvedValueOnce({
      data: { items: [WORKER_USER], total: 1, page: 2, page_size: 25, pages: 1 },
    })
    const { list } = await import('@/api/admin/users')

    const result = await list(2, 25, {
      status: 'active',
      role: 'user',
      search: ' alice ',
      group_name: 'legacy-group',
      api_key_group_id: 9,
      attributes: { 4: 'legacy-attribute' },
      include_subscriptions: true,
      sort_by: 'balance',
      sort_order: 'desc',
    })

    expect(get).toHaveBeenCalledWith('/admin/users', {
      params: {
        page: 2,
        page_size: 25,
        status: 'active',
        role: 'user',
        search: 'alice',
      },
      signal: undefined,
    })
    expect(result.items[0]).toMatchObject({
      id: WORKER_USER_ID,
      email: 'alice@example.com',
      username: 'Alice',
      role: 'user',
      status: 'active',
      balance: 12.5,
      concurrency: 7,
      rpm_limit: 120,
      created_at: '2026-09-03T00:00:00.000Z',
      updated_at: '2026-09-04T00:00:00.000Z',
      notes: '',
      allowed_groups: null,
    })
  })

  it('gets a Worker UUID without the legacy include_deleted query', async () => {
    get.mockResolvedValueOnce({ data: WORKER_USER })
    const { getById } = await import('@/api/admin/users')

    const result = await getById(WORKER_USER_ID, true)

    expect(get).toHaveBeenCalledWith(`/admin/users/${WORKER_USER_ID}`)
    expect(result).toMatchObject({ id: WORKER_USER_ID, username: 'Alice', balance: 12.5 })
  })

  it('creates with Worker field names, integer micros, and an idempotency key', async () => {
    post.mockResolvedValueOnce({ data: WORKER_USER })
    const { create } = await import('@/api/admin/users')

    const result = await create({
      email: 'alice@example.com',
      password: 'safe-password',
      username: 'Alice',
      notes: 'legacy-only',
      role: 'user',
      balance: 12.5,
      concurrency: 7,
      rpm_limit: 120,
      allowed_groups: [4, 9],
    })

    expect(post).toHaveBeenCalledWith('/admin/users', {
      email: 'alice@example.com',
      password: 'safe-password',
      display_name: 'Alice',
      role: 'user',
      balance_micros: 12_500_000,
      concurrency: 7,
      rpm_limit: 120,
    }, {
      headers: {
        'Idempotency-Key': 'admin-user-create-11111111-1111-4111-8111-111111111111',
      },
    })
    expect(result).toMatchObject({ id: WORKER_USER_ID, username: 'Alice', balance: 12.5 })
  })

  it('reuses the create idempotency key when the same payload has an ambiguous failure', async () => {
    post.mockRejectedValueOnce(new Error('response lost'))
    post.mockResolvedValueOnce({ data: WORKER_USER })
    const { create } = await import('@/api/admin/users')
    const payload = {
      email: 'alice@example.com',
      password: 'safe-password',
      username: 'Alice',
      balance: 12.5,
    }

    await expect(create(payload)).rejects.toThrow('response lost')
    await create({ ...payload })

    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0]?.[2]).toEqual(post.mock.calls[1]?.[2])
  })

  it('updates a UUID with only Worker-supported fields and an idempotency key', async () => {
    put.mockResolvedValueOnce({ data: { ...WORKER_USER, display_name: 'Alice Updated' } })
    const { update } = await import('@/api/admin/users')

    const result = await update(WORKER_USER_ID, {
      email: 'updated@example.com',
      password: 'new-safe-password',
      username: 'Alice Updated',
      notes: 'must not leave the browser',
      role: 'admin',
      status: 'active',
      balance: 99,
      concurrency: 11,
      rpm_limit: 240,
      allowed_groups: [4],
      restrict_public_groups: true,
      group_rates: { 4: 1.25 },
    })

    expect(put).toHaveBeenCalledWith(`/admin/users/${WORKER_USER_ID}`, {
      email: 'updated@example.com',
      password: 'new-safe-password',
      display_name: 'Alice Updated',
      role: 'admin',
      status: 'active',
      concurrency: 11,
      rpm_limit: 240,
    }, {
      headers: {
        'Idempotency-Key': `admin-user-update-${WORKER_USER_ID}-11111111-1111-4111-8111-111111111111`,
      },
    })
    expect(result).toMatchObject({ id: WORKER_USER_ID, username: 'Alice Updated' })
  })

  it('converts an additive balance adjustment to integer micros without legacy notes', async () => {
    post.mockResolvedValueOnce({
      data: { ...WORKER_USER, balance_micros: 13_750_000, updated_at_ms: 1_788_480_000_001 },
    })
    const { updateBalance } = await import('@/api/admin/users')

    const result = await updateBalance(WORKER_USER_ID, 1.25, 'add', 'legacy audit note')

    expect(post).toHaveBeenCalledWith(`/admin/users/${WORKER_USER_ID}/balance`, {
      amount_delta_micros: 1_250_000,
    }, {
      headers: {
        'Idempotency-Key': `admin-user-balance-${WORKER_USER_ID}-11111111-1111-4111-8111-111111111111`,
      },
    })
    expect(result.balance).toBe(13.75)
  })

  it('reads the authoritative balance before converting a set operation to a delta', async () => {
    get.mockResolvedValueOnce({ data: WORKER_USER })
    post.mockResolvedValueOnce({ data: { ...WORKER_USER, balance_micros: 20_000_000 } })
    const { updateBalance } = await import('@/api/admin/users')

    const result = await updateBalance(WORKER_USER_ID, 20, 'set', 'legacy note')

    expect(get).toHaveBeenCalledWith(`/admin/users/${WORKER_USER_ID}`)
    expect(post).toHaveBeenCalledWith(`/admin/users/${WORKER_USER_ID}/balance`, {
      amount_delta_micros: 7_500_000,
    }, {
      headers: {
        'Idempotency-Key': `admin-user-balance-${WORKER_USER_ID}-11111111-1111-4111-8111-111111111111`,
      },
    })
    expect(result.balance).toBe(20)
  })

  it('uses a negative delta for subtract and rejects sub-micro amounts', async () => {
    post.mockResolvedValueOnce({ data: { ...WORKER_USER, balance_micros: 12_000_000 } })
    const { updateBalance } = await import('@/api/admin/users')

    await updateBalance(WORKER_USER_ID, 0.5, 'subtract')

    expect(post.mock.calls[0]?.[1]).toEqual({ amount_delta_micros: -500_000 })
    await expect(
      updateBalance(WORKER_USER_ID, 0.0000001, 'add')
    ).rejects.toMatchObject({ code: 'invalid_balance_adjustment' })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('does not mutate when the authoritative balance read for set fails', async () => {
    get.mockRejectedValueOnce(new Error('balance unavailable'))
    const { updateBalance } = await import('@/api/admin/users')

    await expect(updateBalance(WORKER_USER_ID, 20, 'set')).rejects.toThrow('balance unavailable')
    expect(post).not.toHaveBeenCalled()
  })

  it('degrades batch limits to one idempotent Worker update per UUID', async () => {
    const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    put
      .mockResolvedValueOnce({ data: { ...WORKER_USER, concurrency: 4, rpm_limit: 0 } })
      .mockResolvedValueOnce({
        data: { ...WORKER_USER, id: secondId, concurrency: 4, rpm_limit: 0 },
      })
    const { batchUpdateLimits } = await import('@/api/admin/users')

    const result = await batchUpdateLimits({
      user_ids: [WORKER_USER_ID, secondId],
      concurrency: 4,
      rpm_limit: 0,
    })

    expect(post).not.toHaveBeenCalled()
    expect(put).toHaveBeenNthCalledWith(1, `/admin/users/${WORKER_USER_ID}`, {
      concurrency: 4,
      rpm_limit: 0,
    }, {
      headers: {
        'Idempotency-Key': `admin-user-update-${WORKER_USER_ID}-11111111-1111-4111-8111-111111111111`,
      },
    })
    expect(put).toHaveBeenNthCalledWith(2, `/admin/users/${secondId}`, {
      concurrency: 4,
      rpm_limit: 0,
    }, {
      headers: {
        'Idempotency-Key': `admin-user-update-${secondId}-11111111-1111-4111-8111-111111111111`,
      },
    })
    expect(result).toEqual({ affected: 2 })
  })

  it('refuses an unsafe Worker-wide batch without an explicit UUID snapshot', async () => {
    const { batchUpdateLimits } = await import('@/api/admin/users')

    await expect(batchUpdateLimits({
      user_ids: [],
      all: true,
      concurrency: 4,
    })).rejects.toMatchObject({ code: 'worker_batch_all_not_supported' })
    expect(put).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('keeps legacy create, update, and balance payloads unchanged when Worker mode is off', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(false)
    post.mockResolvedValue({ data: { id: 7 } })
    put.mockResolvedValue({ data: { id: 7 } })
    const { create, update, updateBalance } = await import('@/api/admin/users')
    const createPayload = {
      email: 'legacy@example.com',
      password: 'safe-password',
      username: 'Legacy',
      notes: 'kept by Go',
      balance: 3.25,
      allowed_groups: [9],
    }
    const updatePayload = {
      username: 'Legacy Updated',
      notes: 'kept by Go',
      allowed_groups: [9],
    }

    await create(createPayload)
    await update(7, updatePayload)
    await updateBalance(7, 1.5, 'subtract', 'legacy audit note')

    expect(post).toHaveBeenNthCalledWith(1, '/admin/users', createPayload)
    expect(put).toHaveBeenCalledWith('/admin/users/7', updatePayload)
    expect(post).toHaveBeenNthCalledWith(2, '/admin/users/7/balance', {
      balance: 1.5,
      operation: 'subtract',
      notes: 'legacy audit note',
    })
  })
})
