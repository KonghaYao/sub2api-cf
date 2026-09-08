import { env } from 'cloudflare:workers'
import { createExecutionContext,waitOnExecutionContext } from 'cloudflare:test'
import { Hono } from 'hono'
import { expect,it } from 'vitest'
import { createApp } from '../../src/app'
import { runtimeSettingHandlers,runtimeSettingNames } from '../../src/control/runtime-settings'
import { poolStateName } from '../../src/gateway/state-client'

it('persists an admin policy and applies its cooldown to real gateway/Pool state without charging the failed request',async()=>{
 const app=new Hono<{Bindings:typeof env}>()
 for(const name of runtimeSettingNames){const handlers=runtimeSettingHandlers(name);app.get(`/api/v1/admin/settings/${name}`,handlers.get);app.put(`/api/v1/admin/settings/${name}`,handlers.put)}
 app.route('/',createApp())
 async function request(path:string,token:string,body?:unknown,method='POST'){
  const ctx=createExecutionContext()
  const response=await app.fetch(new Request(`https://worker.e2e.invalid${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env,ctx)
  await waitOnExecutionContext(ctx)
  return response
 }
 const bootstrap=await request('/api/v1/admin/bootstrap',env.ADMIN_TOKEN!,{
  user:{email:'runtime-binding@example.test',balance_micros:1000000},group:{name:'Runtime settings binding'},account:{name:'Runtime upstream',base_url:'https://upstream.e2e.invalid/v1',api_key:'fixture-upstream',max_concurrency:1},api_key:{name:'Runtime key'},models:[{public_name:'runtime-overload',upstream_name:'runtime-overload-upstream',endpoint:'chat_completions',input_micros_per_million:1000000,output_micros_per_million:2000000,minimum_reservation_micros:100}],
 })
 expect(bootstrap.status,await bootstrap.clone().text()).toBe(201)
 const {data:fixture}=await bootstrap.json() as {data:{user_id:string;account_id:string;group_id:string;api_key:string;admin_session:string}}
 expect((await request('/api/v1/admin/settings/overload-cooldown',fixture.admin_session,{enabled:true,cooldown_minutes:2},'PUT')).status).toBe(200)
 const response=await request('/v1/chat/completions',fixture.api_key,{model:'runtime-overload',max_tokens:16,messages:[{role:'user',content:'hello'}]})
 expect(response.status,await response.clone().text()).toBe(503)
 const model=await env.DB.prepare("SELECT id FROM models WHERE public_name='runtime-overload'").first<{id:string}>()
 const pool=env.POOL_STATE.get(env.POOL_STATE.idFromName(poolStateName(fixture.group_id,model!.id,'chat_completions')))
 const snapshot=await (await pool.fetch('https://pool.test/snapshot')).json() as {accounts:Array<{account_id:string;cooldown_until_ms:number}>;leases:unknown[]}
 const account=snapshot.accounts.find(a=>a.account_id===fixture.account_id)!
 expect(account.cooldown_until_ms-Date.now()).toBeGreaterThan(110000)
 expect(account.cooldown_until_ms-Date.now()).toBeLessThanOrEqual(120000)
 const user=env.USER_STATE.get(env.USER_STATE.idFromName(fixture.user_id))
 const state=await (await user.fetch('https://user.test/snapshot')).json() as {profile:{balance_micros:number;reserved_micros:number}}
 expect(state.profile).toMatchObject({balance_micros:1000000,reserved_micros:0})
})
