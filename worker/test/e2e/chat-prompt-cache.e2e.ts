import { env, exports } from 'cloudflare:workers'
import { expect, it } from 'vitest'

async function fixture(endpoint: 'responses' | 'chat_completions' = 'responses') {
  const model = 'cache-' + crypto.randomUUID()
  const res = await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/bootstrap', {
    method:'POST', headers:{authorization:'Bearer '+env.ADMIN_TOKEN,'content-type':'application/json'},
    body:JSON.stringify({user:{email:crypto.randomUUID()+'@cache.test',balance_micros:1000000},group:{name:crypto.randomUUID()},account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'fixture'},api_key:{name:'cache'},models:[{public_name:model,upstream_name:'gpt-5.4-cache-probe',endpoint,input_micros_per_million:1000000,output_micros_per_million:2000000,minimum_reservation_micros:100}]})
  }))
  expect(res.status).toBe(201)
  return {model,...(await res.json() as any).data}
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
