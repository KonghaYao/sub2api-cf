import {afterEach,describe,expect,it,vi} from 'vitest'
import {applyMigrations,createSqliteD1} from '../helpers/sqlite-d1'
import {securityDefaults,parseSecuritySettings} from '../../src/control/gateway-security-settings'
import {enforceCyberSession,observeCyberResponse,recordCyberPolicy,type CyberRequest} from '../../src/gateway/cyber-sessions'
import {configuredSourceIp} from '../../src/gateway/ip-policy'
import type {Env} from '../../src/env'
function fixture(){const {raw,d1}=createSqliteD1();applyMigrations(raw);return {raw,env:{DB:d1} as Env}}
const settings={...securityDefaults,cyber_session_block_enabled:true,risk_control_enabled:true,cyber_session_block_ttl_seconds:60}
const request:CyberRequest={user_id:'user-one',api_key_id:'key-one',request_id:'request-one',model:'model',headers:new Headers({'session_id':'private-session'}),body:{input:[{role:'user',content:'private prompt'}]}}
afterEach(()=>vi.useRealTimers())
describe('gateway cyber settings consumers',()=>{
 it('blocks only the affected key/session through the configured TTL without retaining secrets or prompts',async()=>{
  vi.useFakeTimers();vi.setSystemTime(100000)
  const test=fixture()
  await enforceCyberSession(test.env,settings,request)
  await recordCyberPolicy(test.env,settings,request)
  await expect(enforceCyberSession(test.env,settings,request)).rejects.toMatchObject({status:403,code:'session_blocked_by_cyber_policy'})
  await enforceCyberSession(test.env,settings,{...request,api_key_id:'key-other'})
  await enforceCyberSession(test.env,securityDefaults,request)
  const rows=JSON.stringify(test.raw.prepare('SELECT * FROM gateway_cyber_sessions').all())
  expect(rows).not.toContain('private-session');expect(rows).not.toContain('private prompt')
  await recordCyberPolicy(test.env,settings,request)
  expect(test.raw.prepare('SELECT COUNT(*) AS count FROM gateway_risk_events').get()?.count).toBe(1)
  vi.advanceTimersByTime(60001);await enforceCyberSession(test.env,settings,request)
  test.raw.close()
 })
 it('matches transcript continuations while preserving earlier successful history and isolating other keys',async()=>{
  const test=fixture(),first={role:'user',content:'earlier safe turn'},blocked={...request,headers:new Headers(),body:{messages:[first,{role:'assistant',content:'earlier answer'},{role:'user',content:'blocked turn'}]}}
  await recordCyberPolicy(test.env,settings,blocked)
  await enforceCyberSession(test.env,settings,{...blocked,body:{messages:[first]}})
  await expect(enforceCyberSession(test.env,settings,{...blocked,body:{messages:[...blocked.body.messages,{role:'assistant',content:'refusal'},{role:'user',content:'continue'}]}})).rejects.toMatchObject({code:'session_blocked_by_cyber_policy'})
  await enforceCyberSession(test.env,settings,{...blocked,api_key_id:'other-key'})
  test.raw.close()
 })
 it('observes split terminal SSE errors after visible content and preserves every byte',async()=>{
  const test=fixture(),chunks=['data: {"type":"response.output_text.delta","delta":"hello"}\n\n','data: {"type":"response.failed","response":{"error":{"co','de":"cyber_policy"}}}\r\n\r\n'],bytes=new TextEncoder()
  const response=observeCyberResponse(test.env,settings,request,new Response(new ReadableStream({start(controller){chunks.forEach(chunk=>controller.enqueue(bytes.encode(chunk)));controller.close()}}),{headers:{'content-type':'text/event-stream'}}))
  expect(await response.text()).toBe(chunks.join(''))
  await expect(enforceCyberSession(test.env,settings,request)).rejects.toMatchObject({status:403})
  test.raw.close()
 })
 it('observes JSON refusals, ignores ordinary errors, and never records disabled risk logs',async()=>{
  const test=fixture()
  await observeCyberResponse(test.env,settings,request,new Response('{"error":{"code":"invalid_request"}}',{status:400,headers:{'content-type':'application/json'}})).text()
  expect(test.raw.prepare('SELECT COUNT(*) AS count FROM gateway_cyber_sessions').get()?.count).toBe(0)
  await observeCyberResponse(test.env,{...settings,risk_control_enabled:false},request,new Response('{"error":{"code":"cyber_policy"}}',{status:400,headers:{'content-type':'application/json'}})).text()
  expect(test.raw.prepare('SELECT COUNT(*) AS count FROM gateway_risk_events').get()?.count).toBe(0)
  await expect(enforceCyberSession(test.env,settings,request)).rejects.toMatchObject({status:403})
  test.raw.close()
 })
 it.each(['\n','\r\n','\r'])('observes legal multiline SSE with %j delimiters and falls back to nested error codes',async delimiter=>{
  const test=fixture(),text=['data: {"error":{"message":"wrapper"},','data: "response":{"error":{"code":"cyber_policy"}}}','',''].join(delimiter)
  const bytes=new TextEncoder().encode(text)
  const response=observeCyberResponse(test.env,settings,request,new Response(new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close()}}),{headers:{'content-type':'text/event-stream'}}))
  expect(await response.text()).toBe(text)
  await expect(enforceCyberSession(test.env,settings,request)).rejects.toMatchObject({status:403})
  test.raw.close()
 })
 it('keeps Cloudflare authority by default and uses configured forwarded order only under explicit trust',()=>{
  const req=new Request('https://example.test',{headers:{'cf-connecting-ip':'192.0.2.1','x-forwarded-for':'198.51.100.2, 192.0.2.1','x-real-ip':'203.0.113.3'}})
  expect(configuredSourceIp(req,'production',false,['x-forwarded-for'])).toBe('192.0.2.1')
  expect(configuredSourceIp(req,'production',true,['x-real-ip','x-forwarded-for'])).toBe('203.0.113.3')
  expect(configuredSourceIp(req,'production',true,['x-forwarded-for'])).toBe('198.51.100.2')
  expect(()=>parseSecuritySettings({forwarded_client_ip_headers:['authorization']})).toThrow()
  expect(()=>parseSecuritySettings({cyber_session_block_ttl_seconds:0})).toThrow()
 })
})
