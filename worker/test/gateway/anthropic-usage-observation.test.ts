import { expect,it } from 'vitest'
import type { Env } from '../../src/env'
import type { AccountCredential } from '../../src/gateway/types'
import { anthropicUsageObservation,persistAnthropicUsageObservation } from '../../src/gateway/anthropic-usage-observation'
import { anthropicPassiveUsage } from '../../src/control/account-usage-projection'
import { applyMigrations,createSqliteD1 } from '../helpers/sqlite-d1'
const now=Date.parse('2026-09-08T00:15:00Z')
it('requires the original five-hour status before sampling usage',()=>{
  expect(anthropicUsageObservation({},new Headers({'anthropic-ratelimit-unified-7d-utilization':'0.5'}),now)).toBeNull()
})
it('uses actual reset timestamps in seconds or milliseconds and clears stale samples on a new window',()=>{
  for(const multiplier of [1,1000]) {
    const ui=anthropicUsageObservation({session_window_end:'2000-01-01T00:00:00Z',extra:{keep:true,passive_usage_7d_oi_utilization:0.8}},new Headers({
      'anthropic-ratelimit-unified-5h-status':'allowed','anthropic-ratelimit-unified-5h-reset':String((now/1000+3600)*multiplier),
      'anthropic-ratelimit-unified-5h-utilization':'0.2','anthropic-ratelimit-unified-7d-utilization':'0.4',
      'anthropic-ratelimit-unified-7d-reset':String((now/1000+86400)*multiplier),
    }),now)!
    expect(ui.extra).toMatchObject({keep:true,session_window_utilization:0.2,passive_usage_7d_utilization:0.4,passive_usage_7d_oi_utilization:null})
    expect(anthropicPassiveUsage(ui,now)).toMatchObject({five_hour:{utilization:20,remaining_seconds:3600},seven_day:{utilization:40,remaining_seconds:86400}})
  }
})
it('forecasts only an allowed initial window and ignores out-of-range resets',()=>{
  const headers=new Headers({'anthropic-ratelimit-unified-5h-status':'allowed_warning','anthropic-ratelimit-unified-5h-reset':'1'})
  expect(anthropicUsageObservation({},headers,now)?.session_window_end).toBe('2026-09-08T05:00:00.000Z')
  headers.set('anthropic-ratelimit-unified-5h-status','rejected')
  expect(anthropicUsageObservation({},headers,now)).not.toHaveProperty('session_window_end')
})
it('retains current samples on status-only responses and clears an active rate limit only when allowed',()=>{
  const ui={session_window_end:new Date(now+3600000).toISOString(),rate_limit_reset_at:new Date(now+10000).toISOString(),extra:{session_window_utilization:0.5}}
  expect(anthropicUsageObservation(ui,new Headers({'anthropic-ratelimit-unified-5h-status':'allowed'}),now)).toMatchObject({extra:ui.extra,rate_limit_reset_at:null})
  expect(anthropicUsageObservation(ui,new Headers({'anthropic-ratelimit-unified-5h-status':'allowed_warning'}),now)?.rate_limit_reset_at).toBe(ui.rate_limit_reset_at)
})
it.each(['success','background','edit','api-key','failure'])('persists a %s observation without consuming the response or overwriting user edits',async scenario=>{
  const {raw,d1}=createSqliteD1();applyMigrations(raw)
  raw.exec("INSERT INTO accounts(id,platform,name,credential_ref,credential_kind,protocol,base_url,auth_scheme,created_at_ms,updated_at_ms) VALUES('a','anthropic','Sample','s','oauth','anthropic','https://api.anthropic.com','x-api-key',1,1)")
  const before=raw.prepare("SELECT * FROM accounts WHERE id='a'").get()
  const account={account_id:'a',secret_id:'s',platform:'anthropic',credential_kind:scenario==='api-key'?'api_key':'oauth',runtime_snapshot:{config_version:before.config_version,control_version:before.control_version,ui_config_json:before.ui_config_json}} as AccountCredential
  if(scenario==='edit') raw.exec("UPDATE accounts SET control_version=control_version+1 WHERE id='a'")
  if(scenario==='background') raw.exec("UPDATE accounts SET config_version=config_version+1,ui_config_json=json_set(ui_config_json,'$.extra.keep',1) WHERE id='a'")
  const response=new Response('untouched-body',{status:scenario==='failure'?429:200,headers:{'anthropic-ratelimit-unified-5h-status':'allowed','anthropic-ratelimit-unified-5h-utilization':'0.25'}})
  try{
    expect(await persistAnthropicUsageObservation({DB:d1} as Env,account,response)).toBe(['success','background'].includes(scenario))
    expect(await response.text()).toBe('untouched-body')
    const after=raw.prepare("SELECT * FROM accounts WHERE id='a'").get()
    expect(after.control_version).toBe(before.control_version+(scenario==='edit'?1:0))
    if(['success','background'].includes(scenario)) expect(anthropicPassiveUsage(JSON.parse(after.ui_config_json)).five_hour?.utilization).toBe(25)
    if(scenario==='background') expect(JSON.parse(after.ui_config_json).extra.keep).toBe(1)
  }finally{raw.close()}
})
