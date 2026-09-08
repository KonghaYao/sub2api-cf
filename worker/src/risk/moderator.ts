import type { Env } from '../env'
import { accountFetcher } from '../proxy/account-fetch'
import { sha256Hex } from '../gateway/crypto'
import { decodeRiskSecret, keyStatus, newRiskKey, riskKeys, type KeyRow, type RiskConfig } from './config'
export type ModerationContent={text:string;images:string[]}
export type ModerationResult={flagged:boolean;highest_category:string;highest_score:number;category_scores:Record<string,number>;error:string;latency_ms:number;matched_keyword?:string;action?:string}
export function extractModerationContent(body:Record<string,unknown>):ModerationContent{
 const text:string[]=[],images:string[]=[]
 const visit=(value:unknown,depth=0)=>{if(depth>12)return;if(typeof value==='string'){if(!value.trim().startsWith('<system-reminder>'))text.push(value);return}if(Array.isArray(value)){for(const item of value.slice(0,100))visit(item,depth+1);return}if(!value||typeof value!=='object')return;const item=value as Record<string,any>;if(['tool_use','tool_result','function_call','function_call_output'].includes(item.type))return;if(['image_url','input_image','image'].includes(item.type)){const image=item.image_url?.url??item.image_url??item.source?.url??(item.source?.type==='base64'?`data:${item.source.media_type};base64,${item.source.data}`:null);if(typeof image==='string'&&images.length===0)images.push(image);return}if(item.inlineData?.data&&images.length===0){images.push(`data:${item.inlineData.mimeType};base64,${item.inlineData.data}`);return}if(typeof item.text==='string')text.push(item.text);if(item.content!==undefined)visit(item.content,depth+1);if(item.parts!==undefined)visit(item.parts,depth+1)}
 if(typeof body.input==='string')visit(body.input)
 else if(Array.isArray(body.input)){const last=body.input.at(-1) as Record<string,unknown>|undefined;if(last&&(last.role==='user'||last.type==='input_text'||last.role===undefined&&last.type==='message'))visit(last)}
 else if(Array.isArray(body.messages)){const last=body.messages.at(-1) as Record<string,unknown>|undefined;if(last?.role==='user')visit(last.content)}
 else if(Array.isArray(body.contents)){const last=body.contents.at(-1) as Record<string,unknown>|undefined;if(last?.role==='user'||last?.role===undefined)visit(last)}
 else if(typeof body.prompt==='string')visit(body.prompt)
 return {text:[...text.join('\n').trim()].slice(0,12000).join(''),images:images.filter(image=>image.length<=12*1024*1024&&(/^https:\/\//.test(image)||/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image))).slice(0,1)}
}
export async function moderationHash(content:ModerationContent){return sha256Hex(JSON.stringify(content))}
export function evaluateScores(scores:Record<string,number>,config:RiskConfig):ModerationResult{let highest_category='',highest_score=0,flagged=false;for(const [name,score]of Object.entries(scores)){if(typeof score!=='number'||!Number.isFinite(score)||score<0||score>1)throw new Error('moderation_invalid_response');if(score>highest_score||!highest_category){highest_category=name;highest_score=score}if(name in config.thresholds&&score>=(config.thresholds as Record<string,number>)[name])flagged=true}if(!Object.keys(scores).length)throw new Error('moderation_invalid_response');return {flagged,highest_category,highest_score,category_scores:scores,error:'',latency_ms:0}}
async function readJSON(response:Response){const reader=response.body?.getReader();if(!reader)throw new Error('moderation_empty_response');let bytes=0,text='';const decoder=new TextDecoder();try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>262144)throw new Error('moderation_response_too_large');text+=decoder.decode(chunk.value,{stream:true})}return JSON.parse(text+decoder.decode())}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock()}}
export async function callModeration(env:Env,config:RiskConfig,content:ModerationContent,options:{signal?:AbortSignal;keys?:KeyRow[];test?:boolean;request_id?:string}={}):Promise<{result:ModerationResult;statuses:ReturnType<typeof keyStatus>[]} >{
 const keys=options.keys??await riskKeys(env),available=keys.filter(k=>options.test||k.frozen_until_ms<=Date.now()),statuses:ReturnType<typeof keyStatus>[]=[]
 if(!available.length)return {result:{flagged:false,highest_category:'',highest_score:0,category_scores:{},error:'moderation_key_unavailable',latency_ms:0},statuses}
 const controller=new AbortController(),abort=()=>controller.abort(options.signal?.reason);options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort()
 const timer=setTimeout(()=>controller.abort(),config.timeout_ms),started=Date.now();let lastError='moderation_failed'
 try{for(let attempt=0;attempt<=config.retry_count&&!controller.signal.aborted;attempt++){
  const key=available.find(candidate=>candidate.frozen_until_ms<=Date.now()||options.test);if(!key)break;const start=Date.now();let status=0,error='',result:ModerationResult|null=null
  if(options.request_id)await env.DB.prepare("UPDATE risk_jobs SET api_key_hash=? WHERE request_id=? AND status='processing'").bind(key.key_hash,options.request_id).run()
  try{
   const credential=await decodeRiskSecret<{key:string}>(env,key,'risk-key:'+key.key_hash),url=config.base_url.replace(/\/v1\/?$/,'').replace(/\/$/,'')+'/v1/moderations'
   const input=content.images.length?[...(content.text?[{type:'text',text:content.text}]:[]),...content.images.map(url=>({type:'image_url',image_url:{url}}))]:content.text
   const response=await accountFetcher(env,config.proxy_id)(url,{method:'POST',headers:{authorization:'Bearer '+credential.key,'content-type':'application/json'},body:JSON.stringify({model:config.model,input}),signal:controller.signal,redirect:'manual'});status=response.status
   if(!response.ok){await response.body?.cancel();throw new Error('moderation_http_'+status)}
   const payload=await readJSON(response),scores=payload?.results?.[0]?.category_scores;if(!scores||typeof scores!=='object'||Array.isArray(scores))throw new Error('moderation_invalid_response');result=evaluateScores(scores,config)
  }catch(cause){error=controller.signal.aborted?'moderation_timeout':cause instanceof Error&&/^moderation_[a-z_0-9]+$/.test(cause.message)?cause.message:'moderation_transport_failed';lastError=error}
  const latency=Date.now()-start,freeze=error?(status===401||status===403?600000:status===429?60000:10000):0,now=Date.now()
  const updated={...key,status:error?'error':'ok',failure_count:key.failure_count+(error?1:0),success_count:key.success_count+(error?0:1),last_error:error,last_checked_at_ms:now,frozen_until_ms:freeze?now+freeze:0,last_latency_ms:latency,last_http_status:status,last_tested:options.test?1:0}
  await env.DB.prepare('UPDATE risk_api_keys SET status=?,failure_count=failure_count+?,success_count=success_count+?,last_error=?,last_checked_at_ms=?,frozen_until_ms=?,last_latency_ms=?,last_http_status=?,last_tested=?,total=total+1,total_latency_ms=total_latency_ms+? WHERE key_hash=?').bind(updated.status,error?1:0,error?0:1,error,now,updated.frozen_until_ms,latency,status,updated.last_tested,latency,key.key_hash).run()
  statuses.push(keyStatus(updated,keys.indexOf(key)))
  Object.assign(key,updated)
  if(result)return {result:{...result,latency_ms:Date.now()-started},statuses}
 }}finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort)}
 return {result:{flagged:false,highest_category:'',highest_score:0,category_scores:{},error:lastError,latency_ms:Date.now()-started},statuses}
}
export async function transientTestKey(env:Env,raw:string):Promise<KeyRow>{return {...await newRiskKey(env,raw),status:'unknown',failure_count:0,success_count:0,last_error:'',last_checked_at_ms:0,frozen_until_ms:0,last_latency_ms:0,last_http_status:0,last_tested:0,active:0,total:0,total_latency_ms:0}}
