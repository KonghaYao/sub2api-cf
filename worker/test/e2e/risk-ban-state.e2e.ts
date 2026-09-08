import {env,exports} from 'cloudflare:workers'
import {expect,it} from 'vitest'
import {createOpaqueToken,tokenDigest} from '../../src/auth/tokens'
import {recoverRiskBanCommands} from '../../src/risk/ban-state'
it('applies queued risk bans through real user state, revokes access, and permits API-key use after a funded owner-checked unban',async()=>{
 const request=(path:string,token:string,method='GET',body?:unknown,headers:Record<string,string>={})=>exports.default.fetch(new Request('https://worker.e2e.invalid'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':crypto.randomUUID(),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}))
 const model='risk-owner-'+crypto.randomUUID(),seeded=await request('/api/v1/admin/bootstrap',env.ADMIN_TOKEN!,'POST',{user:{email:crypto.randomUUID()+'@risk-state.test',balance_micros:1000000},group:{name:crypto.randomUUID()},account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture-key'},api_key:{name:'risk'},models:[{public_name:model,upstream_name:'gpt-binding-upstream',endpoint:'chat_completions',input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100}]})
 expect(seeded.status,await seeded.clone().text()).toBe(201);const f=(await seeded.json() as any).data
 const admin=async(path:string,method='GET',body?:unknown,headers:Record<string,string>={})=>{const r=await request('/api/v1/admin'+path,f.admin_session,method,body,headers);expect(r.status,await r.clone().text()).toBe(200);return(await r.json() as any).data}
 const created=await request('/api/v1/admin/users',f.admin_session,'POST',{email:crypto.randomUUID()+'@risk-user.test',balance_micros:1000000,role:'user'})
 expect([200,201],await created.clone().text()).toContain(created.status)
 const user=(await created.json() as any).data
 // Bootstrap provisions an administrator; risk enforcement targets a separate normal user.
 await env.DB.prepare('UPDATE api_keys SET user_id=? WHERE id=?').bind(user.id,f.api_key_id).run()
 f.user_id=user.id
 const main=await admin('/settings'),risk=await admin('/risk-control/config')
 await admin('/settings','PUT',{gateway:{risk_control_enabled:true}},{'if-match':'"'+main.control_version+'"'})
 await admin('/risk-control/config','PUT',{...risk,enabled:true,mode:'pre_block',keyword_blocking_mode:'keyword_only',blocked_keywords:['fixture-risk-danger'],all_groups:false,group_ids:[f.group_id],auto_ban_enabled:true,ban_threshold:1,email_on_hit:false})
 const access=createOpaqueToken('access'),refresh=createOpaqueToken('refresh'),now=Date.now()
 await env.DB.prepare('INSERT INTO user_sessions(id,family_id,user_id,auth_version,access_token_hash,refresh_token_hash,created_at_ms,access_expires_at_ms,refresh_expires_at_ms) SELECT ?,?,id,auth_version,?,?,?,?,? FROM users WHERE id=?').bind(crypto.randomUUID(),crypto.randomUUID(),await tokenDigest(access,env.API_KEY_PEPPER!,'access'),await tokenDigest(refresh,env.API_KEY_PEPPER!,'refresh'),now,now+600000,now+1200000,f.user_id).run()
 const completion=(text:string)=>request('/v1/chat/completions',f.api_key,'POST',{model,messages:[{role:'user',content:text}],max_tokens:16})
 try{
  expect((await request('/api/v1/auth/me',access)).status).toBe(200)
  expect((await completion('fixture-risk-danger')).status).toBe(403)
  expect(await recoverRiskBanCommands(env)).toEqual({attempted:1,pending:0})
  expect((await request('/api/v1/auth/me',access)).status).toBe(401)
  const denied=await completion('ordinary');expect([401,403],await denied.clone().text()).toContain(denied.status)
  const funded=await admin('/users/'+f.user_id+'/balance','POST',{amount_delta_micros:250})
  expect(funded.balance_micros).toBe(1000250)
  await admin('/risk-control/users/'+f.user_id+'/unban','POST')
  await admin('/risk-control/users/'+f.user_id+'/unban','POST')
  const allowed=await completion('ordinary');expect(allowed.status,await allowed.clone().text()).toBe(200);await allowed.text()
  // Re-enabling the API key does not revive an old revoked browser session.
  expect((await request('/api/v1/auth/me',access)).status).toBe(401)
  const snapshot=await(await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
  expect(snapshot.profile).toMatchObject({enabled:true,reserved_micros:0,balance_micros:1000223})
 }finally{
  const current=await admin('/settings');await admin('/settings','PUT',{gateway:{risk_control_enabled:main.gateway.risk_control_enabled}},{'if-match':'"'+current.control_version+'"'})
  const currentRisk=await admin('/risk-control/config');await admin('/risk-control/config','PUT',{expected_control_version:currentRisk.control_version,enabled:false})
 }
})
