import {describe,it,expect} from 'vitest'
import {grokDefaults,grokBaseURLs,grokBaseURL,parseGrokSettings,resolveGrokModel} from '../../src/control/grok-settings'
describe('original Grok settings contract',()=>{
 it('resolves all official modes and preserves explicitly pinned URLs',()=>{
  for(const [mode,url] of Object.entries(grokBaseURLs)) {
   const settings={...grokDefaults,grok_default_base_url_mode:mode}
   expect(grokBaseURL(settings)).toBe(url)
   expect(grokBaseURL(settings,'https://custom.example/v1')).toBe('https://custom.example/v1')
  }
 })
 it('uses the configured text fallback for aliases and optional cross-client mappings',()=>{
  const settings={...grokDefaults,grok_default_text_model:'grok-4.5'}
  for(const alias of ['', 'grok', 'xai/grok-latest', 'gpt-5', 'codex-mini', 'o3-mini', 'claude-sonnet-4']) expect(resolveGrokModel(settings,alias)).toBe('grok-4.5')
  expect(resolveGrokModel(settings,'composer-2.5')).toBe('grok-composer-2.5-fast')
  expect(resolveGrokModel(settings,'x-ai/grok-4.20-reasoning')).toBe('grok-4.20-0309-reasoning')
  expect(resolveGrokModel({...settings,grok_cross_client_model_map_enabled:false},'gpt-5')).toBe('gpt-5')
  expect(resolveGrokModel(settings,'private-custom-model')).toBe('private-custom-model')
 })
 it('rejects unsupported modes, unknown fields and invalid model names',()=>{
  for(const value of [{grok_default_base_url_mode:'https://evil.example'},{grok_default_text_model:'grok\nInjected'},{grok_default_text_model:''},{grok_cross_client_model_map_enabled:'true'},{unknown:true}]) expect(()=>parseGrokSettings(value)).toThrow()
  expect(parseGrokSettings(grokDefaults)).toEqual(grokDefaults)
 })
})
