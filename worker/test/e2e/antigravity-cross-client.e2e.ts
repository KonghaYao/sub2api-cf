import {env,exports} from 'cloudflare:workers'
import {expect,it} from 'vitest'
let adminSession:string|undefined
async function fixture(upstream='anti-cross-ok'){
 const invoke=(path:string,token:string,body:unknown,method='POST')=>exports.default.fetch(new Request('https://worker.e2e.invalid'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)}))
 const seeded=await invoke('/api/v1/admin/bootstrap',env.ADMIN_TOKEN!,{user:{email:crypto.randomUUID()+'@anti-cross.test',balance_micros:1000000},group:{name:crypto.randomUUID()},account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture'},api_key:{name:'cross'},models:[{public_name:crypto.randomUUID(),upstream_name:'unused',endpoint:'responses',input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100}]})
 expect(seeded.status).toBe(201);const f=(await seeded.json() as any).data;adminSession??=f.admin_session
 const admin=async(path:string,body:unknown,method='POST')=>{const r=await invoke('/api/v1/admin'+path,adminSession!,body,method);expect([200,201],await r.clone().text()).toContain(r.status);return(await r.json()as any).data}
 const group=await admin('/groups',{name:crypto.randomUUID(),platform:'antigravity'})
 const model=await admin('/models',{public_name:'anti-'+crypto.randomUUID(),upstream_name:upstream,platform:'antigravity',endpoint:'both'})
 await admin(`/groups/${group.id}/models/${model.id}`,{expected_control_version:0},'PUT')
 await admin(`/groups/${group.id}/models/${model.id}/prices`,{expected_control_version:0,input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100})
 await admin('/accounts',{name:crypto.randomUUID(),platform:'antigravity',protocol:'gemini',auth_scheme:'bearer',credential_kind:'oauth',provider_config:{project_id:'antigravity-project'},base_url:'https://upstream.e2e.invalid',api_key:'antigravity-local-fixture',enabled:true,group_links:[{group_id:group.id,priority:0,weight:1}],model_capabilities:[{model_id:model.id,chat_completions:true,responses:true}]})
 await env.DB.prepare('UPDATE api_keys SET group_id=? WHERE id=?').bind(group.id,f.api_key_id).run()
 const state=async()=>(await(await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json()) as any
 return{invoke,f,model,state}
}
it.each(['chat','responses','anthropic'] as const)('bridges %s unary and stream while billing native reported tokens once',async client=>{
 const t=await fixture()
 for(const stream of [false,true]){
  const body=client==='responses'?{model:t.model.public_name,input:'hello',max_output_tokens:16,stream}:{model:t.model.public_name,messages:[{role:'user',content:'hello'}],max_tokens:16,stream}
  const response=await t.invoke(client==='chat'?'/v1/chat/completions':client==='responses'?'/v1/responses':'/v1/messages',t.f.api_key,body)
  expect(response.status,await response.clone().text()).toBe(200)
  const text=await response.text();expect(text).toContain('Antigravity OK');expect(text).not.toContain('usageMetadata')
  expect(text).toContain(client==='anthropic'?'message':client==='responses'?'response':'chat.completion')
 }
 const state=await t.state();expect(state.profile).toMatchObject({balance_micros:999946,reserved_micros:0});expect(state.requests.filter((r:any)=>r.status==='settled')).toHaveLength(2)
})
it('rejects unsupported tool and counting requests with zero billing; error-only upstream streams are free',async()=>{
 const t=await fixture('anti-cross-error')
 const unsupported=await t.invoke('/v1/responses',t.f.api_key,{model:t.model.public_name,input:'hello',tools:[{type:'web_search'}]})
 expect(unsupported.status).toBe(400)
 const count=await t.invoke('/v1/messages/count_tokens',t.f.api_key,{model:t.model.public_name,messages:[{role:'user',content:'hello'}]})
 expect([400,409]).toContain(count.status)
 for(const stream of [false,true]){
  const current=stream?await fixture('anti-cross-error'):t
  const response=await current.invoke('/v1/responses',current.f.api_key,{model:current.model.public_name,input:'hello',max_output_tokens:16,stream})
  const text=await response.text();expect((await current.state()).profile).toMatchObject({balance_micros:1000000,reserved_micros:0});if(stream){expect(text).toContain('failed')}else expect(response.status).toBeGreaterThanOrEqual(400)
 }
 expect((await t.state()).profile).toMatchObject({balance_micros:1000000,reserved_micros:0})
})
it('never marks a truncated Gemini stream completed',async()=>{
 const t=await fixture('anti-cross-truncated')
 const response=await t.invoke('/v1/responses',t.f.api_key,{model:t.model.public_name,input:'hello',max_output_tokens:16,stream:true})
 const text=await response.text();expect(text).toContain('partial');expect(text).toContain('response.failed');expect(text).not.toContain('response.completed')
 expect((await t.state()).profile.reserved_micros).toBe(0)
})

it('enforces output limits and insufficient funds before any Antigravity dispatch',async()=>{
 const t=await fixture()
 const oversized=await t.invoke('/v1/responses',t.f.api_key,{model:t.model.public_name,input:'hello',max_output_tokens:100000000})
 expect(oversized.status).toBe(400)
 await env.DB.prepare('UPDATE users SET balance_micros=0,state_version=state_version+1 WHERE id=?').bind(t.f.user_id).run()
 const noFunds=await t.invoke('/v1/responses',t.f.api_key,{model:t.model.public_name,input:'hello',max_output_tokens:16})
 expect(noFunds.status).toBe(403)
 expect((await t.state()).profile).toMatchObject({balance_micros:0,reserved_micros:0})
})
