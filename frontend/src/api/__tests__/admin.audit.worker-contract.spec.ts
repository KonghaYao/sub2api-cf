import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/api/client', () => ({ apiClient: { get } }))

describe('admin audit Cloudflare Worker contract', () => {
  beforeEach(() => {
    vi.resetModules()
    get.mockReset()
  })

  it('passes cursor filters to the Worker-native event list route', async () => {
    const response = { items: [], has_more: false, next_cursor: null }
    get.mockResolvedValueOnce({ data: response })
    const api = await import('@/api/admin/audit')
    const query = {
      limit: 20,
      cursor: 'opaque-cursor',
      category: 'auth' as const,
      action: 'auth.login',
      outcome: 'failed' as const,
      actor_user_id: 'user-one',
      resource_type: 'user',
      resource_id: 'user-one',
      start_time: '2026-09-01T00:00:00.000Z',
      end_time: '2026-09-02T00:00:00.000Z'
    }

    await expect(api.list(query)).resolves.toEqual(response)
    expect(get).toHaveBeenCalledWith('/admin/audit/events', { params: query })
  })

  it('uses category plus encoded event ID for details and exposes no clear call', async () => {
    get.mockResolvedValueOnce({ data: { category: 'payment', event_id: 'refund/event 1' } })
    const api = await import('@/api/admin/audit')

    await api.get('payment', 'refund/event 1')

    expect(get).toHaveBeenCalledWith('/admin/audit/events/payment/refund%2Fevent%201')
    expect(api.auditAPI).not.toHaveProperty('clear')
  })

  it('supports Worker account operation audit details', async () => {
    get.mockResolvedValueOnce({ data: { category: 'account', event_id: 'account:event/1' } })
    const api = await import('@/api/admin/audit')

    await api.get('account', 'account:event/1')

    expect(get).toHaveBeenCalledWith('/admin/audit/events/account/account%3Aevent%2F1')
  })
})
