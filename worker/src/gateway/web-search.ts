import type { Env } from '../env'
import { searchWeb } from '../control/web-search'

export async function emulateWebSearch(env:Env,accountId:string,groupId:string,platform:string,body:unknown,signal:AbortSignal):Promise<Response|null> {
 if(platform!=='anthropic'||!body||typeof body!=='object')return null
 const request=body as Record<string,unknown>
 if(!Array.isArray(request.tools)||request.tools.length!==1)return null
 const tool=request.tools[0]
 if(!tool||typeof tool!=='object'||!(String(tool.type??'').startsWith('web_search')||tool.type==='google_search'||tool.name==='web_search'||tool.name==='google_search'))return null
 const settings=await env.DB.prepare("SELECT enabled FROM web_search_settings WHERE id='global'").first<{enabled:number}>()
 if(!settings?.enabled)return null
 const policy=await env.DB.prepare(`SELECT json_extract(a.ui_config_json,'$.extra.web_search_emulation') AS mode,
 EXISTS(SELECT 1 FROM channel_groups cg JOIN channels c ON c.id=cg.channel_id WHERE cg.group_id=? AND c.status='active' AND json_extract(c.features_config_json,'$.web_search_emulation.anthropic')=1) AS channel_enabled
 FROM accounts a WHERE a.id=?`).bind(groupId,accountId).first<{mode:string|number|null;channel_enabled:number}>()
 if(!policy||policy.mode==='disabled'||!((policy.mode==='enabled'||policy.mode===1)||policy.channel_enabled===1))return null
 const messages=Array.isArray(request.messages)?request.messages:[]
 const latest=[...messages].reverse().find(m=>m?.role==='user')
 const query=typeof latest?.content==='string'?latest.content:Array.isArray(latest?.content)?latest.content.filter((b:Record<string,unknown>)=>b.type==='text').map((b:Record<string,unknown>)=>b.text).join('\n'):''
 const result=await searchWeb(env,query,signal)
 const id=`msg_ws_${crypto.randomUUID()}`,toolId=`srvtoolu_ws_${crypto.randomUUID()}`
 const content=[{type:'server_tool_use',id:toolId,name:'web_search',input:{query:result.query}},
 {type:'web_search_tool_result',tool_use_id:toolId,content:result.results.map(item=>({type:'web_search_result',url:item.url,title:item.title,page_content:item.snippet,...(item.page_age?{page_age:item.page_age}:{})}))},
 {type:'text',text:result.results.length?result.results.map(item=>`${item.title}\n${item.url}\n${item.snippet}`).join('\n\n'):`No search results found for: ${result.query}`}]
 // Search providers supply no model token usage. Do not bill fabricated model tokens.
 const usage={input_tokens:0,output_tokens:0}
 if(!request.stream)return Response.json({id,type:'message',role:'assistant',model:request.model,content,stop_reason:'end_turn',stop_sequence:null,usage})
 const events:Array<Record<string,unknown>>=[{type:'message_start',message:{id,type:'message',role:'assistant',model:request.model,content:[],stop_reason:null,stop_sequence:null,usage}}]
 for(let index=0;index<content.length;index++) {
  const block=content[index]!
  if(block.type==='text') {
   events.push({type:'content_block_start',index,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index,delta:{type:'text_delta',text:block.text}})
  } else if(block.type==='server_tool_use') {
   events.push({type:'content_block_start',index,content_block:{...block,input:{}}},
    {type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}})
  } else events.push({type:'content_block_start',index,content_block:block})
  events.push({type:'content_block_stop',index})
 }
 events.push({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:0}},{type:'message_stop'})
 return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream','cache-control':'no-cache'}})
}
