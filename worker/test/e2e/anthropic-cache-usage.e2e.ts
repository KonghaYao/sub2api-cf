import { env, exports } from 'cloudflare:workers'
import { expect, it } from 'vitest'
let adminSession: string | undefined
const post = (path: string, token: string, body: unknown, method='POST') => exports.default.fetch(new Request('https://worker.e2e.invalid'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)}))
it.each([[false,false,false,'none'],[true,false,false,'none'],[false,true,false,'none'],[true,true,false,'none'],[false,true,true,'none'],[true,true,true,'none'],[false,true,false,'global'],[true,true,false,'global'],[false,true,false,'account1h'],[true,true,false,'account1h'],[false,true,false,'api-global'],[true,true,false,'api-global']] as const)('keeps native Anthropic cache usage (stream=%s, priced=%s, freeInterval=%s, override=%s)',async (stream,priced,freeInterval,override)=>{
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
  await env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.enable_anthropic_cache_ttl_1h_injection',json(?)) WHERE id='global'").bind(JSON.stringify(override!=='none')).run()
  const group=await admin('/groups' ,{name:crypto.randomUUID(),platform:'anthropic'})
  await env.DB.prepare('UPDATE "groups" SET rate_multiplier_ppm=2000000 WHERE id=?').bind(group.id).run()
  const route=await admin('/models',{public_name:model,upstream_name:'anthropic-cache-alias-fixture',platform:'anthropic',endpoint:'responses'})
  await admin(`/groups/${group.id}/models/${route.id}`,{expected_control_version:0},'PUT')
  await admin(`/groups/${group.id}/models/${route.id}/prices`,{expected_control_version:0,input_micros_per_million:1000000,output_micros_per_million:2000000,cache_read_micros_per_million:1000000,per_request_micros:0,minimum_reservation_micros:100})
  await admin('/accounts',{name:crypto.randomUUID(),platform:'anthropic',protocol:'anthropic',auth_scheme:'x-api-key',credential_kind:override==='global'||override==='account1h'?'setup_token':'api_key',extra:override==='account1h'?{cache_ttl_override_enabled:true,cache_ttl_override_target:'1h'}:{},...(override==='global'||override==='account1h'?{credentials:{access_token:'local-fixture'}}:{}),base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture',enabled:true,group_links:[{group_id:group.id,priority:0,weight:1}],model_capabilities:[{model_id:route.id,chat_completions:false,responses:true}]})
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
  if (priced) await env.DB.batch([
    env.DB.prepare("INSERT INTO channel_model_pricing (id,channel_id,platform,billing_mode,input_micros_per_million,output_micros_per_million,cache_write_micros_per_million,cache_write_1h_micros_per_million,cache_read_micros_per_million,created_at_ms,updated_at_ms) VALUES (?,?,'anthropic','token',1000000,2000000,7000000,11000000,1000000,1,1)").bind(price+'-customer',channel),
    env.DB.prepare('INSERT INTO channel_pricing_models (pricing_id,model_pattern,is_wildcard,sort_order,created_at_ms) VALUES (?,?,0,0,1)').bind(price+'-customer',model),
  ])
  if (freeInterval) await env.DB.prepare("INSERT INTO channel_pricing_intervals (id,pricing_id,min_tokens,cache_write_micros_per_million,cache_write_multiplier_ppm,sort_order,created_at_ms,updated_at_ms) VALUES (?,?,0,0,2000000,0,1,1)").bind(price+'-interval',price+'-customer').run()
  const overridden=override==='global'||override==='account1h'
  const five=override==='global'?5:override==='account1h'?0:2, hour=5-five
  const basis=override==='global'?50:override==='account1h'?70:freeInterval?15:priced?62:20
  const accountCost=override==='global'?53:override==='account1h'?73:65
  const creationCost=override==='global'?35:override==='account1h'?55:priced&&!freeInterval?47:0
  const response=await post('/v1/messages',f.api_key,{model,messages:[{role:'user',content:[{type:'text',text:'TTL probe '+(overridden?'1h':'5m'),cache_control:{type:'ephemeral',ttl:'5m'}}]}],max_tokens:32,stream})
  const failure = response.status === 200 ? null : await env.DB.prepare('SELECT error_message,error_type FROM request_observations WHERE user_id=? ORDER BY occurred_at_ms DESC LIMIT 1').bind(f.user_id).first()
  expect(response.status,(await response.clone().text())+' '+JSON.stringify(failure)).toBe(200)
  const body=await response.text();expect(body).toContain('"cache_read_input_tokens":3');expect(body).toContain('Cache OK');expect(body).toContain('"ephemeral_5m_input_tokens":'+five);expect(body).toContain('"ephemeral_1h_input_tokens":'+hour)
  await expect.poll(async()=>await env.DB.prepare('SELECT input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM usage_projection WHERE user_id=?').bind(f.user_id).first()).toEqual({input_tokens:16,output_tokens:2,cache_read_tokens:3,cache_write_tokens:5})
  expect(await env.DB.prepare('SELECT account_stats_cost_micros,account_cost_micros FROM usage_projection WHERE user_id=?').bind(f.user_id).first()).toEqual({account_stats_cost_micros:accountCost,account_cost_micros:accountCost})
  expect(await env.DB.prepare('SELECT cache_write_5m_tokens,cache_write_1h_tokens FROM usage_projection WHERE user_id=?').bind(f.user_id).first()).toEqual({cache_write_5m_tokens:five,cache_write_1h_tokens:hour})
  const state=await(await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
  expect(state.profile.reserved_micros).toBe(0);expect(state.requests).toHaveLength(1);expect(state.requests[0].settled_micros).toBe(basis*2)
  const detail=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/usage?page=1&user_id='+f.user_id,{headers:{authorization:'Bearer '+adminSession}}))
  expect(detail.status).toBe(200);expect((await detail.json() as any).data.items[0]).toMatchObject({cache_creation_tokens:5,cache_creation_5m_tokens:five,cache_creation_1h_tokens:hour,cache_ttl_overridden:overridden,cache_creation_cost:creationCost/1_000_000,total_cost:(basis)/1_000_000,actual_cost:(basis*2)/1_000_000,rate_multiplier:2})
  const dashboard=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/usage/stats?user_id='+f.user_id,{headers:{authorization:'Bearer '+adminSession}}))
  expect(dashboard.status).toBe(200)
  expect((await dashboard.json() as any).data).toMatchObject({total_input_tokens:8,total_cache_creation_tokens:5,total_cache_read_tokens:3,total_tokens:18,total_cost:(basis)/1_000_000,total_actual_cost:(basis*2)/1_000_000})
})
