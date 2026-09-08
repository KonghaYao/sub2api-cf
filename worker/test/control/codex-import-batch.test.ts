import { expect,it,vi } from 'vitest'
import { executeCodexImportBatch,sanitizeCodexCredentialExtras,type CodexImportStoredAccount,type CodexImportWrite } from '../../src/control/codex-import-batch'
const now=Date.parse('2026-09-08T00:00:00Z'),expires=now/1000+3600
function account(id:string,credentials:Record<string,unknown>):CodexImportStoredAccount {
  return {id,credentials,extra:{keep:true},identity:{accountId:credentials.chatgpt_account_id as string,userId:credentials.chatgpt_user_id as string,
    accessToken:credentials.access_token as string,refreshToken:credentials.refresh_token as string}}
}
const input=(access:string,refresh?:string)=>({access_token:access,refresh_token:refresh,chatgpt_account_id:'team',chatgpt_user_id:'user',expires_at:expires})
it('protects normalized credentials from case/whitespace variants in extras',()=>{
  expect(sanitizeCodexCredentialExtras({' ACCESS_TOKEN ':'bad',api_key:'bad',Agent_Private_Key:'bad',client_id:'bad',' intercept_warmup_requests ':true})).toEqual({intercept_warmup_requests:true})
})
it('updates a renewable account without allowing a later old access-only entry to roll credentials back',async()=>{
  const old=account('existing',{access_token:'old',refresh_token:'old-refresh',chatgpt_account_id:'team',chatgpt_user_id:'user'})
  const writes:CodexImportWrite[]=[]
  const result=await executeCodexImportBatch({content:JSON.stringify([input('new','new-refresh'),input('old')])},[old],async write=>{
    writes.push(write);return account(write.existing?.id??'created',write.credentials)
  },now)
  expect(result).toMatchObject({updated:1,created:1,failed:0})
  expect(writes[0]!.credentials).toMatchObject({access_token:'new',api_key:'new',refresh_token:'new-refresh'})
  expect(writes[1]!.existing).toBeNull()
  expect(old.credentials.refresh_token).toBe('old-refresh')
})
it('preserves existing renewable credentials and account expiry policy on access-only updates',async()=>{
  const old=account('existing',{access_token:'same',refresh_token:'keep',client_id:'keep-client',chatgpt_user_id:'user'})
  const persist=vi.fn(async(write:CodexImportWrite)=>{expect(write).toMatchObject({action:'updated',accountExpiresAt:null,autoPauseOnExpired:undefined,
    credentials:{refresh_token:'keep',client_id:'keep-client'}});return account('existing',write.credentials)})
  const result=await executeCodexImportBatch({content:JSON.stringify(input('same')),auto_pause_on_expired:false},[old],persist,now)
  expect(result.updated).toBe(1);expect(result.warnings.some(w=>w.message.includes('保留自动续期凭据'))).toBe(true)
})
it('reports partial failures and skips duplicates even when the first write failed',async()=>{
  const persist=vi.fn(async(write:CodexImportWrite)=>{if(write.index===1) throw new Error('secret database failure');return account('new',write.credentials)})
  const result=await executeCodexImportBatch({content:JSON.stringify([input('one'),input('one'),input('two'),{}]),name:'Import'},[],persist,now)
  expect(result).toMatchObject({total:4,created:1,updated:0,skipped:1,failed:2})
  expect(persist).toHaveBeenCalledTimes(2);expect(JSON.stringify(result)).not.toContain('secret database')
  expect(result.items[1]).toMatchObject({index:2,name:'Import #2',action:'skipped'})
})
it('creates instead of updating when update_existing is false and retains input-specific metadata',async()=>{
  const persist=vi.fn(async(write:CodexImportWrite)=>{expect(write.action).toBe('created');expect(write.extra).toMatchObject({keep:true,import_source:'codex_session'});return account('new',write.credentials)})
  expect(await executeCodexImportBatch({content:JSON.stringify(input('same','refresh')),update_existing:false,extra:{keep:true,import_source:'wrong'}},
    [account('existing',{access_token:'same',chatgpt_user_id:'user'})],persist,now)).toMatchObject({created:1,updated:0})
})
