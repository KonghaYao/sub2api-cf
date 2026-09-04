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
