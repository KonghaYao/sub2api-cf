import {expect,it} from 'vitest'
import {clearHarness,setupRisk} from '../helpers/risk-control-fixture'
import {moderateGatewayRequest} from '../../src/gateway/risk-moderation'
import {applyRiskBanCommand,recoverRiskBanCommands,requestRiskUnban} from '../../src/risk/ban-state'
async function fixture(){const f=await clearHarness(false),r=setupRisk(f);const config=await r.data(await r.call('/config'));await r.data(await r.call('/config','PUT',{...config,enabled:true,mode:'pre_block',keyword_blocking_mode:'keyword_only',blocked_keywords:['danger'],auto_ban_enabled:true,ban_threshold:1}));await moderateGatewayRequest(f.env,r.input('ban','danger'));const id=f.raw.prepare('SELECT id FROM risk_ban_commands').get().id;const object=f.env.USER_STATE.get(f.env.USER_STATE.idFromName('risk-user'));const post=(path:string,body:unknown)=>object.fetch(new Request('https://state.test'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({schema_version:1,...body as object})}));const snapshot=async()=>await(await object.fetch('https://state.test/snapshot')).json() as any;return {...f,r,id,post,snapshot}}
it('recovers a DO-applied ban after a D1 transaction failure without applying it twice',async()=>{
 const f=await fixture(),db=f.env.DB;let failed=false
 try{
  f.env.DB=new Proxy(db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!failed){failed=true;throw new Error('simulated atomic D1 outage')}return target.batch(statements)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  expect(await applyRiskBanCommand(f.env,f.id)).toEqual({status:'pending'});const applied=await f.snapshot();expect(applied.profile.enabled).toBe(false);expect(f.raw.prepare("SELECT status FROM users WHERE id='risk-user'").get().status).toBe('active')
  expect(await recoverRiskBanCommands(f.env)).toEqual({attempted:1,pending:0});expect((await f.snapshot()).state_version).toBe(applied.state_version)
  expect(f.raw.prepare("SELECT status,auth_version FROM users WHERE id='risk-user'").get()).toEqual({status:'disabled',auth_version:2})
  expect(f.raw.prepare("SELECT count(*) AS n FROM risk_outbox WHERE event='risk.account_disabled'").get().n).toBe(1)
  expect(await applyRiskBanCommand(f.env,f.id)).toEqual({status:'unclaimed'})
 }finally{f.raw.close()}
})
it('keeps ban ownership through a real balance adjustment and makes unban replay idempotent',async()=>{
 const f=await fixture();try{expect(await applyRiskBanCommand(f.env,f.id)).toEqual({status:'done'});expect((await f.post('/balance/adjust',{mutation_id:'topup-after-ban',amount_delta_micros:250})).status).toBe(200)
  expect(await requestRiskUnban(f.env,'risk-user')).toEqual({user_id:'risk-user',status:'active'});expect(await requestRiskUnban(f.env,'risk-user')).toEqual({user_id:'risk-user',status:'active'})
  const row=f.raw.prepare("SELECT status,balance_micros,auth_version FROM users WHERE id='risk-user'").get();expect(row).toEqual({status:'active',balance_micros:250,auth_version:2});expect((await f.snapshot()).profile.enabled).toBe(true)
 }finally{f.raw.close()}
})
it('compensates its DO change if a concurrent administrator promotes the user before D1 projection',async()=>{
 const f=await fixture(),db=f.env.DB;let raced=false
 try{f.env.DB=new Proxy(db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!raced){raced=true;f.raw.prepare("UPDATE users SET role='admin',control_version=control_version+1,auth_version=auth_version+1 WHERE id='risk-user'").run()}return target.batch(statements)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  expect(await applyRiskBanCommand(f.env,f.id)).toEqual({status:'cancelled'});expect((await f.snapshot()).profile.enabled).toBe(true)
  expect(f.raw.prepare("SELECT role,status FROM users WHERE id='risk-user'").get()).toEqual({role:'admin',status:'active'});expect(f.raw.prepare('SELECT count(*) AS n FROM risk_bans').get().n).toBe(0)
 }finally{f.raw.close()}
})
it('refuses to revive an account after an independent same-state administrator disable',async()=>{
 const f=await fixture();try{await applyRiskBanCommand(f.env,f.id);await f.post('/enabled',{mutation_id:'manual-disabled',enabled:false});await expect(requestRiskUnban(f.env,'risk-user')).rejects.toMatchObject({status:409});expect((await f.snapshot()).profile.enabled).toBe(false)}finally{f.raw.close()}
})
it('does not execute queued bans once global policy is disabled or user authentication control changes',async()=>{
 for(const change of ["UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.risk_control_enabled',json('false'))", "UPDATE users SET auth_version=auth_version+1 WHERE id='risk-user'"]){const f=await fixture();try{f.raw.exec(change);expect(await applyRiskBanCommand(f.env,f.id)).toEqual({status:'cancelled'});expect((await f.snapshot()).profile.enabled).toBe(true)}finally{f.raw.close()}}
})
it('fences a prepared but delayed ban request when policy changes after its lease expires',async()=>{
 const f=await fixture();try{
  await f.post('/configure',{mutation_id:'initial',user_id:'risk-user',enabled:true,balance_micros:0,initial_state_version:0})
  f.raw.prepare("UPDATE risk_ban_commands SET prepared=1,prior_enabled_mutation_id=NULL,status='applying',lease_owner='expired',lease_expires_at_ms=0 WHERE id=?").run(f.id)
  f.raw.exec("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.risk_control_enabled',json('false'))")
  expect(await recoverRiskBanCommands(f.env)).toEqual({attempted:1,pending:0})
  const late=await f.post('/enabled',{mutation_id:`risk-enabled:${f.id}`,enabled:false,expected_enabled_mutation_id:null})
  expect(late.status).toBe(409)
  expect((await f.snapshot()).profile.enabled).toBe(true)
 }finally{f.raw.close()}
})
