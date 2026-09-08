import { env, exports } from 'cloudflare:workers'
import { expect, it } from 'vitest'

it.each(['responses','chat_completions'] as const)('preserves two parallel tool calls and reversed results over a %s round trip', async endpoint => {
 const publicModel='roundtrip-'+crypto.randomUUID(),wire=endpoint==='responses'?'chat_completions':'responses'
 const bootstrap=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/bootstrap',{method:'POST',headers:{authorization:'Bearer '+env.ADMIN_TOKEN,'content-type':'application/json'},body:JSON.stringify({user:{email:crypto.randomUUID()+'@roundtrip.test',balance_micros:1000000},group:{name:crypto.randomUUID()},account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'fixture-only'},api_key:{name:'roundtrip'},models:[{public_name:publicModel,upstream_name:'tool-roundtrip-upstream',endpoint:wire,input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100}]})}))
 expect(bootstrap.status).toBe(201)
 const f=(await bootstrap.json() as any).data
 const send=(body:any)=>exports.default.fetch(new Request('https://worker.e2e.invalid/v1/'+(endpoint==='responses'?'responses':'chat/completions'),{method:'POST',headers:{authorization:'Bearer '+f.api_key,'content-type':'application/json'},body:JSON.stringify({model:publicModel,...body})}))
 const tools=endpoint==='responses'?[{type:'function',name:'weather',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}]:[{type:'function',function:{name:'weather',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}}]
 const user={role:'user',content:'查上海和東京天气'}
 const first=await send({...(endpoint==='responses'?{input:[user]}:{messages:[user]}),tools,stream:false,max_output_tokens:128})
 expect(first.status,await first.clone().text()).toBe(200)
 const payload=await first.json() as any
 const calls=endpoint==='responses'?payload.output.filter((v:any)=>v.type==='function_call'):payload.choices[0].message.tool_calls
 expect(calls).toHaveLength(2)
 const outputs=[{call_id:'call-tokyo',output:'東京：雨'},{call_id:'call-shanghai',output:'上海：晴'}]
 const second=await send({...(endpoint==='responses'?{input:[user,...calls,...outputs.map(v=>({type:'function_call_output',...v}))]}:{messages:[user,payload.choices[0].message,...outputs.map(v=>({role:'tool',tool_call_id:v.call_id,content:v.output}))]}),tools,stream:true,max_output_tokens:128})
 expect(second.status,await second.clone().text()).toBe(200)
 expect(await second.text()).toContain('上海晴，東京雨。')
 await expect.poll(async()=>(await env.DB.prepare('SELECT quota_used_micros FROM api_keys WHERE id=?').bind(f.api_key_id).first<any>())?.quota_used_micros).toBe(34)
 const state=await (await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
 expect(state.profile).toMatchObject({balance_micros:999966,reserved_micros:0})
 expect(state.ledger.filter((r:any)=>r.amount_delta_micros<0)).toHaveLength(2)
})
