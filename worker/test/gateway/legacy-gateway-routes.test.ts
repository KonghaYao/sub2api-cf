import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'

type Row = Record<string, unknown>

class PrincipalStatement {
  constructor(private readonly query: string) {}
  bind(): this {
    return this
  }

  async first<T>(): Promise<T> {
    if (this.query.includes('SELECT gateway_json FROM system_settings')) return { gateway_json: '{}' } as T
    return {
      api_key_id: 'key-1',
      api_key_auth_version: 1,
      api_key_enabled: 1,
      expires_at_ms: null,
      revoked_at_ms: null,
      user_id: 'user-1',
      user_status: 'active',
      balance_micros: 1_000_000,
      user_state_version: 0,
      limit_config_version: 1,
      concurrency_limit: 0,
      user_rpm_limit: 0,
      group_rpm_limit: 0,
      api_key_control_version: 0,
      quota_micros: 0,
      quota_used_micros: 0,
      rate_limit_5h_micros: 0,
      rate_limit_1d_micros: 0,
      rate_limit_7d_micros: 0,
      usage_5h_micros: 0,
      usage_1d_micros: 0,
      usage_7d_micros: 0,
      window_5h_start_ms: null,
      window_1d_start_ms: null,
      window_7d_start_ms: null,
      api_key_quota_reset_epoch: 0,
      api_key_rate_limit_reset_epoch: 0,
      group_id: 'group-1',
      group_enabled: 1,
      group_accessible: 1,
      platform: 'openai',
      group_type: 'standard',
      subscription_id: null,
    } as T
  }
}

function validationEnv(): Env {
  return {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: 'p'.repeat(32),
    DB: { prepare: (query: string) => new PrincipalStatement(query) } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  }
}

async function error(response: Response): Promise<Row> {
  return (await response.json() as { error: Row }).error
}

describe('legacy Responses and Codex subroute registration', () => {
  it.each([
    '/v1/responses/compact',
    '/responses/compact',
    '/backend-api/codex/responses/compact',
    '/v1/responses/input_tokens',
    '/responses/input_tokens',
    '/backend-api/codex/responses/input_tokens',
    '/backend-api/codex/responses',
  ])('keeps %s behind the OpenAI authentication contract', async (path) => {
    const response = await createApp().request(path, { method: 'POST' }, validationEnv())
    expect(response.status).toBe(401)
    expect(await error(response)).toMatchObject({
      type: 'authentication_error',
      code: 'api_key_required',
    })
  })
})

describe('legacy OpenAI embeddings validation contract', () => {
  it.each([
    [{ model: 'embedding-public', input: '', stream: undefined }, 'invalid_input'],
    [{ model: 'embedding-public', input: [] }, 'invalid_input'],
    [{ model: 'embedding-public', input: ['valid', 1] }, 'invalid_input'],
    [{ model: 'embedding-public', input: [[1, -1]] }, 'invalid_input'],
    [{ model: 'embedding-public', input: 'hello', stream: true }, 'invalid_stream'],
    [{ model: 'embedding-public', input: 'hello', proxy_url: 'http://localhost' }, 'unsupported_transport_control'],
    [{ model: 'embedding-public', input: 'hello', unsupported: true }, 'invalid_request_error'],
  ])('rejects invalid input before capacity or billing: %#j', async (body, code) => {
    const response = await createApp().request('/v1/embeddings', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-customer',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }, validationEnv())

    expect(response.status).toBe(400)
    expect(await error(response)).toMatchObject({ code })
  })
})
