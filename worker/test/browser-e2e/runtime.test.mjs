import assert from 'node:assert/strict'
import test from 'node:test'

import { reserveLoopbackPort, workerOriginBindings } from './runtime.mjs'

test('concurrent browser E2E runners reserve distinct loopback origins', async (context) => {
  const [first, second] = await Promise.all([
    reserveLoopbackPort(),
    reserveLoopbackPort(),
  ])
  context.after(async () => Promise.all([first.release(), second.release()]))

  assert.notEqual(first.port, second.port)
  assert.match(first.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.match(second.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
})

test('actual runner origin becomes the public and WebAuthn Worker bindings', () => {
  assert.deepEqual(workerOriginBindings('http://127.0.0.1:43123'), {
    PUBLIC_ORIGIN: { type: 'plain_text', value: 'http://127.0.0.1:43123' },
    WEBAUTHN_RP_ID: { type: 'plain_text', value: '127.0.0.1' },
    WEBAUTHN_RP_ORIGINS: { type: 'plain_text', value: '["http://127.0.0.1:43123"]' },
  })
})
