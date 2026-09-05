import { describe, expect, it, vi } from 'vitest'
import { durableObjectMediaBilling } from '../../src/media/billing'
import type { MediaEnv, MediaTaskRow } from '../../src/media/types'

interface StateCall {
  namespace: 'user' | 'subscription' | 'api-key'
  name: string
  path: string
  body: Record<string, unknown>
}

function fixture(respond: (call: StateCall) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const calls: StateCall[] = []
  const namespace = (kind: StateCall['namespace']) => ({
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (name: DurableObjectId) => ({
      fetch: vi.fn(async (request: Request) => {
        const call = {
          namespace: kind,
          name: String(name),
          path: new URL(request.url).pathname,
          body: await request.json() as Record<string, unknown>,
        }
        calls.push(call)
        return respond(call)
      }),
    }),
  }) as unknown as DurableObjectNamespace
  const env = {
    USER_STATE: namespace('user'),
    SUBSCRIPTION_STATE: namespace('subscription'),
    API_KEY_LIMIT_STATE: namespace('api-key'),
  } as MediaEnv
  return { env, calls }
}

function task(overrides: Partial<MediaTaskRow> = {}): MediaTaskRow {
  return {
    id: 'task-1',
    user_id: 'user-1',
    api_key_id: 'key-1',
    billing_type: 'balance',
    subscription_id: null,
    platform_quota_platform: 'gemini',
    ...overrides,
  } as MediaTaskRow
}

describe('durable object media billing renewal', () => {
  it('renews balance, API-key monetary, and platform reservations with one stable identity', async () => {
    const { env, calls } = fixture()

    await durableObjectMediaBilling.renew({ env, task: task(), sequence: 7 })

    expect(calls).toEqual([
      {
        namespace: 'user',
        name: 'user-1',
        path: '/renew',
        body: expect.objectContaining({ request_id: 'media:task-1', renewal_sequence: 7 }),
      },
      {
        namespace: 'api-key',
        name: 'user:user-1',
        path: '/monetary/renew',
        body: expect.objectContaining({
          request_id: 'media:task-1', api_key_id: 'key-1', renewal_sequence: 7,
        }),
      },
      {
        namespace: 'api-key',
        name: 'user:user-1',
        path: '/platform-quota/renew',
        body: expect.objectContaining({
          request_id: 'media:task-1', user_id: 'user-1', platform: 'gemini', renewal_sequence: 7,
        }),
      },
    ])
  })

  it('renews the subscription and API-key authorities without consuming balance-only platform quota', async () => {
    const { env, calls } = fixture()

    await durableObjectMediaBilling.renew({
      env,
      task: task({ billing_type: 'subscription', subscription_id: 'subscription-1' }),
      sequence: 8,
    })

    expect(calls).toEqual([
      {
        namespace: 'subscription',
        name: 'subscription-1',
        path: '/renew',
        body: expect.objectContaining({ request_id: 'media:task-1', renewal_sequence: 8 }),
      },
      {
        namespace: 'api-key',
        name: 'user:user-1',
        path: '/monetary/renew',
        body: expect.objectContaining({ request_id: 'media:task-1', renewal_sequence: 8 }),
      },
    ])
  })

  it('propagates a partial authority failure and safely retries the same sequence and request ID', async () => {
    let failMonetary = true
    const { env, calls } = fixture((call) => {
      if (call.path === '/monetary/renew' && failMonetary) {
        failMonetary = false
        return Response.json({
          error: { code: 'api_key_state_unavailable', message: 'API key renewal unavailable' },
        }, { status: 503 })
      }
      return Response.json({ ok: true })
    })
    const input = { env, task: task(), sequence: 11 }

    await expect(durableObjectMediaBilling.renew(input)).rejects.toThrow('API key renewal unavailable')
    await expect(durableObjectMediaBilling.renew(input)).resolves.toBeUndefined()

    expect(calls).toHaveLength(6)
    expect(calls.map((call) => call.body.request_id)).toEqual(Array(6).fill('media:task-1'))
    expect(calls.map((call) => call.body.renewal_sequence)).toEqual(Array(6).fill(11))
  })
})
