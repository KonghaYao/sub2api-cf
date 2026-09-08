import { describe, expect, it } from 'vitest'
import { normalizeGatewaySettings } from '../../src/control/gateway-settings'
import { enforceCodexCLIOnly } from '../../src/control/codex-cli-policy'
const account={platform:'codex',credential_kind:'oauth',codex_cli_only:1,codex_cli_only_allow_app_server:0}
const headers=(ua='codex_cli_rs/0.100.0',originator='codex_cli_rs',extra:Record<string,string>={})=>new Headers({'user-agent':ua,originator,...extra})
describe('Codex CLI-only original inbound policy',()=>{
 it('persists strict settings and rejects unsafe whitelist or invalid signal documents',()=>{
  expect(normalizeGatewaySettings({codex_cli_only_blacklist:'[{"originator":"evil"}]'}).codex_cli_only_blacklist).toContain('evil')
  for(const patch of [{codex_cli_only_whitelist:'[{"originator":"evil"}]'},{codex_cli_only_engine_fingerprint_signals:'[{"type":"unknown","match":["x"],"required":true}]'},{codex_cli_only_allow_app_server_clients:'true'}])expect(()=>normalizeGatewaySettings(patch)).toThrow()
 })
 it('requires original official identity, a detectable version and default engine fingerprint',()=>{
  const settings=normalizeGatewaySettings({})
  expect(()=>enforceCodexCLIOnly(settings,account,headers(),{})).toThrow()
  expect(()=>enforceCodexCLIOnly(settings,account,headers('browser codex_cli_rs/0.100.0','evil',{'x-codex-window-id':'x'}),{})).toThrow()
  expect(()=>enforceCodexCLIOnly(settings,account,headers('codex_cli_rs/unknown','codex_cli_rs',{'x-codex-window-id':'x'}),{})).toThrow()
  expect(()=>enforceCodexCLIOnly(settings,account,headers(undefined,undefined,{'x-codex-window-id':'x'}),{})).not.toThrow()
 })
 it('applies blacklist OR before whitelist AND and never gates non-oauth or unrestricted accounts',()=>{
  const settings=normalizeGatewaySettings({codex_cli_only_blacklist:'[{"originator":"bad","ua_contains":["blocked"]}]',codex_cli_only_whitelist:'[{"originator":"tool","ua_contains":["tool/","integration"],"skip_engine_fingerprint":true}]'})
  expect(()=>enforceCodexCLIOnly(settings,account,headers('tool/1 integration','tool'),{})).not.toThrow()
  expect(()=>enforceCodexCLIOnly(settings,account,headers('tool/1','tool'),{})).toThrow()
  expect(()=>enforceCodexCLIOnly(settings,account,headers('tool/1 integration blocked','tool'),{})).toThrow()
  expect(()=>enforceCodexCLIOnly(settings,{...account,codex_cli_only:0},headers('blocked','bad'),{})).not.toThrow()
  expect(()=>enforceCodexCLIOnly(settings,{...account,credential_kind:'api_key'},headers('blocked','bad'),{})).not.toThrow()
 })
 it('keeps app-server candidates behind all required fingerprint rows and allows any variant within a row',()=>{
  const settings=normalizeGatewaySettings({codex_cli_only_allow_app_server_clients:true,codex_cli_only_engine_fingerprint_signals:JSON.stringify([{type:'header_exact',match:['session-id','session_id'],required:true},{type:'body_path',match:['client_metadata.window','client_metadata.installation'],required:true}])})
  expect(()=>enforceCodexCLIOnly(settings,account,headers('thirdparty/1','thirdparty',{'session_id':'ok'}),{client_metadata:{installation:null}})).not.toThrow()
  expect(()=>enforceCodexCLIOnly(settings,account,headers('thirdparty/1','thirdparty',{'session_id':'ok'}),{})).toThrow()
  expect(()=>enforceCodexCLIOnly(settings,account,headers('thirdparty/1','thirdparty'),{client_metadata:{window:'x'}})).toThrow()
  expect(()=>enforceCodexCLIOnly(normalizeGatewaySettings({codex_cli_only_engine_fingerprint_signals:'[]'}),{...account,codex_cli_only_allow_app_server:1},headers('thirdparty/1','thirdparty'),{})).not.toThrow()
 })
})
