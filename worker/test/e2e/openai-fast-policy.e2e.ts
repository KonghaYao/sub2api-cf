import {env,exports} from 'cloudflare:workers'
import {expect,it,vi} from 'vitest'
async function request(path:string,token:string,body?:unknown){return exports.default.fetch(new Request('https://worker.e2e.invalid'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}))}
it.each(['filter','force_priority','block'] as const)('keeps %s upstream tier, reservation, settlement, ledger and Key usage consistent',async action=>{
 const upstream='fast-policy-'+action+'-upstream',publicName='fast-'+crypto.randomUUID()
 const seeded=await request('/api/v1/admin/bootstrap',env.ADMIN_TOKEN!,{
  user:{email:crypto.randomUUID()+'@fast-policy.test',balance_micros:1000000},group:{name:crypto.randomUUID()},
  account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture-key'},api_key:{name:'fast policy'},
  models:[{public_name:publicName,upstream_name:upstream,endpoint:'chat_completions',input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100}],
 })
 expect(seeded.status,await seeded.clone().text()).toBe(201)
 const fixture=(await seeded.json() as any).data
 await env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.openai_fast_policy_settings',json(?)) WHERE id='global'").bind(JSON.stringify({rules:[{service_tier:'all',scope:'apikey',action}]})).run()
 try{
  const response=await request('/v1/chat/completions',fixture.api_key,{model:publicName,messages:[{role:'user',content:'hi'}],max_tokens:16,service_tier:action==='filter'?'priority':'flex',stream:action==='force_priority'})
  expect(response.status,await response.clone().text()).toBe(action==='block'?403:200)
  const output=await response.text();expect(output).toContain(action==='block'?'openai_service_tier_blocked':'policy-body-verified')
  const expected=action==='block'?0:action==='force_priority'?54:27
  await vi.waitFor(async()=>{
   const state=await (await env.USER_STATE.get(env.USER_STATE.idFromName(fixture.user_id)).fetch('https://state.test/snapshot')).json() as any
   expect(state.profile).toMatchObject({balance_micros:1000000-expected,reserved_micros:0})
   expect(state.requests).toHaveLength(1)
   expect(state.requests[0].settled_micros??0).toBe(expected)
   expect(state.ledger.filter((r:any)=>r.amount_delta_micros<0)).toHaveLength(expected?1:0)
   expect(await env.DB.prepare('SELECT quota_used_micros FROM api_keys WHERE id=?').bind(fixture.api_key_id).first()).toEqual({quota_used_micros:expected})
   if(expected)expect(await env.DB.prepare('SELECT amount_micros FROM usage_projection WHERE request_id=?').bind(response.headers.get('x-request-id')).first()).toEqual({amount_micros:expected})
  })
 }finally{await env.DB.prepare("UPDATE system_settings SET gateway_json=json_remove(gateway_json,'$.openai_fast_policy_settings') WHERE id='global'").run()}
})
it('reserves forced priority cost before dispatch and rejects a balance that only covers the original flex request',async()=>{
 const publicName='fast-'+crypto.randomUUID()
 const seeded=await request('/api/v1/admin/bootstrap',env.ADMIN_TOKEN!,{
  user:{email:crypto.randomUUID()+'@fast-policy.test',balance_micros:1500},group:{name:crypto.randomUUID()},
  account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture-key'},api_key:{name:'fast policy'},
  models:[{public_name:publicName,upstream_name:'fast-policy-force_priority-upstream',endpoint:'chat_completions',input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100}],
 })
 expect(seeded.status).toBe(201);const fixture=(await seeded.json() as any).data
 await env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.openai_fast_policy_settings',json(?)) WHERE id='global'").bind(JSON.stringify({rules:[{service_tier:'flex',scope:'apikey',action:'force_priority'}]})).run()
 try{
  const response=await request('/v1/chat/completions',fixture.api_key,{model:publicName,messages:[{role:'user',content:'hi'}],max_tokens:16,service_tier:'flex'})
  expect(response.status,await response.clone().text()).toBe(403)
  const state=await (await env.USER_STATE.get(env.USER_STATE.idFromName(fixture.user_id)).fetch('https://state.test/snapshot')).json() as any
  expect(state.profile).toMatchObject({balance_micros:1500,reserved_micros:0});expect(state.requests.every((r:any)=>(r.settled_micros??0)===0)).toBe(true)
  expect(await response.json()).toMatchObject({error:{code:'insufficient_funds'}})
  expect(await env.DB.prepare('SELECT quota_used_micros FROM api_keys WHERE id=?').bind(fixture.api_key_id).first()).toEqual({quota_used_micros:0})
 }finally{await env.DB.prepare("UPDATE system_settings SET gateway_json=json_remove(gateway_json,'$.openai_fast_policy_settings') WHERE id='global'").run()}
})
