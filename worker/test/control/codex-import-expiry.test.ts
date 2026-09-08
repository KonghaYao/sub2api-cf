import { expect,it } from 'vitest'
import { CodexImportNumber } from '../../src/control/codex-import-content'
import { parseCodexImportTime,resolveCodexImportExpiry } from '../../src/control/codex-import-expiry'
const now=Date.parse('2026-09-08T00:00:00Z'),seconds=now/1000
it.each([seconds,String(seconds),now,String(now),new CodexImportNumber(String(seconds)+'.75'),'2026-09-08T08:00:00+08:00'])(
  'parses original time representation %s',value=>expect(parseCodexImportTime(value)).toBe(now))
it.each(['1.25','not-a-date',true,null,'1e3',new CodexImportNumber('1e999'),'999999999999999999999','2026-02-30T00:00:00Z','2026-09-08T24:00:00Z'])('rejects invalid or unrepresentable time %s',value=>{
  expect(parseCodexImportTime(value)).toBeNull()
})
it('uses the earlier access-only expiry and forces automatic pause',()=>{
  const result=resolveCodexImportExpiry({expiresAt:seconds+600,autoPauseOnExpired:false},{refreshToken:'',tokenExpiresAt:now+1200000},now)
  expect(result).toMatchObject({accountExpiresAt:seconds+600,credentialExpiresAt:now+600000,autoPauseOnExpired:true})
  expect(result.warnings).toHaveLength(2)
})
it('requires expiry for opaque access-only credentials and enforces the clock-skew boundary',()=>{
  expect(()=>resolveCodexImportExpiry({},{refreshToken:'',tokenExpiresAt:null},now)).toThrow('未包含 refresh_token')
  expect(()=>resolveCodexImportExpiry({},{refreshToken:'',tokenExpiresAt:now-120000},now)).toThrow('过期时间已过期')
  expect(resolveCodexImportExpiry({},{refreshToken:'',tokenExpiresAt:now-119000},now).autoPauseOnExpired).toBe(true)
})
it('does not auto-expire renewable accounts when their access tokens expire',()=>{
  expect(resolveCodexImportExpiry({autoPauseOnExpired:false},{refreshToken:'refresh',tokenExpiresAt:now+60000},now))
    .toEqual({accountExpiresAt:null,credentialExpiresAt:now+60000,autoPauseOnExpired:false,warnings:[]})
  expect(resolveCodexImportExpiry({expiresAt:seconds+86400},{refreshToken:'refresh',tokenExpiresAt:now+60000},now))
    .toMatchObject({accountExpiresAt:seconds+86400,credentialExpiresAt:now+60000,autoPauseOnExpired:undefined})
})
it('does not apply OAuth expiration to agent runtime identities',()=>{
  expect(resolveCodexImportExpiry({expiresAt:1,autoPauseOnExpired:true},{refreshToken:'',tokenExpiresAt:1,isAgentIdentity:true},now))
    .toEqual({accountExpiresAt:null,credentialExpiresAt:null,autoPauseOnExpired:undefined,warnings:[]})
})
