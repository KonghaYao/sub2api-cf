import { GatewayError } from '../gateway/errors'
interface ClientEntry { originator?: string; ua_contains?: string[]; skip_engine_fingerprint?: boolean }
interface Signal { type: 'header_exact'|'header_prefix'|'body_path'; match: string[]; required: boolean }
const seeds: Signal[] = [
  {type:'header_prefix',match:['x-codex-'],required:true},
  {type:'header_exact',match:['session-id','session_id'],required:false},
  {type:'header_exact',match:['thread-id','thread_id'],required:false},
  {type:'body_path',match:['client_metadata.x-codex-window-id','client_metadata.x-codex-installation-id'],required:false},
]
export const codexCLIOnlyDefaults = {
  codex_cli_only_blacklist:'', codex_cli_only_whitelist:'',
  codex_cli_only_allow_app_server_clients:false,
  codex_cli_only_engine_fingerprint_signals:JSON.stringify(seeds),
}
type Settings = typeof codexCLIOnlyDefaults & {min_codex_version?:string;max_codex_version?:string}
const clean=(value:string)=>value.trim().toLowerCase()
const invalid=(field:string)=>new GatewayError(400,'invalid_settings',`Invalid gateway setting: ${field}`)
function array(raw:unknown,field:string):Record<string,unknown>[] {
  if(typeof raw!=='string'||raw.length>65536)throw invalid(field)
  if(!raw.trim())return []
  let value:unknown;try{value=JSON.parse(raw)}catch{throw invalid(field)}
  if(!Array.isArray(value)||value.length>128||value.some(item=>!item||typeof item!=='object'||Array.isArray(item)))throw invalid(field)
  return value
}
export function parseCodexCLIOnlyPatch(patch:Record<string,unknown>):Partial<Settings> {
 const result:Record<string,unknown>={}
 for(const [field,value] of Object.entries(patch)){
  if(!(field in codexCLIOnlyDefaults))throw invalid(field)
  if(field==='codex_cli_only_allow_app_server_clients'){if(typeof value!=='boolean')throw invalid(field);result[field]=value;continue}
  const rows=array(value,field)
  for(const row of rows){
   if(field==='codex_cli_only_engine_fingerprint_signals'){
    if(Object.keys(row).some(k=>!['type','match','required'].includes(k))||!['header_exact','header_prefix','body_path'].includes(String(row.type))||typeof row.required!=='boolean'||!Array.isArray(row.match)||!row.match.length||row.match.length>64||row.match.some(m=>typeof m!=='string'||!m.trim()||m.length>512))throw invalid(field)
    // Worker supports deterministic object/array paths, never executable GJSON modifiers or queries.
    if(row.type==='body_path'&&row.match.some(m=>!/^[-\w]+(?:\.[-\w]+)*$/.test(String(m))))throw invalid(field)
    if(row.type!=='body_path'&&row.match.some(m=>! /^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(String(m))))throw invalid(field)
   }else{
    if(Object.keys(row).some(k=>!['originator','ua_contains','skip_engine_fingerprint'].includes(k))||(row.originator!==undefined&&(typeof row.originator!=='string'||row.originator.length>512))||(row.skip_engine_fingerprint!==undefined&&typeof row.skip_engine_fingerprint!=='boolean')||(row.ua_contains!==undefined&&(!Array.isArray(row.ua_contains)||row.ua_contains.length>64||row.ua_contains.some(m=>typeof m!=='string'||m.length>512))))throw invalid(field)
    if(field==='codex_cli_only_whitelist'&&(!(typeof row.originator==='string'&&row.originator.trim())||!Array.isArray(row.ua_contains)||!row.ua_contains.length||row.ua_contains.some(m=>!String(m).trim())))throw invalid(field)
   }
  }
  result[field]=typeof value==='string'?value.trim():value
 }
 return result
}
const officials=new Set(['codex_cli_rs','codex-tui','codex_vscode','codex_vscode_copilot','codex_app','codex_chatgpt_desktop','codex_atlas','codex_exec','codex_sdk_ts'])
const officialOrigin=(v:string)=>officials.has(v)||v.startsWith('codex ')
function bodyHas(body:unknown,path:string):boolean {let current=body;for(const key of path.split('.')){if(!current||typeof current!=='object'||!Object.prototype.hasOwnProperty.call(current,key))return false;current=(current as Record<string,unknown>)[key]}return true}
/** Client compatibility policy only: inspect untouched inbound evidence; never mint authentication headers. */
export function enforceCodexCLIOnly(settings:Settings,account:{platform:string;credential_kind:string;codex_cli_only?:number|boolean;codex_cli_only_allow_app_server?:number|boolean},headers:Headers,body:unknown):void {
 if(!['openai','codex'].includes(account.platform)||account.credential_kind!=='oauth'||!(account.codex_cli_only===1||account.codex_cli_only===true))return
 const deny=()=>{throw new GatewayError(403,'codex_cli_only','This account only allows Codex official clients')}
 const ua=clean(headers.get('user-agent')??''),origin=clean(headers.get('originator')??'')
 const blacklist=array(settings.codex_cli_only_blacklist,'codex_cli_only_blacklist') as ClientEntry[]
 if(blacklist.some(e=>(!!e.originator?.trim()&&clean(e.originator)===origin)||e.ua_contains?.some(m=>!!m.trim()&&ua.includes(clean(m)))))deny()
 const trailer=/\(([^()]*)\)[^()]*$/.exec(ua)?.[1].split(';')[0].trim()??''
 const official=[...officials].some(name=>ua.startsWith(name+'/'))||ua.startsWith('codex ')||officialOrigin(trailer)||officialOrigin(origin)
 let skip=false
 if(!official){
  const entry=(array(settings.codex_cli_only_whitelist,'codex_cli_only_whitelist') as ClientEntry[]).find(e=>!!e.originator?.trim()&&clean(e.originator)===origin&&!!e.ua_contains?.length&&e.ua_contains.every(m=>!!m.trim()&&ua.includes(clean(m))))
  if(entry)skip=entry.skip_engine_fingerprint===true
  else if(!settings.codex_cli_only_allow_app_server_clients&&account.codex_cli_only_allow_app_server!==1&&account.codex_cli_only_allow_app_server!==true)deny()
 }else{
  const version=/^[^/]+\/(\d+\.\d+\.\d+)/.exec(ua)?.[1];if(!version)deny()
  const cmp=(other:string)=>{const a=version!.split('.').map(Number),b=other.split('.').map(Number);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]-b[i];return 0}
  if((settings.min_codex_version&&cmp(settings.min_codex_version)<0)||(settings.max_codex_version&&cmp(settings.max_codex_version)>0))deny()
 }
 const signals=settings.codex_cli_only_engine_fingerprint_signals.trim()?array(settings.codex_cli_only_engine_fingerprint_signals,'codex_cli_only_engine_fingerprint_signals') as unknown as Signal[]:seeds
 if(!skip&&signals.some(signal=>signal.required&&!signal.match.some(match=>signal.type==='body_path'?bodyHas(body,match):signal.type==='header_exact'?!!headers.get(match)?.trim():[...headers.keys()].some(key=>key.startsWith(clean(match))))))deny()
}
