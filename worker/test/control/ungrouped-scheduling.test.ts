import {expect,it} from 'vitest'
import {applyMigrations,createSqliteD1} from '../helpers/sqlite-d1'
import {authenticateGatewayRequest,getAccountCredential} from '../../src/gateway/repository'
import {apiKeyDigest} from '../../src/gateway/crypto'
import type {Env} from '../../src/env'
it('virtual group contains only otherwise unassigned accounts and never borrows private models or keys',async()=>{
 const {raw,d1}=createSqliteD1();applyMigrations(raw);const now=Date.now(),virtual='worker-ungrouped-default'
 const enable=(on:boolean)=>raw.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.allow_ungrouped_key_scheduling',json(?)) WHERE id='global'").run(JSON.stringify(on))
 const account=(id:string)=>raw.prepare('INSERT INTO accounts(id,name,platform,credential_ref,base_url,created_at_ms,updated_at_ms)VALUES(?,?,?,?,?,?,?)').run(id,id,'openai','secret-'+id,'https://upstream.e2e.invalid/v1',now,now)
 raw.prepare("INSERT INTO users(id,email,created_at_ms,updated_at_ms)VALUES('user','ungrouped@test.invalid',?,?)").run(now,now)
 raw.prepare("INSERT INTO \"groups\"(id,name,platform,created_at_ms,updated_at_ms)VALUES('private','private','openai',?,?)").run(now,now)
 account('private-account');account('loose-account')
 raw.prepare("INSERT INTO account_groups(account_id,group_id,created_at_ms,updated_at_ms)VALUES('private-account','private',?,?)").run(now,now)
 expect(raw.prepare('SELECT id FROM "groups" WHERE id=?').get(virtual)).toBeUndefined()
 enable(true)
 expect(raw.prepare('SELECT account_id FROM account_groups WHERE group_id=?').all(virtual)).toEqual([{account_id:'loose-account'}])
 expect(raw.prepare('SELECT * FROM group_models WHERE group_id=?').all(virtual)).toEqual([])
 expect(()=>raw.prepare('INSERT INTO account_groups(account_id,group_id,created_at_ms,updated_at_ms)VALUES(?,?,?,?)').run('private-account',virtual,now,now)).toThrow('virtual_default_requires_ungrouped_account')
 raw.prepare("INSERT INTO account_groups(account_id,group_id,created_at_ms,updated_at_ms)VALUES('loose-account','private',?,?)").run(now,now)
 expect(raw.prepare('SELECT account_id FROM account_groups WHERE group_id=?').all(virtual)).toEqual([])
 raw.prepare("DELETE FROM account_groups WHERE account_id='loose-account'").run()
 expect(raw.prepare('SELECT account_id FROM account_groups WHERE group_id=?').all(virtual)).toEqual([{account_id:'loose-account'}])
 const env={DB:d1,API_KEY_PEPPER:'p'.repeat(32)} as Env,token='sk-ungrouped-local-fixture'
 raw.prepare('INSERT INTO api_keys(id,user_id,group_id,name,key_hash,key_prefix,created_at_ms,updated_at_ms)VALUES(?,?,?,?,?,?,?,?)').run('key','user',virtual,'key',await apiKeyDigest(token,env.API_KEY_PEPPER!),token.slice(0,12),now,now)
 const request=new Request('https://gateway.test/v1/models',{headers:{authorization:'Bearer '+token}})
 expect((await authenticateGatewayRequest(request,env)).group_id).toBe(virtual)
 enable(false)
 await expect(authenticateGatewayRequest(request,env)).rejects.toMatchObject({code:'group_unavailable'})
 await expect(getAccountCredential(env,virtual,'missing','responses','loose-account')).rejects.toMatchObject({code:'credential_unavailable'})
 expect(()=>raw.prepare('UPDATE "groups" SET enabled=1 WHERE id=?').run(virtual)).toThrow('virtual_default_group_managed')
 expect(()=>raw.prepare('DELETE FROM "groups" WHERE id=?').run(virtual)).toThrow('virtual_default_group_managed')
 enable(true)
 raw.prepare("UPDATE users SET restrict_public_groups=1 WHERE id='user'").run()
 await expect(authenticateGatewayRequest(request,env)).rejects.toMatchObject({code:'group_access_denied'})
 raw.close()
})
