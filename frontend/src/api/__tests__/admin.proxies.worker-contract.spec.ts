import { beforeEach, describe, expect, it, vi } from 'vitest'
const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('@/api/client', () => ({ apiClient: { post } }))

describe('original proxy bulk Worker transport', () => {
  beforeEach(() => { vi.resetModules(); post.mockReset() })
  it('retains every imported proxy while aggregating bounded requests', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { batchCreate } = await import('@/api/admin/proxies')
    const proxies = Array.from({ length: 12 }, (_, port) => ({ protocol: 'socks5h', host: 'proxy.test', port: 1000 + port }))
    post.mockImplementation(async (_path, body) => ({ data: { created: body.proxies.length - 1, skipped: 1 } }))
    expect(await batchCreate(proxies)).toEqual({ created: 9, skipped: 3 })
    expect(post.mock.calls.map(call => call[1].proxies.length)).toEqual([5, 5, 2])
    expect(post.mock.calls.flatMap(call => call[1].proxies)).toEqual(proxies)
  })
  it('preserves opaque IDs and skipped outcomes across delete chunks', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(true)
    const { batchDelete } = await import('@/api/admin/proxies')
    const ids = Array.from({ length: 23 }, (_, i) => `proxy-${i}`) as unknown as number[]
    post.mockImplementation(async (_path, body) => ({ data: { deleted_ids: body.ids.slice(1), skipped: [{ id: body.ids[0], reason: 'in use' }] } }))
    const result = await batchDelete(ids)
    expect(post.mock.calls.map(call => call[1].ids.length)).toEqual([10, 10, 3])
    expect(post.mock.calls.flatMap(call => call[1].ids)).toEqual(ids)
    expect(result.deleted_ids).toHaveLength(20)
    expect(result.skipped.map(row => row.id)).toEqual([ids[0], ids[10], ids[20]])
  })
  it('keeps the original server batch request unchanged', async () => {
    const { setCloudflareWorkerContractActive } = await import('@/utils/adminCapabilities')
    setCloudflareWorkerContractActive(false)
    const { batchDelete } = await import('@/api/admin/proxies')
    post.mockResolvedValue({ data: { deleted_ids: [1], skipped: [] } })
    expect(await batchDelete([1])).toEqual({ deleted_ids: [1], skipped: [] })
    expect(post).toHaveBeenCalledOnce()
  })
})
