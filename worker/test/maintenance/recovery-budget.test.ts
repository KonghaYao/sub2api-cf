import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { recoveryMaintenanceTasks } from '../../src/maintenance/recovery'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
import { recordRequestStart } from '../../src/observability/recorder'

describe('real maintenance recovery page budgets', () => {
 it('repairs a full ten-row payload page below 50 total calls and leaves the remaining rows retryable', async () => {
  const { raw, d1 } = createSqliteD1();applyMigrations(raw)
  let calls=0
  const db=new Proxy(d1,{get(target,key){if(key==='prepare')return(sql:string)=>{calls++;return target.prepare(sql)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  const env={DB:db,EVENTS_QUEUE:{send:vi.fn()},OBJECTS:{head:vi.fn(async()=>{calls++;return {customMetadata:{sha256:'a'.repeat(64)}}})}} as unknown as Env
  try {
   for(let index=0;index<50;index++){
    const handle=await recordRequestStart(env,{requestId:'payload-'+index,method:'POST',requestPath:'/v1/responses',occurredAtMs:1})
    raw.prepare("UPDATE request_observations SET payload_state='pending',payload_content_type='application/json',payload_bytes=2,payload_object_key=?,payload_sha256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE id=?").run('observability/v1/test-payload-fixture/'+index,handle!.id)
   }
   calls=0
   expect(await recoveryMaintenanceTasks.observability_payload_repair(env)).toEqual({scanned:10,repaired:10})
   expect(calls).toBe(21);expect(calls).toBeLessThanOrEqual(50)
   expect(raw.prepare("SELECT COUNT(*) AS n FROM request_observations WHERE payload_state='pending'").get().n).toBe(40)
  } finally {raw.close()}
 })
 it('advances past a fully referenced R2 page and cleans later orphans under the per-invocation budget',async()=>{
  const {raw,d1}=createSqliteD1();applyMigrations(raw);let calls=0
  const db=new Proxy(d1,{get(target,key){if(key==='prepare')return(sql:string)=>{calls++;return target.prepare(sql)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  const keys=Array.from({length:20},(_,i)=>'observability/v1/test-payload-fixture/'+String(i).padStart(2,'0'))
  const removed:string[]=[]
  const list=vi.fn(async(input:R2ListOptions)=>{calls++;const from=input.cursor?Number(input.cursor):0;return{objects:keys.slice(from,from+10).map(key=>({key,uploaded:new Date(1)})),truncated:from===0,...(from===0?{cursor:'10'}:{})}})
  const env={DB:db,EVENTS_QUEUE:{send:vi.fn()},OBJECTS:{list,delete:vi.fn(async(key:string)=>{calls++;removed.push(key)})}} as unknown as Env
  try {
   for(let i=0;i<10;i++) {const h=await recordRequestStart(env,{requestId:'referenced-'+i,method:'POST',requestPath:'/v1/responses',occurredAtMs:1});raw.prepare("UPDATE request_observations SET payload_state='stored',payload_content_type='application/json',payload_bytes=2,payload_sha256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',payload_object_key=? WHERE id=?").run(keys[i],h!.id)}
   calls=0;await recoveryMaintenanceTasks.observability_r2_orphans(env);expect(removed).toHaveLength(0);expect(calls).toBeLessThanOrEqual(50)
   calls=0;await recoveryMaintenanceTasks.observability_r2_orphans(env);expect(list.mock.calls[1][0].cursor).toBe('10');expect(removed).toEqual(keys.slice(10));expect(calls).toBe(23)
   expect(raw.prepare('SELECT value_json FROM runtime_settings WHERE name=?').get('maintenance:observability-orphan-cursor').value_json).toBe('{"cursor":null}')
  }finally{raw.close()}
 })
})
