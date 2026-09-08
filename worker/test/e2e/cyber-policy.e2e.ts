import {env,exports} from 'cloudflare:workers'
import {expect,it,vi} from 'vitest'
it.each([false,true])('blocks a refused session before the next reservation for stream=%s with zero billing',async stream=>{
 const publicName='cyber-'+crypto.randomUUID()
 const bootstrap=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/bootstrap',{method:'POST',headers:{authorization:'Bearer '+env.ADMIN_TOKEN,'content-type':'application/json'},body:JSON.stringify({
  user:{email:crypto.randomUUID()+'@cyber.test',balance_micros:1000000},group:{name:crypto.randomUUID()},
  account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture-key'},api_key:{name:'cyber'},
  models:[{public_name:publicName,upstream_name:'cyber-policy-test',endpoint:'responses',input_micros_per_million:1000000,output_micros_per_million:2000000,minimum_reservation_micros:100}],
 })}))
 expect(bootstrap.status,await bootstrap.clone().text()).toBe(201)
 const fixture=(await bootstrap.json() as any).data
 await env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.cyber_session_block_enabled',json('true'),'$.risk_control_enabled',json('true')) WHERE id='global'").run()
 const call=()=>exports.default.fetch(new Request('https://worker.e2e.invalid/v1/responses',{method:'POST',headers:{authorization:'Bearer '+fixture.api_key,'content-type':'application/json','session_id':'private-'+publicName},body:JSON.stringify({model:publicName,input:'private request',max_output_tokens:16,stream})}))
 try{
  const first=await call();expect(await first.text()).toContain('cyber_policy')
  const second=await call();expect(second.status,await second.clone().text()).toBe(403)
  expect(await second.json()).toMatchObject({error:{code:'session_blocked_by_cyber_policy'}})
  await vi.waitFor(async()=>{
   const state=await (await env.USER_STATE.get(env.USER_STATE.idFromName(fixture.user_id)).fetch('https://state.test/snapshot')).json() as any
   expect(state.profile).toMatchObject({balance_micros:1000000,reserved_micros:0})
   expect(state.ledger.filter((row:any)=>row.amount_delta_micros<0)).toHaveLength(0)
  })
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM gateway_risk_events WHERE api_key_id=?').bind(fixture.api_key_id).first()).toEqual({count:1})
  expect(await env.DB.prepare('SELECT quota_used_micros FROM api_keys WHERE id=?').bind(fixture.api_key_id).first()).toEqual({quota_used_micros:0})
 }finally{await env.DB.prepare("UPDATE system_settings SET gateway_json=json_remove(gateway_json,'$.cyber_session_block_enabled','$.risk_control_enabled') WHERE id='global'").run()}
})
