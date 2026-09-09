import { env, exports } from 'cloudflare:workers'
import { expect, it } from 'vitest'
it.each(['finish','usage','error','truncated'])('handles original raw Chat EOF markers: %s', async mode => {
 const model='chat-eof-'+crypto.randomUUID(),upstream='chat-eof-'+mode
 const bootstrap=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/bootstrap',{method:'POST',headers:{authorization:'Bearer '+env.ADMIN_TOKEN,'content-type':'application/json'},body:JSON.stringify({user:{email:crypto.randomUUID()+'@chat-eof.test',balance_micros:1000000},group:{name:crypto.randomUUID()},account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'fixture'},api_key:{name:'chat-eof'},models:[{public_name:model,upstream_name:upstream,endpoint:'chat_completions',input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100}]})}))
 expect(bootstrap.status).toBe(201)
 const f=(await bootstrap.json() as any).data
 const response=await exports.default.fetch(new Request('https://worker.e2e.invalid/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+f.api_key,'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'hi'}],stream:true,max_tokens:128})}))
 const content=await response.text()
 expect(response.status).toBe(200)
 expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
 expect(response.headers.get('x-accel-buffering')).toBe('no')
 expect(response.headers.get('cache-control')).toBe('no-cache')
 expect(content).toContain('Chat OK')
 const failed=mode==='error'||mode==='truncated'
 if(!failed) {
  expect(content).not.toContain('upstream_stream_error')
  expect(content.endsWith('data: [DONE]\n\n')).toBe(true)
 }
 await expect.poll(async()=>(await env.DB.prepare('SELECT outcome FROM usage_projection WHERE user_id=?').bind(f.user_id).first<any>())?.outcome).toBe(failed?'failed':'completed')
 const state=await (await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
 expect(state.profile.reserved_micros).toBe(0)
 expect(state.ledger.filter((r:any)=>r.amount_delta_micros<0)).toHaveLength(1)
 if(mode==='finish') {
  await env.DB.prepare('UPDATE accounts SET ui_config_json=? WHERE id=?').bind(JSON.stringify({extra:{openai_responses_mode:'force_chat_completions'}}),f.account_id).run()
  const diagnostic=await exports.default.fetch(new Request(`https://worker.e2e.invalid/api/v1/admin/accounts/${f.account_id}/test`,{method:'POST',headers:{authorization:'Bearer '+f.admin_session,'content-type':'application/json'},body:JSON.stringify({model_id:upstream,prompt:'hi'})}))
  expect(diagnostic.status).toBe(200)
  const text=await diagnostic.text()
  expect(text).toContain('"success":true')
  expect(text).toContain('Chat OK')
 }
})
