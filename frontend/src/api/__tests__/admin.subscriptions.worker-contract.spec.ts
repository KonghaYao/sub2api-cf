import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('@/api/client', () => ({ apiClient: { get, post } }))

const SUBSCRIPTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const GROUP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('admin subscriptions Cloudflare Worker contract', () => {
  beforeEach(() => {
    vi.resetModules()
    get.mockReset()
    post.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '33333333-3333-4333-8333-333333333333'
    )
  })

  it('remembers listed control versions and sends CAS plus idempotency on every mutation', async () => {
    get.mockResolvedValueOnce({
      data: {
        items: [{ id: SUBSCRIPTION_ID, user_id: USER_ID, group_id: GROUP_ID, control_version: 4 }],
        total: 1,
        page: 1,
        page_size: 20,
        pages: 1
      }
    })
    post
      .mockResolvedValueOnce({ data: { id: SUBSCRIPTION_ID, control_version: 5 } })
      .mockResolvedValueOnce({ data: { id: SUBSCRIPTION_ID, control_version: 6 } })
      .mockResolvedValueOnce({ data: { message: 'Subscription revoked successfully' } })

    const api = await import('@/api/admin/subscriptions')
    await api.list()
    await api.extend(SUBSCRIPTION_ID, { days: 7 })
    await api.resetQuota(SUBSCRIPTION_ID, { daily: true, weekly: false, monthly: true })
    await api.revoke(SUBSCRIPTION_ID)

    expect(post.mock.calls[0]).toEqual([
      `/admin/subscriptions/${SUBSCRIPTION_ID}/extend`,
      { days: 7, expected_control_version: 4 },
      { headers: {
        'Idempotency-Key': 'admin-subscription-extend-33333333-3333-4333-8333-333333333333',
        'If-Match': '"4"'
      } }
    ])
    expect(post.mock.calls[1]).toEqual([
      `/admin/subscriptions/${SUBSCRIPTION_ID}/reset-quota`,
      { daily: true, weekly: false, monthly: true, expected_control_version: 5 },
      { headers: {
        'Idempotency-Key': 'admin-subscription-reset-quota-33333333-3333-4333-8333-333333333333',
        'If-Match': '"5"'
      } }
    ])
    expect(post.mock.calls[2]).toEqual([
      `/admin/subscriptions/${SUBSCRIPTION_ID}/revoke`,
      { expected_control_version: 6 },
      { headers: {
        'Idempotency-Key': 'admin-subscription-revoke-33333333-3333-4333-8333-333333333333',
        'If-Match': '"6"'
      } }
    ])
  })

  it('sends UUID filters unchanged and adds idempotency to assign and bulk assign', async () => {
    get.mockResolvedValueOnce({ data: { items: [], total: 0, page: 1, page_size: 20, pages: 0 } })
    post
      .mockResolvedValueOnce({ data: { id: SUBSCRIPTION_ID, control_version: 0 } })
      .mockResolvedValueOnce({ data: {
        success_count: 1,
        created_count: 1,
        reused_count: 0,
        failed_count: 0,
        subscriptions: [{ id: SUBSCRIPTION_ID, control_version: 0 }],
        errors: [],
        statuses: { [USER_ID]: 'created' }
      } })
    const api = await import('@/api/admin/subscriptions')

    await api.list(1, 20, { user_id: USER_ID, group_id: GROUP_ID })
    await api.assign({ user_id: USER_ID, group_id: GROUP_ID, validity_days: 30 })
    await api.bulkAssign({ user_ids: [USER_ID], group_id: GROUP_ID, validity_days: 30 })

    expect(get).toHaveBeenCalledWith('/admin/subscriptions', expect.objectContaining({
      params: expect.objectContaining({ user_id: USER_ID, group_id: GROUP_ID })
    }))
    expect(post.mock.calls[0][2].headers['Idempotency-Key']).toBe(
      'admin-subscription-assign-33333333-3333-4333-8333-333333333333'
    )
    expect(post.mock.calls[1][2].headers['Idempotency-Key']).toBe(
      'admin-subscription-bulk-assign-33333333-3333-4333-8333-333333333333'
    )
  })
})
