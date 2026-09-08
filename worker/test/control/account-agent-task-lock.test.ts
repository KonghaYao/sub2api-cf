import { expect,it } from 'vitest'
import type { Env } from '../../src/env'
import { executeAccountCreate } from '../../src/control/accounts'
import { claimAgentTaskRegistration,agentTaskRegistrationGuard,releaseAgentTaskRegistration } from '../../src/control/account-agent-task-lock'
import { applyMigrations,createSqliteD1 } from '../helpers/sqlite-d1'
async function fixture() {
  const {raw,d1}=createSqliteD1();applyMigrations(raw)
  const env={DB:d1,ENVIRONMENT:'test',CREDENTIALS_MASTER_KEY:'m'.repeat(32)} as Env
  const {account}=await executeAccountCreate(env,{name:'Lock account',platform:'openai',type:'oauth',credentials:{access_token:'test-only'}},'lock-account',true)
  return {raw,env,id:account.id}
}
it('shares a lease between requests and never lets an old owner release its replacement',async()=>{
  const t=await fixture()
  try {
    const first=await claimAgentTaskRegistration(t.env,t.id);expect(first).toBeTypeOf('string')
    expect(await claimAgentTaskRegistration(t.env,t.id)).toBeNull()
    await releaseAgentTaskRegistration(t.env,t.id,first!)
    const second=await claimAgentTaskRegistration(t.env,t.id);expect(second).not.toBe(first)
    await releaseAgentTaskRegistration(t.env,t.id,first!)
    expect(await claimAgentTaskRegistration(t.env,t.id)).toBeNull()
    await expect(claimAgentTaskRegistration(t.env,'missing')).rejects.toMatchObject({status:404})
  } finally {t.raw.close()}
})
it.each(['expired','replaced','deleted'])('rolls back account writes for a %s lease',async scenario=>{
  const t=await fixture()
  try {
    let now=Date.now();t.raw.function('unixepoch',{varargs:true},()=>now/1000)
    const owner=(await claimAgentTaskRegistration(t.env,t.id))!
    const guard=agentTaskRegistrationGuard(t.env,t.id,owner)
    if(scenario==='expired') now+=60001
    if(scenario==='replaced') t.raw.exec("UPDATE account_agent_task_registration SET lease_token='other'")
    if(scenario==='deleted') t.raw.exec('DELETE FROM account_agent_task_registration')
    await expect(t.env.DB.batch([t.env.DB.prepare("UPDATE accounts SET name='must rollback' WHERE id=?").bind(t.id),guard])).rejects.toThrow()
    expect(t.raw.prepare('SELECT name FROM accounts WHERE id=?').get(t.id)).toMatchObject({name:'Lock account'})
  } finally {t.raw.close()}
})
it('allows writes guarded by the current unexpired owner',async()=>{
  const t=await fixture()
  try {
    const owner=(await claimAgentTaskRegistration(t.env,t.id))!
    await t.env.DB.batch([t.env.DB.prepare("UPDATE accounts SET name='updated' WHERE id=?").bind(t.id),agentTaskRegistrationGuard(t.env,t.id,owner)])
    expect(t.raw.prepare('SELECT name FROM accounts WHERE id=?').get(t.id)).toMatchObject({name:'updated'})
  } finally {t.raw.close()}
})
