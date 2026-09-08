import { beforeEach, describe, expect, it, vi } from 'vitest'
const client = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() }))
vi.mock('@/api/client', () => ({ apiClient: client }))
import groupsAPI from '../groups'
import accountsAPI from '../accounts'

describe('model management API contracts', () => {
  beforeEach(() => Object.values(client).forEach(mock => mock.mockReset()))
  it('loads diagnosis and complete price history contract', async () => {
    client.get.mockResolvedValueOnce({ data: { routable: false, blockers: ['active_price_missing'], checks: null } }).mockResolvedValueOnce({ data: [] })
    await groupsAPI.diagnoseGroupModel('g1', 'm1')
    await groupsAPI.listGroupModelPrices('g1', 'm1')
    expect(client.get).toHaveBeenNthCalledWith(1, '/admin/groups/g1/models/m1/diagnosis')
    expect(client.get).toHaveBeenNthCalledWith(2, '/admin/groups/g1/models/m1/prices')
  })
  it('publishes every price field and CAS version', async () => {
    client.post.mockResolvedValue({ data: {} })
    await groupsAPI.publishGroupModelPrice('g1', { group_id:'g1', model_id:'m1', public_name:'m', upstream_name:'m', endpoint:'both', enabled:true, catalog_visible:true, sort_order:0, max_output_tokens:1, default_max_output_tokens:1, control_version:7 }, { input_micros_per_million:1, output_micros_per_million:2, cache_read_micros_per_million:3, per_request_micros:4, minimum_reservation_micros:5 })
    expect(client.post).toHaveBeenCalledWith('/admin/groups/g1/models/m1/prices', expect.objectContaining({ expected_control_version:7, input_micros_per_million:1, output_micros_per_million:2, cache_read_micros_per_million:3, per_request_micros:4, minimum_reservation_micros:5 }), expect.anything())
  })
  it('writes four account capability flags to account_models endpoint', async () => {
    client.put.mockResolvedValue({ data: { id: 1 } })
    await accountsAPI.setModelCapability({ id:1, control_version:3 } as any, { model_id:'m1', chat_completions:true, responses:false, embeddings:true, image_generation:false })
    expect(client.put).toHaveBeenCalledWith('/admin/accounts/1/models/m1', expect.objectContaining({ expected_control_version:3, chat_completions:true, responses:false, embeddings:true, image_generation:false }))
  })
})
