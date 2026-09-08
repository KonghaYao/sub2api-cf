import type { Env } from '../env'
import type { securityDefaults } from '../control/gateway-security-settings'
import { sha256Hex } from './crypto'
import { GatewayError } from './errors'

type Settings=typeof securityDefaults
export type CyberRequest={user_id:string;api_key_id:string;request_id:string;model:string;headers:Headers;body:Record<string,unknown>}
const headers=['session_id','x-session-id','conversation_id','x-conversation-id','x-codex-session-id','x-opencode-session-id','x-codebuddy-conversation-id']
/** Hash stable conversation contents, never store prompts, session IDs or credentials. */
async function sessionKeys(request:CyberRequest):Promise<string[]>{
 const raw:string[]=[]
 const explicit=headers.map(header=>request.headers.get(header)?.trim()).find(Boolean)??request.body.prompt_cache_key
 if(typeof explicit==='string'&&explicit.trim())raw.push('session:'+explicit.trim())
 const transcript=request.body.input??request.body.messages
 if(typeof transcript==='string')raw.push('transcript:'+await sha256Hex('root\0'+JSON.stringify({role:'user',content:transcript})))
 else if(Array.isArray(transcript)){
  if(transcript.length>256)throw new GatewayError(400,'session_transcript_too_large','Session policy supports at most 256 conversation items; start a new session')
  let chain='root',count=0
  for(const item of transcript){
   if(!item||typeof item!=='object')continue
   const value=item as Record<string,unknown>
   chain=await sha256Hex(chain+'\0'+JSON.stringify({role:value.role??value.type,content:value.content??value.output??value.arguments??'',...(value.call_id?{call_id:value.call_id}:{})}));count++
   // Exact prefixes identify retries and continuations without conflating unrelated conversations.
   if(value.role==='user'||value.type==='function_call_output')raw.push('transcript:'+chain)
  }
  if(count&&raw.length===0)raw.push('transcript:'+chain)
 }
 return Promise.all(raw.map(key=>sha256Hex(`cyber:v1:${request.api_key_id}:${key}`)))
}
export async function enforceCyberSession(env:Env,settings:Settings,request:CyberRequest):Promise<void>{
 if(!settings.cyber_session_block_enabled)return
 const keys=await sessionKeys(request)
 if(!keys.length)return
 const row=await env.DB.prepare(`SELECT key_hash FROM gateway_cyber_sessions WHERE key_hash IN(SELECT value FROM json_each(?)) AND expires_at_ms>? LIMIT 1`).bind(JSON.stringify(keys),Date.now()).first()
 if(row)throw new GatewayError(403,'session_blocked_by_cyber_policy','This session is blocked by cyber-security policy; start a new session','permission_error')
}
export async function recordCyberPolicy(env:Env,settings:Settings,request:CyberRequest):Promise<void>{
 const statements:D1PreparedStatement[]=[]
 if(settings.risk_control_enabled)statements.push(env.DB.prepare("INSERT INTO gateway_risk_events(request_id,user_id,api_key_id,model,code,created_at_ms) VALUES(?,?,?,?,'cyber_policy',?) ON CONFLICT(request_id) DO NOTHING").bind(request.request_id,request.user_id,request.api_key_id,request.model,Date.now()))
 if(settings.cyber_session_block_enabled){
  const keys=await sessionKeys(request)
  // Write the explicit session and final transcript only. Older successful prefixes must remain usable.
  const explicit=headers.some(header=>request.headers.get(header)?.trim())||typeof request.body.prompt_cache_key==='string'&&!!request.body.prompt_cache_key.trim()
  const selected=[...new Set([...(explicit&&keys.length?[keys[0]]:[]),...(keys.length?[keys[keys.length-1]]:[])])]
  if(selected.length)statements.push(env.DB.prepare(`INSERT INTO gateway_cyber_sessions(key_hash,expires_at_ms,request_id) VALUES ${selected.map(()=>'(?,?,?)').join(',')} ON CONFLICT(key_hash) DO UPDATE SET expires_at_ms=MAX(gateway_cyber_sessions.expires_at_ms,excluded.expires_at_ms),request_id=excluded.request_id`).bind(...selected.flatMap(key=>[key,Date.now()+settings.cyber_session_block_ttl_seconds*1000,request.request_id])))
 }
 if(statements.length)await env.DB.batch(statements)
}
function cyber(value:unknown):boolean{
 if(!value||typeof value!=='object')return false
 const object=value as Record<string,unknown>
 const readCode=(error:unknown)=>error&&typeof error==='object'?String((error as Record<string,unknown>).code??'').trim().toLowerCase():''
 return (readCode(object.error)||readCode((object.response as Record<string,unknown>|undefined)?.error))==='cyber_policy'
}
/** Observe the exact upstream bytes under backpressure, including errors after visible SSE output. */
export function observeCyberResponse(env:Env,settings:Settings,request:CyberRequest,response:Response):Response{
 if((!settings.cyber_session_block_enabled&&!settings.risk_control_enabled)||!response.body)return response
 const sse=(response.headers.get('content-type')??'').includes('text/event-stream')
 if(!sse&&!(response.headers.get('content-type')??'').includes('json'))return response
 let buffered='',discard=false,recorded=false,lineLength=0,skipLF=false,eventLength=0
 let data:string[]=[]
 const decoder=new TextDecoder()
 const check=async(text:string)=>{
  if(recorded)return
  let parsed:unknown;try{parsed=JSON.parse(text)}catch{return}
  if(cyber(parsed)){await recordCyberPolicy(env,settings,request);recorded=true}
 }
 const finishLine=async()=>{
  if(lineLength===0){
   if(!discard&&data.length)await check(data.join('\n'))
   data=[];eventLength=0;discard=false
  }else if(!discard&&buffered.startsWith('data:')){
   const value=buffered.slice(5).replace(/^ /,'')
   eventLength+=value.length+1
   if(eventLength>262144){discard=true;data=[]}else data.push(value)
  }
  buffered='';lineLength=0
 }
 const consume=async(text:string)=>{
  if(!sse){if(!discard){buffered+=text;if(buffered.length>262144){buffered='';discard=true}}return}
  for(const char of text){
   if(recorded)break
   if(char==='\n'&&skipLF){skipLF=false;continue}
   skipLF=false
   if(char==='\r'||char==='\n'){await finishLine();skipLF=char==='\r';continue}
   lineLength++
   if(!discard){if(lineLength>262144){discard=true;buffered='';data=[]}else buffered+=char}
  }
 }
 const transform=new TransformStream<Uint8Array,Uint8Array>({
  async transform(chunk,controller){
   if(!recorded)await consume(decoder.decode(chunk,{stream:true}))
   controller.enqueue(chunk)
  },
  async flush(){
   if(recorded)return
   await consume(decoder.decode())
   if(sse){if(lineLength>0)await finishLine();if(!discard&&data.length)await check(data.join('\n'))}
   else if(!discard)await check(buffered)
  }
 })
 return new Response(response.body.pipeThrough(transform),{status:response.status,statusText:response.statusText,headers:response.headers})
}
export async function cleanupCyberSessions(env:Env){await env.DB.prepare('DELETE FROM gateway_cyber_sessions WHERE key_hash IN(SELECT key_hash FROM gateway_cyber_sessions WHERE expires_at_ms<? LIMIT 100)').bind(Date.now()).run()}
