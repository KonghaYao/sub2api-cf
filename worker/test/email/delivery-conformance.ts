import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import type { EmailDeliveryExecutionResult } from '../../src/email/delivery-executor'

interface ConformanceEvent {
  event_id: string
  payload: { challenge_id: string }
}

interface DeliveryConformanceHarness {
  env: Env
  raw: any
  event: ConformanceEvent
  table: string
  consume(): Promise<EmailDeliveryExecutionResult>
}

interface DeliveryConformanceConfig {
  name: string
  setup(): Promise<DeliveryConformanceHarness>
}

export function defineEmailDeliveryConformanceSuite(
  config: DeliveryConformanceConfig,
): void {
  describe(`${config.name} shared email delivery conformance`, () => {
    it('delivers once and treats a sent replay as already delivered', async () => {
      const test = await config.setup()
      const provider = vi.fn(async () => new Response(null, { status: 202 }))
      useCompatibilityProvider(test.env, provider)

      await expect(test.consume()).resolves.toBe('delivered')
      await expect(test.consume()).resolves.toBe('already_delivered')

      expect(provider).toHaveBeenCalledOnce()
      expect(readDelivery(test)).toMatchObject({
        delivery_state: 'sent',
        delivery_attempts: 1,
        delivery_lease_id: null,
        last_delivery_error: null,
      })
    })

    it('persists a bounded permanent terminal state and acknowledges every replay', async () => {
      const test = await config.setup()
      removeProviders(test.env)

      await expect(test.consume()).resolves.toBe('permanently_failed')
      await expect(test.consume()).resolves.toBe('permanently_failed')

      expect(readDelivery(test)).toMatchObject({
        delivery_state: 'failed',
        delivery_attempts: 1,
        delivery_lease_id: null,
        last_delivery_error: 'permanent:email_delivery_not_configured',
      })
    })

    it('persists only a content-free transient code and throws for Queue retry', async () => {
      const test = await config.setup()
      const providerSecret = 'provider-body-secret-value'
      useCompatibilityProvider(
        test.env,
        async () => new Response(providerSecret, { status: 503 }),
      )

      await expect(test.consume()).rejects.toThrow('email_delivery_unavailable_503')
      await expect(test.consume()).rejects.toThrow('email_delivery_unavailable_503')

      const delivery = readDelivery(test)
      expect(delivery).toMatchObject({
        delivery_state: 'failed',
        delivery_attempts: 2,
        delivery_lease_id: null,
        last_delivery_error: 'email_delivery_unavailable_503',
      })
      expect(JSON.stringify(delivery)).not.toContain(providerSecret)
    })

    it('rejects an active lease and recovers it only after its TTL expires', async () => {
      const test = await config.setup()
      const provider = vi.fn(async () => new Response(null, { status: 202 }))
      useCompatibilityProvider(test.env, provider)
      test.raw.prepare(
        `UPDATE ${test.table}
            SET delivery_state = 'delivering', delivery_lease_id = 'active-lease',
                delivery_lease_expires_at_ms = ?
          WHERE id = ?`,
      ).run(Date.now() + 60_000, test.event.payload.challenge_id)

      await expect(test.consume()).rejects.toThrow('already has an active lease')
      expect(provider).not.toHaveBeenCalled()

      test.raw.prepare(
        `UPDATE ${test.table} SET delivery_lease_expires_at_ms = ? WHERE id = ?`,
      ).run(Date.now() - 1, test.event.payload.challenge_id)
      await expect(test.consume()).resolves.toBe('delivered')
      expect(provider).toHaveBeenCalledOnce()
    })

    it('does not let a sender that lost its lease overwrite the replacement lease', async () => {
      const test = await config.setup()
      useCompatibilityProvider(test.env, async () => {
        test.raw.prepare(
          `UPDATE ${test.table}
              SET delivery_state = 'delivering', delivery_lease_id = 'replacement-lease',
                  delivery_lease_expires_at_ms = ?, last_delivery_error = NULL
            WHERE id = ?`,
        ).run(Date.now() + 60_000, test.event.payload.challenge_id)
        return new Response(null, { status: 202 })
      })

      await expect(test.consume()).rejects.toThrow('lost its lease')

      expect(readDelivery(test)).toMatchObject({
        delivery_state: 'delivering',
        delivery_attempts: 1,
        delivery_lease_id: 'replacement-lease',
        last_delivery_error: null,
      })
    })

    it('drops a stale domain record without contacting the provider', async () => {
      const test = await config.setup()
      const provider = vi.fn(async () => new Response(null, { status: 202 }))
      useCompatibilityProvider(test.env, provider)
      test.raw.prepare(
        `UPDATE ${test.table}
            SET status = 'consumed', consumed_at_ms = updated_at_ms,
                consume_nonce = 'delivery-conformance-consumed'
          WHERE id = ?`,
      ).run(test.event.payload.challenge_id)

      await expect(test.consume()).resolves.toBe('stale')
      expect(provider).not.toHaveBeenCalled()
    })
  })
}

function useCompatibilityProvider(
  env: Env,
  handler: (request: Request) => Promise<Response>,
): void {
  delete env.SEND_EMAIL
  env.EMAIL_DELIVERY = { fetch: vi.fn(handler) } as unknown as Fetcher
}

function removeProviders(env: Env): void {
  delete env.SEND_EMAIL
  delete env.EMAIL_DELIVERY
}

function readDelivery(test: DeliveryConformanceHarness): Record<string, unknown> {
  return test.raw.prepare(
    `SELECT delivery_state, delivery_attempts, delivery_lease_id,
            delivery_lease_expires_at_ms, last_delivery_error
       FROM ${test.table} WHERE id = ?`,
  ).get(test.event.payload.challenge_id) as Record<string, unknown>
}
