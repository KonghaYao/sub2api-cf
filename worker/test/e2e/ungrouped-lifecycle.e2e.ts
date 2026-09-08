import {env,exports} from 'cloudflare:workers'
import {expect,it} from 'vitest'
it('ungrouped requests need their own explicit catalog and price and lose access immediately when an account becomes private',async()=>{
 const invoke=(path:string,token:string,body:unknown,method='POST')=>exports.default.fetch(new Request('https://worker.e2e.invalid'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)}))
 const name='ungrouped-'+crypto.randomUUID(),virtual='worker-ungrouped-default'
 const seeded=await invoke('/api/v1/admin/bootstrap',env.ADMIN_TOKEN!,{user:{email:crypto.randomUUID()+'@ungrouped.test',balance_micros:1000000},group:{name:crypto.randomUUID()},account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture-key'},api_key:{name:'ungrouped'},models:[{public_name:name,upstream_name:'ungrouped-fixture',endpoint:'chat_completions',input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100}]})
 expect(seeded.status).toBe(201);const f=(await seeded.json() as any).data
 const admin=async(path:string,body:unknown,method='POST')=>{const r=await invoke('/api/v1/admin'+path,f.admin_session,body,method);expect([200,201],await r.clone().text()).toContain(r.status);return (await r.json() as any).data}
 const model=await env.DB.prepare('SELECT id FROM models WHERE public_name=?').bind(name).first<{id:string}>()
 await env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.allow_ungrouped_key_scheduling',json('true')) WHERE id='global'").run()
 await env.DB.prepare('UPDATE api_keys SET group_id=? WHERE id=?').bind(virtual,f.api_key_id).run()
 const call=()=>invoke('/v1/chat/completions',f.api_key,{model:name,messages:[{role:'user',content:'hello'}],max_tokens:16,stream:false})
 const state=async()=>(await(await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json()) as any
 try{
  expect((await call()).status).toBe(404)
  await admin(`/groups/${virtual}/models/${model!.id}`,{expected_control_version:0},'PUT')
  await admin(`/groups/${virtual}/models/${model!.id}/prices`,{expected_control_version:0,input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100})
  const privateOnly=await call();expect(privateOnly.status,await privateOnly.clone().text()).not.toBe(200)
  await env.DB.prepare('DELETE FROM account_groups WHERE account_id=?').bind(f.account_id).run()
  const allowed=await call();expect(allowed.status,await allowed.clone().text()).toBe(200);await allowed.text()
  expect((await state()).profile).toMatchObject({balance_micros:999973,reserved_micros:0})
  await env.DB.prepare('INSERT INTO account_groups(account_id,group_id,created_at_ms,updated_at_ms)VALUES(?,?,?,?)').bind(f.account_id,f.group_id,Date.now(),Date.now()).run()
  expect((await call()).status).not.toBe(200)
  await env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.allow_ungrouped_key_scheduling',json('false')) WHERE id='global'").run()
  const disabled=await call();expect(disabled.status).toBe(403);expect(await disabled.text()).toContain('group_unavailable')
  expect((await state()).profile).toMatchObject({balance_micros:999973,reserved_micros:0})
 }finally{await env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.allow_ungrouped_key_scheduling',json('false')) WHERE id='global'").run()}
})
