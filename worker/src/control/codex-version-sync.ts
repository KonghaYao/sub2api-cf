import type {Env} from '../env'
import {loadGatewaySettings} from './gateway-settings'
const INTERVAL=6*3600000,NAME='codex-version-sync'
async function release(url:string,signal:AbortSignal):Promise<unknown>{
 const response=await fetch(url,{headers:{accept:'application/vnd.github+json','user-agent':'Sub2API-Codex-Version-Sync','x-github-api-version':'2022-11-28'},redirect:'error',signal})
 if(!response.ok){void response.body?.cancel();throw new Error('codex_release_unavailable')}
 const reader=response.body?.getReader();let size=0,text='';const decoder=new TextDecoder()
 try{if(reader)while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>1048576)throw new Error('codex_release_too_large');text+=decoder.decode(next.value,{stream:true})}text+=decoder.decode();return JSON.parse(text)}finally{void reader?.cancel().catch(()=>undefined)}
}
function stable(value:unknown):string|null {const row=value as {tag_name?:unknown;draft?:unknown;prerelease?:unknown};return row&&row.draft===false&&row.prerelease===false&&typeof row.tag_name==='string'&&/^rust-v\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(row.tag_name)?row.tag_name.slice(6):null}
function newer(a:string,b:string):number {const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]!-y[i]!;return 0}
/** Root schedules this in an isolated maintenance message. Only stable releases in openai/codex are trusted. */
export async function runCodexVersionSync(env:Env):Promise<{checked:boolean;version?:string;error?:string}>{
 const settings=await loadGatewaySettings(env);if(!settings.openai_codex_version_auto_sync_enabled)return {checked:false}
 const now=Date.now(),claimed=await env.DB.prepare('INSERT INTO runtime_settings(name,value_json,updated_at_ms) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET updated_at_ms=excluded.updated_at_ms WHERE runtime_settings.updated_at_ms<=? RETURNING name').bind(NAME,'{}',now,now-INTERVAL).first()
 if(!claimed)return {checked:false}
 const signal=AbortSignal.timeout(10000)
 try{
  let version:string|null=null
  try{version=stable(await release('https://api.github.com/repos/openai/codex/releases/latest',signal))}catch{if(signal.aborted)throw new Error('codex_release_timeout')}
  if(!version){const recent=await release('https://api.github.com/repos/openai/codex/releases?per_page=30',signal);if(Array.isArray(recent))version=recent.map(stable).filter((v):v is string=>v!==null).sort((a,b)=>newer(b,a))[0]??null}
  if(!version)throw new Error('codex_stable_release_not_found')
  // CAS on the synchronized value preserves administrator edits and avoids overwriting a concurrent newer sync.
  const result=await env.DB.prepare("UPDATE system_settings SET gateway_json=json_set(gateway_json,'$.openai_codex_client_version_synced',?),control_version=control_version+1,updated_at_ms=? WHERE id='global' AND COALESCE(json_extract(gateway_json,'$.openai_codex_version_auto_sync_enabled'),1)=1 AND COALESCE(json_extract(gateway_json,'$.openai_codex_client_version_synced'),'')=?").bind(version,now,settings.openai_codex_client_version_synced).run()
  return result.meta.changes?{checked:true,version}:{checked:true,error:'configuration_changed'}
 }catch(error){
  await env.DB.prepare('UPDATE runtime_settings SET updated_at_ms=? WHERE name=? AND updated_at_ms=?').bind(now-INTERVAL+15*60000,NAME,now).run()
  return {checked:true,error:signal.aborted?'codex_release_timeout':error instanceof Error&&error.message.startsWith('codex_')?error.message:'codex_release_unavailable'}
 }
}
