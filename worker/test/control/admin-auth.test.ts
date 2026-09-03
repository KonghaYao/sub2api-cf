import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/env'

function env(): Env {
  return {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    ADMIN_TOKEN: 'a'.repeat(32),
    API_KEY_PEPPER: 'p'.repeat(32),
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
        }),
      }),
    } as unknown as D1Database,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace,
  }
}

describe('admin control-plane authentication', () => {
  it('rejects missing and incorrect admin sessions before routing admin APIs', async () => {
    const app = createApp()

    const missing = await app.request('/api/v1/admin/users', {}, env())
    const incorrect = await app.request(
      '/api/v1/admin/users',
      { headers: { authorization: `Bearer ${'s'.repeat(32)}` } },
      env(),
    )

    expect(missing.status).toBe(401)
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'admin_session_required' },
    })
    expect(incorrect.status).toBe(401)
    await expect(incorrect.json()).resolves.toMatchObject({
      error: { code: 'invalid_admin_session' },
    })
  })

  it('keeps the break-glass token scoped to bootstrap', async () => {
    const response = await createApp().request(
      '/api/v1/admin/users',
      { headers: { authorization: `Bearer ${'a'.repeat(32)}` } },
      env(),
    )

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_admin_session' },
    })
  })
})
