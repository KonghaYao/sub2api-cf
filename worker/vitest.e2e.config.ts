import { toolRoundtrip } from './test/e2e/fixtures/tool-roundtrip.js'
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
            if (url.origin === 'https://chatgpt.com' && request.headers.get('authorization') === 'Bearer official-quota-local-fixture') {
              if (url.pathname === '/backend-api/wham/usage') return Response.json({rate_limit:{primary_window:{used_percent:85,limit_window_seconds:18000,reset_at:Math.floor(Date.now()/1000)+3600}}})
              if (url.pathname === '/backend-api/codex/responses') return new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'quota-fixture',status:'completed',output:[],usage:{input_tokens:6,output_tokens:2}}})+'\n\n',{headers:{'content-type':'text/event-stream'}})
              return Response.json({error:'unexpected quota fixture path'},{status:502})
            }
            if (
              url.origin !== 'https://upstream.e2e.invalid' &&
              url.origin !== 'https://upstream-fallback.e2e.invalid'
            ) {
              return Response.json({ error: 'unexpected outbound request' }, { status: 502 })
            }
            if (request.method === 'POST' && ['/v1/responses', '/v1/chat/completions'].includes(url.pathname)) {
              const roundtrip = await toolRoundtrip(request)
              if (roundtrip) return roundtrip
            }
            if (url.pathname.startsWith('/v1internal:')) {
              const body = await request.json() as any
              if (request.method !== 'POST' || request.headers.get('authorization') !== 'Bearer antigravity-local-fixture' || body.project !== 'antigravity-project') return Response.json({error:'invalid Antigravity fixture credentials/project'},{status:401})
              if (url.pathname === '/v1internal:fetchAvailableModels') return Response.json({models:{'gemini-antigravity-fixture':{displayName:'Antigravity fixture'}}})
              if (url.pathname !== '/v1internal:streamGenerateContent' || url.searchParams.get('alt') !== 'sse' || !Array.isArray(body.request?.contents) || body.userAgent !== 'antigravity') return Response.json({error:'invalid Antigravity fixture path/body'},{status:400})
              const parts = body.request.systemInstruction?.parts ?? []
              if (!parts.some((part:any)=>typeof part.text==='string'&&part.text.includes('Antigravity'))) return Response.json({error:'missing configured identity'},{status:400})
              if (body.model === 'anti-cross-error') return new Response('data: '+JSON.stringify({error:{code:500,message:'fixture failure'}})+'\n\n',{headers:{'content-type':'text/event-stream'}})
              if (body.model === 'anti-cross-truncated') return new Response('data: '+JSON.stringify({response:{candidates:[{index:0,content:{role:'model',parts:[{text:'partial'}]}}]}})+'\n\n',{headers:{'content-type':'text/event-stream'}})
              const response = {candidates:[{index:0,content:{role:'model',parts:[{text:'Antigravity OK'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:15},modelVersion:body.model}
              const {usageMetadata,...content}=response
              const encode=new TextEncoder()
              return new Response(new ReadableStream({start(controller){controller.enqueue(encode.encode('data: '+JSON.stringify({response:content})+'\n\n'));controller.enqueue(encode.encode('data: '+JSON.stringify({response:{usageMetadata}})+'\n\n'));controller.close()}}),{headers:{'content-type':'text/event-stream'}})
            }
            if (url.pathname === '/v1/sub2api/billing') return Response.json({object:'sub2api.key_billing',schema_version:1,billing_scope:'token',group_rate_multiplier:0.25,resolved_rate_multiplier:0.25,effective_rate_multiplier:0.25,peak_rate_enabled:false,observed_at:new Date().toISOString()})
            if (url.pathname === '/v1/messages' || url.pathname === '/v1/responses' || url.pathname === '/backend-api/codex/responses') {
              const body = await request.clone().json() as any
              if (url.pathname === '/v1/messages' && body.model === 'anthropic-cache-alias-fixture') {
                const ttlProbe = body.messages?.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).find((block: any) => typeof block.text === 'string' && block.text.startsWith('TTL probe '))
                if (ttlProbe && ttlProbe.cache_control?.ttl !== ttlProbe.text.slice('TTL probe '.length)) return Response.json({error:'fixture TTL injection mismatch'},{status:400})
                const message={id:'msg_cache_fixture',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'Cache OK'}],stop_reason:'end_turn',usage:{input_tokens:8,output_tokens:2,cache_creation_input_tokens:5,cache_read_input_tokens:0,cached_tokens:3,cache_creation:{ephemeral_5m_input_tokens:2,ephemeral_1h_input_tokens:3}}}
                if (!body.stream) return Response.json(message)
                const events=[{type:'message_start',message:{...message,content:[],usage:{...message.usage,output_tokens:0}}},
                  {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Cache OK'}},
                  {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},
                  {type:'message_delta',usage:{input_tokens:0,output_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0}},
                  {type:'message_stop'}]
                return new Response(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
              }
              if (body.model === 'cyber-policy-test') {
                const error={code:'cyber_policy',message:'Fixture cyber refusal'}
                return body.stream?new Response('data: '+JSON.stringify({type:'response.failed',response:{id:'cyber-fixture',status:'failed',error}})+'\n\n',{headers:{'content-type':'text/event-stream'}}):Response.json({error},{status:400})
              }
              if (typeof body.model === 'string' && body.model.startsWith('native-buffer-')) {
                if (body.model.startsWith('native-buffer-error-')) {
                  const mode = body.model.slice('native-buffer-error-'.length)
                  if (mode === 'document' || mode === 'cyber-document') return Response.json({id:'native-failed-document',object:'response',status:'failed',output:[],
                    error:{code:mode === 'cyber-document' ? 'cyber_policy' : 'server_error',message:'failed document'},usage:{input_tokens:6,output_tokens:2}})
                  return Response.json({error:mode === 'output-limit'
                    ? {code:'3',errorType:'INFERENCE_STREAM_ERROR_TYPE_OUTPUT_TOKEN_LIMIT',message:'private provider detail'}
                    : {code:mode === 'quota' ? 'resource_exhausted' : 'server_error',message:'private provider detail'}})
                }
                if (body.model === 'native-buffer-tool-arguments') return new Response([
                  {type:'response.output_item.added',output_index:2,item:{type:'function_call',id:'fc_done',call_id:'call_done',name:'weather',arguments:''}},
                  {type:'response.function_call_arguments.delta',output_index:2,delta:'{"city":'},
                  {type:'response.function_call_arguments.done',output_index:2,item_id:'fc_done',arguments:'{"city":"上海"}'},
                  {type:'response.output_item.added',output_index:4,item:{type:'custom_tool_call',id:'ctc_done',call_id:'custom_done',name:'apply_patch',input:''}},
                  {type:'response.custom_tool_call_input.done',call_id:'custom_done',input:'*** Begin Patch'},
                  {type:'response.completed',response:{id:'native-tool-done',status:'completed',output:[],usage:{input_tokens:6,output_tokens:2}}},
                ].map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
                if (body.model === 'native-buffer-items') return new Response([
                  { type: 'response.output_item.done', output_index: 2, item: { type: 'custom_tool_call', id: 'ctc_native', call_id: 'call_native', name: 'apply_patch', input: '*** Begin Patch', status: 'completed' } },
                  { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_native', encrypted_content: 'opaque-native-reasoning', summary: [] } },
                  { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_native', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Ready.', annotations: [] }] } },
                  { type: 'response.completed', response: { id: 'items-fixture', status: 'completed', output: [], usage: { input_tokens: 6, output_tokens: 2 } } },
                ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
                if (body.model === 'native-buffer-completion') return new Response([
                  { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Think' },
                  { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'Thinking complete.' },
                  { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Hello ' },
                  { type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'Hello complete world.' },
                  { type: 'response.completed', response: { id: 'completion-fixture', status: 'completed', output: [], usage: { input_tokens: 6, output_tokens: 2 } } },
                ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
                if (body.model === 'native-buffer-refusal') return new Response([
                  { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'Cannot comply.' },
                  { type: 'response.completed', response: { id: 'refusal-fixture', status: 'completed', output: [], usage: { input_tokens: 6, output_tokens: 2 } } },
                ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })

                const data=body.model === 'native-buffer-failed'
                  ? {type:'response.failed',response:{id:'native-error',status:'failed',error:{code:'invalid_request',message:'fixture failure'},usage:{input_tokens:6,output_tokens:2}}}
                  : {type:'response.created',response:{id:'native-incomplete'}}
                const bytes=new TextEncoder().encode('data: '+JSON.stringify(data)+'\n\n')
                if(body.model === 'native-buffer-cancel')return new Response(new ReadableStream({start(controller){controller.enqueue(bytes)}}),{headers:{'content-type':'text/event-stream'}})
                return new Response(bytes,{headers:{'content-type':'text/event-stream'}})
              }
              if (body.model === 'provider-forwarding-anthropic') {
                const valid=request.headers.get('authorization')==='Bearer local-fixture-key' && !request.headers.has('x-api-key') && request.headers.get('user-agent')?.startsWith('claude-cli/') && request.headers.get('x-stainless-runtime')==='node' && body.system.some((b:any)=>b.text==='Custom fixture expansion') && body.messages[0].content[0].text.includes('Original client instructions') && body.messages[0].content[0].cache_control?.type==='ephemeral' && body.messages[0].content[0].cache_control?.ttl==='1h'
                if (!valid) return Response.json({error:'anthropic provider settings mismatch'},{status:422})
                return Response.json({id:'provider',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'provider-settings-verified'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:5}})
              }
              if (body.model === 'responses-empty-completed-fixture') {
                const recovered = request.headers.get('authorization') === 'Bearer silent-recovery-key'
                const events = recovered
                  ? [{ type: 'response.completed', response: { id: 'recovered-attempt', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Recovered' }] }], usage: { input_tokens: 10, output_tokens: 5 } } }]
                  : [{ type: 'response.created', response: { id: 'empty-attempt', status: 'in_progress', error: null, usage: null, output: [] } },
                     { type: 'response.completed', response: { id: 'empty-attempt', status: 'completed', output: [] } }]
                return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
              }
              if (body.model === 'responses-slow-prelude-fixture') {
                const fallback = request.headers.get('authorization') === 'Bearer unexpected-fallback-key'
                return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                  const emit = (event: unknown) => controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'))
                  emit({ type: 'response.created', response: { id: 'slow-prelude' } })
                  const finish = () => {
                    emit({ type: 'response.output_text.delta', delta: fallback ? 'Unexpected fallback' : 'Slow reasoning OK' })
                    emit({ type: 'response.completed', response: { id: 'slow-prelude', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5 } } })
                    controller.close()
                  }
                  if (fallback) finish(); else setTimeout(finish, 65_000)
                } }), { headers: { 'content-type': 'text/event-stream' } })
              }
              if (body.model === 'cursor-shape-probe') {
                const response={id:'shape-probe',object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({body,session:request.headers.get('session_id')})}]}],usage:{input_tokens:6,output_tokens:2}}
                return body.stream ? new Response('data: '+JSON.stringify({type:'response.completed',response})+'\n\n',{headers:{'content-type':'text/event-stream'}}) : Response.json(response)
              }
              if (body.model === 'gpt-5.4-cache-probe') {
                const text = JSON.stringify({ key: body.prompt_cache_key ?? null, session: request.headers.get('session_id') })
                return new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'cache-probe',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:6,output_tokens:2}}})+'\n\n',{headers:{'content-type':'text/event-stream'}})
              }
              if (body.model === 'provider-forwarding-native') {
                if(request.headers.get('user-agent')!=='codex-tui/0.200.0 (Linux)' || request.headers.get('version')!=='0.200.0' || request.headers.get('originator')!=='codex-tui')return Response.json({error:'codex provider settings mismatch'},{status:422})
                return new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'provider',object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'provider-settings-verified'}]}],usage:{input_tokens:10,output_tokens:5}}})+'\n\n',{headers:{'content-type':'text/event-stream'}})
              }
            }
            if (url.pathname === '/v1/chat/completions') {
              const body = await request.clone().json() as Record<string, unknown>
              if (body.model === 'gpt-5.4-cache-probe') return Response.json({id:'raw-cache-probe',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:JSON.stringify({key:body.prompt_cache_key??null,session:request.headers.get('session_id')})},finish_reason:'stop'}],usage:{prompt_tokens:6,completion_tokens:2}})
              if (body.model === 'chat-json-cache-fixture' || body.model === 'chat-json-diagnostic-fixture') {
                if (body.stream !== true || (body.model === 'chat-json-cache-fixture' && (body.stream_options as any)?.include_usage !== true)) return Response.json({ error: 'stream flag missing' }, { status: 422 })
                return Response.json({ id: 'json-cache', object: 'chat.completion', model: body.model, created: 123,
                  choices: [{ index: 0, message: { role: 'assistant', content: 'Cache and streaming OK' }, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 100, completion_tokens: 2, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 } })
              }
              if (typeof body.model === 'string' && body.model.startsWith('chat-eof-')) {
                const mode=body.model.slice('chat-eof-'.length)
                const events: unknown[]=[{choices:[{index:0,delta:{content:'Chat OK'}}]}]
                if(mode==='finish')events.push({choices:[{index:0,delta:{},finish_reason:'stop'}]})
                if(mode==='error')events.push({error:{code:'server_error',message:'fixture error'}})
                if(mode==='usage'||mode==='error')events.push({choices:[],usage:{prompt_tokens:6,completion_tokens:2}})
                return new Response(events.map(event=>'data: '+JSON.stringify(event)).join('\n\n')+'\n',{headers:{'content-type':'text/event-stream'}})
              }
              if (body.model === 'composer-bridge-fixture' || body.model === 'composer-slow-fixture') {
                if (!Array.isArray(body.messages) || 'input' in body) return Response.json({error:'expected chat bridge body'},{status:422})
                const slow = body.model === 'composer-slow-fixture'
                if (slow) await new Promise(resolve => setTimeout(resolve, 65_000))
                const usage = {prompt_tokens:10,completion_tokens:5,total_tokens:15}
                if (!body.stream) return Response.json({id:'composer-fixture',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'Composer OK'},finish_reason:'stop'}],usage})
                const frames = [
                  {choices:[{index:0,delta:{role:'assistant',content:'Composer '}}]},
                  {choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}]},
                  {choices:[],usage},
                ]
                let sent = 0
                return new Response(new ReadableStream({async pull(controller) {
                  if (slow && sent === 1) await new Promise(resolve => setTimeout(resolve, 25_000))
                  const frame = frames.shift(); sent++
                  controller.enqueue(new TextEncoder().encode('data: '+(frame ? JSON.stringify(frame) : '[DONE]')+'\n\n'))
                  if (!frame) controller.close()
                }}), {headers:{'content-type':'text/event-stream'}})
              }
              if (typeof body.model === 'string' && body.model.startsWith('fast-policy-')) {
                const expectedTier = body.model === 'fast-policy-filter-upstream' ? undefined : 'priority'
                if (body.model === 'fast-policy-block-upstream' || body.service_tier !== expectedTier) return Response.json({error:'policy body mismatch'}, {status:422})
                const result = {id:'fast-policy',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'policy-body-verified'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}
                if (body.stream) return new Response('data: '+JSON.stringify({choices:[{delta:{content:'policy-body-verified'}}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:result.usage})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
                return Response.json(result)
              }
              if (body.model === 'runtime-overload-upstream') return new Response('fixture overload', { status: 529 })
              if (body.model === 'lifecycle-silent-upstream') {
                const recovered = request.headers.get('authorization') === 'Bearer silent-recovery-key'
                return new Response(recovered
                  ? 'data: {"choices":[{"delta":{"content":"Recovered"}}]}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n'
                  : 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                  { headers: { 'content-type': 'text/event-stream' } })
              }
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
            const body = request.method === 'POST' ? await request.clone().json() as any : {}
            if (typeof body.model === 'string' && /^(?:grok-native-fixture|gpt-grok-fixture)/.test(body.model)) {
              const completion={id:'grok-fixture',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:body.model},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}
              if(body.stream)return new Response('data: '+JSON.stringify({choices:[{delta:{content:body.model}}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:completion.usage})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
              return Response.json(completion)
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
