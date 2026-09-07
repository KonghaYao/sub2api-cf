/** Measures the first generated SSE token, excluding keepalives, role and usage frames. */
export class FirstTokenTimer {
 private buffer=''
 private decoder=new TextDecoder()
 firstTokenMs:number|null=null
 responseId:string|null=null
 constructor(private readonly startedAt:number,private readonly mode?:string){}
 push(chunk:Uint8Array,now=Date.now()):void {
  this.buffer+=this.decoder.decode(chunk,{stream:true})
  // Stream validation owns oversized frames; telemetry never buffers unbounded input.
  if(this.buffer.length>1048576){this.buffer='';return}
  const frames=this.buffer.split(/\r?\n\r?\n/);this.buffer=frames.pop()??''
  for(const frame of frames){
   const data=frame.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n')
   if(!data || data==='[DONE]')continue
   try {
    const value=JSON.parse(data)
    if(value.type==='response.completed' && typeof value.response?.id==='string' && value.response.id.length<=256)this.responseId=value.response.id
    if(this.firstTokenMs===null && (this.mode==='semantic'?semanticToken(value):generatedToken(value)))this.firstTokenMs=Math.max(0,now-this.startedAt)
   } catch { /* Protocol validation belongs to the existing stream transformer. */ }
  }
 }
}
function semanticToken(value:any):boolean {
 if(!value||typeof value!=='object'||value.error||['response.failed','error','response.created','response.in_progress','keepalive'].includes(value.type))return false
 if(typeof value.type==='string'&&value.type.startsWith('response.'))return true
 return generatedToken(value)
}
function generatedToken(value:any):boolean {
 if(!value||typeof value!=='object'||value.error)return false
 if(Array.isArray(value.choices) && value.choices.some((c:any)=>c.delta && [c.delta.content,c.delta.reasoning_content,c.delta.tool_calls?.[0]?.function?.arguments].some(s=>typeof s==='string'&&s.length>0)))return true
 if(value.type==='content_block_delta' && [value.delta?.text,value.delta?.thinking,value.delta?.partial_json].some(s=>typeof s==='string'&&s.length>0))return true
 if(['response.output_text.delta','response.reasoning_text.delta','response.reasoning_summary_text.delta','response.function_call_arguments.delta'].includes(value.type) && typeof value.delta==='string' && value.delta.length>0)return true
 if(value.type==='response.image_generation_call.partial_image' && value.partial_image_b64)return true
 if(value.type==='response.output_item.done' && value.item?.type==='image_generation_call' && value.item.result)return true
 if(value.type==='response.completed' && Array.isArray(value.response?.output))return value.response.output.some((item:any)=>item?.content?.some((c:any)=>c?.type==='output_text'&&typeof c.text==='string'&&c.text.length>0)||item?.type==='image_generation_call'&&item.result)
 return Array.isArray(value.candidates)&&value.candidates.some((c:any)=>c.content?.parts?.some((p:any)=>typeof p.text==='string'&&p.text.length>0))
}

/** Moving a continuation requires explicit assistant context and complete tool-call coverage. */
export function canMovePreviousResponse(body:unknown):boolean {
 if(!body||typeof body!=='object'||!Array.isArray((body as any).input))return false
 const input=(body as any).input as any[]
 const calls=new Set(input.filter(i=>i?.type==='function_call'&&typeof i.call_id==='string').map(i=>i.call_id))
 return input.some(i=>i?.role==='assistant'||i?.type==='function_call') && input.filter(i=>i?.type==='function_call_output').every(i=>typeof i.call_id==='string'&&calls.has(i.call_id))
}

export interface UpstreamQuotaSnapshot { headroom: number; reset_at_ms: number; observed_at_ms:number }
/** Read real provider rate-limit windows; never infer a quota from customer balance. */
export function upstreamQuotaSnapshot(headers:Headers,now=Date.now()):UpstreamQuotaSnapshot|null {
 const windows:Array<{headroom:number;reset_at_ms:number}>=[]
 for(const dimension of ['tokens','requests']){
  const limitRaw=headers.get(`x-ratelimit-limit-${dimension}`),remainingRaw=headers.get(`x-ratelimit-remaining-${dimension}`),reset=headers.get(`x-ratelimit-reset-${dimension}`)
  if(limitRaw===null||remainingRaw===null||reset===null||!/^\d+$/.test(limitRaw)||!/^\d+$/.test(remainingRaw))continue
  const limit=Number(limitRaw),remaining=Number(remainingRaw)
  if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(remaining)||limit<=0||remaining>limit)continue
  let resetAt:number
  if(/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(reset)){
   const scales:Record<string,number>={ms:1,s:1000,m:60000,h:3600000,d:86400000}
   resetAt=now+[...reset.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)].reduce((sum,m)=>sum+Number(m[1])*scales[m[2]!]!,0)
  } else if(/^\d+(?:\.\d+)?$/.test(reset)) {
   const n=Number(reset);resetAt=n>1000000000?n*1000:now+n*1000
  } else resetAt=Date.parse(reset)
  if(!Number.isSafeInteger(resetAt)||resetAt<=now||resetAt-now>8*3600000)continue
  windows.push({headroom:remaining/limit,reset_at_ms:resetAt})
 }
 if(windows.length===0)return null
 const tightest=windows.sort((a,b)=>a.headroom-b.headroom)[0]!
 return {...tightest,observed_at_ms:now}
}
