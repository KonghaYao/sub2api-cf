import {env,exports} from 'cloudflare:workers'
import {expect,it} from 'vitest'
import {consumeSettingsMaintenance} from '../../src/maintenance/queue'
it('runs real Worker settings→account opt-in→upstream billing GET→CAS rate sync and scheduled maintenance',async()=>{
 async function request(path:string,token:string,body?:unknown,method=body===undefined?'GET':'POST',headers:Record<string,string>={}){return exports.default.fetch(new Request('https://worker.e2e.invalid'+path,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)}))}
 const bootstrap=await request('/api/v1/admin/bootstrap',env.ADMIN_TOKEN!,{user:{email:'billing-probe@example.test',balance_micros:1000000},group:{name:'Billing probe'},account:{name:'Billing upstream',base_url:'https://upstream.e2e.invalid/v1',api_key:'fixture-billing',max_concurrency:1},api_key:{name:'Probe key'},models:[{public_name:'billing-probe-model',upstream_name:'gpt-binding-upstream',endpoint:'chat_completions',input_micros_per_million:1000000,output_micros_per_million:2000000,minimum_reservation_micros:100}]})
 expect(bootstrap.status,await bootstrap.clone().text()).toBe(201)
 const {data:f}=await bootstrap.json() as {data:{account_id:string;admin_session:string;user_id:string}}
 const updated=await request('/api/v1/admin/accounts/'+f.account_id,f.admin_session,{extra:{upstream_billing_probe_enabled:true,upstream_billing_rate_sync_enabled:true}},'PUT',{'if-match':'"0"','idempotency-key':crypto.randomUUID()})
 expect(updated.status,await updated.clone().text()).toBe(200)
 const settings=await request('/api/v1/admin/accounts/upstream-billing-probe/settings',f.admin_session,{enabled:true,interval_minutes:5},'PUT')
 expect(settings.status,await settings.clone().text()).toBe(200)
 const response=await request(`/api/v1/admin/accounts/${f.account_id}/upstream-billing-probe`,f.admin_session,{})
 expect(response.status,await response.clone().text()).toBe(200)
 expect(await response.json()).toMatchObject({data:{account_id:f.account_id,snapshot:{status:'ok',synced_rate_multiplier:0.25}}})
 const stored=await env.DB.prepare('SELECT billing_rate_multiplier_ppm,billing_probe_claim_token FROM accounts WHERE id=?').bind(f.account_id).first()
 expect(stored).toEqual({billing_rate_multiplier_ppm:250000,billing_probe_claim_token:null})
 await env.DB.prepare('UPDATE accounts SET billing_probe_next_at_ms=0 WHERE id=?').bind(f.account_id).run()
 expect(await consumeSettingsMaintenance({schema_version:1,event_type:'settings.maintenance.v1',payload:{task:'upstream_billing_probes'}},env)).toBe(true)
 const due=await env.DB.prepare('SELECT billing_probe_next_at_ms FROM accounts WHERE id=?').bind(f.account_id).first<{billing_probe_next_at_ms:number}>()
 expect(due!.billing_probe_next_at_ms).toBeGreaterThan(Date.now())
 expect(await env.DB.prepare('SELECT balance_micros FROM users WHERE id=?').bind(f.user_id).first()).toEqual({balance_micros:1000000})
})
