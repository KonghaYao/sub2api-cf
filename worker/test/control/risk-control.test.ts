import { recoverRiskBanCommands } from '../../src/risk/ban-state'
import { createApp } from '../../src/app'
import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../../src/env'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { encryptTotpSecret } from '../../src/auth/totp'
import { deliverPlatformEmail, hasEmailDeliveryConfigured } from '../../src/email/delivery'
import { normalizeOpsFeature } from '../../src/control/ops-feature-settings'
import { moderateGatewayRequest,consumeRiskModeration,recoverRiskJobs } from '../../src/gateway/risk-moderation'
import { persistRiskResult,deliverRiskNotifications } from '../../src/risk/effects'
import { readRiskConfig } from '../../src/risk/config'
import { cleanupRiskData,projectCyberRiskEvents } from '../../src/risk/maintenance'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
import { clearHarness, setupRisk } from '../helpers/risk-control-fixture'
describe('Risk-control actual configuration and enforcement lifecycle',()=>{
 it('persists encrypted API keys with CAS, applies keyword/group/model scope, bans atomically, unbans only its own unchanged restriction and never replays the ban',async()=>{
  const f=await clearHarness(false),r=setupRisk(f)
  try{
   const config=await r.data(await r.call('/config'))
   expect((await r.call('/config','PUT',{enabled:true})).status).toBe(428)
   let saved=await r.data(await r.call('/config','PUT',{...config,enabled:true,mode:'pre_block',keyword_blocking_mode:'keyword_only',blocked_keywords:['danger'],all_groups:false,group_ids:['risk-group'],model_filter:{type:'include',models:['test-model']},auto_ban_enabled:true,ban_threshold:1,email_on_hit:true,api_keys:['moderation-secret-test']}))
   expect(JSON.stringify(saved)).not.toContain('moderation-secret-test');expect(f.raw.prepare('SELECT config_json FROM risk_settings').get().config_json).not.toContain('moderation-secret-test');expect(f.raw.prepare('SELECT ciphertext_b64 FROM risk_api_keys').get().ciphertext_b64).not.toContain('moderation-secret-test')
   expect((await r.call('/config','PUT',{...config,clear_api_key:true})).status).toBe(412);expect((await r.data(await r.call('/config'))).api_key_count).toBe(1)
   expect(await moderateGatewayRequest(f.env,{...r.input('other-model','danger'),model:'other-model'})).toMatchObject({allowed:true})
   const blocked=await moderateGatewayRequest(f.env,r.input('keyword-hit','danger'));expect(blocked).toMatchObject({allowed:false,status:403,action:'keyword_block'})
   expect(await recoverRiskBanCommands(f.env)).toEqual({attempted:1,pending:0})
   let user=f.raw.prepare("SELECT status,auth_version,state_version,control_version FROM users WHERE id='risk-user'").get();expect(user.status).toBe('disabled');expect(user.auth_version).toBe(2)
   const logs=await r.data(await r.call('/logs?result=hit&group_id=risk-group'));expect(logs.total).toBe(1);expect(logs.items[0]).toMatchObject({flagged:true,auto_banned:true,violation_count:1,user_id:'risk-user'})
   await deliverRiskNotifications(f.env);expect(r.mail).toHaveLength(1);expect(r.mail[0].html).toContain('Risk User');expect(r.mail[0].html).not.toContain('danger')
   await r.data(await r.call('/users/risk-user/unban','POST'))
   await moderateGatewayRequest(f.env,r.input('keyword-hit','danger'))
   expect(f.raw.prepare("SELECT status FROM users WHERE id='risk-user'").get().status).toBe('active');expect(f.raw.prepare('SELECT COUNT(*) AS n FROM risk_logs').get().n).toBe(1)
   await moderateGatewayRequest(f.env,r.input('new-hit','danger'))
   await recoverRiskBanCommands(f.env)
   await f.env.USER_STATE.get(f.env.USER_STATE.idFromName('risk-user')).fetch(new Request('https://state.test/enabled',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({schema_version:1,mutation_id:'manual-admin-disabled',enabled:false})}))
   expect((await r.call('/users/risk-user/unban','POST')).status).toBe(409)
   saved=await r.data(await r.call('/config','PUT',{expected_control_version:saved.control_version,clear_api_key:true,auto_ban_enabled:false}));expect(saved.api_key_count).toBe(0)
   expect((await r.data(await r.call('/status'))).pre_block_blocked).toBeGreaterThan(0)
  }finally{f.raw.close()}
 })
 it('executes real moderation transport, observe queue/R2, frozen key state and explicit hash gate without double-counting',async()=>{
  const f=await clearHarness(false),r=setupRisk(f);let apiCalls=0
  vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{apiCalls++;expect(new Headers(init?.headers).get('authorization')).toBe('Bearer moderation-test-key');return Response.json({results:[{flagged:false,category_scores:{violence:.99}}]})})
  try{
   let config=await r.data(await r.call('/config'));config=await r.data(await r.call('/config','PUT',{...config,enabled:true,mode:'observe',auto_ban_enabled:false,email_on_hit:true,pre_hash_check_enabled:false,api_keys:['moderation-test-key'],base_url:'https://moderation.example.com',record_non_hits:true}))
   const test=await r.data(await r.call('/api-keys/test','POST',{}));expect(test.items[0].status).toBe('ok');expect(test.audit_result.flagged).toBe(true)
   expect(await moderateGatewayRequest(f.env,r.input('observe','secret prompt for review'))).toMatchObject({allowed:true});expect(r.queue).toHaveLength(1);expect(apiCalls).toBe(1)
   expect(JSON.stringify(r.queue)).not.toContain('secret prompt');expect(JSON.stringify([...r.objects.values()])).not.toContain('secret prompt')
   await consumeRiskModeration(r.queue[0],f.env);await consumeRiskModeration(r.queue[0],f.env);expect(apiCalls).toBe(2);expect(r.objects.size).toBe(0)
   const row=f.raw.prepare('SELECT * FROM risk_logs').get();expect(row).toMatchObject({flagged:1,action:'allow',violation_count:1})
   config=await r.data(await r.call('/config','PUT',{expected_control_version:config.control_version,pre_hash_check_enabled:true}))
   // The original UI explicitly promises that this separate switch blocks hashes even in observe mode.
   expect(await moderateGatewayRequest(f.env,r.input('hash-hit','secret prompt for review'))).toMatchObject({allowed:false,action:'hash_block'});expect(apiCalls).toBe(2)
   expect(f.raw.prepare("SELECT violation_count FROM risk_logs WHERE request_id='hash-hit'").get().violation_count).toBe(0)
   await r.data(await r.call('/hashes','DELETE',{input_hash:row.input_hash}));expect((await r.data(await r.call('/status'))).flagged_hash_count).toBe(0)
   await r.data(await r.call('/hashes/all','DELETE'))
   await r.data(await r.call('/logs?result=pass'))
  }finally{vi.restoreAllMocks();f.raw.close()}
 })
 it('does not enforce an immediate result if the global switch is disabled during hashing',async()=>{
  const f=await clearHarness(false),r=setupRisk(f)
  try{
   const config=await r.data(await r.call('/config'));await r.data(await r.call('/config','PUT',{...config,enabled:true,keyword_blocking_mode:'keyword_only',blocked_keywords:['danger'],auto_ban_enabled:true,ban_threshold:1}))
   let reads=0;const db=f.env.DB;f.env.DB=new Proxy(db,{get(target,key){if(key==='prepare')return(sql:string)=>{if(sql.includes("json_extract(gateway_json,'$.risk_control_enabled')")&&++reads===2)f.raw.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.risk_control_enabled',json('false'))").run();return target.prepare(sql)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
   expect(await moderateGatewayRequest(f.env,r.input('disabled-race','danger'))).toMatchObject({allowed:true})
   expect(f.raw.prepare('SELECT COUNT(*) AS n FROM risk_logs').get().n).toBe(0);expect(f.raw.prepare("SELECT status FROM users WHERE id='risk-user'").get().status).toBe('active')
  }finally{f.raw.close()}
 })
})
