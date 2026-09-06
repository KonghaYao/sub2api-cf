import {
  emailDeliveryFailure,
  isPermanentEmailDeliveryFailure,
  persistedEmailDeliveryFailure,
} from './delivery'

export type EmailDeliveryExecutionResult =
  | 'delivered'
  | 'already_delivered'
  | 'stale'
  | 'permanently_failed'

export interface EmailDeliveryRecord {
  id: string
  deliveryState: string
  lastDeliveryError: string | null
}

export interface LoadedEmailDelivery<Event, Record extends EmailDeliveryRecord> {
  event: Event
  record: Record | null
}

export interface EmailDeliveryExecutorAdapter<Event, Record extends EmailDeliveryRecord> {
  leaseMs: number
  failureErrorMaxLength: number
  describe(event: Event): string
  lostLeaseMessage?(event: Event): string
  load(value: unknown, now: number): Promise<LoadedEmailDelivery<Event, Record>>
  acquireLease(
    loaded: LoadedEmailDelivery<Event, Record> & { record: Record },
    leaseId: string,
    now: number,
    leaseExpiresAtMs: number,
  ): Promise<boolean>
  inspect(
    loaded: LoadedEmailDelivery<Event, Record> & { record: Record },
  ): Promise<EmailDeliveryRecord | null>
  send(event: Event): Promise<void>
  markSent(
    loaded: LoadedEmailDelivery<Event, Record> & { record: Record },
    leaseId: string,
    completedAtMs: number,
  ): Promise<boolean>
  markFailed(
    loaded: LoadedEmailDelivery<Event, Record> & { record: Record },
    leaseId: string,
    persistedFailure: string,
    failedAtMs: number,
  ): Promise<void>
}

/**
 * Runs the shared Queue email state machine. Domain adapters own event identity
 * checks and their D1 statements; this executor owns terminal replay, lease,
 * send, and failure semantics.
 */
export async function executeLeasedEmailDelivery<Event, Record extends EmailDeliveryRecord>(
  value: unknown,
  adapter: EmailDeliveryExecutorAdapter<Event, Record>,
): Promise<EmailDeliveryExecutionResult> {
  const now = Date.now()
  const loaded = await adapter.load(value, now)
  if (loaded.record === null) return 'stale'
  const delivery = loaded as LoadedEmailDelivery<Event, Record> & { record: Record }

  if (delivery.record.deliveryState === 'sent') return 'already_delivered'
  if (
    delivery.record.deliveryState === 'failed' &&
    isPermanentEmailDeliveryFailure(delivery.record.lastDeliveryError)
  ) return 'permanently_failed'

  const leaseId = crypto.randomUUID()
  const acquired = await adapter.acquireLease(
    delivery,
    leaseId,
    now,
    now + adapter.leaseMs,
  )
  if (!acquired) {
    const current = await adapter.inspect(delivery)
    if (current?.deliveryState === 'sent') return 'already_delivered'
    if (isPermanentEmailDeliveryFailure(current?.lastDeliveryError)) {
      return 'permanently_failed'
    }
    throw new Error(`${adapter.describe(delivery.event)} already has an active lease`)
  }

  try {
    await adapter.send(delivery.event)
    const completedAt = Date.now()
    if (!(await adapter.markSent(delivery, leaseId, completedAt))) {
      throw new Error(
        adapter.lostLeaseMessage?.(delivery.event) ??
          `${adapter.describe(delivery.event)} lost its lease after sending`,
      )
    }
    return 'delivered'
  } catch (error) {
    const failure = emailDeliveryFailure(error)
    const persistedFailure = persistedEmailDeliveryFailure(failure)
      .slice(0, adapter.failureErrorMaxLength)
    await adapter.markFailed(delivery, leaseId, persistedFailure, Date.now())
    if (!failure.retryable) return 'permanently_failed'
    throw error
  }
}
