import { env, exports } from 'cloudflare:workers'
import { expect, it } from 'vitest'

it.each([false,true])('preserves Responses-shaped Chat bodies and returns Chat output (stream=%s)',async stream=>{
 const model='shape-'+crypto.randomUUID()
 const bootstrap=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/bootstrap',{method:'POST',headers:{authorization:'Bearer '+env.ADMIN_TOKEN,'content-type':'application/json'},body:JSON.stringify({user:{email:crypto.randomUUID()+'@shape.test',balance_micros:1000000},group:{name:crypto.randomUUID()},account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'fixture'},api_key:{name:'shape'},models:[{public_name:model,upstream_name:'cursor-shape-probe',endpoint:'responses',input_micros_per_million:1000000,output_micros_per_million:2000000,minimum_reservation_micros:100}]})}))
 expect(bootstrap.status).toBe(201)
 const f=(await bootstrap.json() as any).data
 const input=[{role:'user',content:[{type:'input_text',text:'Patch the file'}]},{type:'custom_tool_call',call_id:'call-patch',name:'patch',input:'*** Begin Patch'},{type:'custom_tool_call_output',call_id:'call-patch',output:'done'}]
 const tools=[{type:'custom',name:'patch',format:{type:'text'}}]
 const response=await exports.default.fetch(new Request('https://worker.e2e.invalid/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+f.api_key,'content-type':'application/json'},body:JSON.stringify({model,input,tools,stream,store:false,max_output_tokens:256,service_tier:'fast',prompt_cache_key:'cursor-session',metadata:{source:'cursor'},prompt_cache_retention:'24h',safety_identifier:'client',stream_options:{include_usage:true}})}))
 expect(response.status).toBe(200)
 let content=''
 if(stream){
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const events=(await response.text()).split('\n\n').filter(Boolean).map(frame=>frame.slice(6))
  expect(events.at(-1)).toBe('[DONE]')
  for(const data of events.filter(data=>data!=='[DONE]')){const chunk=JSON.parse(data);expect(chunk.object).toBe('chat.completion.chunk');content+=chunk.choices[0]?.delta?.content??''}
 }else {const chat=await response.json() as any;expect(chat.object).toBe('chat.completion');content=chat.choices[0].message.content}
 const actual=JSON.parse(content)
 expect(actual.body).toMatchObject({model:'cursor-shape-probe',input,tools,stream,store:false,max_output_tokens:256,service_tier:'priority',prompt_cache_key:'cursor-session'})
 for(const field of ['messages','metadata','prompt_cache_retention','safety_identifier','stream_options','max_completion_tokens'])expect(actual.body).not.toHaveProperty(field)
 expect(actual.session).toMatch(/^[a-f0-9-]{36}$/)
 const state=await(await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
 expect(state.profile.reserved_micros).toBe(0)
 expect(state.ledger.filter((row:any)=>row.amount_delta_micros<0)).toHaveLength(1)
})
