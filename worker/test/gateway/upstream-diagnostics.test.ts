import { expect, it, vi } from 'vitest'
import { captureUpstreamDiagnostic } from '../../src/gateway/upstream-diagnostics'
import { GatewayError, gatewayErrorResponse } from '../../src/gateway/errors'

it('keeps a useful error while removing credentials and preserving the generic public response', async () => {
  const error = new GatewayError(502, 'upstream_error', 'Upstream service failed')
  error.upstreamDiagnostic = await captureUpstreamDiagnostic(Response.json({ error: { message: 'failed account crsr_another-secret custom-secret', api_key: 'hidden' } }, { status: 500 }), 'custom-secret')
  expect(JSON.stringify(error.upstreamDiagnostic)).not.toMatch(/custom-secret|crsr_another-secret|hidden/)
  expect(error.upstreamDiagnostic).toMatchObject({ status: 500, body: { error: { message: expect.stringContaining('failed account') } } })
  expect(await gatewayErrorResponse(error).text()).not.toContain('failed account')
})
it('bounds oversized or stalled upstream diagnostics', async () => {
  expect((await captureUpstreamDiagnostic(new Response('x'.repeat(20000)), '')).body).toContain('size limit')
  expect((await captureUpstreamDiagnostic(new Response(new ReadableStream({ start() {} })), '')).body).toContain('timed out')
})

it.each(['complete', 'oversized', 'stalled', 'error'] as const)('releases reader ownership after %s diagnostics', async (kind) => {
  const cancel = vi.fn(() => new Promise<void>(() => {}))
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (kind === 'complete') { controller.enqueue(new TextEncoder().encode('{}')); controller.close() }
      if (kind === 'oversized') controller.enqueue(new Uint8Array(20000))
      if (kind === 'error') controller.error(new Error('upstream disconnected'))
    },
    cancel,
  })
  await captureUpstreamDiagnostic(new Response(body, { status: 502 }), '')
  expect(body.locked).toBe(false)
  if (kind === 'oversized' || kind === 'stalled') expect(cancel).toHaveBeenCalledOnce()
})
