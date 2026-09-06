import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { get, post, put, deleteRequest } = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), deleteRequest: vi.fn(),
}))

vi.mock('@/api/client', () => ({ apiClient: { get, post, put, delete: deleteRequest } }))

describe('admin user attributes Cloudflare Worker contract', () => {
  beforeEach(async () => {
    vi.resetModules(); get.mockReset(); post.mockReset(); put.mockReset(); deleteRequest.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('99999999-9999-4999-8999-999999999999')
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
  })
  afterEach(() => vi.restoreAllMocks())

  it('uses opaque user IDs and carries Worker idempotency/CAS metadata for every unsafe operation', async () => {
    post.mockResolvedValue({ data: { id: 4 } }); put.mockResolvedValue({ data: {} }); deleteRequest.mockResolvedValue({ data: {} })
    const api = await import('@/api/admin/userAttributes')
    await api.createDefinition({ key: 'department', name: 'Department', type: 'text' })
    await api.updateDefinition(4, { name: 'Team' }, 7)
    await api.deleteDefinition(4, 8)
    await api.reorderDefinitions([4, 5], 3)
    await api.updateUserAttributeValues('018f3b79-0000-7000-8000-000000000001', { 4: 'eng' }, 9)
    await api.getBatchUserAttributes(['018f3b79-0000-7000-8000-000000000001'])

    expect(post).toHaveBeenCalledWith('/admin/user-attributes', { key: 'department', name: 'Department', type: 'text' }, { headers: { 'Idempotency-Key': 'admin-user-attribute-create-99999999-9999-4999-8999-999999999999' } })
    expect(put.mock.calls).toEqual([
      ['/admin/user-attributes/4', { name: 'Team', expected_control_version: 7 }, { headers: { 'Idempotency-Key': 'admin-user-attribute-update-4-99999999-9999-4999-8999-999999999999', 'If-Match': '"7"' } }],
      ['/admin/user-attributes/reorder', { ids: [4, 5], expected_control_version: 3 }, { headers: { 'Idempotency-Key': 'admin-user-attribute-reorder-99999999-9999-4999-8999-999999999999', 'If-Match': '"3"' } }],
      ['/admin/users/018f3b79-0000-7000-8000-000000000001/attributes', { values: { 4: 'eng' }, expected_control_version: 9 }, { headers: { 'Idempotency-Key': 'admin-user-attribute-values-018f3b79-0000-7000-8000-000000000001-99999999-9999-4999-8999-999999999999', 'If-Match': '"9"' } }],
    ])
    expect(deleteRequest).toHaveBeenCalledWith('/admin/user-attributes/4', { data: { expected_control_version: 8 }, headers: { 'Idempotency-Key': 'admin-user-attribute-delete-4-99999999-9999-4999-8999-999999999999', 'If-Match': '"8"' } })
    expect(post).toHaveBeenLastCalledWith('/admin/user-attributes/batch', { user_ids: ['018f3b79-0000-7000-8000-000000000001'] })
  })

  it('keeps legacy payloads free of Worker-only metadata', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(false); put.mockResolvedValue({ data: {} })
    const api = await import('@/api/admin/userAttributes')
    await api.updateDefinition(4, { name: 'Team' }, 7)
    expect(put).toHaveBeenCalledWith('/admin/user-attributes/4', { name: 'Team' })
  })
})
