import {beforeEach,describe,expect,it,vi} from 'vitest'
const client=vi.hoisted(()=>({get:vi.fn(),put:vi.fn(),post:vi.fn(),delete:vi.fn()}))
vi.mock('@/api/client',()=>({apiClient:client}))
beforeEach(()=>{vi.resetModules();Object.values(client).forEach(mock=>mock.mockReset())})
async function api(){const {setCloudflareWorkerContractActive}=await import('@/utils/adminCapabilities');setCloudflareWorkerContractActive(true);return import('@/api/admin/proxies')}
describe('Worker proxy control contract',()=>{
 it('sends the editor version even when a later list fetched a newer version',async()=>{
  const proxy=await api();client.get.mockResolvedValue({data:{id:1,control_version:4}});await proxy.getById(1)
  client.put.mockRejectedValue({response:{status:412}})
  await expect(proxy.update(1,{name:'stale editor'},2)).rejects.toMatchObject({response:{status:412}})
  expect(client.put.mock.calls[0][2].headers).toEqual({'If-Match':'"2"'})
  expect(client.put).toHaveBeenCalledTimes(1)
 })
 it('reuses a failed create idempotency key until the same request succeeds',async()=>{
  const proxy=await api(),body={name:'proxy',protocol:'http' as const,host:'proxy.test',port:8080}
  client.post.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({data:{id:1,control_version:1}})
  await expect(proxy.create(body)).rejects.toThrow('network');await proxy.create(body)
  expect(client.post.mock.calls[0][2].headers['Idempotency-Key']).toBe(client.post.mock.calls[1][2].headers['Idempotency-Key'])
 })
 it('chunks batch imports to the server query budget and aggregates real counts',async()=>{
  const proxy=await api(),items=Array.from({length:11},(_,index)=>({protocol:'http',host:`proxy${index}.test`,port:8080}))
  client.post.mockImplementation(async(_url,body)=>({data:{created:body.proxies.length,skipped:0}}))
  expect(await proxy.batchCreate(items)).toEqual({created:11,skipped:0})
  expect(client.post.mock.calls.map(call=>call[1].proxies.length)).toEqual([5,5,1])
 })
})

const post = client.post
describe('original proxy bulk Worker transport', () => {
  beforeEach(() => { client.get.mockImplementation(async (path: string) => ({ data: { id: path.split('/').pop(), control_version: 4 } })) })
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
