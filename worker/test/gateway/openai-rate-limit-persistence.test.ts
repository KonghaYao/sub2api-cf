import { afterEach, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { persistOpenAIRateLimit } from '../../src/gateway/openai-rate-limit-persistence'
const account = { account_id: 'a', secret_id: 's', platform: 'openai' as const,
  runtime_snapshot: { config_version: 1, control_version: 0, ui_config_json: '{}' } }
afterEach(() => vi.useRealTimers())
it('bounds stalled error-body parsing and leaves the original response cancellable', async () => {
  vi.useFakeTimers()
  const cancelled = vi.fn()
  const response = new Response(new ReadableStream({ cancel: cancelled }), { status: 429 })
  const pending = persistOpenAIRateLimit({} as Env, account, response)
  await vi.advanceTimersByTimeAsync(2001)
  await expect(pending).resolves.toBe(false)
  await response.body!.cancel()
  expect(cancelled).toHaveBeenCalledOnce()
})
it('does not read an error stream when headers already identify the reset', async () => {
  const response = new Response(new ReadableStream(), { status: 429, headers: { 'x-codex-primary-reset-after-seconds': '60' } })
  const clone = vi.spyOn(response, 'clone')
  const first = vi.fn(async () => ({ id: 'a' }))
  const env = { DB: { prepare: () => ({ bind: () => ({ first }) }) } } as unknown as Env
  await expect(persistOpenAIRateLimit(env, account, response)).resolves.toBe(true)
  expect(clone).not.toHaveBeenCalled()
  await response.body!.cancel()
})
