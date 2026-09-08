import { Hono } from 'hono'
import { afterEach,expect,it,vi } from 'vitest'
import type { Env } from '../../src/env'
import { encryptCredential } from '../../src/gateway/crypto'
import { applyMigrations,createSqliteD1 } from '../helpers/sqlite-d1'
import { nextScheduledTestRun } from '../../src/control/scheduled-test-cron'
import { createScheduledTest,listAccountScheduledTests,updateScheduledTest,deleteScheduledTest,listScheduledTestResults } from '../../src/control/scheduled-tests'
import { runDueScheduledTests } from '../../src/control/scheduled-test-runner'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const from = Date.parse('2026-09-08T10:31:22Z')
it.each([
  ['*/30 * * * *','2026-09-08T11:00:00.000Z'], ['5/20 11 * * *','2026-09-08T11:05:00.000Z'],
  ['0 0 * * MON','2026-09-14T00:00:00.000Z'], ['0 0 1 * MON','2026-09-14T00:00:00.000Z'],
  ['0 0 */2 * MON','2026-09-09T00:00:00.000Z'], ['0 0 29 FEB *','2028-02-29T00:00:00.000Z'],
  ['0 0 31 FEB *',null], ['0 12 ? SEP TUE-THU','2026-09-08T12:00:00.000Z'],
])('computes original calendar semantics: %s',(cron,expected) => {
  const next = nextScheduledTestRun(cron!,from)
  expect(next === null ? null : new Date(next).toISOString()).toBe(expected)
})
it.each(['* * * *','60 * * * *','*/0 * * * *','0 24 * * *','0 0 32 * *','0 0 * XYZ *','0 0 * * 7','0 0 5-2 * *'])('rejects invalid cron %s',cron => {
  expect(() => nextScheduledTestRun(cron,from)).toThrow()
})
it.each([
  ['CRON_TZ=Asia/Shanghai 0 9 * * *','2026-09-08T00:00:00Z','2026-09-08T01:00:00.000Z'],
  ['TZ=America/New_York 30 2 * * *','2026-03-08T06:00:00Z','2026-03-09T06:30:00.000Z'],
  ['TZ=America/New_York 30 1 * * *','2026-11-01T06:00:00Z','2026-11-01T06:30:00.000Z'],
])('honors timezone and daylight transitions: %s',(cron,from,expected) => {
  expect(new Date(nextScheduledTestRun(cron,Date.parse(from))!).toISOString()).toBe(expected)
})
async function fixture() {
  const { raw,d1 } = createSqliteD1(); applyMigrations(raw)
  const key = 'm'.repeat(32), encrypted = await encryptCredential({ api_key: 'scheduled-secret' },key,'test/opaque-account/secret/1')
  raw.exec("INSERT INTO accounts(id,platform,name,credential_ref,credential_kind,protocol,base_url,auth_scheme,created_at_ms,updated_at_ms) VALUES('opaque-account','anthropic','Scheduled','secret','api_key','anthropic','https://claude.test','x-api-key',1,1)")
  raw.prepare('INSERT INTO account_secrets(id,account_id,key_version,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES(?,?,1,?,?,1,1)').run('secret','opaque-account',encrypted.nonce_b64,encrypted.ciphertext_b64)
  const env = { DB:d1,ENVIRONMENT:'test',CREDENTIALS_MASTER_KEY:key } as Env
  const app = new Hono<{ Bindings:Env }>().get('/accounts/:id/scheduled-test-plans',listAccountScheduledTests)
    .post('/plans',createScheduledTest).put('/plans/:id',updateScheduledTest).delete('/plans/:id',deleteScheduledTest).get('/plans/:id/results',listScheduledTestResults)
  const req = (url:string,method='GET',body?:unknown) => app.request(url,{ method,headers:{ 'content-type':'application/json' },...(body ? { body:JSON.stringify(body) } : {}) },env)
  const create = async (extra={}) => {
    const result = await req('/plans','POST',{ account_id:'opaque-account',model_id:'claude-sonnet-4-5-20250929',cron_expression:'*/5 * * * *',...extra })
    expect(result.status,await result.clone().text()).toBe(200)
    return (await result.json() as any).data
  }
  return { raw,env,req,create }
}
const supplier = () => new Response('data: {"type":"content_block_delta","delta":{"text":"scheduled works"}}\n\ndata: {"type":"message_stop"}\n\n',{ headers:{ 'content-type':'text/event-stream' } })
it('round-trips original plan fields, opaque accounts, edits, empty results and deletion',async () => {
  const t=await fixture()
  try {
    const p=await t.create()
    expect(p).toMatchObject({ account_id:'opaque-account',enabled:true,max_results:50,auto_recover:false,last_run_at:null })
    expect((await (await t.req('/accounts/opaque-account/scheduled-test-plans')).json() as any).data).toEqual([p])
    const updated=await t.req(`/plans/${p.id}`,'PUT',{ enabled:false,auto_recover:true,max_results:3,cron_expression:'0 * * * *' })
    expect((await updated.json() as any).data).toMatchObject({ enabled:false,auto_recover:true,max_results:3 })
    expect((await (await t.req(`/plans/${p.id}/results`)).json() as any).data).toEqual([])
    expect((await t.req(`/plans/${p.id}`,'DELETE')).status).toBe(200)
    expect((await t.req(`/plans/${p.id}`,'PUT',{})).status).toBe(404)
    expect((await t.req('/plans','POST',{ account_id:'opaque-account',cron_expression:'bad' })).status).toBe(400)
  } finally { t.raw.close() }
})
it.each(['success','failed','disabled','no-recovery'])('runs real provider diagnostics and retains bounded results: %s',async scenario => {
  const t=await fixture()
  try {
    const p=await t.create({ max_results:2,enabled:scenario!=='disabled',auto_recover:scenario!=='no-recovery' })
    t.raw.exec("UPDATE accounts SET health_status='unhealthy',last_health_error='prior error',ui_config_json=json_set(ui_config_json,'$.temp_unschedulable_until','2099-01-01T00:00:00Z')")
    const fetcher=vi.fn(async (_url:string,init:RequestInit) => {
      expect(new Headers(init.headers).get('x-api-key')).toBe('scheduled-secret')
      expect(JSON.parse(String(init.body)).model).toBe('claude-sonnet-4-5-20250929')
      return scenario==='failed' ? new Response('private upstream body',{ status:503 }) : supplier()
    }); vi.stubGlobal('fetch',fetcher)
    for(let i=0;i<3;i++) { t.raw.prepare('UPDATE scheduled_test_plans SET next_run_at_ms=1 WHERE id=?').run(p.id); await runDueScheduledTests(t.env) }
    const results=(await (await t.req(`/plans/${p.id}/results`)).json() as any).data
    expect(results).toHaveLength(scenario==='disabled'?0:2)
    expect(fetcher).toHaveBeenCalledTimes(scenario==='disabled'?0:3)
    if(scenario!=='disabled') {
      expect(results[0]).toMatchObject({ status:scenario==='failed'?'failed':'success',response_text:scenario==='failed'?'':'scheduled works' })
      expect(JSON.stringify(results)).not.toContain('private upstream body')
      expect(t.raw.prepare('SELECT next_run_at_ms FROM scheduled_test_plans WHERE id=?').get(p.id).next_run_at_ms).toBeGreaterThan(Date.now())
    }
    expect(t.raw.prepare('SELECT health_status FROM accounts').get().health_status).toBe(scenario==='success'?'unknown':'unhealthy')
  } finally { t.raw.close() }
})
it.each(['overlap','edit','delete','account-edit','expired'])('fences scheduled execution: %s',async scenario => {
  const t=await fixture()
  try {
    const p=await t.create({ auto_recover:true });t.raw.prepare('UPDATE scheduled_test_plans SET next_run_at_ms=1 WHERE id=?').run(p.id)
    t.raw.exec("UPDATE accounts SET health_status='unhealthy'")
    let started!:()=>void,release!:()=>void
    const ready=new Promise<void>(r=>started=r),pending=new Promise<void>(r=>release=r)
    const fetcher=vi.fn(async()=>{started();await pending;return supplier()});vi.stubGlobal('fetch',fetcher)
    const run=runDueScheduledTests(t.env);await ready
    if(scenario==='overlap') await runDueScheduledTests(t.env)
    if(scenario==='edit') await t.req(`/plans/${p.id}`,'PUT',{ enabled:false })
    if(scenario==='delete') await t.req(`/plans/${p.id}`,'DELETE')
    if(scenario==='account-edit') t.raw.exec('UPDATE accounts SET control_version=control_version+1')
    if(scenario==='expired') t.raw.exec('UPDATE scheduled_test_plans SET lease_until_ms=0')
    release();await run
    expect(fetcher).toHaveBeenCalledTimes(1)
    const results=t.raw.prepare('SELECT * FROM scheduled_test_results').all()
    expect(results).toHaveLength(['overlap','account-edit'].includes(scenario)?1:0)
    expect(t.raw.prepare('SELECT health_status FROM accounts').get().health_status).toBe(scenario==='overlap'?'unknown':'unhealthy')
  } finally { t.raw.close() }
})
it('finishes a stalled diagnostic, releases the lease and ignores a late success',async () => {
  const t=await fixture()
  try {
    const p=await t.create({ auto_recover:true });t.raw.prepare('UPDATE scheduled_test_plans SET next_run_at_ms=1 WHERE id=?').run(p.id)
    t.raw.exec("UPDATE accounts SET health_status='unhealthy'")
    vi.useFakeTimers()
    let started!:()=>void,release!:(response:Response)=>void
    const ready=new Promise<void>(r=>started=r),pending=new Promise<Response>(r=>release=r)
    vi.stubGlobal('fetch',vi.fn(()=>{started();return pending}))
    const running=runDueScheduledTests(t.env);await ready
    await vi.advanceTimersByTimeAsync(70000);await running
    const results=t.raw.prepare('SELECT * FROM scheduled_test_results').all()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ status:'failed',error_message:'Account diagnostic timed out',latency_ms:70000 })
    expect(t.raw.prepare('SELECT lease_token,lease_until_ms FROM scheduled_test_plans WHERE id=?').get(p.id)).toMatchObject({ lease_token:null,lease_until_ms:0 })
    release(supplier());await vi.advanceTimersByTimeAsync(1)
    expect(t.raw.prepare('SELECT * FROM scheduled_test_results').all()).toEqual(results)
    expect(t.raw.prepare('SELECT health_status FROM accounts').get().health_status).toBe('unhealthy')
  } finally { vi.useRealTimers();t.raw.close() }
})
it('leaves excess slow plans due for the next cycle instead of exceeding the cycle budget',async () => {
  const t=await fixture()
  try {
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-08T00:00:00Z'))
    for(let i=0;i<20;i++) await t.create()
    t.raw.exec('UPDATE scheduled_test_plans SET next_run_at_ms=1')
    const releases: Array<(response: Response) => void> = []
    const waiters: Array<{ count: number; resolve: () => void }> = []
    const fetcher=vi.fn(()=>new Promise<Response>(resolve=>{
      releases.push(resolve)
      for(const waiter of waiters) if(releases.length>=waiter.count) waiter.resolve()
    }))
    const calls = (count:number) => releases.length>=count ? Promise.resolve() : new Promise<void>(resolve=>waiters.push({ count,resolve }))
    vi.stubGlobal('fetch',fetcher)
    const running=runDueScheduledTests(t.env)
    for(let wave=1;wave<=4;wave++) {
      await calls(wave*4)
      await vi.advanceTimersByTimeAsync(60000)
      for(let i=(wave-1)*4;i<wave*4;i++) releases[i]!(supplier())
    }
    await running
    expect(fetcher).toHaveBeenCalledTimes(16)
    expect(t.raw.prepare('SELECT COUNT(*) AS n FROM scheduled_test_results').get().n).toBe(16)
    expect(t.raw.prepare('SELECT COUNT(*) AS n FROM scheduled_test_plans WHERE next_run_at_ms=1 AND lease_token IS NULL').get().n).toBe(4)
  } finally { vi.useRealTimers();t.raw.close() }
})
