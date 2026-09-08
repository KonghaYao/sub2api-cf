import {env,exports} from 'cloudflare:workers'
import {expect,it} from 'vitest'
let administratorSession:string|undefined
async function request(path:string,token:string,body:unknown,headers:Record<string,string>={}){return exports.default.fetch(new Request('https://worker.e2e.invalid'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:JSON.stringify(body)}))}
it('uses native Grok accounts with authorized catalog mapping, live setting changes, streaming and fixed billing scope',async()=>{
 const platform='grok'
 const model='gpt-grok-fixture-'+crypto.randomUUID()
 const seeded=await request('/api/v1/admin/bootstrap',env.ADMIN_TOKEN!,{
  user:{email:crypto.randomUUID()+'@provider.test',balance_micros:1000000},group:{name:crypto.randomUUID()},
  account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture-key'},api_key:{name:'provider'},
  models:[{public_name:model+'-unused',upstream_name:model,endpoint:'responses',input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100}],
 })
 expect(seeded.status).toBe(201);const f=(await seeded.json() as any).data
 administratorSession??=f.admin_session
 const admin=async(path:string,body:unknown,method='POST')=>{
  const response=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin'+path,{method,headers:{authorization:'Bearer '+administratorSession,'content-type':'application/json','idempotency-key':crypto.randomUUID(),...((body as any).expected_control_version!==undefined?{'if-match':'"'+(body as any).expected_control_version+'"'}:{})},body:JSON.stringify(Object.fromEntries(Object.entries(body as Record<string,unknown>).filter(([key])=>!(key==='expected_control_version'&&(path==='/settings'||path.startsWith('/accounts/'))))))}))
  expect([200,201],await response.clone().text()).toContain(response.status);return (await response.json() as any).data
 }
 const group=await admin('/groups',{name:crypto.randomUUID(),platform})
 const route=await admin('/models',{public_name:model,upstream_name:model,platform,endpoint:'chat_completions'})
 await admin(`/groups/${group.id}/models/${route.id}`,{expected_control_version:0},'PUT')
 await admin(`/groups/${group.id}/models/${route.id}/prices`,{expected_control_version:0,input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100})
 const account=await admin('/accounts',{name:crypto.randomUUID(),platform,protocol:'openai',auth_scheme:'bearer',credential_kind:'api_key',image_adapter:'direct_images',base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture-key',enabled:true,group_links:[{group_id:group.id,priority:0,weight:1}],model_capabilities:[{model_id:route.id,chat_completions:true,responses:false}]})
 await env.DB.batch([
  env.DB.prepare('UPDATE api_keys SET group_id=? WHERE id=?').bind(group.id,f.api_key_id),
  env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.openai_codex_client_version','0.200.0','$.openai_codex_user_agent','codex-tui/0.100.0 (Linux)','$.claude_oauth_system_prompt','Custom fixture expansion') WHERE id='global'"),
 ])


 const old=(await env.DB.prepare("SELECT gateway_json FROM system_settings WHERE id='global'").first<any>())!.gateway_json
 const patch=async(gateway:unknown)=>{const current=await env.DB.prepare("SELECT control_version FROM system_settings WHERE id='global'").first<any>();return admin('/settings',{gateway,expected_control_version:current!.control_version},'PUT')}
 const call=(name=model,stream=false)=>request('/v1/chat/completions',f.api_key,{model:name,messages:[{role:'user',content:'hello'}],max_tokens:16,stream})
 try{
  await patch({grok_default_text_model:'grok-native-fixture-default',grok_cross_client_model_map_enabled:true,grok_default_base_url_mode:'eu-west-1'})
  const mapped=await call();expect(mapped.status,await mapped.clone().text()).toBe(200);expect(await mapped.text()).toContain('grok-native-fixture-default')
  // Explicit account endpoint remains usable despite switching the global default to an official regional endpoint.
  const streaming=await call(model,true);expect(streaming.status).toBe(200);expect(await streaming.text()).toContain('grok-native-fixture-default')
  const missing=await call('gpt-grok-fixture-unconfigured');expect(missing.status,await missing.clone().text()).toBe(404)
  await patch({grok_cross_client_model_map_enabled:false})
  const unmapped=await call();expect(unmapped.status,await unmapped.clone().text()).toBe(200);expect(await unmapped.text()).toContain(model)
  await env.DB.prepare('UPDATE models SET upstream_name=? WHERE id=?').bind('grok-native-fixture-explicit',route.id).run()
  await patch({grok_cross_client_model_map_enabled:true})
  const explicit=await call();expect(explicit.status,await explicit.clone().text()).toBe(200);expect(await explicit.text()).toContain('grok-native-fixture-explicit')
  const state=await (await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
  expect(state.profile.reserved_micros).toBe(0)
  expect(state.requests.filter((item:any)=>item.settled_micros===27)).toHaveLength(4)
 }finally{await env.DB.prepare("UPDATE system_settings SET gateway_json=? WHERE id='global'").bind(old).run()}
})
