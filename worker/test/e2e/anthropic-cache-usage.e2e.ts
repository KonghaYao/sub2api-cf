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
  const channel='ttl-'+crypto.randomUUID(),rule='ttl-'+crypto.randomUUID(),price='ttl-'+crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO channels (id,name,status,created_at_ms,updated_at_ms) VALUES (?,?,'active',1,1)").bind(channel,channel),
    env.DB.prepare('INSERT INTO channel_groups (channel_id,group_id,created_at_ms) VALUES (?,?,1)').bind(channel,group.id),
    env.DB.prepare('INSERT INTO channel_account_stats_pricing_rules (id,channel_id,name,sort_order,created_at_ms,updated_at_ms) VALUES (?,?,?,0,1,1)').bind(rule,channel,rule),
    env.DB.prepare('INSERT INTO channel_account_stats_rule_groups (rule_id,group_id,created_at_ms) VALUES (?,?,1)').bind(rule,group.id),
    env.DB.prepare("INSERT INTO channel_account_stats_model_pricing (id,rule_id,platform,billing_mode,input_micros_per_million,output_micros_per_million,cache_write_micros_per_million,cache_write_1h_micros_per_million,cache_read_micros_per_million,sort_order,created_at_ms,updated_at_ms) VALUES (?,?,'anthropic','token',1000000,2000000,7000000,11000000,2000000,0,1,1)").bind(price,rule),
    env.DB.prepare('INSERT INTO channel_account_stats_pricing_models (pricing_id,model_pattern,is_wildcard,sort_order,created_at_ms) VALUES (?,?,0,0,1)').bind(price,'anthropic-cache-alias-fixture'),
  ])
  const response=await post('/v1/messages',f.api_key,{model,messages:[{role:'user',content:'Hi'}],max_tokens:32,stream})
  expect(response.status,await response.clone().text()).toBe(200)
  const body=await response.text();expect(body).toContain('"cache_read_input_tokens":3');expect(body).toContain('Cache OK')
  await expect.poll(async()=>await env.DB.prepare('SELECT input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM usage_projection WHERE user_id=?').bind(f.user_id).first()).toEqual({input_tokens:16,output_tokens:2,cache_read_tokens:3,cache_write_tokens:5})
  expect(await env.DB.prepare('SELECT account_stats_cost_micros,account_cost_micros FROM usage_projection WHERE user_id=?').bind(f.user_id).first()).toEqual({account_stats_cost_micros:65,account_cost_micros:65})
  const state=await(await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
  expect(state.profile.reserved_micros).toBe(0);expect(state.requests).toHaveLength(1);expect(state.requests[0].settled_micros).toBe(20)
  const dashboard=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/usage/stats?user_id='+f.user_id,{headers:{authorization:'Bearer '+adminSession}}))
  expect(dashboard.status).toBe(200)
  expect((await dashboard.json() as any).data).toMatchObject({total_input_tokens:8,total_cache_creation_tokens:5,total_cache_read_tokens:3,total_tokens:18})
})
