import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname)

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.e2e.jsonc' },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          outboundService: async (request) => {
            const url = new URL(request.url)
            if (url.origin !== 'https://upstream.e2e.invalid') {
              return Response.json({ error: 'unexpected outbound request' }, { status: 502 })
            }
            if (url.pathname === '/v1/responses') {
              const body = await request.json() as Record<string, unknown>
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
