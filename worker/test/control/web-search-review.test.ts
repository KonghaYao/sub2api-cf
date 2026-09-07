import { Hono } from 'hono'
import { afterEach,describe,expect,it,vi } from 'vitest'
import type { Env } from '../../src/env'
import { getWebSearchConfig,updateWebSearchConfig,resetWebSearchUsage,searchWeb } from '../../src/control/web-search'
import { emulateWebSearch } from '../../src/gateway/web-search'
import { applyMigrations,createSqliteD1 } from '../helpers/sqlite-d1'
function fixture(){const sqlite=createSqliteD1();applyMigrations(sqlite.raw);const env={DB:sqlite.d1,CREDENTIALS_MASTER_KEY:'m'.repeat(32)} as Env;const app=new Hono<{Bindings:Env}>();app.get('/settings',getWebSearchConfig);app.put('/settings',updateWebSearchConfig);app.post('/reset',resetWebSearchUsage);return {...sqlite,env,app}}
const provider={type:'tavily',api_key:'private-search-key',quota_limit:1,subscribed_at:null,expires_at:null,proxy_id:null}
async function configure(test:ReturnType<typeof fixture>,providers:unknown[]=[provider]){const response=await test.app.request('/settings',{method:'PUT',headers:{'content-type':'application/json','if-match':'"0"'},body:JSON.stringify({enabled:true,providers})},test.env);expect(response.status).toBe(200);return response.json()}
afterEach(()=>vi.unstubAllGlobals())
describe('web search negative protocol and control review',()=>{
 it('requires explicit CAS and rejects stale versions without replacing secrets',async()=>{
  const t=fixture();try{
   const save=(version?:number)=>t.app.request('/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true,providers:[provider],...(version===undefined?{}:{expected_control_version:version})})},t.env)
   expect((await save()).status).toBe(428)
   expect((await save(0)).status).toBe(200)
   expect((await save(0)).status).toBe(412)
   expect(t.raw.prepare('SELECT control_version FROM web_search_settings').get()).toMatchObject({control_version:1})
  }finally{t.raw.close()}
 })
 it('does not consume provider quota for a request cancelled before dispatch',async()=>{
  const t=fixture();try{await configure(t);const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher)
   const abort=new AbortController();abort.abort()
   await expect(searchWeb(t.env,'query',abort.signal)).rejects.toMatchObject({status:499})
   expect(fetcher).not.toHaveBeenCalled();expect(t.raw.prepare('SELECT COUNT(*) AS n FROM web_search_usage').get()).toMatchObject({n:0})
  }finally{t.raw.close()}
 })
 it('streams text and tool inputs via protocol deltas consumed by an ordinary stream accumulator',async()=>{
  const t=fixture();try{await configure(t,[{...provider,quota_limit:null}]);
   t.raw.exec(`INSERT INTO accounts(id,name,platform,credential_ref,created_at_ms,updated_at_ms,protocol,base_url,auth_scheme,ui_config_json) VALUES('search-account','Search','anthropic','fixture',1,1,'anthropic','https://api.anthropic.com','x-api-key','{"extra":{"web_search_emulation":"enabled"}}')`)
   vi.stubGlobal('fetch',vi.fn(async()=>Response.json({results:[null,{url:'javascript:alert(1)'},{url:'https://example.com',title:'Result',content:'Body'}]})))
   const response=await emulateWebSearch(t.env,'search-account','group','anthropic',{model:'claude-test',stream:true,tools:[{type:'web_search_20250305'}],messages:[{role:'user',content:'test query'}]},new AbortController().signal)
   const events=(await response!.text()).split('\n\n').filter(Boolean).map(frame=>JSON.parse(frame.split('\n').find(line=>line.startsWith('data: '))!.slice(6)))
   const text=events.filter(event=>event.type==='content_block_delta'&&event.delta.type==='text_delta').map(event=>event.delta.text).join('')
   const input=events.filter(event=>event.type==='content_block_delta'&&event.delta.type==='input_json_delta').map(event=>event.delta.partial_json).join('')
   expect(text).toBe('Result\nhttps://example.com\nBody');expect(JSON.parse(input)).toEqual({query:'test query'})
   expect(events.at(-1)).toEqual({type:'message_stop'})
  }finally{t.raw.close()}
 })
})
