import {env,exports} from 'cloudflare:workers'
import {expect,it} from 'vitest'
it('official quota threshold rejects before upstream generation, releases all holds, and recovers after reset',async()=>{
 const invoke=(path:string,token:string,body:unknown,method='POST')=>exports.default.fetch(new Request('https://worker.e2e.invalid'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)}))
 const seeded=await invoke('/api/v1/admin/bootstrap',env.ADMIN_TOKEN!,{user:{email:crypto.randomUUID()+'@quota.test',balance_micros:1000000},group:{name:crypto.randomUUID()},account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture-key'},api_key:{name:'quota'},models:[{public_name:'quota-bootstrap-'+crypto.randomUUID(),upstream_name:'quota',endpoint:'responses',input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100}]})
 expect(seeded.status).toBe(201);const f=(await seeded.json() as any).data
 const admin=async(path:string,body:unknown,method='POST')=>{const r=await invoke('/api/v1/admin'+path,f.admin_session,body,method);expect([200,201],await r.clone().text()).toContain(r.status);return (await r.json() as any).data}
 const group=await admin('/groups',{name:crypto.randomUUID(),platform:'codex'})
 const model=await admin('/models',{public_name:'quota-'+crypto.randomUUID(),upstream_name:'quota',platform:'codex',endpoint:'responses'})
 await admin(`/groups/${group.id}/models/${model.id}`,{expected_control_version:0},'PUT')
 await admin(`/groups/${group.id}/models/${model.id}/prices`,{expected_control_version:0,input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100})
 const account=await admin('/accounts',{name:crypto.randomUUID(),platform:'codex',protocol:'codex',auth_scheme:'bearer',credential_kind:'oauth',image_adapter:'responses_image_tool',base_url:'https://chatgpt.com',api_key:'official-quota-local-fixture',enabled:true,group_links:[{group_id:group.id,priority:0,weight:1}],model_capabilities:[{model_id:model.id,chat_completions:false,responses:true}]})
 await env.DB.batch([env.DB.prepare('UPDATE api_keys SET group_id=? WHERE id=?').bind(group.id,f.api_key_id),env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.account_scheduling_thresholds',json(?)) WHERE id='global'").bind(JSON.stringify({openai:80,anthropic:100,grok:100}))])
 const call=()=>invoke('/v1/responses',f.api_key,{model:model.public_name,input:'hello',max_output_tokens:16,stream:false})
 const state=async()=>(await(await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json()) as any
 try {
  const blocked=await call();expect(blocked.status,await blocked.clone().text()).toBe(503);expect(await blocked.text()).toContain('account_scheduling_threshold_reached')
  expect((await state()).profile).toMatchObject({balance_micros:1000000,reserved_micros:0})
  const snapshot=await env.DB.prepare('SELECT value_json FROM runtime_settings WHERE name=?').bind('official-account-quota:'+account.id).first<{value_json:string}>()
  expect(JSON.parse(snapshot!.value_json).windows[0].used_percent).toBe(85)
  await env.DB.prepare("UPDATE runtime_settings SET value_json=json_set(value_json,'$.windows[0].reset_at_ms',?) WHERE name=?").bind(Date.now()-1,'official-account-quota:'+account.id).run()
  const recovered=await call();expect(recovered.status,await recovered.clone().text()).toBe(200)
  expect((await state()).profile).toMatchObject({balance_micros:999983,reserved_micros:0})
  const healthy=await env.DB.prepare('SELECT health_status FROM accounts WHERE id=?').bind(account.id).first<{health_status:string}>();expect(healthy?.health_status).not.toBe('unhealthy')
 }finally{await env.DB.prepare("UPDATE system_settings SET gateway_json=json_remove(gateway_json,'$.account_scheduling_thresholds') WHERE id='global'").run()}
})

it('persists actual Grok rolling headers and rejects reuse after credential replacement',async()=>{
 const {observeGrokQuota,accountThresholdPause}=await import('../../src/gateway/official-account-quota')
 const account={account_id:crypto.randomUUID(),platform:'grok',credential_kind:'api_key',secret_id:'fixture-secret',key_version:1,base_url:'https://api.x.ai/v1',provider_config:{}} as any
 const threshold={openai:100,anthropic:100,grok:80}
 await observeGrokQuota(env,account,new Headers({'x-ratelimit-limit-requests':'100','x-ratelimit-remaining-requests':'5','x-ratelimit-reset-requests':'1m'}))
 expect(await accountThresholdPause(env,threshold,account,{api_key:'local-fixture'})).toBeGreaterThan(Date.now())
 expect(await accountThresholdPause(env,threshold,{...account,secret_id:'replacement-secret'},{api_key:'local-fixture'})).toBeNull()
 expect(await accountThresholdPause(env,{...threshold,grok:100},account,{api_key:'local-fixture'})).toBeNull()
 await env.DB.prepare("UPDATE runtime_settings SET value_json=json_set(value_json,'$.windows[0].reset_at_ms',?) WHERE name=?").bind(Date.now()-1,'official-account-quota:'+account.account_id).run()
 expect(await accountThresholdPause(env,threshold,account,{api_key:'local-fixture'})).toBeNull()
})
