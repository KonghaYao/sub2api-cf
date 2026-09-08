import {expect,it} from 'vitest'
import type {Env} from '../../src/env'
import type {AccountCredential} from '../../src/gateway/types'
import {persistCodexUsageObservation} from '../../src/gateway/codex-usage-observation'
import {applyMigrations,createSqliteD1} from '../helpers/sqlite-d1'
it.each(['success','throttle','edit','background','shadow','api-key','failed','empty'])('handles normal Codex quota sampling: %s',async scenario=>{
  const {raw,d1}=createSqliteD1();applyMigrations(raw)
  raw.prepare(`INSERT INTO accounts(id,platform,name,credential_ref,credential_kind,protocol,base_url,auth_scheme,ui_config_json,created_at_ms,updated_at_ms)
    VALUES('a','openai','Quota','s','oauth','openai','https://api.openai.com','bearer',?,1,1)`)
    .run(JSON.stringify({extra:{keep:true},...(scenario==='shadow'?{parent_account_id:'parent'}:{})}))
  const current=()=>{const row=raw.prepare("SELECT * FROM accounts WHERE id='a'").get();return {account_id:'a',secret_id:'s',platform:'openai',credential_kind:scenario==='api-key'?'api_key':'oauth',runtime_snapshot:{config_version:row.config_version,control_version:row.control_version,ui_config_json:row.ui_config_json}} as AccountCredential}
  const account=current(),now=Date.now()
  if(scenario==='edit')raw.exec("UPDATE accounts SET control_version=control_version+1 WHERE id='a'")
  if(scenario==='background')raw.exec("UPDATE accounts SET config_version=config_version+1,ui_config_json=json_set(ui_config_json,'$.extra.background',1) WHERE id='a'")
  const response=new Response('unchanged',{status:scenario==='failed'?429:200,headers:scenario==='empty'?{}:{'x-codex-secondary-used-percent':'35','x-codex-secondary-reset-after-seconds':'600'}})
  try{
    const expected=['success','throttle','background'].includes(scenario)
    expect(await persistCodexUsageObservation({DB:d1} as Env,account,response,now)).toBe(expected)
    expect(await response.text()).toBe('unchanged')
    const row=raw.prepare("SELECT * FROM accounts WHERE id='a'").get()
    expect(row.control_version).toBe(account.runtime_snapshot!.control_version+(scenario==='edit'?1:0))
    expect(JSON.parse(row.ui_config_json).extra.keep).toBe(true)
    if(expected)expect(JSON.parse(row.ui_config_json).extra.codex_5h_used_percent).toBe(35)
    if(scenario==='background')expect(JSON.parse(row.ui_config_json).extra.background).toBe(1)
    if(scenario==='throttle'){
      const next=new Response(null,{headers:{'x-codex-secondary-used-percent':'70'}})
      expect(await persistCodexUsageObservation({DB:d1} as Env,current(),next,now+29999)).toBe(false)
      expect(await persistCodexUsageObservation({DB:d1} as Env,current(),next,now+30000)).toBe(true)
      expect(raw.prepare("SELECT last_attempt_at_ms FROM account_usage_probe_state WHERE account_id='a'").get().last_attempt_at_ms).toBe(0)
    }
  }finally{raw.close()}
})
