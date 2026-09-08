import {env,exports} from 'cloudflare:workers'
import {createExecutionContext,waitOnExecutionContext} from 'cloudflare:test'
import {createApp} from '../../src/app'
import {expect,it} from 'vitest'
async function seed(mode:string){
 const model='native-buffer-'+mode+'-'+crypto.randomUUID()
 const response=await exports.default.fetch(new Request('https://worker.e2e.invalid/api/v1/admin/bootstrap',{method:'POST',headers:{authorization:'Bearer '+env.ADMIN_TOKEN,'content-type':'application/json'},body:JSON.stringify({user:{email:crypto.randomUUID()+'@native-buffer.test',balance_micros:1000000},group:{name:crypto.randomUUID()},account:{name:crypto.randomUUID(),base_url:'https://upstream.e2e.invalid/v1',api_key:'local-fixture-key'},api_key:{name:'native'},models:[{public_name:model,upstream_name:'native-buffer-'+mode,endpoint:'responses',input_micros_per_million:1000000,output_micros_per_million:2000000,per_request_micros:7,minimum_reservation_micros:100}]})}))
 expect(response.status).toBe(201);return {...(await response.json() as any).data,model}
}
it.each(['failed','missing','cancel'] as const)('handles native non-stream SSE %s without a successful response or duplicate debit',async mode=>{
 const f=await seed(mode),controller=new AbortController(),ctx=createExecutionContext(),started=Date.now()
 const pending=createApp().fetch(new Request('https://worker.e2e.invalid/v1/responses',{method:'POST',headers:{authorization:'Bearer '+f.api_key,'content-type':'application/json'},body:JSON.stringify({model:f.model,input:'hello',stream:false,max_output_tokens:16}),signal:controller.signal}),env,ctx)
 if(mode==='cancel')setTimeout(()=>controller.abort(),50)
 const response=await pending;expect(response.status,await response.clone().text()).toBe(mode==='cancel'?499:502)
 if(mode==='cancel')expect(Date.now()-started).toBeLessThan(1000)
 await waitOnExecutionContext(ctx)
 const state=await (await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
 const charge=mode==='failed'?17:0
 expect(state.profile).toMatchObject({balance_micros:1000000-charge,reserved_micros:0})
 expect(state.ledger.filter((r:any)=>r.amount_delta_micros<0)).toHaveLength(charge?1:0)
 expect(await env.DB.prepare('SELECT quota_used_micros FROM api_keys WHERE id=?').bind(f.api_key_id).first()).toEqual({quota_used_micros:charge})
})

it('preserves a delta-only refusal and settles its actual usage once', async () => {
 const f=await seed('refusal'),ctx=createExecutionContext()
 const response=await createApp().fetch(new Request('https://worker.e2e.invalid/v1/responses',{method:'POST',headers:{authorization:'Bearer '+f.api_key,'content-type':'application/json'},body:JSON.stringify({model:f.model,input:'hello',stream:false,max_output_tokens:16})}),env,ctx)
 expect(response.status,await response.clone().text()).toBe(200)
 expect(await response.json()).toMatchObject({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'Cannot comply.'}]}]})
 await waitOnExecutionContext(ctx)
 const state=await (await env.USER_STATE.get(env.USER_STATE.idFromName(f.user_id)).fetch('https://state.test/snapshot')).json() as any
 expect(state.profile).toMatchObject({balance_micros:999983,reserved_micros:0})
 expect(state.ledger.filter((r:any)=>r.amount_delta_micros<0)).toHaveLength(1)
})
