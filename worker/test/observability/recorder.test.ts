import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { consumeEvents } from '../../src/gateway/queue'
import {
  consumeObservabilityPayloadRetry,
  recordRequestContext,
  recordRequestOutcome,
  recordRequestStart,
} from '../../src/observability/recorder'
import type { ObservabilityPayloadRetryMessage } from '../../src/observability/types'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function fixture(failPut = false) {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const objects = new Map<string, string>()
  const put = vi.fn(async (key: string, value: unknown) => {
    if (failPut) throw new Error('R2 unavailable')
    objects.set(key, typeof value === 'string' ? value : await new Response(value as BodyInit).text())
  })
  const messages: ObservabilityPayloadRetryMessage[] = []
  const env = {
    DB: d1,
    OBJECTS: { put, get: vi.fn(), delete: vi.fn(), list: vi.fn() },
    EVENTS_QUEUE: { send: vi.fn(async (message: ObservabilityPayloadRetryMessage) => { messages.push(message) }) },
  } as unknown as Env
  return { raw, env, objects, put, messages, setFailPut(value: boolean) { failPut = value } }
}

describe('request observation recorder', () => {
  it('records terminal metadata and stores only a redacted R2 payload', async () => {
    const test = fixture()
    const handle = await recordRequestStart(test.env, {
      requestId: 'req-observe-1', userId: 'alice', method: 'POST', requestPath: '/v1/responses',
      requestedModel: 'gpt-5.5', stream: true, clientIp: '203.0.113.8', userAgent: 'test-agent/1',
    })
    expect(handle).not.toBeNull()
    await expect(recordRequestContext(test.env, handle!, {
      upstreamEndpoint: '/responses',
    })).resolves.toBe(true)
    await expect(recordRequestOutcome(test.env, handle!, {
      lifecycle: 'completed', statusCode: 200, durationMs: 25, inputTokens: 2,
      outputTokens: 3, amountMicros: 10,
      payload: { request: { body: { model: 'gpt-5.5', api_key: 'sk-never-store-this' } } },
    })).resolves.toBe(true)

    const row = test.raw.prepare(
      `SELECT lifecycle, payload_state, payload_object_key, input_tokens, amount_micros,
              upstream_endpoint, client_ip, user_agent
         FROM request_observations WHERE request_id = 'req-observe-1'`,
    ).get() as Record<string, unknown>
    expect(row).toMatchObject({
      lifecycle: 'completed', payload_state: 'stored', input_tokens: 2, amount_micros: 10,
      upstream_endpoint: '/responses', client_ip: '203.0.113.8', user_agent: 'test-agent/1',
    })
    expect(row.payload_object_key).toMatch(/^observability\/v1\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\/[a-f0-9]{16}\.json$/)
    const payload = test.objects.get(String(row.payload_object_key))!
    expect(payload).toContain('[REDACTED]')
    expect(payload).not.toContain('sk-never-store-this')
    test.raw.close()
  })

  it('does not reject the gateway finalizer when R2 fails and recovers idempotently through Queue', async () => {
    const test = fixture(true)
    const handle = await recordRequestStart(test.env, {
      requestId: 'req-observe-r2-retry', userId: 'alice', method: 'POST', requestPath: '/v1/messages',
    })
    await expect(recordRequestOutcome(test.env, handle!, {
      lifecycle: 'failed', statusCode: 502,
      error: { phase: 'upstream', type: 'upstream_error', owner: 'provider', message: 'bad gateway' },
      payload: { error: { body: { authorization: 'Bearer never-store-this' } } },
    })).resolves.toBe(true)
    expect(test.messages.some(message=>(message as unknown as {event_type:string}).event_type==='ops.system-log.v1')).toBe(true)
    test.messages.splice(0,test.messages.length,...test.messages.filter(message=>(message as unknown as {event_type:string}).event_type!=='ops.system-log.v1'))
    expect(test.messages).toHaveLength(1)
    expect(test.raw.prepare(
      `SELECT lifecycle, payload_state, payload_attempts FROM request_observations
        WHERE request_id = 'req-observe-r2-retry'`,
    ).get()).toEqual({ lifecycle: 'failed', payload_state: 'retry', payload_attempts: 1 })

    const queueMessage = {
      id: 'observability-retry-1', timestamp: new Date(), attempts: 1,
      body: test.messages[0]!, ack: vi.fn(), retry: vi.fn(),
    }
    await consumeEvents(
      { queue: 'events', messages: [queueMessage] } as unknown as MessageBatch<unknown>,
      test.env,
    )
    expect(queueMessage.ack).toHaveBeenCalledOnce()
    expect(queueMessage.retry).not.toHaveBeenCalled()
    expect(test.messages).toHaveLength(2)
    expect(test.messages[1]).toMatchObject({
      observation_id: test.messages[0]!.observation_id,
      attempt: test.messages[0]!.attempt + 1,
    })

    test.setFailPut(false)
    const retriedQueueMessage = {
      id: 'observability-retry-2', timestamp: new Date(), attempts: 1,
      body: test.messages[1]!, ack: vi.fn(), retry: vi.fn(),
    }
    await consumeEvents(
      { queue: 'events', messages: [retriedQueueMessage] } as unknown as MessageBatch<unknown>,
      test.env,
    )
    expect(retriedQueueMessage.ack).toHaveBeenCalledOnce()
    expect(retriedQueueMessage.retry).not.toHaveBeenCalled()
    await expect(consumeObservabilityPayloadRetry(test.env, test.messages[0]!)).resolves.toBe(true)
    expect(test.raw.prepare(
      `SELECT payload_state FROM request_observations WHERE request_id = 'req-observe-r2-retry'`,
    ).get()).toEqual({ payload_state: 'stored' })
    expect([...test.objects.values()].join('')).not.toContain('never-store-this')
    test.raw.close()
  })
})
