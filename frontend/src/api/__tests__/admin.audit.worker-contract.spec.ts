import { beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('@/api/client', () => ({ apiClient: { get, post } }))

describe('admin request audit Cloudflare Worker contract', () => {
  beforeEach(() => {
    vi.resetModules()
    get.mockReset()
    post.mockReset()
  })

  it('passes page and original filter fields to the request-audit list route', async () => {
    const response = { items: [], total: 0, page: 2, page_size: 50, pages: 0 }
    get.mockResolvedValueOnce({ data: response })
    const api = await import('@/api/admin/audit')
    const query = {
      page: 2,
      page_size: 50,
      start_time: '2026-09-01T00:00:00.000Z',
      end_time: '2026-09-02T00:00:00.000Z',
      actor_user_id: 'user-one',
      actor_email: 'admin@example.com',
      auth_method: 'jwt',
      action: 'POST /api/v1/admin/users',
      method: 'POST',
      client_ip: '203.0.113.1',
      success: 'true',
      q: 'users',
    }

    await expect(api.list(query)).resolves.toEqual(response)
    expect(get).toHaveBeenCalledWith('/admin/audit-logs', { params: query })
  })

  it('uses the numeric detail route', async () => {
    get.mockResolvedValueOnce({ data: { id: 42 } })
    const api = await import('@/api/admin/audit')
    await api.get(42)
    expect(get).toHaveBeenCalledWith('/admin/audit-logs/42')
  })

  it('keeps the original clear action wired to the explicit Worker route', async () => {
    post.mockResolvedValueOnce({ data: { deleted: 3 } })
    const api = await import('@/api/admin/audit')
    await expect(api.clear('123456')).resolves.toEqual({ deleted: 3 })
    expect(post).toHaveBeenCalledWith('/admin/audit-logs/clear', { totp_code: '123456' })
  })
})
