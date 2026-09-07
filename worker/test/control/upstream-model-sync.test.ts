import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { apiKeyDigest } from '../../src/gateway/crypto'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

async function fixture() {
  const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
  const now = Date.now(), pepper = 'p'.repeat(32), token = `adm-sub2api-${'s'.repeat(48)}`
  raw.prepare(`INSERT INTO users (id,email,role,created_at_ms,updated_at_ms) VALUES ('admin','admin@example.test','admin',?,?)`).run(now,now)
  raw.prepare(`INSERT INTO admin_sessions (id,user_id,token_hash,created_at_ms,expires_at_ms) VALUES ('session','admin',?,?,?)`).run(await apiKeyDigest(`admin-session:v1:${token}`,pepper),now,now+600000)
  const env = { DB:d1, ENVIRONMENT:'test', API_KEY_PEPPER:pepper, CREDENTIALS_MASTER_KEY:'m'.repeat(32), ASSETS:{ fetch:async()=>new Response('asset') } } as unknown as Env
  const headers = { authorization:`Bearer ${token}`, 'content-type':'application/json' }
  return { app:createApp(), env, headers, raw }
}
const preview = '/api/v1/admin/accounts/models/sync-upstream-preview'
const body = { platform:'openai',type:'apikey',base_url:'https://pucoding.com/v1',api_key:'test-upstream-secret' }
afterEach(()=>{ vi.unstubAllGlobals(); vi.useRealTimers() })
describe('upstream model sync through the Worker HTTP routes',()=>{
  it('previews a v1 catalog without duplicating v1 and deduplicates model IDs',async()=>{
    const t=await fixture(); const fetcher=vi.fn().mockResolvedValue(Response.json({data:[{id:'gpt-test'},{id:'gpt-test'},{id:'image-test'}]}));vi.stubGlobal('fetch',fetcher)
    const r=await t.app.request(preview,{method:'POST',headers:t.headers,body:JSON.stringify(body)},t.env)
    expect(r.status,await r.clone().text()).toBe(200)
    expect(await r.json()).toMatchObject({data:{models:['gpt-test','image-test']}})
    expect(fetcher.mock.calls[0][0]).toBe('https://pucoding.com/v1/models')
    expect(new Headers(fetcher.mock.calls[0][1].headers).get('authorization')).toBe('Bearer test-upstream-secret')
    expect(fetcher.mock.calls[0][1].redirect).toBe('manual')
    expect(t.raw.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({n:0})
  })
  it('uses the saved encrypted credential through the saved account route',async()=>{
    const t=await fixture(); const created=await t.app.request('/api/v1/admin/accounts',{method:'POST',headers:{...t.headers,'idempotency-key':'sync-account'},body:JSON.stringify({...body,name:'pucoding',max_concurrency:1})},t.env)
    expect(created.status,await created.clone().text()).toBe(201)
    const id=(await created.json() as any).data.id
    const fetcher=vi.fn().mockResolvedValue(Response.json({data:[{id:'saved-model'}]}));vi.stubGlobal('fetch',fetcher)
    const r=await t.app.request(`/api/v1/admin/accounts/${id}/models/sync-upstream`,{method:'POST',headers:t.headers},t.env)
    expect(r.status,await r.clone().text()).toBe(200)
    expect(await r.json()).toMatchObject({data:{models:['saved-model']}})
    expect(new Headers(fetcher.mock.calls[0][1].headers).get('authorization')).toBe('Bearer test-upstream-secret')
  })
  it.each([401,403,429,500])('reports upstream HTTP %s without leaking the upstream body',async(status)=>{
    const t=await fixture();vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('test-upstream-secret',{status})))
    const r=await t.app.request(preview,{method:'POST',headers:t.headers,body:JSON.stringify(body)},t.env)
    expect(r.status).toBe(502); const text=await r.text();expect(text).toContain(`HTTP ${status}`);expect(text).not.toContain(body.api_key)
  })
  it('rejects HTML and invalid catalogs instead of treating them as empty success',async()=>{
    const t=await fixture()
    for(const response of [new Response('<html>login</html>'),Response.json({error:'failure'}),Response.json({data:[{}]})]){
      vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response))
      const r=await t.app.request(preview,{method:'POST',headers:t.headers,body:JSON.stringify(body)},t.env)
      expect(r.status).toBe(502)
    }
  })
  it('bounds catalog size and rejects redirects',async()=>{
    const t=await fixture()
    for(const response of [new Response('x'.repeat(2*1024*1024+1)),new Response(null,{status:302,headers:{location:'https://other.example/models'}})]){
      vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response))
      const r=await t.app.request(preview,{method:'POST',headers:t.headers,body:JSON.stringify(body)},t.env)
      expect(r.status).toBe(502)
    }
  })
  it('times out while reading a stalled catalog body',async()=>{
    const t=await fixture();vi.useFakeTimers()
    const cancel=vi.fn()
    const fetcher=vi.fn().mockResolvedValue(new Response(new ReadableStream({cancel})))
    vi.stubGlobal('fetch',fetcher)
    const pending=t.app.request(preview,{method:'POST',headers:t.headers,body:JSON.stringify(body)},t.env)
    await vi.waitFor(()=>expect(fetcher).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(20001)
    const r=await pending;expect(r.status).toBe(504)
    expect(await r.text()).toContain('upstream_models_timeout')
    expect(cancel).toHaveBeenCalled()
  })
  it('requires authentication and rejects private URLs before fetch',async()=>{
    const t=await fixture();const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher)
    expect((await t.app.request(preview,{method:'POST',body:JSON.stringify(body)},t.env)).status).toBe(401)
    expect((await t.app.request(preview,{method:'POST',headers:t.headers,body:JSON.stringify({...body,base_url:'https://127.0.0.1/v1'})},t.env)).status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
