import {env,exports} from 'cloudflare:workers'
import {expect,it,vi} from 'vitest'
import {poolStateName,responseAffinityKey} from '../../src/gateway/state-client'
it('binds actual completed SSE and JSON response IDs, reuses the account, and rejects another Key without charging',async()=>{
 async function request(path:string,token:string,body?:unknown,headers:Record<string,string>={}){return exports.default.fetch(new Request('https://worker.e2e.invalid'+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)}))}
 const bootstrap=await request('/api/v1/admin/bootstrap',env.ADMIN_TOKEN!,{user:{email:'scheduler-response@example.test',balance_micros:1000000},group:{name:'Scheduler lifecycle'},account:{name:'Scheduler upstream',base_url:'https://upstream.e2e.invalid/v1',api_key:'fixture-scheduler',max_concurrency:2},api_key:{name:'First key'},models:[{public_name:'scheduler-response',upstream_name:'scheduler-response-upstream',endpoint:'both',input_micros_per_million:1000000,output_micros_per_million:2000000,minimum_reservation_micros:100}]})
 expect(bootstrap.status,await bootstrap.clone().text()).toBe(201)
 const {data:f}=await bootstrap.json() as {data:{api_key:string;api_key_id:string;user_id:string;group_id:string;account_id:string;admin_session:string}}
 await env.DB.prepare("UPDATE system_settings SET gateway_json=? WHERE id='global'").bind(JSON.stringify({openai_advanced_scheduler_enabled:true})).run()
 const stream=await request('/v1/responses',f.api_key,{model:'scheduler-response',input:'hello',max_output_tokens:16,stream:true})
 expect(stream.status,await stream.clone().text()).toBe(200)
 expect(await stream.text()).toContain('resp-scheduler-first')
 const model=await env.DB.prepare("SELECT id FROM models WHERE public_name='scheduler-response'").first<{id:string}>()
 const pool=env.POOL_STATE.get(env.POOL_STATE.idFromName(poolStateName(f.group_id,model!.id,'responses')))
 const binding=await pool.fetch('https://pool.test/response-affinity',{method:'POST',body:JSON.stringify({schema_version:1,response_key:await responseAffinityKey(f.user_id,f.api_key_id,'resp-scheduler-first')})})
 expect(await binding.json()).toMatchObject({account_id:f.account_id})
 const continued=await request('/v1/responses',f.api_key,{model:'scheduler-response',input:'continue',previous_response_id:'resp-scheduler-first',max_output_tokens:16})
 expect(continued.status,await continued.clone().text()).toBe(200)
 expect(await continued.json()).toMatchObject({id:'resp-scheduler-next'})
 const second=await request(`/api/v1/admin/users/${f.user_id}/api-keys`,f.admin_session,{name:'Second key',group_id:f.group_id},{'idempotency-key':crypto.randomUUID()})
 expect(second.status,await second.clone().text()).toBe(201)
 const {data:key}=await second.json() as {data:{api_key:string}}
 const user=env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id))
 const before=await (await user.fetch('https://user.test/snapshot')).json() as {profile:{balance_micros:number;reserved_micros:number}}
 const forbidden=await request('/v1/responses',key.api_key,{model:'scheduler-response',input:'continue',previous_response_id:'resp-scheduler-first',max_output_tokens:16})
 expect(forbidden.status,await forbidden.clone().text()).toBe(400)
 expect(await forbidden.json()).toMatchObject({error:{code:'previous_response_not_found'}})
 expect(await (await user.fetch('https://user.test/snapshot')).json()).toMatchObject({profile:{balance_micros:before.profile.balance_micros,reserved_micros:0}})
 for(const id of ['hold-1','hold-2'])expect((await pool.fetch('https://pool.test/reserve',{method:'POST',body:JSON.stringify({schema_version:1,request_id:id,lease_ttl_ms:60000})})).status).toBe(200)
 const queued=request('/v1/responses',f.api_key,{model:'scheduler-response',input:'waiting',max_output_tokens:16})
 await vi.waitFor(async()=>expect(await (await pool.fetch('https://pool.test/snapshot')).json()).toMatchObject({waiting:[expect.anything()]}))
 await env.DB.prepare('UPDATE api_keys SET enabled=0 WHERE id=?').bind(f.api_key_id).run()
 for(const id of ['hold-1','hold-2'])await pool.fetch('https://pool.test/release',{method:'POST',body:JSON.stringify({schema_version:1,request_id:id})})
 const deniedAfterQueue=await queued
 expect(deniedAfterQueue.status,await deniedAfterQueue.clone().text()).toBe(401)
 expect(await (await user.fetch('https://user.test/snapshot')).json()).toMatchObject({profile:{balance_micros:before.profile.balance_micros,reserved_micros:0}})

})
