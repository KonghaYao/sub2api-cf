import type { Env } from '../env'

const COMPATIBILITY_ENDPOINT = 'https://email-delivery.internal/v1/challenges'
const COMPATIBILITY_TIMEOUT_MS = 5_000
const MAX_DELIVERY_ID_LENGTH = 256
const MAX_MESSAGE_BYTES = 128 * 1_024

type EmailDeliveryEnv = Pick<Env, 'SEND_EMAIL' | 'EMAIL_FROM_ADDRESS' | 'EMAIL_DELIVERY'>

export interface PlatformEmail {
  eventId: string
  recipient: string
  subject: string
  text: string
  html: string
  compatibilityPayload: Readonly<Record<string, unknown>>
}

export interface EmailDeliveryFailure {
  code: string
  retryable: boolean
}

/**
 * A deliberately content-free provider failure. Only this error crosses into
 * Queue logs or durable delivery metadata; provider exceptions and response
 * bodies may contain credentials or challenge material and are never retained.
 */
export class PlatformEmailDeliveryError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, retryable: boolean) {
    super(code)
    this.name = 'PlatformEmailDeliveryError'
    this.code = code
    this.retryable = retryable
  }
}

export function hasEmailDeliveryBinding(env: EmailDeliveryEnv): boolean {
  if (env.SEND_EMAIL !== undefined) {
    return typeof env.EMAIL_FROM_ADDRESS === 'string' &&
      isEmailAddress(env.EMAIL_FROM_ADDRESS.trim().toLowerCase())
  }
  return env.EMAIL_DELIVERY !== undefined
}

export function emailDeliveryFailure(error: unknown): EmailDeliveryFailure {
  if (error instanceof PlatformEmailDeliveryError) {
    return { code: error.code, retryable: error.retryable }
  }
  return { code: 'email_delivery_failed', retryable: true }
}

export function persistedEmailDeliveryFailure(failure: EmailDeliveryFailure): string {
  return failure.retryable ? failure.code : `permanent:${failure.code}`
}

export function isPermanentEmailDeliveryFailure(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('permanent:')
}

export async function deliverPlatformEmail(
  email: PlatformEmail,
  env: EmailDeliveryEnv,
): Promise<void> {
  validatePlatformEmail(email)

  if (env.SEND_EMAIL !== undefined) {
    const from = requireEmailFromAddress(env.EMAIL_FROM_ADDRESS)
    try {
      await env.SEND_EMAIL.send({
        from,
        to: email.recipient,
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: { 'X-Sub2API-Delivery-ID': email.eventId },
      })
      return
    } catch {
      throw new PlatformEmailDeliveryError('email_native_delivery_failed', true)
    }
  }

  if (env.EMAIL_DELIVERY === undefined) {
    throw new PlatformEmailDeliveryError('email_delivery_not_configured', false)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), COMPATIBILITY_TIMEOUT_MS)
  let response: Response
  try {
    response = await env.EMAIL_DELIVERY.fetch(new Request(COMPATIBILITY_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': email.eventId,
      },
      body: JSON.stringify(email.compatibilityPayload),
      signal: controller.signal,
    }))
  } catch {
    if (controller.signal.aborted) {
      throw new PlatformEmailDeliveryError('email_delivery_timeout', true)
    }
    throw new PlatformEmailDeliveryError('email_delivery_transport_failed', true)
  } finally {
    clearTimeout(timeout)
  }

  if (response.ok) return
  if (isRetryableStatus(response.status)) {
    throw new PlatformEmailDeliveryError(`email_delivery_unavailable_${response.status}`, true)
  }
  throw new PlatformEmailDeliveryError(`email_delivery_rejected_${response.status}`, false)
}

function validatePlatformEmail(email: PlatformEmail): void {
  if (
    email.eventId.length === 0 || email.eventId.length > MAX_DELIVERY_ID_LENGTH ||
    !/^[A-Za-z0-9:._-]+$/.test(email.eventId)
  ) {
    throw new PlatformEmailDeliveryError('email_delivery_id_invalid', false)
  }
  if (!isEmailAddress(email.recipient)) {
    throw new PlatformEmailDeliveryError('email_recipient_invalid', false)
  }
  if (/[\r\n]/.test(email.subject) || email.subject.length === 0 || email.subject.length > 256) {
    throw new PlatformEmailDeliveryError('email_subject_invalid', false)
  }
  const encoder = new TextEncoder()
  const size = encoder.encode(email.text).byteLength + encoder.encode(email.html).byteLength
  if (size > MAX_MESSAGE_BYTES) {
    throw new PlatformEmailDeliveryError('email_message_too_large', false)
  }
}

function requireEmailFromAddress(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PlatformEmailDeliveryError('email_sender_not_configured', false)
  }
  const email = value.trim().toLowerCase()
  if (!isEmailAddress(email)) {
    throw new PlatformEmailDeliveryError('email_sender_invalid', false)
  }
  return email
}

function isEmailAddress(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429
}
