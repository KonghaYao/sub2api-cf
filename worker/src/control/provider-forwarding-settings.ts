import {GatewayError} from '../gateway/errors'
export const providerForwardingDefaults={
 enable_fingerprint_unification:true,
 enable_claude_oauth_system_prompt_injection:true,
 claude_oauth_system_prompt:'',claude_oauth_system_prompt_blocks:'',
 enable_client_dateline_normalization:true,
 openai_codex_user_agent:'',openai_codex_client_version:'',openai_codex_version_auto_sync_enabled:true,
 openai_codex_client_version_synced:'',openai_ttft_mode:'semantic',
}
export type ProviderForwardingSettings=typeof providerForwardingDefaults
export interface PromptBlock {enabled?:boolean;type?:'text';text:string;cache_control?:boolean|null|{type:'ephemeral';ttl?:'5m'|'1h'}}
function invalid(field:string):never{throw new GatewayError(400,'invalid_provider_forwarding','Invalid forwarding setting: '+field)}
export function promptBlocks(value:string):PromptBlock[]{
 if(!value.trim())return []
 let parsed:unknown;try{parsed=JSON.parse(value)}catch{invalid('claude_oauth_system_prompt_blocks')}
 if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.keys(parsed).every(k=>k==='blocks'))parsed=(parsed as {blocks:unknown}).blocks
 if(!Array.isArray(parsed)||parsed.length>20)invalid('claude_oauth_system_prompt_blocks')
 for(const block of parsed){
  if(!block||typeof block!=='object'||Object.keys(block).some(k=>!['enabled','type','text','cache_control'].includes(k))||typeof block.text!=='string'||block.text.length>32768||(block.type!==undefined&&block.type!=='text')||(block.enabled!==undefined&&typeof block.enabled!=='boolean'))invalid('claude_oauth_system_prompt_blocks')
  const cc=block.cache_control
  if(cc!==undefined&&cc!==null&&typeof cc!=='boolean'&&(!cc||typeof cc!=='object'||Array.isArray(cc)||cc.type!=='ephemeral'||Object.keys(cc).some(k=>!['type','ttl'].includes(k))||(cc.ttl!==undefined&&!['5m','1h'].includes(cc.ttl))))invalid('claude_oauth_system_prompt_blocks.cache_control')
 }
 return parsed
}
export function parseProviderForwardingSettings(value:unknown,allowReadonly=false):Partial<ProviderForwardingSettings>{
 if(!value||typeof value!=='object'||Array.isArray(value))invalid('object')
 const output:Record<string,unknown>={}
 for(const [key,item] of Object.entries(value)){
  if(!Object.hasOwn(providerForwardingDefaults,key))invalid(key)
  if(key.endsWith('_synced')&&!allowReadonly)invalid(key+' is read-only')
  if(typeof item!==typeof providerForwardingDefaults[key as keyof ProviderForwardingSettings])invalid(key)
  if(typeof item==='string'){
   if(item.length> (key.startsWith('claude_oauth_system_prompt')?65536:512)||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item))invalid(key)
   if(key==='claude_oauth_system_prompt_blocks')promptBlocks(item)
   if(key==='openai_ttft_mode'&&!['semantic','visible'].includes(item))invalid(key)
   if((key==='openai_codex_client_version'||key.endsWith('_synced'))&&item!==''&&!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(item))invalid(key)
   if(key==='openai_codex_user_agent'&&item!==''&&(!/^(?:codex_cli_rs|codex-tui|codex-desktop)\/\d+\.\d+\.\d+(?: |$)/.test(item)||/[\r\n]/.test(item)))invalid(key)
  }
  output[key]=item
 }
 return output
}
export function normalizeProviderForwardingSettings(value:unknown){return {...providerForwardingDefaults,...parseProviderForwardingSettings(value??{},true)}}
