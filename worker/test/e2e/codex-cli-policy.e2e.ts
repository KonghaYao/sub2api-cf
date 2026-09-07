import {env,exports} from 'cloudflare:workers'
import {expect,it} from 'vitest'
let administratorSession:string|undefined
async function request(path:string,token:string,body:unknown,headers:Record<string,string>={}){return exports.default.fetch(new Request('https://worker.e2e.invalid'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:JSON.stringify(body)}))}
it('round-trips CLI policy through admin settings, real D1 account projection, admission and the original inbound gate',async()=>{
 const platform='codex'
 const model='cli-policy-'+platform+'-'+crypto.randomUUID()
 const seeded=await request('/api/v1/admin/bootstrap',env.ADMIN_TOKEN!,{
  user:{email:crypto.randomUUID()+'@provider.test',balance_micros:1000000},group:{name:crypto.randomUUID()},
  account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture-key'},api_key:{name:'provider'},
  models:[{public_name:model+'-unused',upstream_name:'provider-forwarding-'+platform,endpoint:'responses',input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100}],
 })
 expect(seeded.status).toBe(201);const f=(await seeded.json() as any).data
 administratorSession??=f.admin_session
 const admin=async(path:string,body:unknown,method='POST')=>{
  const response=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin'+path,{method,headers:{authorization:'Bearer '+administratorSession,'content-type':'application/json','idempotency-key':crypto.randomUUID(),...((body as any).expected_control_version!==undefined?{'if-match':'"'+(body as any).expected_control_version+'"'}:{})},body:JSON.stringify(Object.fromEntries(Object.entries(body as Record<string,unknown>).filter(([key])=>!(key==='expected_control_version'&&(path==='/settings'||path.startsWith('/accounts/'))))))}))
  expect([200,201],await response.clone().text()).toContain(response.status);return (await response.json() as any).data
 }
 const group=await admin('/groups',{name:crypto.randomUUID(),platform})
 const route=await admin('/models',{public_name:model,upstream_name:'provider-forwarding-'+platform,platform,endpoint:'responses'})
 await admin(`/groups/${group.id}/models/${route.id}`,{expected_control_version:0},'PUT')
 await admin(`/groups/${group.id}/models/${route.id}/prices`,{expected_control_version:0,input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100})
 const account=await admin('/accounts',{name:crypto.randomUUID(),platform,protocol:platform,auth_scheme:'bearer',credential_kind:'oauth',image_adapter:platform==='codex'?'responses_image_tool':'direct_images',base_url:platform==='codex'?'https://upstream.e2e.invalid':'https://upstream.e2e.invalid/v1',api_key:'local-fixture-key',enabled:true,extra:{codex_cli_only:true},group_links:[{group_id:group.id,priority:0,weight:1}],model_capabilities:[{model_id:route.id,chat_completions:false,responses:true}]})
 await env.DB.batch([
  env.DB.prepare('UPDATE api_keys SET group_id=? WHERE id=?').bind(group.id,f.api_key_id),
  env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.openai_codex_client_version','0.200.0','$.openai_codex_user_agent','codex-tui/0.100.0 (Linux)','$.claude_oauth_system_prompt','Custom fixture expansion') WHERE id='global'"),
 ])

 const old=(await env.DB.prepare("SELECT gateway_json FROM system_settings WHERE id='global'").first<any>())!.gateway_json
 const patch=async(gateway:unknown)=>{const current=await env.DB.prepare("SELECT control_version FROM system_settings WHERE id='global'").first<any>();return admin('/settings',{gateway,expected_control_version:current!.control_version},'PUT')}
 const call=(headers:Record<string,string>={},body:Record<string,unknown>={})=>request('/v1/responses',f.api_key,{model,input:'hello',max_output_tokens:16,stream:false,...body},headers)
 try{
  await patch({codex_cli_only_allow_app_server_clients:false,codex_cli_only_blacklist:'',codex_cli_only_whitelist:'',codex_cli_only_engine_fingerprint_signals:JSON.stringify([{type:'header_prefix',match:['x-codex-'],required:true}])})
  const denied=await call();expect(denied.status,await denied.clone().text()).toBe(403)
  // Outbound settings supply an official UA, but may never turn a missing inbound identity into authorization.
  expect(await denied.text()).toContain('codex_cli_only')
  const official={'user-agent':'codex-tui/0.100.0','x-codex-window-id':'window'}
  const allowed=await call(official);expect(allowed.status,await allowed.clone().text()).toBe(200)
  await patch({codex_cli_only_blacklist:'[{"originator":"blocked"}]'})
  expect((await call({...official,originator:'blocked'})).status).toBe(403)
  await patch({codex_cli_only_blacklist:'',codex_cli_only_whitelist:'[{"originator":"tool","ua_contains":["tool/","integration"],"skip_engine_fingerprint":true}]'})
  expect((await call({'user-agent':'tool/1 integration',originator:'tool'})).status).toBe(200)
  expect((await call({'user-agent':'tool/1',originator:'tool'})).status).toBe(403)
  await patch({codex_cli_only_whitelist:'',codex_cli_only_allow_app_server_clients:true,codex_cli_only_engine_fingerprint_signals:JSON.stringify([{type:'body_path',match:['client_metadata.engine'],required:true}])})
  expect((await call({'user-agent':'tool/1',originator:'tool'})).status).toBe(403)
  expect((await call({'user-agent':'tool/1',originator:'tool'},{client_metadata:{engine:'original'}})).status).toBe(200)
  const current=await env.DB.prepare('SELECT control_version FROM accounts WHERE id=?').bind(account.id).first<any>()
  await admin('/accounts/'+account.id,{expected_control_version:current!.control_version,extra:{codex_cli_only:false}},'PUT')
  expect((await call()).status).toBe(200)
  const state=await (await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
  expect(state.profile.reserved_micros).toBe(0)
 }finally{await env.DB.prepare("UPDATE system_settings SET gateway_json=? WHERE id='global'").bind(old).run()}
})
