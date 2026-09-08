import {env,exports} from 'cloudflare:workers'
import {expect,it} from 'vitest'
let administratorSession:string|undefined
async function request(path:string,token:string,body:unknown,headers:Record<string,string>={}){return exports.default.fetch(new Request('https://worker.e2e.invalid'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:JSON.stringify(body)}))}
it('executes Antigravity native model catalog, account test, Gemini streaming and non-streaming with real settlement',async()=>{
 const platform='antigravity'
 const model='gemini-antigravity-fixture-'+crypto.randomUUID()
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
 const route=await admin('/models',{public_name:model,upstream_name:model,platform,endpoint:'responses'})
 await admin(`/groups/${group.id}/models/${route.id}`,{expected_control_version:0},'PUT')
 await admin(`/groups/${group.id}/models/${route.id}/prices`,{expected_control_version:0,input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100})
 const account=await admin('/accounts',{name:crypto.randomUUID(),platform,type:'oauth',protocol:'gemini',auth_scheme:'bearer',credential_kind:'oauth',image_adapter:'direct_images',credentials:{base_url:'https://upstream.e2e.invalid',access_token:'antigravity-local-fixture',project_id:'antigravity-project'},enabled:true,group_links:[{group_id:group.id,priority:0,weight:1}],model_capabilities:[{model_id:route.id,chat_completions:false,responses:true}]})
 await env.DB.batch([
  env.DB.prepare('UPDATE api_keys SET group_id=? WHERE id=?').bind(group.id,f.api_key_id),
  env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.openai_codex_client_version','0.200.0','$.openai_codex_user_agent','codex-tui/0.100.0 (Linux)','$.claude_oauth_system_prompt','Custom fixture expansion') WHERE id='global'"),
 ])


 const old=(await env.DB.prepare("SELECT gateway_json FROM system_settings WHERE id='global'").first<any>())!.gateway_json
 const settings=await env.DB.prepare("SELECT control_version FROM system_settings WHERE id='global'").first<any>()
 try {
  await admin('/settings',{gateway:{enable_identity_patch:true,identity_patch_prompt:'You are Antigravity. Fixture custom identity.',antigravity_user_agent_version:'2.3.4'},expected_control_version:settings.control_version},'PUT')
  const models=await admin(`/accounts/${account.id}/models/sync-upstream`,{})
  expect(models.models).toContain('gemini-antigravity-fixture')
  const tested=await request('/api/v1/admin/accounts/'+account.id+'/test',administratorSession!,{model_id:model})
  expect(tested.status).toBe(200);expect(await tested.text()).toContain('"success":true')
  const body={contents:[{role:'user',parts:[{text:'Hello'}]}],generationConfig:{maxOutputTokens:16}}
  const normal=await request('/v1beta/models/'+model+':generateContent',f.api_key,body)
  expect(normal.status,await normal.clone().text()).toBe(200)
  const result=await normal.json() as any;expect(result.candidates[0].content.parts[0].text).toBe('Antigravity OK');expect(result.usageMetadata.promptTokenCount).toBe(10)
  const stream=await request('/v1beta/models/'+model+':streamGenerateContent',f.api_key,body)
  expect(stream.status,await stream.clone().text()).toBe(200);expect(await stream.text()).toContain('Antigravity OK')
  const state=await (await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
  expect(state.profile.reserved_micros).toBe(0);expect(state.profile.balance_micros).toBe(1000000-54)
  expect(state.requests.filter((item:any)=>item.settled_micros===27)).toHaveLength(2)
  // Imported-token edits rotate the actual bearer secret; a blank field retains it.
  const rotated=await admin('/accounts/'+account.id,{credentials:{access_token:'invalid-rotated-token'},expected_control_version:account.control_version},'PUT')
  const blank=await admin('/accounts/'+account.id,{credentials:{access_token:''},expected_control_version:rotated.control_version},'PUT')
  const invalidTest=await request('/api/v1/admin/accounts/'+account.id+'/test',administratorSession!,{model_id:model});expect(await invalidTest.text()).toContain('\"success\":false')
  await admin('/accounts/'+account.id,{credentials:{access_token:'antigravity-local-fixture'},expected_control_version:blank.control_version},'PUT')
  expect((await admin(`/accounts/${account.id}/models/sync-upstream`,{})).models).toContain('gemini-antigravity-fixture')
  const current=await env.DB.prepare('SELECT control_version FROM accounts WHERE id=?').bind(account.id).first<any>()
  await admin('/accounts/'+account.id,{provider_config:{project_id:'changed-project'},expected_control_version:current.control_version},'PUT')
  const readback=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/accounts/'+account.id,{headers:{authorization:'Bearer '+administratorSession}}))
  expect(readback.status).toBe(200);const view=(await readback.json() as any).data
  expect(view.credentials.project_id).toBe('changed-project');expect(view.credentials.antigravity_project_id).toBe('changed-project')
  const saved=await admin('/accounts/'+account.id,{credentials:{project_id:view.credentials.project_id},expected_control_version:view.control_version},'PUT')
  expect(saved.provider_config.project_id).toBe('changed-project')

 } finally { await env.DB.prepare("UPDATE system_settings SET gateway_json=? WHERE id='global'").bind(old).run() }
})
