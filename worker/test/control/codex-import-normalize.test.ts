import { expect,it } from 'vitest'
import { normalizeCodexImportEntry } from '../../src/control/codex-import-normalize'
import { parseCodexImportEntries } from '../../src/control/codex-import-content'
const now=Date.parse('2026-09-08T00:00:00Z'),sec=now/1000
const jwt=(value:unknown)=>'header.'+btoa(JSON.stringify(value)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')+'.signature'
const normalize=(value:unknown)=>normalizeCodexImportEntry(parseCodexImportEntries({content:JSON.stringify(value)})[0]!,now)
it('normalizes nested tokens and preserves explicit identity ahead of JWT hints',async()=>{
  const result=await normalize({name:'Imported',tokens:{access_token:jwt({exp:sec+3600,email:'jwt@test',sub:'jwt-user'}),refreshToken:'refresh'},
    user:{id:123,email:'explicit@test'},account:{id:'workspace',planType:'team'},sessionToken:'must-never-be-refresh',expires:'2030-01-01T00:00:00Z'})
  expect(result).toMatchObject({name:'Imported',userId:'123',accountId:'workspace',email:'explicit@test',tokenExpiresAt:now+3600000,
    credentials:{refresh_token:'refresh',chatgpt_user_id:'123',plan_type:'team'},extra:{session_token_present:true}})
  expect(result.warnings.some(text=>text.includes('sessionToken 已忽略'))).toBe(true)
  expect(JSON.stringify(result)).not.toContain('must-never-be-refresh')
})
it('uses ID-token hints first but access-token expiry and provider organization fallback',async()=>{
  const result=await normalize({accessToken:jwt({exp:sec+600,sub:'access-user','https://api.openai.com/auth':{chatgpt_account_id:'team',user_id:'provider-user',organizations:[{id:'one'},{id:'two',is_default:true}]}}),
    id_token:jwt({exp:1,email:'identity@test',sub:'id-user'}),refresh_token:'refresh'})
  expect(result).toMatchObject({email:'identity@test',userId:'id-user',accountId:'team',organization:'two',tokenExpiresAt:now+600000})
})
it('preserves large IDs from JSON and does not use session expiry as token expiry',async()=>{
  const result=await normalizeCodexImportEntry(parseCodexImportEntries({content:'{"accessToken":"opaque","user":{"id":9007199254740993},"expires":"2030-01-01T00:00:00Z"}'})[0]!,now)
  expect(result.userId).toBe('9007199254740993');expect(result.tokenExpiresAt).toBeNull()
  expect(result.extra.session_expires_at).toBe('2030-01-01T00:00:00.000Z')
  expect(result.warnings).toHaveLength(3)
})
it('uses the original expiry boundaries for explicit timestamps and JWT hints',async()=>{
  await expect(normalize({accessToken:'opaque',expires_at:sec-120})).rejects.toMatchObject({code:'invalid_codex_import_entry'})
  await expect(normalize({accessToken:jwt({exp:sec-121})})).rejects.toMatchObject({code:'invalid_codex_import_entry'})
  expect((await normalize({accessToken:jwt({exp:sec-120})})).tokenExpiresAt).toBe(now-120000)
})
it('treats malformed JWT claim types as unparseable rather than trusting coerced identities',async()=>{
  const result=await normalize({accessToken:jwt({exp:String(sec+600),sub:123})})
  expect(result.userId).toBe('');expect(result.tokenExpiresAt).toBeNull();expect(result.warnings).toHaveLength(3)
})
it('validates Ed25519 agent identities and separates them from OAuth/session metadata',async()=>{
  const pair=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']) as CryptoKeyPair
  const pkcs8=await crypto.subtle.exportKey('pkcs8',pair.privateKey)
  const privateKey=btoa(String.fromCharCode(...new Uint8Array(pkcs8)))
  const result=await normalize({name:'ignored',agentIdentity:{agentRuntimeId:'runtime',agentPrivateKey:privateKey,accountId:'team',chatgptUserId:'user',chatgptAccountIsFedramp:'True'},expires_at:1})
  expect(result).toMatchObject({isAgentIdentity:true,name:'team',accessToken:'',tokenExpiresAt:null,identityKeys:['account:team'],
    credentials:{auth_mode:'agentIdentity',agent_runtime_id:'runtime',chatgpt_account_is_fedramp:true}})
  expect(result.warnings).toHaveLength(1)
})
it.each([{accessToken:''},{agent_identity:{}},{agent_identity:{agent_runtime_id:'runtime',agent_private_key:'secret-invalid-key',account_id:'team',chatgpt_user_id:'user'}}])('rejects invalid credentials without exposing them',async value=>{
  try {await normalize(value);throw new Error('unexpected success')}
  catch(error:any) {expect(error.code).toBe('invalid_codex_import_entry');expect(error.message).not.toContain('secret-invalid-key')}
})

it.each(['agentIdentity','AGENTIDENTITY','agent_identity'])('accepts top-level Agent Identity auth mode %s and stores the original canonical value',async auth_mode=>{
  const privateKey='MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f'
  const value={auth_mode,agent_runtime_id:'runtime',agent_private_key:privateKey,account_id:'workspace',chatgpt_user_id:'user',task_id:'task'}
  const result=await normalizeCodexImportEntry({index:1,value},Date.now())
  expect(result).toMatchObject({isAgentIdentity:true,credentials:{auth_mode:'agentIdentity',task_id:'task',agent_runtime_id:'runtime'}})
})
