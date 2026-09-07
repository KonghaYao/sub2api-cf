import {expect,it} from 'vitest'
import {applyMigrations,createSqliteD1} from '../helpers/sqlite-d1'
import {sqliteUserStateNamespace} from '../helpers/sqlite-user-state'
import {prepareAuthSourceGrant,settleAuthSourceGrant,recoverPendingAuthSourceGrants,recoverPendingAuthSourceGrantEffects} from '../../src/auth/source-entitlements'
import {recoverPendingSubscriptionState} from '../../src/control/subscriptions'
import type {Env} from '../../src/env'
it('keeps 100 granted subscriptions immediately visible without authentication fanout, then resumes four durable intents',async()=>{
 const {raw,d1}=createSqliteD1();applyMigrations(raw);let queries=0,configured=0
 const db=new Proxy(d1,{get(target,key){if(key==='prepare')return(sql:string)=>{queries++;return target.prepare(sql)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
 const env={DB:db,SUBSCRIPTION_STATE:{idFromName:(id:string)=>id,get:()=>({fetch:async()=>{configured++;return Response.json({schema_version:1})}})}} as unknown as Env
 try{
  raw.exec("INSERT INTO users(id,email,role,status,balance_micros,created_at_ms,updated_at_ms) VALUES('u','budget@example.com','user','active',0,1,1)")
  raw.exec("UPDATE auth_source_defaults SET grant_on_first_bind=1 WHERE source='email'")
  for(let i=0;i<100;i++){raw.prepare('INSERT INTO groups(id,name,platform,group_type,created_at_ms,updated_at_ms) VALUES(?,?,\'openai\',\'subscription\',1,1)').run('g'+i,'g'+i);raw.prepare("INSERT INTO auth_source_default_subscriptions VALUES('email',?,30)").run('g'+i)}
  const grant=await prepareAuthSourceGrant(env,'u','email','first_bind',{kind:'user',value:'u'},Date.now());await db.batch(grant.statements)
  queries=0;await settleAuthSourceGrant(env,grant.grantId);await recoverPendingAuthSourceGrants(env,'u');expect(await recoverPendingAuthSourceGrantEffects(env,1)).toBe(0)
  expect(queries).toBe(3);expect(configured).toBe(0)
  expect(raw.prepare("SELECT count(*) AS n FROM user_subscriptions WHERE status='active'").get().n).toBe(100)
  expect(raw.prepare("SELECT count(*) AS n FROM subscription_state_sync WHERE status='pending'").get().n).toBe(100)
  expect(await recoverPendingSubscriptionState(env,4)).toBe(4);expect(configured).toBe(4)
  expect(raw.prepare("SELECT count(*) AS n FROM subscription_state_sync WHERE status='pending'").get().n).toBe(96)
 }finally{raw.close()}
})
it('limits a login recovery to one pending balance grant and safely resumes later grants',async()=>{
 const {raw,d1}=createSqliteD1();applyMigrations(raw);const state=sqliteUserStateNamespace();const env={DB:d1,USER_STATE:state.namespace} as unknown as Env
 try{
  raw.exec("INSERT INTO users(id,email,role,status,balance_micros,created_at_ms,updated_at_ms) VALUES('u','balances@example.com','user','active',0,1,1)")
  raw.exec('UPDATE auth_source_defaults SET grant_on_first_bind=1,balance_micros=10')
  for(const source of ['email','github','google'] as const){const grant=await prepareAuthSourceGrant(env,'u',source,'first_bind',{kind:'user',value:'u'},Date.now());await d1.batch(grant.statements)}
  await recoverPendingAuthSourceGrants(env,'u',16)
  expect(raw.prepare("SELECT count(*) AS n FROM auth_source_entitlement_balance_effects WHERE status='applied'").get().n).toBe(1)
  await recoverPendingAuthSourceGrants(env,'u');await recoverPendingAuthSourceGrants(env,'u')
  expect(raw.prepare("SELECT balance_micros FROM users WHERE id='u'").get().balance_micros).toBe(30)
 }finally{state.close();raw.close()}
})
