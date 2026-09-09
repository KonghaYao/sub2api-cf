import { env, exports } from 'cloudflare:workers'
import { expect, it } from 'vitest'

let adminSession: string | undefined
async function fixture(endpoint: 'responses' | 'chat_completions' = 'responses') {
  const model = 'cache-' + crypto.randomUUID()
  const res = await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/bootstrap', {
    method:'POST', headers:{authorization:'Bearer '+env.ADMIN_TOKEN,'content-type':'application/json'},
    body:JSON.stringify({user:{email:crypto.randomUUID()+'@cache.test',balance_micros:1000000},group:{name:crypto.randomUUID()},account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'fixture'},api_key:{name:'cache'},models:[{public_name:model,upstream_name:'gpt-5.4-cache-probe',endpoint,input_micros_per_million:1000000,output_micros_per_million:2000000,minimum_reservation_micros:100}]})
  }))
  expect(res.status).toBe(201)
  const data=(await res.json() as any).data
  adminSession??=data.admin_session
  return {model,...data,admin_session:adminSession}
}
async function chat(f: any, extra: Record<string,unknown> = {}, headers: Record<string,string> = {}) {
  const res = await exports.default.fetch(new Request('https://worker.e2e.invalid/v1/chat/completions', {
    method:'POST',headers:{authorization:'Bearer '+f.api_key,'content-type':'application/json',...headers},
    body:JSON.stringify({model:f.model,messages:[{role:'system',content:'Help'},{role:'user',content:'First'}],stream:false,max_tokens:128,...extra})
  }))
  expect(res.status).toBe(200)
  const json = await res.json() as any
  return JSON.parse(json.choices[0].message.content)
}
it('keeps a Chat bridge cache key across turns, separates tenants and preserves explicit identities', async () => {
  const a=await fixture(), b=await fixture()
  const first=await chat(a)
  expect(first.key).toMatch(/^[a-f0-9]{32}$/)
  expect(first.session).toMatch(/^[a-f0-9-]{36}$/)
  expect(await chat(a,{messages:[{role:'system',content:'Help'},{role:'user',content:'First'},{role:'assistant',content:'Answer'},{role:'user',content:'Next'}]}, {'x-request-id':'rotating-request-id'})).toEqual(first)
  const other=await chat(b)
  expect(other.key).not.toBe(first.key)
  expect(other.session).not.toBe(first.session)
  const explicit=await chat(a,{prompt_cache_key:'shared-explicit'})
  const explicitOther=await chat(b,{prompt_cache_key:'shared-explicit'})
  expect(explicit.key).toBe('shared-explicit')
  expect(explicitOther.key).toBe('shared-explicit')
  expect(explicit.session).not.toBe(explicitOther.session)
  expect((await chat(a,{prompt_cache_key:'body-key'},{'x-session-id':'header-key'})).key).toBe('header-key')
  const state=await (await env.USER_STATE.get(env.USER_STATE.idFromName(a.user_id)).fetch('https://state.test/snapshot')).json() as any
  expect(state.profile.reserved_micros).toBe(0)
  expect(state.ledger.filter((row:any)=>row.amount_delta_micros<0)).toHaveLength(4)
})
it('preserves raw Chat forwarding without injecting cache identities', async () => {
  const f=await fixture('chat_completions')
  expect(await chat(f)).toEqual({key:null,session:null})
  expect(await chat(f,{prompt_cache_key:'raw-explicit'})).toEqual({key:'raw-explicit',session:null})
})

it.each([false,true])('preserves raw OpenAI multi-turn context, explicit cache key and metadata (stream=%s)',async stream=>{
 const f=await fixture('chat_completions')
 await env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.enable_metadata_passthrough',json('false')) WHERE id='global'").run()
 try{
  const prefix=[{role:'system',content:'Stable project instructions. '.repeat(100)},{role:'user',content:'First question'}]
  for(const messages of [prefix,[...prefix,{role:'assistant',content:'First answer'},{role:'user',content:'Follow-up'}]]){
   const body={model:f.model,messages,stream,max_tokens:128,metadata:{session:'stable-client-context'},prompt_cache_key:'raw-round-trip',prompt_cache_retention:'24h'}
   const response=await exports.default.fetch(new Request('https://worker.e2e.invalid/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+f.api_key,'content-type':'application/json','user-agent':'OpenAI/Python fixture','accept-language':'zh-CN',session_id:'do-not-forward-codex-header'},body:JSON.stringify(body)}))
   expect(response.status).toBe(200)
   let content:string
   if(stream){
    const text=await response.text()
    const events=text.split('\n').filter(line=>line.startsWith('data: ')&&line!=='data: [DONE]').map(line=>JSON.parse(line.slice(6)))
    content=events.map(e=>e.choices?.[0]?.delta?.content??'').join('')
    expect(events.find(e=>e.usage)?.usage.prompt_tokens_details.cached_tokens).toBe(80)
    expect(text).toContain('data: [DONE]')
   }else{
    const json=await response.json() as any
    content=json.choices[0].message.content
    expect(json.usage.prompt_tokens_details.cached_tokens).toBe(80)
   }
   const forwarded=JSON.parse(content)
   expect(forwarded.body).toEqual({...body,model:'gpt-5.4-cache-probe',...(stream?{stream_options:{include_usage:true}}:{})})
   expect(forwarded.headers).toEqual({ua:'OpenAI/Python fixture',language:'zh-CN',session:null})
  }
 }finally{await env.DB.prepare("UPDATE system_settings SET gateway_json=json_remove(gateway_json,'$.enable_metadata_passthrough') WHERE id='global'").run()}
})

it.each(['content','header','body'] as const)('keeps raw OpenAI turns on the bound account despite changed priority (%s identity)',async identity=>{
 const f=await fixture('chat_completions')
 const model=await env.DB.prepare('SELECT id FROM models WHERE public_name=?').bind(f.model).first<any>()
 const created=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/accounts',{method:'POST',headers:{authorization:'Bearer '+f.admin_session,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({name:crypto.randomUUID(),platform:'openai',protocol:'openai',auth_scheme:'bearer',credential_kind:'api_key',base_url:'https://upstream.e2e.invalid/v1',api_key:'second-fixture',enabled:true,group_links:[{group_id:f.group_id,priority:10,weight:1}],model_capabilities:[{model_id:model.id,chat_completions:true,responses:false}]})}))
 expect(created.status,await created.clone().text()).toBe(201)
 const second=(await created.json() as any).data
 const prefix=[{role:'system',content:'Stable project instructions'},{role:'user',content:'First question'}]
 const send=async(messages:unknown[],fresh=false)=>chat(f,{messages,...(identity==='body'?{prompt_cache_key:fresh?'new-session':'same-session'}:{})},identity==='header'?{'session-id':fresh?'new-session':'same-session'}:{})
 await send(prefix)
 await expect.poll(async()=>(await env.DB.prepare('SELECT account_id FROM usage_projection WHERE user_id=?').bind(f.user_id).all<any>()).results.map(r=>r.account_id)).toEqual([f.account_id])
 await env.DB.batch([
  env.DB.prepare('UPDATE account_groups SET priority=CASE WHEN account_id=? THEN 20 ELSE 0 END WHERE group_id=?').bind(f.account_id,f.group_id),
  env.DB.prepare('UPDATE gateway_config_revision SET revision=revision+1 WHERE singleton=1'),
 ])
 await send([...prefix,{role:'assistant',content:'Answer'},{role:'user',content:'Follow-up'}])
 await expect.poll(async()=>(await env.DB.prepare('SELECT account_id FROM usage_projection WHERE user_id=?').bind(f.user_id).all<any>()).results.map(r=>r.account_id)).toEqual([f.account_id,f.account_id])
 await send([{role:'system',content:'Stable project instructions'},{role:'user',content:'Different conversation'}],true)
 await expect.poll(async()=>(await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_projection WHERE user_id=? AND account_id=?').bind(f.user_id,second.id).first<any>())?.n).toBe(1)
})

it('preserves the actual Responses-shaped body cache key across changing session headers',async()=>{
 const f=await fixture('responses')
 const body={messages:undefined,input:[{role:'user',content:'Stable input'}],prompt_cache_key:'client-body-cache'}
 const first=await chat(f,body,{'session-id':'first-header'})
 const next=await chat(f,{...body,input:[...body.input,{role:'assistant',content:'Answer'},{role:'user',content:'Next'}]},{'session-id':'second-header'})
 expect(first.key).toBe('client-body-cache')
 expect(next.key).toBe(first.key)
 expect(next.session).not.toBe(first.session)
 expect((await chat(f,{...body,prompt_cache_key:undefined},{'session-id':'fallback-header'})).key).toBe('fallback-header')
})

it('anchors actual OpenAI OAuth cache and session identity to the explicit body key',async()=>{
 const f=await fixture('responses')
 const model=await env.DB.prepare('SELECT id FROM models WHERE public_name=?').bind(f.model).first<any>()
 const created=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/accounts',{method:'POST',headers:{authorization:'Bearer '+f.admin_session,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({name:crypto.randomUUID(),platform:'openai',protocol:'openai',auth_scheme:'bearer',credential_kind:'oauth',base_url:'https://chatgpt.com',api_key:'unused',credentials:{access_token:'oauth-cache-local-fixture'},enabled:true,group_links:[{group_id:f.group_id,priority:0,weight:1}],model_capabilities:[{model_id:model.id,chat_completions:false,responses:true}]})}))
 expect(created.status,await created.clone().text()).toBe(201)
 await env.DB.batch([env.DB.prepare('UPDATE accounts SET enabled=0 WHERE id=?').bind(f.account_id),env.DB.prepare('UPDATE gateway_config_revision SET revision=revision+1 WHERE singleton=1')])
 const body={messages:undefined,input:'Stable input',prompt_cache_key:'oauth-body-cache'}
 const first=await chat(f,body,{'session-id':'first-header'})
 const next=await chat(f,body,{'session-id':'second-header'})
 expect(first.key).toBe('oauth-body-cache')
 expect(first.session).toMatch(/^[a-f0-9-]{36}$/)
 expect(next).toEqual(first)
})

it.each([false,true])('forwards native OpenAI Responses session context (stream=%s)',async stream=>{
 const f=await fixture('responses')
 const response=await exports.default.fetch(new Request('https://worker.e2e.invalid/v1/responses',{method:'POST',headers:{authorization:'Bearer '+f.api_key,'content-type':'application/json',session_id:'native-session',conversation_id:'native-conversation','user-agent':'OpenAI/native','accept-language':'zh-CN','x-codex-turn-state':'opaque-turn-state',cookie:'must-not-forward'},body:JSON.stringify({model:f.model,input:'Stable context',prompt_cache_key:'native-header-probe',stream,max_output_tokens:128})}))
 expect(response.status,await response.clone().text()).toBe(200)
 let result:any
 if(stream){const events=(await response.text()).split('\n').filter(line=>line.startsWith('data: ')&&line!=='data: [DONE]').map(line=>JSON.parse(line.slice(6)));result=events.find(e=>e.type==='response.completed').response}
 else result=await response.json()
 const actual=JSON.parse(result.output[0].content[0].text)
 expect(actual).toEqual({key:'native-header-probe',session:'native-session',conversation:'native-conversation',ua:'OpenAI/native',language:'zh-CN',turn:'opaque-turn-state',cookie:null})
})
