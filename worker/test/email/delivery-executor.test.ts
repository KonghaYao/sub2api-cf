import { describe, expect, it, vi } from 'vitest'
import {
  executeLeasedEmailDelivery,
  type EmailDeliveryExecutorAdapter,
  type EmailDeliveryRecord,
} from '../../src/email/delivery-executor'
import { PlatformEmailDeliveryError } from '../../src/email/delivery'

interface TestEvent {
  id: string
}

interface TestRecord extends EmailDeliveryRecord {
  acquired: boolean
}

function adapter(
  record: TestRecord | null,
  send: () => Promise<void> = async () => undefined,
): EmailDeliveryExecutorAdapter<TestEvent, TestRecord> & {
  failures: string[]
  sent: ReturnType<typeof vi.fn>
} {
  const failures: string[] = []
  const sent = vi.fn(async () => true)
  return {
    leaseMs: 60_000,
    failureErrorMaxLength: 32,
    describe: (event) => `Test email delivery ${event.id}`,
    load: async (value) => ({ event: value as TestEvent, record }),
    acquireLease: async (loaded) => {
      if (loaded.record === null || loaded.record.acquired) return false
      loaded.record.acquired = true
      return true
    },
    inspect: async (loaded) => loaded.record,
    send: async () => send(),
    markSent: sent,
    markFailed: async (_loaded, _leaseId, failure) => { failures.push(failure) },
    failures,
    sent,
  }
}

describe('shared leased email delivery executor', () => {
  it('returns stale without leasing or sending when the domain load no longer matches', async () => {
    const send = vi.fn(async () => undefined)
    const subject = adapter(null, send)

    await expect(executeLeasedEmailDelivery({ id: 'event-1' }, subject)).resolves.toBe('stale')

    expect(send).not.toHaveBeenCalled()
    expect(subject.sent).not.toHaveBeenCalled()
  })

  it('acknowledges sent and permanent terminal records without acquiring another lease', async () => {
    const sent = adapter({
      id: 'row-1', deliveryState: 'sent', lastDeliveryError: null, acquired: false,
    })
    const permanent = adapter({
      id: 'row-2', deliveryState: 'failed',
      lastDeliveryError: 'permanent:email_delivery_not_configured', acquired: false,
    })

    await expect(executeLeasedEmailDelivery({ id: 'sent' }, sent))
      .resolves.toBe('already_delivered')
    await expect(executeLeasedEmailDelivery({ id: 'permanent' }, permanent))
      .resolves.toBe('permanently_failed')
  })

  it('marks a successful send with the same lease before reporting delivery', async () => {
    const subject = adapter({
      id: 'row-1', deliveryState: 'queued', lastDeliveryError: null, acquired: false,
    })

    await expect(executeLeasedEmailDelivery({ id: 'event-1' }, subject)).resolves.toBe('delivered')

    expect(subject.sent).toHaveBeenCalledOnce()
    expect(subject.failures).toEqual([])
  })

  it('persists a content-free retryable failure and rethrows the original error', async () => {
    const providerSecret = 'Bearer provider-secret'
    const failure = new Error(providerSecret)
    const subject = adapter(
      { id: 'row-1', deliveryState: 'queued', lastDeliveryError: null, acquired: false },
      async () => { throw failure },
    )

    await expect(executeLeasedEmailDelivery({ id: 'event-1' }, subject)).rejects.toBe(failure)

    expect(subject.failures).toEqual(['email_delivery_failed'])
    expect(JSON.stringify(subject.failures)).not.toContain(providerSecret)
  })

  it('persists and acknowledges a deterministic permanent failure', async () => {
    const subject = adapter(
      { id: 'row-1', deliveryState: 'queued', lastDeliveryError: null, acquired: false },
      async () => { throw new PlatformEmailDeliveryError('email_delivery_not_configured', false) },
    )

    await expect(executeLeasedEmailDelivery({ id: 'event-1' }, subject))
      .resolves.toBe('permanently_failed')
    expect(subject.failures).toEqual(['permanent:email_delivery_not_con'])
  })
})
