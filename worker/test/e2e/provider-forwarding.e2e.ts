import {env,exports} from 'cloudflare:workers'
import {expect,it} from 'vitest'
let administratorSession: string | undefined
async function request(path:string,token:string,body:unknown){return exports.default.fetch(new Request('https://worker.e2e.invalid'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)}))}
it.each(['anthropic','codex'] as const)('applies persisted %s provider settings through actual admission, outbound fixture and settlement',async platform=>{
 const model='provider-forwarding-'+(platform==='codex'?'native':platform)+'-'+crypto.randomUUID()
 const seeded=await request('/api/v1/admin/bootstrap',env.ADMIN_TOKEN!,{
  user:{email:crypto.randomUUID()+'@provider.test',balance_micros:1000000},group:{name:crypto.randomUUID()},
  account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture-key'},api_key:{name:'provider'},
  models:[{public_name:model+'-unused',upstream_name:'provider-forwarding-'+(platform==='codex'?'native':platform),endpoint:'responses',input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100}],
 })
 expect(seeded.status).toBe(201);const f=(await seeded.json() as any).data
 administratorSession??=f.admin_session
 const admin=async(path:string,body:unknown,method='POST')=>{
  const response=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin'+path,{method,headers:{authorization:'Bearer '+administratorSession,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)}))
  expect([200,201],await response.clone().text()).toContain(response.status);return (await response.json() as any).data
 }
 const group=await admin('/groups',{name:crypto.randomUUID(),platform})
 const route=await admin('/models',{public_name:model,upstream_name:'provider-forwarding-'+(platform==='codex'?'native':platform),platform,endpoint:'responses'})
 await admin(`/groups/${group.id}/models/${route.id}`,{expected_control_version:0},'PUT')
 await admin(`/groups/${group.id}/models/${route.id}/prices`,{expected_control_version:0,input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100})
 await admin('/accounts',{name:crypto.randomUUID(),platform,protocol:platform,auth_scheme:platform==='anthropic'?'x-api-key':'bearer',credential_kind:'oauth',image_adapter:platform==='codex'?'responses_image_tool':'direct_images',base_url:platform==='codex'?'https://upstream.e2e.invalid':'https://upstream.e2e.invalid/v1',api_key:'local-fixture-key',...(platform==='anthropic'?{credentials:{access_token:'local-fixture-key'}}:{}),enabled:true,group_links:[{group_id:group.id,priority:0,weight:1}],model_capabilities:[{model_id:route.id,chat_completions:false,responses:true}]})
 await env.DB.batch([
  env.DB.prepare('UPDATE api_keys SET group_id=? WHERE id=?').bind(group.id,f.api_key_id),
  env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.openai_codex_client_version','0.200.0','$.openai_codex_user_agent','codex-tui/0.100.0 (Linux)','$.claude_oauth_system_prompt','Custom fixture expansion') WHERE id='global'"),
 ])
 try{
  const response=await request(platform==='codex'?'/v1/responses':'/v1/messages',f.api_key,platform==='codex'?{model,input:'hello',max_output_tokens:16,stream:false}:{model,system:[{type:'text',text:'Original client instructions',cache_control:{type:'ephemeral',ttl:'1h'}}],messages:[{role:'user',content:'hello'}],max_tokens:16})
  expect(response.status,await response.clone().text()).toBe(200);expect(await response.text()).toContain('provider-settings-verified')
  const state=await (await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
  expect(state.profile.reserved_micros).toBe(0);expect(state.requests).toHaveLength(1);expect(state.requests[0].settled_micros).toBe(27)
  if(platform==='anthropic')expect(state.requests[0].reserved_micros).toBeGreaterThan(1400)
 }finally{await env.DB.prepare("UPDATE system_settings SET gateway_json=json_remove(gateway_json,'$.openai_codex_client_version','$.openai_codex_user_agent','$.claude_oauth_system_prompt') WHERE id='global'").run()}
})
