import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { emailDeliveryFixture } from './test/e2e/fixtures/email-delivery.js'

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname)

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.e2e.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          serviceBindings: { EMAIL_DELIVERY: emailDeliveryFixture },
          outboundService: async (request) => {
            const url = new URL(request.url)
            if (
              url.origin !== 'https://upstream.e2e.invalid' &&
              url.origin !== 'https://upstream-fallback.e2e.invalid'
            ) {
              return Response.json({ error: 'unexpected outbound request' }, { status: 502 })
            }
            if (url.pathname === '/v1/sub2api/billing') return Response.json({object:'sub2api.key_billing',schema_version:1,billing_scope:'token',group_rate_multiplier:0.25,resolved_rate_multiplier:0.25,effective_rate_multiplier:0.25,peak_rate_enabled:false,observed_at:new Date().toISOString()})
            if (url.pathname === '/v1/messages' || url.pathname === '/v1/responses' || url.pathname === '/backend-api/codex/responses') {
              const body = await request.clone().json() as any
              if (body.model === 'cyber-policy-test') {
                const error={code:'cyber_policy',message:'Fixture cyber refusal'}
                return body.stream?new Response('data: '+JSON.stringify({type:'response.failed',response:{id:'cyber-fixture',status:'failed',error}})+'\n\n',{headers:{'content-type':'text/event-stream'}}):Response.json({error},{status:400})
              }
              if (typeof body.model === 'string' && body.model.startsWith('native-buffer-')) {
                const data=body.model === 'native-buffer-failed'
                  ? {type:'response.failed',response:{id:'native-error',status:'failed',error:{code:'invalid_request',message:'fixture failure'},usage:{input_tokens:6,output_tokens:2}}}
                  : {type:'response.created',response:{id:'native-incomplete'}}
                const bytes=new TextEncoder().encode('data: '+JSON.stringify(data)+'\n\n')
                if(body.model === 'native-buffer-cancel')return new Response(new ReadableStream({start(controller){controller.enqueue(bytes)}}),{headers:{'content-type':'text/event-stream'}})
                return new Response(bytes,{headers:{'content-type':'text/event-stream'}})
              }
              if (body.model === 'provider-forwarding-anthropic') {
                const valid=request.headers.get('authorization')==='Bearer local-fixture-key' && !request.headers.has('x-api-key') && request.headers.get('user-agent')?.startsWith('claude-cli/') && request.headers.get('x-stainless-runtime')==='node' && body.system.some((b:any)=>b.text==='Custom fixture expansion') && body.messages[0].content[0].text.includes('Original client instructions')
                if (!valid) return Response.json({error:'anthropic provider settings mismatch'},{status:422})
                return Response.json({id:'provider',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'provider-settings-verified'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:5}})
              }
              if (body.model === 'provider-forwarding-codex') {
                if(request.headers.get('user-agent')!=='codex-tui/0.200.0 (Linux)' || request.headers.get('version')!=='0.200.0' || request.headers.get('originator')!=='codex-tui')return Response.json({error:'codex provider settings mismatch'},{status:422})
                return new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'provider',object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'provider-settings-verified'}]}],usage:{input_tokens:10,output_tokens:5}}})+'\n\n',{headers:{'content-type':'text/event-stream'}})
              }
            }
            if (url.pathname === '/v1/chat/completions') {
              const body = await request.clone().json() as Record<string, unknown>
              if (typeof body.model === 'string' && body.model.startsWith('fast-policy-')) {
                const expectedTier = body.model === 'fast-policy-filter-upstream' ? undefined : 'priority'
                if (body.model === 'fast-policy-block-upstream' || body.service_tier !== expectedTier) return Response.json({error:'policy body mismatch'}, {status:422})
                const result = {id:'fast-policy',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'policy-body-verified'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}
                if (body.stream) return new Response('data: '+JSON.stringify({choices:[{delta:{content:'policy-body-verified'}}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:result.usage})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
                return Response.json(result)
              }
              if (body.model === 'runtime-overload-upstream') return new Response('fixture overload', { status: 529 })
              if (body.model === 'lifecycle-invalid-json-upstream') {
                return new Response('<html>upstream maintenance</html>', { headers: { 'content-type': 'text/html' } })
              }
              if (typeof body.model === 'string' && ['lifecycle-stream-success-upstream', 'lifecycle-stream-partial-error-upstream', 'lifecycle-stream-cancel-upstream', 'lifecycle-stream-late-usage-upstream'].includes(body.model)) {
                const frames = [
                  'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
                  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
                  body.model === 'lifecycle-stream-partial-error-upstream'
                    ? 'data: {"error":{"code":"upstream_error","message":"generation interrupted"}}\n\ndata: [DONE]\n\n'
                    : 'data: [DONE]\n\n',
                ]
                if (body.model === 'lifecycle-stream-late-usage-upstream') {
                  frames.splice(1, 0, 'data: {"error":{"code":"upstream_error","message":"generation interrupted"}}\n\n')
                }
                return new Response(new ReadableStream({
                  async pull(controller) {
                    await new Promise(resolve => setTimeout(resolve, 20))
                    const frame = frames.shift()
                    if (frame === undefined) controller.close()
                    else controller.enqueue(new TextEncoder().encode(frame))
                  },
                }), { headers: { 'content-type': 'text/event-stream' } })
              }
              if (body.model === 'lifecycle-stream-error-upstream') {
                return new Response('data: {"error":{"code":"resource_exhausted","message":"Monthly usage limit"}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
              }
              if (body.model === 'lifecycle-quota-upstream') {
                return Response.json({ error: { code: 'resource_exhausted', message: 'Monthly usage limit' } })
              }
            }
            if (url.pathname === '/v1/images/generations') {
              const body = await request.json() as Record<string, unknown>
              if (
                body.model !== 'gpt-image-binding-upstream' ||
                body.prompt !== 'binding image' ||
                body.size !== '1024x1024'
              ) return Response.json({ error: 'unexpected Images request', body }, { status: 422 })
              return Response.json({
                created: 1_700_000_000,
                data: [{
                  b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                }],
              })
            }
            if (url.pathname === '/backend-api/codex/responses') {
              const body = await request.json() as Record<string, unknown>
              const tool = Array.isArray(body.tools) ? body.tools[0] as Record<string, unknown> : null
              if (
                body.model !== 'gpt-5.4-mini' || body.stream !== true || body.store !== false ||
                tool?.type !== 'image_generation' || tool.action !== 'generate' ||
                tool.model !== 'gpt-image-codex-upstream'
              ) return Response.json({ error: 'unexpected Codex image request', body }, { status: 422 })
              const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
              return new Response([
                'event: response.completed',
                `data: {"type":"response.completed","response":{"created_at":1710000010,"status":"completed","output":[{"id":"ig_codex_binding","type":"image_generation_call","status":"completed","result":"${png}","output_format":"png"}]}}`,
                '',
                '',
              ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
            }
            if (url.pathname === '/v1/responses') {
              const body = await request.json() as Record<string, unknown>
              if (body.model === 'scheduler-response-upstream') {
                const value={id:body.previous_response_id ? 'resp-scheduler-next':'resp-scheduler-first',object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:body.previous_response_id ? 'continued':'first'}]}],usage:{input_tokens:2,output_tokens:1}}
                const headers={'x-ratelimit-limit-tokens':'1000','x-ratelimit-remaining-tokens':'900','x-ratelimit-reset-tokens':'1m'}
                if(body.stream) return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'first'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:value})+'\n\n',{headers:{...headers,'content-type':'text/event-stream'}})
                return Response.json(value,{headers})
              }
              if (body.model === 'gpt-bridge-failover-upstream') {
                if (url.origin === 'https://upstream.e2e.invalid') {
                  return new Response([
                    'event: response.failed',
                    'data: {"type":"response.failed","response":{"id":"resp-binding-failed","status":"failed","output":[],"error":{"code":"server_error","message":"first binding account failed"},"usage":{"input_tokens":90,"output_tokens":9}}}',
                    '',
                    '',
                  ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
                }
                return new Response([
                  'event: response.completed',
                  'data: {"type":"response.completed","response":{"id":"resp-binding-failover","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"binding-failover-ok"}]}],"usage":{"input_tokens":9,"output_tokens":3,"total_tokens":12}}}',
                  '',
                  '',
                ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
              }
              if (body.model === 'gpt-bridge-stream-upstream') {
                const valid = body.stream === true && body.store === false &&
                  body.max_output_tokens === 128 && body.stream_options === undefined &&
                  JSON.stringify(body.include) === JSON.stringify(['reasoning.encrypted_content']) &&
                  JSON.stringify(body.input) === JSON.stringify([
                    { role: 'user', content: 'Run both tools.' },
                  ])
                if (!valid) {
                  return Response.json({ error: 'unexpected streaming Responses bridge request', body }, { status: 422 })
                }
                return new Response([
                  'event: response.created',
                  'data: {"type":"response.created","response":{"id":"resp-binding-stream","model":"gpt-bridge-stream-upstream"}}',
                  '',
                  'event: response.reasoning_summary_text.delta',
                  'data: {"type":"response.reasoning_summary_text.delta","delta":"choose tools"}',
                  '',
                  'event: response.output_text.delta',
                  'data: {"type":"response.output_text.delta","delta":"working"}',
                  '',
                  'event: response.output_item.added',
                  'data: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","call_id":"call_alpha","name":"alpha"}}',
                  '',
                  'event: response.output_item.added',
                  'data: {"type":"response.output_item.added","output_index":5,"item":{"type":"function_call","call_id":"call_beta","name":"beta"}}',
                  '',
                  'event: response.function_call_arguments.delta',
                  'data: {"type":"response.function_call_arguments.delta","output_index":5,"delta":"{\\"b\\":"}',
                  '',
                  'event: response.function_call_arguments.delta',
                  'data: {"type":"response.function_call_arguments.delta","output_index":2,"delta":"{\\"a\\":"}',
                  '',
                  'event: response.function_call_arguments.delta',
                  'data: {"type":"response.function_call_arguments.delta","output_index":5,"delta":"2}"}',
                  '',
                  'event: response.function_call_arguments.delta',
                  'data: {"type":"response.function_call_arguments.delta","output_index":2,"delta":"1}"}',
                  '',
                  'event: response.completed',
                  'data: {"type":"response.completed","response":{"id":"resp-binding-stream","model":"gpt-bridge-stream-upstream","status":"completed","output":[],"usage":{"input_tokens":12,"output_tokens":6,"total_tokens":18}}}',
                  '',
                  '',
                ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
              }
              const expected = {
                model: 'gpt-bridge-upstream',
                input: [
                  { role: 'system', content: 'Answer precisely.' },
                  { role: 'user', content: 'Say bridge-ok.' },
                ],
                stream: true,
                store: false,
                include: ['reasoning.encrypted_content'],
                max_output_tokens: 128,
              }
              if (JSON.stringify(body) !== JSON.stringify(expected)) {
                return Response.json({ error: 'unexpected Responses bridge request', body }, { status: 422 })
              }
              const forcedStream = [
                'event: response.created',
                'data: {"type":"response.created","response":{"id":"resp-binding-bridge","model":"gpt-bridge-upstream"}}',
                '',
                'event: response.output_text.delta',
                'data: {"type":"response.output_text.delta","delta":"bridge-ok"}',
                '',
                'event: response.completed',
                'data: {"type":"response.completed","response":{"id":"resp-binding-bridge","model":"gpt-bridge-upstream","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
                '',
                '',
              ].join('\n')
              return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(forcedStream))
                  // Deliberately keep the connection open. A buffered Chat client must
                  // return as soon as the Responses terminal event is observed.
                },
              }), { headers: { 'content-type': 'text/event-stream' } })
            }
            return Response.json({
              id: 'chatcmpl-binding-e2e',
              object: 'chat.completion',
              created: 1_700_000_000,
              model: 'gpt-binding-upstream',
              choices: [{ index: 0, message: { role: 'assistant', content: 'binding-ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            })
          },
        },
      }),
    ],
    test: {
      include: ['test/e2e/**/*.e2e.ts'],
      setupFiles: ['./test/e2e/apply-migrations.ts'],
      testTimeout: 20_000,
      hookTimeout: 20_000,
    },
  }
})
