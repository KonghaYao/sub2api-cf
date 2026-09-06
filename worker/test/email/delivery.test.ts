import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import {
  deliverPlatformEmail,
  emailDeliveryFailure,
  hasEmailDeliveryBinding,
  type PlatformEmail,
} from '../../src/email/delivery'

const email: PlatformEmail = {
  eventId: 'email-event:challenge-1:1',
  recipient: 'alice@example.test',
  subject: 'Sub2API: Verify email',
  text: 'Verification code: 123456',
  html: '<p>Verification code: <code>123456</code></p>',
  compatibilityPayload: {
    recipient_email: 'alice@example.test',
    purpose: 'email_verification',
    token: '123456',
    action_url: 'https://example.test/verify?token=123456',
    site_name: 'Sub2API',
    locale: 'en',
    expires_at_ms: 2_000,
  },
}

function env(bindings: Pick<Env, 'SEND_EMAIL' | 'EMAIL_FROM_ADDRESS' | 'EMAIL_DELIVERY'>): Env {
  return bindings as Env
}

afterEach(() => {
  vi.useRealTimers()
})

describe('production email delivery boundary', () => {
  it('prefers the native Cloudflare binding and attaches a stable delivery id', async () => {
    const sent: Array<Record<string, unknown>> = []
    let compatibilityCalls = 0
    const bindings = env({
      SEND_EMAIL: {
        send: async (message: EmailMessage | EmailMessageBuilder) => {
          sent.push(message as unknown as Record<string, unknown>)
          return { messageId: 'native-1' }
        },
      } as SendEmail,
      EMAIL_FROM_ADDRESS: 'noreply@example.test',
      EMAIL_DELIVERY: {
        fetch: async () => {
          compatibilityCalls += 1
          return new Response(null, { status: 202 })
        },
      } as unknown as Fetcher,
    })

    await deliverPlatformEmail(email, bindings)

    expect(compatibilityCalls).toBe(0)
    expect(sent).toEqual([expect.objectContaining({
      from: 'noreply@example.test',
      to: 'alice@example.test',
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: { 'X-Sub2API-Delivery-ID': email.eventId },
    })])
  })

  it('sends the compatibility request with an idempotency key and no credential header', async () => {
    let captured: Request | undefined
    const bindings = env({
      EMAIL_DELIVERY: {
        fetch: async (request: Request) => {
          captured = request
          return new Response(null, { status: 202 })
        },
      } as unknown as Fetcher,
    })

    await deliverPlatformEmail(email, bindings)

    expect(captured?.url).toBe('https://email-delivery.internal/v1/challenges')
    expect(captured?.headers.get('idempotency-key')).toBe(email.eventId)
    expect(captured?.headers.get('authorization')).toBeNull()
    await expect(captured?.json()).resolves.toEqual(email.compatibilityPayload)
  })

  it('classifies deterministic rejection as terminal and transient rejection as retryable', async () => {
    const rejected = env({
      EMAIL_DELIVERY: { fetch: async () => new Response(null, { status: 422 }) } as unknown as Fetcher,
    })
    const unavailable = env({
      EMAIL_DELIVERY: { fetch: async () => new Response(null, { status: 503 }) } as unknown as Fetcher,
    })

    const permanent = await deliverPlatformEmail(email, rejected).catch(emailDeliveryFailure)
    const transient = await deliverPlatformEmail(email, unavailable).catch(emailDeliveryFailure)

    expect(permanent).toEqual({ code: 'email_delivery_rejected_422', retryable: false })
    expect(transient).toEqual({ code: 'email_delivery_unavailable_503', retryable: true })
  })

  it('fails closed without a binding and never exposes an opaque provider error', async () => {
    const missing = await deliverPlatformEmail(email, env({})).catch(emailDeliveryFailure)
    const token = 'spr_v1_secret-reset-token'
    const leaking = env({
      SEND_EMAIL: {
        send: async () => {
          throw new Error(`Authorization: Bearer provider-secret; token=${token}`)
        },
      } as SendEmail,
      EMAIL_FROM_ADDRESS: 'noreply@example.test',
    })
    const opaque = await deliverPlatformEmail(email, leaking).catch(emailDeliveryFailure)

    expect(missing).toEqual({ code: 'email_delivery_not_configured', retryable: false })
    expect(opaque).toEqual({ code: 'email_native_delivery_failed', retryable: true })
    expect(JSON.stringify(opaque)).not.toContain(token)
    expect(JSON.stringify(opaque)).not.toContain('provider-secret')
    expect(hasEmailDeliveryBinding(env({
      SEND_EMAIL: { send: async () => ({ messageId: 'unused' }) } as SendEmail,
    }))).toBe(false)
  })

  it('aborts a stalled compatibility request at the bounded deadline', async () => {
    vi.useFakeTimers()
    const bindings = env({
      EMAIL_DELIVERY: {
        fetch: (request: Request) => new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(new DOMException('request aborted with token=123456', 'AbortError'))
          })
        }),
      } as unknown as Fetcher,
    })

    const delivery = deliverPlatformEmail(email, bindings).catch(emailDeliveryFailure)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(delivery).resolves.toEqual({
      code: 'email_delivery_timeout',
      retryable: true,
    })
  })
})
