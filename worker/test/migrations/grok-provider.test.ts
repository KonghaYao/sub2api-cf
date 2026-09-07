import {expect,it} from 'vitest'
import {applyMigrations,createSqliteD1} from '../helpers/sqlite-d1'
it('preserves all existing provider columns and linked secrets while adding the Grok contract',()=>{
 const {raw}=createSqliteD1();applyMigrations(raw,96)
 const providers=[['openai','openai','bearer'],['anthropic','anthropic','x-api-key'],['gemini','gemini','x-goog-api-key'],['codex','codex','bearer']]
 for(const [platform,protocol,auth] of providers){raw.prepare('INSERT INTO accounts(id,name,platform,credential_ref,protocol,auth_scheme,created_at_ms,updated_at_ms)VALUES(?,?,?,?,?,?,1,1)').run(platform,platform,platform,platform,protocol,auth);raw.prepare('INSERT INTO account_secrets(id,account_id,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms)VALUES(?,?,?, ?,1,1)').run(platform,platform,'nonce','cipher')}
 raw.prepare("INSERT INTO \"groups\"(id,name,platform,created_at_ms,updated_at_ms)VALUES('mixed','mixed','composite',1,1)").run()
 raw.prepare("INSERT INTO composite_model_routes(id,group_id,public_model,match_type,target_platform,upstream_model,endpoint,created_at_ms,updated_at_ms)VALUES('legacy-route','mixed','legacy','exact','codex','legacy-upstream','responses',1,1)").run()
 const oldRoute=raw.prepare("SELECT * FROM composite_model_routes WHERE id='legacy-route'").get()
 const before=raw.prepare('SELECT * FROM accounts ORDER BY id').all();applyMigrations(raw,97)
 expect(raw.prepare('SELECT * FROM accounts ORDER BY id').all()).toEqual(before)
 expect(raw.prepare("SELECT * FROM composite_model_routes WHERE id='legacy-route'").get()).toEqual(oldRoute)
 raw.prepare("UPDATE composite_model_routes SET target_platform='antigravity' WHERE id='legacy-route'").run()
 expect(()=>raw.prepare("UPDATE composite_model_routes SET target_platform='unsupported' WHERE id='legacy-route'").run()).toThrow()
 expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
 expect(raw.prepare('SELECT COUNT(*) AS n FROM account_secrets').get().n).toBe(4)
 const add=(protocol:string,auth:string)=>raw.prepare("INSERT INTO accounts(id,name,platform,credential_ref,protocol,auth_scheme,provider_config_json,created_at_ms,updated_at_ms)VALUES('grok','Grok','grok','grok-secret',?,?,?,1,1)").run(protocol,auth,'{"use_default_base_url":true}')
 expect(()=>add('grok','bearer')).toThrow();expect(()=>add('openai','x-api-key')).toThrow();add('openai','bearer')
 raw.close()
})
