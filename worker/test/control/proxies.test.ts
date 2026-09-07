import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { batchCreateProxies, batchDeleteProxies, proxyStats, exportProxyData, importProxyData, createProxy, deleteProxy, getProxy, listProxies, loadProxyForRequest, proxyAccounts, updateProxy } from '../../src/control/proxies'
import { proxyFetch } from '../../src/proxy/transport'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const env = { DB: d1, ENVIRONMENT: 'test', CREDENTIALS_MASTER_KEY: 'proxy-test-master-key-only' } as Env
  const app = new Hono<{ Bindings: Env }>()
  app.get('/proxies/all', listProxies)
  app.get('/proxies', listProxies)
  app.post('/proxies', createProxy)
  app.post('/proxies/batch', batchCreateProxies)
  app.post('/proxies/batch-delete', batchDeleteProxies)
  app.get('/proxies/data', exportProxyData)
  app.post('/proxies/data', importProxyData)
  app.get('/proxies/:id', getProxy)
  app.get('/proxies/:id/accounts', proxyAccounts)
  app.get('/proxies/:id/stats', proxyStats)
  app.put('/proxies/:id', updateProxy)
  app.delete('/proxies/:id', deleteProxy)
  const request = (path: string, method = 'GET', body?: unknown, version?: number, key?: string) => app.request(path, {
    method, headers: { 'content-type': 'application/json', ...(version !== undefined ? { 'if-match': `"${version}"` } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env)
  async function create(name: string, patch: Record<string, unknown> = {}, key = `proxy-${name}`) {
    const response = await request('/proxies', 'POST', { name, protocol: 'http', host: 'proxy.example.test', port: 8080, username: 'proxy-user', password: 'private-proxy-password', ...patch }, undefined, key)
    expect(response.status, response.status === 201 ? '' : await response.clone().text()).toBe(201)
    return (await response.json() as { data: { id: number; control_version: number; [key: string]: unknown } }).data
  }
  return { raw, env, request, create }
}
afterEach(() => vi.restoreAllMocks())
describe('proxy catalog with real SQLite', () => {
  it('encrypts credentials, redacts every API projection, and resolves only server-side', async () => {
    const test = fixture(), proxy = await test.create('encrypted')
    const row = test.raw.prepare('SELECT * FROM proxies WHERE id=?').get(proxy.id)
    expect(JSON.stringify(row)).not.toContain('private-proxy-password')
    expect(row.ciphertext_b64).toBeTruthy()
    for (const path of ['/proxies', '/proxies/all', `/proxies/${proxy.id}`]) {
      const response = await test.request(path)
      expect(response.status).toBe(200)
      expect(await response.text()).not.toContain('private-proxy-password')
    }
    expect(proxy).toMatchObject({ password: null, password_configured: true })
    expect(await loadProxyForRequest(test.env, proxy.id)).toMatchObject({ password: 'private-proxy-password', host: 'proxy.example.test' })
  })
  it('replays create safely, rejects changed reuse, and serializes simultaneous duplicate create', async () => {
    const test = fixture()
    const [first, second] = await Promise.all([test.create('same', {}, 'same-key'), test.create('same', {}, 'same-key')])
    expect(second.id).toBe(first.id)
    expect((await test.create('same', {}, 'same-key')).id).toBe(first.id)
    expect(test.raw.prepare('SELECT COUNT(*) AS count FROM proxies').get().count).toBe(1)
    const changed = await test.request('/proxies', 'POST', { name: 'other', host: 'proxy.example.test', port: 8080 }, undefined, 'same-key')
    expect(changed.status).toBe(409)
  })
  it('requires CAS, rejects stale updates and preserves a blank password', async () => {
    const test = fixture(), proxy = await test.create('cas')
    expect((await test.request(`/proxies/${proxy.id}`, 'PUT', { name: 'missing-version' })).status).toBe(428)
    const updated = await test.request(`/proxies/${proxy.id}`, 'PUT', { name: 'new-name', password: '' }, proxy.control_version)
    expect(updated.status).toBe(200)
    const value = (await updated.json() as { data: { control_version: number } }).data
    expect(value.control_version).toBeGreaterThan(proxy.control_version)
    expect((await test.request(`/proxies/${proxy.id}`, 'PUT', { name: 'stale-write' }, proxy.control_version)).status).toBe(412)
    expect(await loadProxyForRequest(test.env, proxy.id)).toMatchObject({ name: 'new-name', password: 'private-proxy-password' })
  })
  it('replays deletion with the same version and refuses stale deletion', async () => {
    const test = fixture(), proxy = await test.create('delete-retry')
    expect((await test.request(`/proxies/${proxy.id}`, 'DELETE', undefined, proxy.control_version + 1)).status).toBe(412)
    expect((await test.request(`/proxies/${proxy.id}`, 'DELETE', undefined, proxy.control_version)).status).toBe(200)
    expect((await test.request(`/proxies/${proxy.id}`, 'DELETE', undefined, proxy.control_version)).status).toBe(200)
    expect((await test.request(`/proxies/${proxy.id}`, 'DELETE', undefined, proxy.control_version + 1)).status).toBe(412)
    expect((await test.request(`/proxies/${proxy.id}`)).status).toBe(404)
  })
  it('blocks deletion while account or fallback references exist', async () => {
    const test = fixture(), primary = await test.create('account-assigned')
    test.raw.prepare(`INSERT INTO accounts(id,platform,name,credential_ref,created_at_ms,updated_at_ms,ui_config_json) VALUES ('account','openai','Proxy account','credential',1,1,?)`).run(JSON.stringify({ proxy_id: primary.id }))
    expect((await test.request(`/proxies/${primary.id}`, 'DELETE', undefined, primary.control_version)).status).toBe(409)
    expect(await (await test.request(`/proxies/${primary.id}/accounts`)).json()).toMatchObject({ data: [{ id: 'account' }] })
    test.raw.exec('DELETE FROM accounts')
    const backupUser = await test.create('backup-user', { fallback_mode: 'proxy', backup_proxy_id: primary.id })
    expect((await test.request(`/proxies/${primary.id}`, 'DELETE', undefined, primary.control_version)).status).toBe(409)
    expect((await test.request(`/proxies/${backupUser.id}`, 'DELETE', undefined, backupUser.control_version)).status).toBe(200)
    expect((await test.request(`/proxies/${primary.id}`, 'DELETE', undefined, primary.control_version)).status).toBe(200)
  })
  it('never silently falls back for inactive, expired, missing, or cyclic proxies', async () => {
    const test = fixture(), inactive = await test.create('inactive', { status: 'inactive' }), expired = await test.create('expired', { expires_at: Math.floor(Date.now()/1000)-10 })
    await expect(loadProxyForRequest(test.env, inactive.id)).rejects.toMatchObject({ code: 'proxy_unavailable' })
    await expect(loadProxyForRequest(test.env, expired.id)).rejects.toMatchObject({ code: 'proxy_unavailable' })
    await expect(loadProxyForRequest(test.env, 99999)).rejects.toMatchObject({ code: 'proxy_not_found' })
    const cycle = await test.create('cycle', { status: 'inactive', fallback_mode: 'proxy', backup_proxy_id: inactive.id })
    expect((await test.request(`/proxies/${inactive.id}`, 'PUT', { fallback_mode: 'proxy', backup_proxy_id: cycle.id }, inactive.control_version)).status).toBe(200)
    await expect(loadProxyForRequest(test.env, inactive.id)).rejects.toMatchObject({ code: 'proxy_fallback_cycle' })
  })
  it('follows only explicitly configured proxy or direct fallback', async () => {
    const test = fixture(), backup = await test.create('backup'), primary = await test.create('primary', { status: 'inactive', fallback_mode: 'proxy', backup_proxy_id: backup.id }), direct = await test.create('direct', { status: 'inactive', fallback_mode: 'direct' })
    expect((await loadProxyForRequest(test.env, primary.id))?.id).toBe(backup.id)
    expect(await loadProxyForRequest(test.env, direct.id)).toBeNull()
    expect(await loadProxyForRequest(test.env, null)).toBeNull()
  })
  it('does not send a direct HTTP request after proxy connection failure', async () => {
    const direct = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected direct request'))
    const connector = vi.fn(() => { throw new Error('Connection refused') })
    await expect(proxyFetch({ protocol: 'http', host: 'proxy.example.test', port: 8080 }, 'https://upstream.example.test/v1/models', {}, connector)).rejects.toThrow()
    expect(connector).toHaveBeenCalledOnce()
    expect(direct).not.toHaveBeenCalled()
  })
  it('creates bounded idempotent batches and returns original-style encrypted export/import contracts',async()=>{
    const test=fixture(),items=[{protocol:'http',host:'one.example.test',port:8080,password:'batch-secret'},{protocol:'socks5',host:'two.example.test',port:1080}]
    for(let attempt=0;attempt<2;attempt++){
      const response=await test.request('/proxies/batch','POST',{proxies:items},undefined,'batch-creation-0001')
      expect(await response.json()).toMatchObject({data:{created:2,skipped:0}})
    }
    expect(test.raw.prepare('SELECT COUNT(*) AS count FROM proxies').get()?.count).toBe(2)
    const exported=await test.request('/proxies/data'),data=(await exported.json() as any).data
    expect(exported.headers.get('cache-control')).toBe('no-store')
    expect(data.proxies).toHaveLength(2);expect(data.accounts).toEqual([])
    expect(data.proxies.some((proxy:any)=>proxy.password==='batch-secret')).toBe(true)
    const first=data.proxies[0];first.name='imported-copy'
    const imported=await test.request('/proxies/data','POST',{data:{proxies:[first],accounts:[]}},undefined,'proxy-import-0001')
    expect(await imported.json()).toMatchObject({data:{proxy_created:1,proxy_failed:0}})
    expect(JSON.stringify(test.raw.prepare('SELECT * FROM proxies').all())).not.toContain('batch-secret')
    test.raw.close()
  })
  it('requires each delete version and preserves stale or referenced proxies without pretending the batch succeeded',async()=>{
    const test=fixture(),one=await test.create('batch-one'),two=await test.create('batch-two')
    expect((await test.request('/proxies/batch-delete','POST',{ids:[one.id]})).status).toBe(428)
    const response=await test.request('/proxies/batch-delete','POST',{ids:[one.id,two.id],expected_control_versions:{[one.id]:one.control_version,[two.id]:two.control_version+1}})
    expect(await response.json()).toMatchObject({data:{deleted_ids:[one.id],skipped:[{id:two.id,reason:'control_version_conflict'}]}})
    expect((await test.request(`/proxies/${two.id}`)).status).toBe(200)
    test.raw.close()
  })
  it('filters expired status accurately and preserves total count on empty later pages',async()=>{
    const test=fixture();await test.create('old-expired',{expires_at:1});await test.create('still-active')
    const active=(await (await test.request('/proxies?status=active')).json() as any).data
    expect(active.total).toBe(1);expect(active.items[0].name).toBe('still-active')
    const empty=(await (await test.request('/proxies?page=10&page_size=1')).json() as any).data
    expect(empty.total).toBe(2);expect(empty.items).toEqual([])
    test.raw.close()
  })

  it('counts completed observations as successes and scopes statistics to the assigned accounts',async()=>{
    const test=fixture(),proxy=await test.create('statistics')
    test.raw.prepare("INSERT INTO accounts(id,platform,name,credential_ref,created_at_ms,updated_at_ms,ui_config_json) VALUES('stats-account','openai','Stats','credential',1,1,?)").run(JSON.stringify({proxy_id:proxy.id}))
    for(const [id,account,lifecycle,status,duration]of [['a','stats-account','completed',200,100],['b','stats-account','failed',502,300],['c','other','failed',500,900]] as const){
      test.raw.prepare("INSERT INTO request_observations(id,request_id,bucket_day,occurred_at_ms,completed_at_ms,updated_at_ms,lifecycle,outcome,account_id,method,request_path,status_code,duration_ms) VALUES(?,?,20260907,1,1001,1001,?,?,?,'POST','/v1/responses',?,?)").run(id.repeat(32),id,lifecycle,lifecycle,account,status,duration)
    }
    const response=await test.request(`/proxies/${proxy.id}/stats`)
    expect(await response.json()).toMatchObject({data:{total_accounts:1,active_accounts:1,total_requests:2,success_rate:50,average_latency:200}})
    test.raw.close()
  })

})
