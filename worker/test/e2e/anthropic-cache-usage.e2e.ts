import { env, exports } from 'cloudflare:workers'
import { expect, it } from 'vitest'
let adminSession: string | undefined
const post = (path: string, token: string, body: unknown, method='POST') => exports.default.fetch(new Request('https://worker.e2e.invalid'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)}))
it.each([false,true])('keeps native Anthropic cache usage in client, ledger and dashboard (stream=%s)',async stream=>{
  const model='anthropic-cache-'+crypto.randomUUID()
  const seed=await post('/api/v1/admin/bootstrap',env.ADMIN_TOKEN!,{
    user:{email:crypto.randomUUID()+'@cache.test',balance_micros:1000000},group:{name:crypto.randomUUID()},
    account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture'},api_key:{name:'cache'},
    models:[{public_name:model+'-unused',upstream_name:'unused',endpoint:'responses',input_micros_per_million:1000000,output_micros_per_million:2000000,minimum_reservation_micros:100}],
  })
  expect(seed.status).toBe(201);const f=(await seed.json() as any).data
  adminSession??=f.admin_session
  const admin=async(path:string,body:unknown,method='POST')=>{
    const res=await post('/api/v1/admin'+path,adminSession!,body,method)
    expect([200,201],await res.clone().text()).toContain(res.status);return(await res.json() as any).data
  }
  const group=await admin('/groups',{name:crypto.randomUUID(),platform:'anthropic'})
  const route=await admin('/models',{public_name:model,upstream_name:'anthropic-cache-alias-fixture',platform:'anthropic',endpoint:'responses'})
  await admin(`/groups/${group.id}/models/${route.id}`,{expected_control_version:0},'PUT')
  await admin(`/groups/${group.id}/models/${route.id}/prices`,{expected_control_version:0,input_micros_per_million:1000000,output_micros_per_million:2000000,cache_read_micros_per_million:1000000,per_request_micros:0,minimum_reservation_micros:100})
  await admin('/accounts',{name:crypto.randomUUID(),platform:'anthropic',protocol:'anthropic',auth_scheme:'x-api-key',credential_kind:'api_key',base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture',enabled:true,group_links:[{group_id:group.id,priority:0,weight:1}],model_capabilities:[{model_id:route.id,chat_completions:false,responses:true}]})
  await env.DB.prepare('UPDATE api_keys SET group_id=? WHERE id=?').bind(group.id,f.api_key_id).run()
  const response=await post('/v1/messages',f.api_key,{model,messages:[{role:'user',content:'Hi'}],max_tokens:32,stream})
  expect(response.status,await response.clone().text()).toBe(200)
  const body=await response.text();expect(body).toContain('"cache_read_input_tokens":3');expect(body).toContain('Cache OK')
  await expect.poll(async()=>await env.DB.prepare('SELECT input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM usage_projection WHERE user_id=?').bind(f.user_id).first()).toEqual({input_tokens:16,output_tokens:2,cache_read_tokens:3,cache_write_tokens:5})
  const state=await(await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
  expect(state.profile.reserved_micros).toBe(0);expect(state.requests).toHaveLength(1);expect(state.requests[0].settled_micros).toBe(20)
  const dashboard=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/usage/stats?user_id='+f.user_id,{headers:{authorization:'Bearer '+adminSession}}))
  expect(dashboard.status).toBe(200)
  expect((await dashboard.json() as any).data).toMatchObject({total_input_tokens:8,total_cache_creation_tokens:5,total_cache_read_tokens:3,total_tokens:18})
})
