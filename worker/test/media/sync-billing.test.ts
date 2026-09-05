import { describe, expect, it, vi } from 'vitest'
import { isSettlementCommandEvent } from '../../src/gateway/recovery'
import { buildSyncImageUsagePayload, settleSyncImageBilling } from '../../src/media/sync-billing'

describe('synchronous image billing', () => {
  it('records image units without token charges', () => {
    expect(buildSyncImageUsagePayload({
      requestId: 'image-request-1',
      principal: {
        user_id: 'user-1', api_key_id: 'key-1', group_id: 'group-1',
        platform: 'openai', billing: { type: 'balance' },
      },
      accountId: 'account-1',
      priceId: 'price-1',
      requestedModel: 'gpt-image-2',
      upstreamModel: 'gpt-image-2-2026-01-01',
      amountMicros: 320_000,
      operation: 'generations',
      imageCount: 2,
      imageSize: '4K',
      imageInputSize: '2048x2048',
      imageOutputSize: '3840x2160',
      imageSizeSource: 'output',
      imageSizeBreakdown: { '1K': 1, '4K': 1 },
      startedAt: 1_000,
      occurredAt: 1_250,
    })).toEqual(expect.objectContaining({
      billing_mode: 'image',
      request_type: 1,
      inbound_endpoint: '/v1/images/generations',
      upstream_endpoint: '/v1/images/generations',
      amount_micros: 320_000,
      base_amount_micros: 320_000,
      standard_cost_micros: 320_000,
      account_stats_cost_micros: null,
      account_rate_multiplier_ppm: 1_000_000,
      account_cost_micros: 320_000,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      duration_ms: 250,
      outcome: 'completed',
      image_count: 2,
      image_size: '4K',
      image_input_size: '2048x2048',
      image_output_size: '3840x2160',
      image_size_source: 'output',
      image_size_breakdown: { '1K': 1, '4K': 1 },
    }))
  })

  it('distinguishes edits in operations data', () => {
    const payload = buildSyncImageUsagePayload({
      requestId: 'image-request-2',
      principal: {
        user_id: 'user-1', api_key_id: 'key-1', group_id: 'group-1',
        platform: 'openai', billing: { type: 'subscription', subscription_id: 'sub-1' },
      },
      accountId: 'account-1', priceId: 'price-1', requestedModel: 'gpt-image-2',
      upstreamModel: 'gpt-image-2', amountMicros: 0, operation: 'edits',
      startedAt: 1_000, occurredAt: 1_000,
    })
    expect(payload).toMatchObject({
      billing_type: 'subscription', subscription_id: 'sub-1', request_type: 1,
      inbound_endpoint: '/v1/images/edits', upstream_endpoint: '/v1/images/edits',
    })
  })

  it('records live Codex Images transport and cancellation attribution', () => {
    const payload = buildSyncImageUsagePayload({
      requestId: 'image-request-stream',
      principal: {
        user_id: 'user-1', api_key_id: 'key-1', group_id: 'group-1',
        platform: 'codex', billing: { type: 'balance' },
      },
      accountId: 'account-1', priceId: 'price-1', requestedModel: 'gpt-image-public',
      upstreamModel: 'gpt-image-upstream', amountMicros: 200_000, operation: 'generations',
      stream: true, outcome: 'cancelled', upstreamEndpoint: '/backend-api/codex/responses',
      startedAt: 1_000, occurredAt: 1_250,
    })
    expect(payload).toMatchObject({
      stream: true, request_type: 2, outcome: 'cancelled',
      inbound_endpoint: '/v1/images/generations',
      upstream_endpoint: '/backend-api/codex/responses',
    })
  })

  it('enqueues the complete durable settlement command when D1 is unavailable', async () => {
    const send = vi.fn(async (_event: unknown) => undefined)
    const statement = {
      bind() { return this },
      async run() { throw new Error('D1 unavailable') },
    }
    const env = {
      DB: { prepare: () => statement },
      EVENTS_QUEUE: { send },
    }
    await settleSyncImageBilling(env as never, {
      user_id: 'user-1', api_key_id: 'key-1', group_id: 'group-1', platform: 'openai',
      billing: { type: 'balance' }, platform_quota: { platform: 'openai' },
    } as never, {
      requestId: 'image-request-queue', accountId: 'account-1', priceId: 'price-1',
      requestedModel: 'gpt-image-2', upstreamModel: 'gpt-image-2', amountMicros: 100_000,
      initialReservedMicros: 80_000, operation: 'generations', startedAt: 1,
    })
    expect(send).toHaveBeenCalledOnce()
    expect(isSettlementCommandEvent(send.mock.calls[0]?.[0])).toBe(true)
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      event_type: 'settlement.command.v2',
      payload: {
        request_id: 'image-request-queue',
        initial_reserved_micros: 80_000,
        amount_micros: 100_000,
        usage_event: {
          payload: {
            standard_cost_micros: 100_000,
            account_stats_cost_micros: null,
            account_rate_multiplier_ppm: 1_000_000,
            account_cost_micros: 100_000,
          },
        },
      },
    })
  })
})
