import { expect,it } from 'vitest'
import { codexImportIdentityKeys,codexStoredIdentityKeys,codexAgentIdentityKeys,codexIdentityConflicts,mergeCodexImportCredentials,CodexImportAccountIndex } from '../../src/control/codex-import-identity'
it('keeps independent access-only sessions distinct within the same team and user',async()=>{
  const base={accountId:'team',userId:'user',email:'user@test.local'}
  const a=await codexImportIdentityKeys({...base,accessToken:'first-secret'})
  const b=await codexImportIdentityKeys({...base,accessToken:'second-secret'})
  expect(a).toHaveLength(1);expect(a[0]).toMatch(/^access:[a-f0-9]{64}$/)
  expect(a).not.toEqual(b);expect(JSON.stringify(a)).not.toContain('first-secret')
  expect(await codexImportIdentityKeys({...base,accessToken:' first-secret '})).toEqual(a)
})
it('upgrades an access-only account through stored user identity without merging different team members',async()=>{
  const index=new CodexImportAccountIndex()
  await index.add({id:'one',identity:{accountId:'team',userId:'one',accessToken:'old'}})
  const keys=await codexImportIdentityKeys({accountId:'team',userId:'one',accessToken:'new',refreshToken:'refresh'})
  expect(index.find(keys,'one')?.account.id).toBe('one')
  expect(index.find(await codexImportIdentityKeys({accountId:'team',userId:'two',refreshToken:'other'}),'two')).toBeNull()
  expect(codexIdentityConflicts('account:team','','one')).toBe(false)
})
it('removes old fingerprints on reindex and preserves other accounts sharing a key',async()=>{
  const index=new CodexImportAccountIndex()
  await index.add({id:'one',identity:{accountId:'team',userId:'one',accessToken:'old'}})
  await index.add({id:'two',identity:{accountId:'team',userId:'two',accessToken:'other'}})
  await index.add({id:'one',identity:{accountId:'new-team',userId:'one',accessToken:'new'}})
  expect(index.find(await codexImportIdentityKeys({accessToken:'old'}),'one')).toBeNull()
  expect(index.find(['account:team'],'two')?.account.id).toBe('two')
  expect(index.find(await codexImportIdentityKeys({accessToken:'new'}),'one')?.account.id).toBe('one')
})
it('uses email only without user/workspace IDs and isolates agent workspaces',async()=>{
  expect(await codexStoredIdentityKeys({email:' Test@Example.Com '})).toEqual(['email:test@example.com'])
  expect(await codexStoredIdentityKeys({accountId:'team',email:'test@example.com'})).toEqual(['account:team'])
  expect(codexAgentIdentityKeys(' team-one ')).toEqual(['account:team-one'])
  expect(codexAgentIdentityKeys('')).toEqual([])
})
it('preserves refresh credentials on access-only updates while discarding stale ID claims',()=>{
  const old={refresh_token:'keep-refresh',client_id:'keep-client',id_token:'old-claims',intercept_warmup_requests:true}
  const merged=mergeCodexImportCredentials(old,{access_token:'new',refresh_token:'',client_id:'wrong'}, {})
  expect(merged).toEqual({refresh_token:'keep-refresh',client_id:'keep-client',access_token:'new',intercept_warmup_requests:true})
  expect(old.id_token).toBe('old-claims')
  expect(mergeCodexImportCredentials({}, {access_token:'new',refresh_token:'',client_id:'wrong',id_token:'stale'},{})).toEqual({access_token:'new'})
})
