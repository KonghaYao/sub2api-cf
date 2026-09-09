import {CLAUDE_SYSTEM_PROMPT} from '../../src/gateway/claude-prompt-defaults'
import {afterEach,expect,it,vi} from 'vitest'
import {normalizeProviderForwardingSettings,parseProviderForwardingSettings} from '../../src/control/provider-forwarding-settings'
import {applyProviderBodySettings,applyProviderIdentity,codexHeaders} from '../../src/gateway/provider-forwarding'
import {runCodexVersionSync} from '../../src/control/codex-version-sync'
import {FirstTokenTimer} from '../../src/gateway/scheduler-telemetry'
import {applyMigrations,createSqliteD1} from '../helpers/sqlite-d1'
import type {Env} from '../../src/env'
afterEach(()=>vi.unstubAllGlobals())
it('validates admin overrides and reserves the synchronized version for the background writer',()=>{
 expect(()=>parseProviderForwardingSettings({openai_codex_client_version_synced:'1.2.3'})).toThrow('read-only')
 for(const patch of [{openai_ttft_mode:'raw'},{openai_codex_user_agent:'Chrome/100'},{openai_codex_client_version:'latest'},{claude_oauth_system_prompt_blocks:'[{"text":"x","type":"image"}]'}])expect(()=>parseProviderForwardingSettings(patch)).toThrow()
 const settings=normalizeProviderForwardingSettings({openai_codex_client_version:'0.200.0',openai_codex_client_version_synced:'0.190.0',openai_codex_user_agent:'codex-tui/0.100.0 (Linux)'})
 expect(codexHeaders(settings)).toEqual({'user-agent':'codex-tui/0.200.0 (Linux)',originator:'codex-tui',version:'0.200.0'})
 expect(codexHeaders(settings,true)).not.toHaveProperty('version')
})
it('normalizes only OAuth system datelines/reminder regions and expands configured blocks while retaining client instructions',async()=>{
 const settings=normalizeProviderForwardingSettings({claude_oauth_system_prompt:'Custom expansion',claude_oauth_system_prompt_blocks:JSON.stringify([{text:'{billing_header}'},{text:'{claude_code_system_prompt}'},{text:'{claude_code_expansion_prompt}',cache_control:true},{text:'disabled',enabled:false}])})
 const body={system:'Today’s date is 2026/09/07.',messages:[{role:'user',content:"User prose Today’s date is 2026/09/07. <system-reminder>Todayʼs date is 2026/09/07.</system-reminder>"}]}
 const output=await applyProviderBodySettings(settings,'anthropic','oauth',body) as any
 expect(output.system).toHaveLength(3);expect(output.system[0].text).toMatch(/cc_version=2\.1\.220\.[a-f0-9]{3};/)
 expect(output.system[2]).toMatchObject({text:'Custom expansion',cache_control:{type:'ephemeral',ttl:'5m'}})
 expect(output.messages[0].content[0].text).toBe("[System Instructions]\nToday's date is 2026-09-07.")
 expect(output.messages[2].content).toContain('User prose Today’s date is 2026/09/07.')
 expect(output.messages[2].content).toContain("<system-reminder>Today's date is 2026-09-07.</system-reminder>")
 expect(await applyProviderBodySettings(settings,'anthropic','api_key',body)).toEqual(body)
 const disabled=await applyProviderBodySettings({...settings,enable_claude_oauth_system_prompt_injection:false},'anthropic','setup_token',body) as any
 expect(disabled.system).toBe("Today's date is 2026-09-07.");expect(disabled.messages).toHaveLength(1)
 expect(body.system).toContain('’')
})
it('persists account fingerprints, keeps unrelated callers on one identity and upgrades valid newer clients',async()=>{
 const {raw,d1}=createSqliteD1();applyMigrations(raw);const env={DB:d1} as Env,settings=normalizeProviderForwardingSettings({}),account={id:'account',platform:'anthropic',credential_kind:'oauth'}
 const first=new Headers({'x-api-key':'oauth-token'})
 await applyProviderIdentity(env,settings,account,first,new Headers({'user-agent':'claude-cli/2.1.221 (external, cli)','x-stainless-os':'MacOS'}))
 expect(first.get('authorization')).toBe('Bearer oauth-token');expect(first.has('x-api-key')).toBe(false)
 const next=new Headers();await applyProviderIdentity(env,settings,account,next,new Headers({'user-agent':'Chrome/999','x-stainless-os':'Windows'}))
 expect(next.get('user-agent')).toBe(first.get('user-agent'));expect(next.get('x-stainless-os')).toBe('MacOS')
 const upgraded=new Headers();await applyProviderIdentity(env,settings,account,upgraded,new Headers({'user-agent':'claude-cli/2.1.222 (external, cli)'}))
 expect(upgraded.get('user-agent')).toContain('2.1.222');expect(upgraded.get('x-stainless-os')).toBe('MacOS')
 expect(raw.prepare("SELECT count(*) AS n FROM runtime_settings WHERE name LIKE 'account-fingerprint:%'").get().n).toBe(1)
 raw.close()
})
it('uses stable official releases, bounded sync claims and preserves manual overrides',async()=>{
 const {raw,d1}=createSqliteD1();applyMigrations(raw);const env={DB:d1} as Env
 raw.prepare("UPDATE system_settings SET gateway_json=? WHERE id='global'").run(JSON.stringify({openai_codex_client_version:'0.199.0',openai_codex_version_auto_sync_enabled:true}))
 const upstream=vi.fn(async(url:string)=>url.endsWith('/latest')?Response.json({tag_name:'other-component-v9.0.0',draft:false,prerelease:false}):Response.json([{tag_name:'rust-v0.202.0-alpha.1',prerelease:true,draft:false},{tag_name:'rust-v0.201.0',prerelease:false,draft:false},{tag_name:'rust-v0.200.0',prerelease:false,draft:false}]))
 vi.stubGlobal('fetch',upstream)
 expect(await runCodexVersionSync(env)).toEqual({checked:true,version:'0.201.0'})
 expect(upstream).toHaveBeenCalledTimes(2);expect(upstream.mock.calls.every(([url])=>url.startsWith('https://api.github.com/repos/openai/codex/releases'))).toBe(true)
 const saved=JSON.parse(raw.prepare("SELECT gateway_json FROM system_settings WHERE id='global'").get().gateway_json)
 expect(saved.openai_codex_client_version).toBe('0.199.0');expect(saved.openai_codex_client_version_synced).toBe('0.201.0')
 expect(await runCodexVersionSync(env)).toEqual({checked:false});expect(upstream).toHaveBeenCalledTimes(2)
 raw.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.openai_codex_version_auto_sync_enabled',0) WHERE id='global'").run()
 // Booleans are represented as JSON true/false, not numeric switches.
 raw.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.openai_codex_version_auto_sync_enabled',json('false')) WHERE id='global'").run()
 expect(await runCodexVersionSync(env)).toEqual({checked:false});raw.close()
})
it('distinguishes semantic events from visible first output without counting preamble/errors',()=>{
 const semantic=new FirstTokenTimer(100,'semantic'),visible=new FirstTokenTimer(100,'visible'),enc=new TextEncoder()
 const push=(value:unknown,time:number)=>{const bytes=enc.encode('data: '+JSON.stringify(value)+'\n\n');semantic.push(bytes,time);visible.push(bytes,time)}
 push({type:'response.created'},110);expect(semantic.firstTokenMs).toBeNull()
 push({type:'response.output_item.added',item:{type:'reasoning'}},120);expect(semantic.firstTokenMs).toBe(20);expect(visible.firstTokenMs).toBeNull()
 push({type:'response.output_text.delta',delta:'hello'},180);expect(visible.firstTokenMs).toBe(80)
})

it.each(['oauth','setup_token'])('preserves the last system cache breakpoint and stable conversation prefix for %s',async kind=>{
 const settings=normalizeProviderForwardingSettings({})
 const body={system:[
  {type:'text',text:'Project rules',cache_control:{type:'ephemeral',ttl:'5m'}},
  {type:'text',text:'Stable project context',cache_control:{type:'ephemeral',ttl:'1h'}},
  {type:'text',text:'Additional instructions'},
  {type:'text',text:'  ',cache_control:{type:'ephemeral',ttl:'5m'}},
 ],messages:[{role:'user',content:'First question'}]}
 const before=structuredClone(body)
 const first=await applyProviderBodySettings(settings,'anthropic',kind,body) as any
 expect(first.messages[0].content).toEqual([{type:'text',text:'[System Instructions]\nProject rules\n\nStable project context\n\nAdditional instructions',cache_control:{type:'ephemeral',ttl:'1h'}}])
 const next=await applyProviderBodySettings(settings,'anthropic',kind,{...body,messages:[...body.messages,{role:'assistant',content:'First answer'},{role:'user',content:'Follow-up question'}]}) as any
 expect(next.system).toEqual(first.system)
 expect(next.messages.slice(0,first.messages.length)).toEqual(first.messages)
 expect(body).toEqual(before)
 expect(await applyProviderBodySettings(settings,'anthropic','api_key',body)).toEqual(before)
 const uncached=await applyProviderBodySettings(settings,'anthropic',kind,{system:'  Instructions  ',messages:body.messages}) as any
 expect(uncached.messages[0].content).toEqual([{type:'text',text:'[System Instructions]\nInstructions'}])
})

it('rewrites message breakpoints after system migration and only for OAuth preparation',async()=>{
 const settings={...normalizeProviderForwardingSettings({}),rewrite_message_cache_control:true}
 const body={system:[{type:'text',text:'Project instructions',cache_control:{type:'ephemeral',ttl:'1h'}}],messages:[
  {role:'user',content:'First question'},
  {role:'assistant',content:'First answer'},
  {role:'user',content:[{type:'text',text:'Follow-up',cache_control:{type:'ephemeral',ttl:'1h'}}]},
 ]}
 const before=structuredClone(body)
 for(const kind of ['oauth','setup_token']){
  const output=await applyProviderBodySettings(settings,'anthropic',kind,body) as any
  expect(output.messages).toHaveLength(5)
  expect(output.messages[0].content[0]).not.toHaveProperty('cache_control')
  expect(output.messages[2].content).toEqual([{type:'text',text:'First question',cache_control:{type:'ephemeral',ttl:'5m'}}])
  expect(output.messages[4].content).toEqual([{type:'text',text:'Follow-up',cache_control:{type:'ephemeral',ttl:'5m'}}])
  expect(output.messages[3].content).toBe('First answer')
 }
 expect(await applyProviderBodySettings(settings,'anthropic','api_key',body)).toEqual(before)
 expect(await applyProviderBodySettings(settings,'openai','oauth',body)).toEqual(before)
 expect(body).toEqual(before)
 const disabled=await applyProviderBodySettings({...settings,enable_claude_oauth_system_prompt_injection:false},'anthropic','oauth',body) as any
 expect(disabled.messages).toHaveLength(3)
 expect(disabled.messages[0].content).toBe('First question')
 expect(disabled.messages[2].content[0].cache_control.ttl).toBe('5m')
})
it('enforces the final four-breakpoint limit after configured system injection',async()=>{
 const settings=normalizeProviderForwardingSettings({claude_oauth_system_prompt_blocks:JSON.stringify(Array.from({length:5},(_,i)=>({text:'Configured '+i,cache_control:true})))})
 const body={system:[{type:'text',text:'Client instructions',cache_control:{type:'ephemeral',ttl:'1h'}}],messages:[{role:'user',content:[{type:'text',text:'hello',cache_control:{type:'ephemeral',ttl:'1h'}}]}],tools:[{name:'lookup',input_schema:{type:'object'},cache_control:{type:'ephemeral',ttl:'1h'}}]}
 const output=await applyProviderBodySettings(settings,'anthropic','oauth',body) as any
 expect(output.system.map((b:any)=>!!b.cache_control)).toEqual([true,true,true,true,false])
 expect(output.messages[0].content[0]).not.toHaveProperty('cache_control')
 expect(output.messages[2].content[0]).not.toHaveProperty('cache_control')
 expect(output.tools[0]).not.toHaveProperty('cache_control')
 expect(output.messages[2].content[0].text).toBe('hello')
 expect(body.tools[0].cache_control.ttl).toBe('1h')
})
it('does not put a cache breakpoint on trailing thinking content',async()=>{
 const settings={...normalizeProviderForwardingSettings({}),rewrite_message_cache_control:true,enable_claude_oauth_system_prompt_injection:false}
 const body={messages:[{role:'user',content:'Question'},{role:'assistant',content:[{type:'thinking',thinking:'reasoning',signature:'signed'}]}]}
 const output=await applyProviderBodySettings(settings,'anthropic','oauth',body) as any
 expect(output.messages).toEqual(body.messages)
})

it('preserves existing Claude Code message breakpoints when rewrite is enabled',async()=>{
 const settings={...normalizeProviderForwardingSettings({}),rewrite_message_cache_control:true}
 const body={system:[{type:'text',text:CLAUDE_SYSTEM_PROMPT,cache_control:{type:'ephemeral',ttl:'1h'}}],messages:[{role:'user',content:[{type:'text',text:'Client-controlled prefix',cache_control:{type:'ephemeral',ttl:'1h'}}]}]}
 expect(await applyProviderBodySettings(settings,'anthropic','oauth',body)).toEqual(body)
})
