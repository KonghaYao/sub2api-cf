import {expect,it} from 'vitest'
import {sqliteUserStateNamespace} from '../helpers/sqlite-user-state'
it('keeps enabled-command ownership across billing but prevents risk from undoing another administrator mutation',async()=>{
 const t=sqliteUserStateNamespace(),object=t.get('u'),post=(path:string,body:unknown)=>object.fetch('https://state.test'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({schema_version:1,...body as object})})
 try{
  expect((await post('/configure',{mutation_id:'init',user_id:'u',balance_micros:100,enabled:true})).status).toBe(200)
  expect((await post('/enabled',{mutation_id:'risk-ban',enabled:false,expected_enabled_mutation_id:null})).status).toBe(200)
  expect((await post('/balance/adjust',{mutation_id:'topup',amount_delta_micros:10})).status).toBe(200)
  expect((await post('/enabled',{mutation_id:'risk-unban',enabled:true,expected_enabled_mutation_id:'risk-ban'})).status).toBe(200)
  expect((await post('/enabled',{mutation_id:'risk-unban',enabled:true,expected_enabled_mutation_id:'risk-ban'})).status).toBe(200)
  await post('/enabled',{mutation_id:'next-risk-ban',enabled:false})
  await post('/enabled',{mutation_id:'admin-disable',enabled:false})
  expect((await post('/enabled',{mutation_id:'unsafe-unban',enabled:true,expected_enabled_mutation_id:'next-risk-ban'})).status).toBe(409)
  const state=await(await object.fetch('https://state.test/snapshot')).json() as any
  expect(state.last_enabled_mutation_id).toBe('admin-disable');expect(state.profile.enabled).toBe(false)
 }finally{t.close()}
})
