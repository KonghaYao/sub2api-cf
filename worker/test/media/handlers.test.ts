import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { apiKeyDigest } from '../../src/gateway/crypto'
import {
  cancelGatewayMediaTask,
  cancelUserMediaTask,
  deleteGatewayMediaTask,
  deleteGatewayMediaTaskOutputs,
  deleteUserMediaTask,
  deleteUserMediaTaskOutputs,
  downloadGatewayMediaTask,
  downloadUserMediaTask,
  getGatewayMediaTask,
  getGatewayMediaTaskItemContent,
  listGatewayMediaTaskItems,
  listGatewayMediaTasks,
  listGatewayMediaModels,
  getUserMediaTask,
  getUserMediaTaskItemContent,
  listUserMediaTaskItems,
  listUserMediaModels,
  listUserMediaTasks,
  submitUserMediaTask,
  submitGatewayMediaTask,
} from '../../src/media/handlers'
import { consumeMediaTaskExecute, recoverPendingMediaTasks } from '../../src/media/queue'
import { consumeMediaProviderJobAdvance } from '../../src/media/provider-job'
import type { GeminiBatchClient } from '../../src/media/gemini-batch'
import type { MediaBilling, MediaEnv, MediaProvider } from '../../src/media/types'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const RAW_KEY = 'sk-media-test-key'
const PEPPER = 'media-handler-test-pepper-value-32-bytes'

async function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(
    `INSERT INTO users (
       id, email, display_name, balance_micros, concurrency, rpm_limit,
       created_at_ms, updated_at_ms
     ) VALUES ('user-1', 'media@example.test', 'Media User', 10000000, 2, 60, ?, ?)`,
  ).run(now, now)
  raw.prepare(
    `INSERT INTO "groups" (
       id, name, platform, enabled, rate_multiplier_ppm, group_type, is_exclusive,
       allow_image_generation, allow_batch_image_generation,
       image_price_1k_micros, image_price_2k_micros, image_price_4k_micros,
       created_at_ms, updated_at_ms
     ) VALUES (
       'group-1', 'Gemini images', 'gemini', 1, 1000000, 'standard', 0,
       1, 1, 100000, 200000, 400000, ?, ?
     )`,
  ).run(now, now)
  raw.prepare(
    `INSERT INTO api_keys (
       id, user_id, key_hash, name, enabled, group_id, key_prefix,
       created_at_ms, updated_at_ms
     ) VALUES ('key-1', 'user-1', ?, 'Media key', 1, 'group-1', 'sk-media', ?, ?)`,
  ).run(await apiKeyDigest(RAW_KEY, PEPPER), now, now)
  const accessToken = createOpaqueToken('access')
  const refreshToken = createOpaqueToken('refresh')
  raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms
     ) VALUES ('session-1', 'family-1', 'user-1', 1, ?, ?, ?, ?, ?)`,
  ).run(
    await tokenDigest(accessToken, PEPPER, 'access'),
    await tokenDigest(refreshToken, PEPPER, 'refresh'),
    now,
    now + 60_000,
    now + 600_000,
  )
  raw.exec(`
    INSERT INTO models (
      id, platform, public_name, upstream_name, endpoint, enabled, created_at_ms, updated_at_ms
    ) VALUES ('model-1', 'gemini', 'gemini-image', 'gemini-2.5-flash-image', 'responses', 1, 1, 1);
    INSERT INTO group_models (
      group_id, model_id, enabled, catalog_visible, created_at_ms, updated_at_ms
    ) VALUES ('group-1', 'model-1', 1, 1, 1, 1);
    INSERT INTO model_prices (
      id, group_id, model_id, version, active, input_micros_per_million,
      output_micros_per_million, cache_read_micros_per_million,
      per_request_micros, minimum_reservation_micros, effective_at_ms, created_at_ms
    ) VALUES ('price-1', 'group-1', 'model-1', 1, 1, 0, 0, 0, 0, 1, 1, 1);
    INSERT INTO accounts (
      id, platform, name, credential_ref, enabled, max_concurrency,
      created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, health_status
    ) VALUES (
      'account-1', 'gemini', 'Media account', 'secret-1', 1, 2,
      1, 1, 'gemini', 'https://generativelanguage.googleapis.com', 'x-goog-api-key', 'healthy'
    );
    INSERT INTO account_secrets (
      id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
    ) VALUES ('secret-1', 'account-1', 1, 'nonce', 'ciphertext', 1, 1);
    INSERT INTO account_groups (
      account_id, group_id, priority, weight, created_at_ms, updated_at_ms
    ) VALUES ('account-1', 'group-1', 1, 1, 1, 1);
    INSERT INTO account_models (
      account_id, model_id, chat_completions, responses, created_at_ms, updated_at_ms
    ) VALUES ('account-1', 'model-1', 0, 1, 1, 1);
  `)

  const objects = new Map<string, Uint8Array>()
  const bucket = {
    put: vi.fn(async (key: string, value: string | ArrayBuffer | ArrayBufferView) => {
      const bytes = typeof value === 'string'
        ? new TextEncoder().encode(value)
        : new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer)
      objects.set(key, bytes)
    }),
    get: vi.fn(async (key: string) => {
      const value = objects.get(key)
      if (value === undefined) return null
      return {
        body: new Blob([value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer]).stream(),
        size: value.byteLength,
        text: async () => new TextDecoder().decode(value),
        arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
      }
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key) }),
  } as unknown as R2Bucket
  const queued: unknown[] = []
  const reserve = vi.fn(async () => undefined)
  const renew = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  const settle = vi.fn(async () => undefined)
  const billing: MediaBilling = {
    reserve,
    renew,
    settle,
    cancel,
  }
  const provider: MediaProvider = {
    generate: vi.fn(async () => ({ items: [] })),
  }
  const namespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({ fetch: async () => Response.json({}) }),
  } as unknown as DurableObjectNamespace
  const env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: PEPPER,
    DB: d1,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: bucket,
    EVENTS_QUEUE: { send: async (value: unknown) => void queued.push(value) } as unknown as Queue,
    USER_STATE: namespace,
    POOL_STATE: namespace,
    ASSETS: {} as Fetcher,
    MEDIA_PROVIDER: provider,
    MEDIA_BILLING: billing,
  } as MediaEnv
  return { raw, env, objects, queued, reserve, renew, settle, cancel, sessionAuth: `Bearer ${accessToken}` }
}

function app() {
  const api = new Hono<{ Bindings: MediaEnv }>()
  api.post('/v1/images/batches', submitGatewayMediaTask)
  api.get('/v1/images/batches/models', listGatewayMediaModels)
  api.get('/v1/images/batches', listGatewayMediaTasks)
  api.get('/v1/images/batches/:id', getGatewayMediaTask)
  api.get('/v1/images/batches/:id/items', listGatewayMediaTaskItems)
  api.get('/v1/images/batches/:id/items/:customId/content', getGatewayMediaTaskItemContent)
  api.get('/v1/images/batches/:id/download', downloadGatewayMediaTask)
  api.post('/v1/images/batches/:id/cancel', cancelGatewayMediaTask)
  api.delete('/v1/images/batches/:id/outputs', deleteGatewayMediaTaskOutputs)
  api.delete('/v1/images/batches/:id', deleteGatewayMediaTask)
  api.post('/api/v1/user/image-batches', submitUserMediaTask)
  api.get('/api/v1/user/image-batches/models', listUserMediaModels)
  api.get('/api/v1/user/image-batches', listUserMediaTasks)
  api.get('/api/v1/user/image-batches/:id', getUserMediaTask)
  api.get('/api/v1/user/image-batches/:id/items', listUserMediaTaskItems)
  api.get('/api/v1/user/image-batches/:id/items/:customId/content', getUserMediaTaskItemContent)
  api.get('/api/v1/user/image-batches/:id/download', downloadUserMediaTask)
  api.post('/api/v1/user/image-batches/:id/cancel', cancelUserMediaTask)
  api.delete('/api/v1/user/image-batches/:id/outputs', deleteUserMediaTaskOutputs)
  api.delete('/api/v1/user/image-batches/:id', deleteUserMediaTask)
  return api
}

async function submit(test: Awaited<ReturnType<typeof fixture>>): Promise<Record<string, unknown>> {
  const response = await app().request('/v1/images/batches', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${RAW_KEY}`,
      'content-type': 'application/json',
      'idempotency-key': 'media-operation-0001',
    },
    body: JSON.stringify({
      model: 'gemini-image',
      provider: 'gemini_api',
      task_name: 'Campaign covers',
      image_size: '1K',
      response_mime_type: 'image/png',
      items: [{ custom_id: 'cover', prompt: 'A quiet lighthouse', output_count: 2 }],
    }),
  }, test.env)
  expect(response.status).toBe(200)
  return response.json() as Promise<Record<string, unknown>>
}

describe('media task handlers', () => {
  it('submits an owner-scoped task, reserves its price snapshot, and enqueues it', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111',
    )

    const body = await submit(test)

    expect(body).toMatchObject({
      id: 'imgbatch_11111111111141118111111111111111',
      object: 'image.batch',
      task_name: 'Campaign covers',
      status: 'queued',
      model: 'gemini-image',
      provider: 'gemini_api',
      item_count: 2,
      estimated_cost: 0.1,
      hold_amount: 0.12,
      actual_cost: null,
    })
    expect(test.reserve).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'media:imgbatch_11111111111141118111111111111111',
      amountMicros: 120000,
    }))
    expect(test.queued).toEqual([
      expect.objectContaining({
        event_type: 'media.task.execute.v1',
        aggregate_id: 'imgbatch_11111111111141118111111111111111',
        payload: { task_id: 'imgbatch_11111111111141118111111111111111' },
      }),
    ])
    expect([...test.objects.keys()]).toEqual([
      'media/test/imgbatch_11111111111141118111111111111111/input.json',
    ])
  })

  it('gets, lists, and cancels only tasks owned by the exact API key', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '22222222-2222-4222-8222-222222222222',
    )
    const submitted = await submit(test)
    const id = String(submitted.id)
    const auth = { authorization: `Bearer ${RAW_KEY}` }

    const detail = await app().request(`/v1/images/batches/${id}`, { headers: auth }, test.env)
    const list = await app().request('/v1/images/batches?limit=20', { headers: auth }, test.env)
    const items = await app().request(`/v1/images/batches/${id}/items`, { headers: auth }, test.env)
    const cancelled = await app().request(`/v1/images/batches/${id}/cancel`, {
      method: 'POST', headers: auth,
    }, test.env)

    expect(detail.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      object: 'list', data: [{ id, status: 'queued' }], has_more: false,
    })
    await expect(items.json()).resolves.toMatchObject({
      object: 'list',
      data: [
        { batch_id: id, custom_id: 'cover_01', status: 'queued', image_count: 0 },
        { batch_id: id, custom_id: 'cover_02', status: 'queued', image_count: 0 },
      ],
      has_more: false,
    })
    expect(cancelled.status).toBe(200)
    await expect(cancelled.json()).resolves.toMatchObject({ id, status: 'cancelled' })
    expect(test.cancel).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ id, api_key_id: 'key-1' }),
    }))

    const otherKey = 'sk-other-media-key'
    test.raw.prepare(
      `INSERT INTO api_keys (
         id, user_id, key_hash, name, enabled, group_id, key_prefix, created_at_ms, updated_at_ms
       ) VALUES ('key-2', 'user-1', ?, 'Other key', 1, 'group-1', 'sk-other', 1, 1)`,
    ).run(await apiKeyDigest(otherKey, PEPPER))
    const hidden = await app().request(`/v1/images/batches/${id}`, {
      headers: { authorization: `Bearer ${otherKey}` },
    }, test.env)
    expect(hidden.status).toBe(404)
  })

  it('lets a session submit and inspect a task by opaque owned API-key id', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '33333333-3333-4333-8333-333333333333',
    )
    const headers = {
      authorization: test.sessionAuth,
      'content-type': 'application/json',
      'idempotency-key': 'media-session-operation-0001',
    }
    const submitted = await app().request('/api/v1/user/image-batches', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        api_key_id: 'key-1',
        model: 'gemini-image',
        image_size: '1K',
        items: [{ custom_id: 'session-cover', prompt: 'A paper kite' }],
      }),
    }, test.env)

    expect(submitted.status).toBe(200)
    const envelope = await submitted.json() as { code: number; data: { id: string } }
    expect(envelope).toMatchObject({
      code: 0,
      data: { object: 'image.batch', status: 'queued', item_count: 1 },
    })
    const list = await app().request('/api/v1/user/image-batches?api_key_id=key-1&cursor=0', {
      headers: { authorization: test.sessionAuth },
    }, test.env)
    const detail = await app().request(`/api/v1/user/image-batches/${envelope.data.id}`, {
      headers: { authorization: test.sessionAuth },
    }, test.env)
    await expect(list.json()).resolves.toMatchObject({
      code: 0,
      data: { object: 'list', data: [{ id: envelope.data.id }] },
    })
    await expect(detail.json()).resolves.toMatchObject({
      code: 0,
      data: { id: envelope.data.id, model: 'gemini-image' },
    })
    const gatewayModels = await app().request('/v1/images/batches/models', {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    const userModels = await app().request('/api/v1/user/image-batches/models?api_key_id=key-1', {
      headers: { authorization: test.sessionAuth },
    }, test.env)
    await expect(gatewayModels.json()).resolves.toMatchObject({
      object: 'list', data: [{ id: 'gemini-image', object: 'model', provider: 'gemini_api' }],
    })
    await expect(userModels.json()).resolves.toMatchObject({
      code: 0,
      data: { object: 'list', data: [{ id: 'gemini-image' }] },
    })
  })

  it('executes one bounded output per queue event, settles successes, and serves R2 artifacts', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '44444444-4444-4444-8444-444444444444',
    )
    const generate = vi.fn(async (input: Parameters<MediaProvider['generate']>[0]) => ({
      accountId: 'account-1',
      items: [{
        customId: input.manifest.items[0].custom_id,
        outputs: [{ bytes: new Uint8Array([137, 80, 78, 71]).buffer, mimeType: 'image/png' as const }],
      }],
    }))
    test.env.MEDIA_PROVIDER = { generate }
    const submitted = await submit(test)
    const id = String(submitted.id)

    expect(await consumeMediaTaskExecute(test.queued.shift(), test.env)).toBe(true)
    expect(test.queued).toHaveLength(1)
    expect(await consumeMediaTaskExecute(test.queued.shift(), test.env)).toBe(true)

    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls.every(([input]) => input.manifest.items[0].output_count === 1)).toBe(true)
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({ amountMicros: 100000 }))
    const detail = await app().request(`/v1/images/batches/${id}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(detail.json()).resolves.toMatchObject({
      status: 'completed', success_count: 2, fail_count: 0, actual_cost: 0.1,
    })
    const items = await app().request(`/api/v1/user/image-batches/${id}/items`, {
      headers: { authorization: test.sessionAuth },
    }, test.env)
    await expect(items.json()).resolves.toMatchObject({
      code: 0,
      data: { data: [
        { custom_id: 'cover_01', status: 'succeeded', image_count: 1 },
        { custom_id: 'cover_02', status: 'succeeded', image_count: 1 },
      ] },
    })
    expect([...test.objects.keys()].sort()).toEqual([
      `media/test/${id}/input.json`,
      `media/test/${id}/outputs/0-0.png`,
      `media/test/${id}/outputs/1-0.png`,
    ].sort())

    const content = await app().request(`/v1/images/batches/${id}/items/cover_02/content?image_index=0`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toBe('image/png')
    expect(content.headers.get('content-disposition')).toBe('attachment; filename="cover_02.png"')
    expect([...new Uint8Array(await content.arrayBuffer())]).toEqual([137, 80, 78, 71])
    const zip = await app().request(`/api/v1/user/image-batches/${id}/download`, {
      headers: { authorization: test.sessionAuth },
    }, test.env)
    expect(zip.status).toBe(200)
    expect(zip.headers.get('content-type')).toContain('application/zip')
    expect(new TextDecoder().decode((await zip.arrayBuffer()).slice(0, 2))).toBe('PK')

    const deletedOutputs = await app().request(`/api/v1/user/image-batches/${id}/outputs`, {
      method: 'DELETE', headers: { authorization: test.sessionAuth },
    }, test.env)
    await expect(deletedOutputs.json()).resolves.toMatchObject({
      code: 0, data: { id, status: 'output_deleted' },
    })
    expect(test.objects.size).toBe(1)
    const gone = await app().request(`/v1/images/batches/${id}/items/cover_01/content`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    expect(gone.status).toBe(410)
    const deleted = await app().request(`/api/v1/user/image-batches/${id}`, {
      method: 'DELETE', headers: { authorization: test.sessionAuth },
    }, test.env)
    expect(deleted.status).toBe(204)
  })

  it('submits an eligible batch once, reconciles provider results, and settles through Queue', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '49494949-4949-4949-8949-494949494949',
    )
    test.env.BATCH_PROVIDER_JOBS_ENABLED = 'true'
    test.env.MEDIA_PROVIDER_JOB_ACCOUNT_RESOLVER = {
      select: vi.fn(async () => ({
        id: 'account-1', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'secret',
      })),
      exact: vi.fn(async () => ({
        id: 'account-1', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'secret',
      })),
    }
    const submitBatch = vi.fn(async () => ({
      providerJobId: 'batches/job-49', rawState: 'JOB_STATE_PENDING', pollAfterMs: 1_000,
    }))
    const succeededPoll = {
      state: 'succeeded' as const,
      rawState: 'JOB_STATE_SUCCEEDED',
      done: true,
      pollAfterMs: 1_000,
      items: [
        { customId: 'cover_01', outputs: [{ bytes: new Uint8Array([1, 2, 3]).buffer, mimeType: 'image/png' as const }] },
        { customId: 'cover_02', outputs: [{ bytes: new Uint8Array([4, 5, 6]).buffer, mimeType: 'image/png' as const }] },
      ],
    }
    const poll = vi.fn()
      .mockResolvedValueOnce({
        state: 'running', rawState: 'JOB_STATE_RUNNING', done: false, pollAfterMs: 1_000,
      })
      .mockResolvedValue(succeededPoll)
    test.env.MEDIA_PROVIDER_JOB_CLIENT = {
      submit: submitBatch,
      poll,
      cancel: vi.fn(async () => ({ requested: true as const })),
      findByDisplayName: vi.fn(async () => ({ status: 'absent' as const })),
    } satisfies GeminiBatchClient
    test.settle.mockRejectedValueOnce(new Error('transient settlement outage'))

    const submitted = await submit(test)
    const id = String(submitted.id)
    const first = test.queued.shift()
    expect(first).toMatchObject({
      event_type: 'media.provider_job.advance.v1',
      aggregate_id: id,
      payload: { task_id: id, expected_version: 0 },
    })
    expect(test.raw.prepare(
      'SELECT execution_mode FROM media_tasks WHERE id = ?',
    ).get(id)).toEqual({ execution_mode: 'provider_job_v1' })

    expect(await consumeMediaTaskExecute({
      schema_version: 1,
      event_id: `media-execute:${id}`,
      event_type: 'media.task.execute.v1',
      occurred_at_ms: Date.now(),
      aggregate_type: 'media_task',
      aggregate_id: id,
      payload: { task_id: id },
    }, test.env)).toBe(true)
    expect(submitBatch).not.toHaveBeenCalled()

    expect(await consumeMediaProviderJobAdvance(first, test.env)).toBe(true)
    expect(await consumeMediaProviderJobAdvance(first, test.env)).toBe(true)
    expect(submitBatch).toHaveBeenCalledTimes(1)
    expect(await consumeMediaProviderJobAdvance(test.queued.shift(), test.env)).toBe(true)
    const originalBatch = test.env.DB.batch.bind(test.env.DB)
    let rejectedResultCommit = false
    const batchSpy = vi.spyOn(test.env.DB, 'batch').mockImplementation(async (statements) => {
      const isResultCommit = statements.some((statement) =>
        String((statement as unknown as { sql?: string }).sql).includes("phase = 'materialize_pending'"))
      if (isResultCommit && !rejectedResultCommit) {
        rejectedResultCommit = true
        throw new Error('transient D1 result commit outage')
      }
      return originalBatch(statements)
    })
    expect(await consumeMediaProviderJobAdvance(test.queued.shift(), test.env)).toBe(true)
    expect([...test.objects.keys()]).toEqual([`media/test/${id}/input.json`])
    batchSpy.mockRestore()
    while (test.queued.length > 0) {
      expect(await consumeMediaProviderJobAdvance(test.queued.shift(), test.env)).toBe(true)
    }

    expect(poll).toHaveBeenCalledTimes(3)
    expect(test.settle).toHaveBeenCalledTimes(2)
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({ amountMicros: 100_000 }))
    const detail = await app().request(`/v1/images/batches/${id}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    const body = await detail.json() as Record<string, unknown>
    expect(body).toMatchObject({ status: 'completed', success_count: 2, fail_count: 0, actual_cost: 0.1 })
    expect(JSON.stringify(body)).not.toContain('batches/job-49')
    const objectKeys = [...test.objects.keys()].sort()
    expect(objectKeys).toHaveLength(4)
    expect(objectKeys).toContain(`media/test/${id}/input.json`)
    expect(objectKeys).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^media/test/${id}/provider/result-v\\d+-[a-f0-9]{16}\\.json$`)),
      expect.stringMatching(new RegExp(`^media/test/${id}/outputs/0-0-v\\d+-[a-f0-9]{16}\\.png$`)),
      expect.stringMatching(new RegExp(`^media/test/${id}/outputs/1-0-v\\d+-[a-f0-9]{16}\\.png$`)),
    ]))
  })

  it('keeps larger batches on the bounded per-item Queue path', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '52525252-5252-4252-8252-525252525252',
    )
    test.env.BATCH_PROVIDER_JOBS_ENABLED = 'true'
    const select = vi.fn()
    test.env.MEDIA_PROVIDER_JOB_ACCOUNT_RESOLVER = {
      select,
      exact: vi.fn(),
    }
    const response = await app().request('/v1/images/batches', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${RAW_KEY}`,
        'content-type': 'application/json',
        'idempotency-key': 'media-large-fallback-0001',
      },
      body: JSON.stringify({
        model: 'gemini-image',
        items: Array.from({ length: 9 }, (_, index) => ({ custom_id: `item-${index}`, prompt: `image ${index}` })),
      }),
    }, test.env)
    expect(response.status).toBe(200)
    const body = await response.json() as { id: string }
    expect(select).not.toHaveBeenCalled()
    expect(test.raw.prepare(
      'SELECT execution_mode FROM media_tasks WHERE id = ?',
    ).get(body.id)).toEqual({ execution_mode: 'inline_v1' })
    expect(test.queued).toEqual([expect.objectContaining({ event_type: 'media.task.execute.v1' })])
  })

  it('waits for the provider cancellation terminal state before releasing the hold', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '50505050-5050-4050-8050-505050505050',
    )
    test.env.BATCH_PROVIDER_JOBS_ENABLED = 'true'
    test.env.MEDIA_PROVIDER_JOB_ACCOUNT_RESOLVER = {
      select: vi.fn(async () => ({ id: 'account-1', baseUrl: 'https://gemini.test', apiKey: 'secret' })),
      exact: vi.fn(async () => ({ id: 'account-1', baseUrl: 'https://gemini.test', apiKey: 'secret' })),
    }
    const requestCancel = vi.fn(async () => ({ requested: true as const }))
    test.env.MEDIA_PROVIDER_JOB_CLIENT = {
      submit: vi.fn(async () => ({
        providerJobId: 'batches/job-cancel', rawState: 'JOB_STATE_PENDING', pollAfterMs: 1_000,
      })),
      poll: vi.fn()
        .mockResolvedValueOnce({
          state: 'running' as const,
          rawState: 'JOB_STATE_RUNNING',
          done: false,
          pollAfterMs: 1_000,
        })
        .mockResolvedValueOnce({
          state: 'cancelled' as const,
          rawState: 'JOB_STATE_CANCELLED',
          done: true,
          pollAfterMs: 1_000,
          error: { code: 'GEMINI_BATCH_CANCELLED', message: 'cancelled' },
        }),
      cancel: requestCancel,
      findByDisplayName: vi.fn(async () => ({ status: 'absent' as const })),
    }

    const submitted = await submit(test)
    const id = String(submitted.id)
    await consumeMediaProviderJobAdvance(test.queued.shift(), test.env)
    const response = await app().request(`/v1/images/batches/${id}/cancel`, {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ id, status: 'running' })
    expect(test.cancel).not.toHaveBeenCalled()

    while (requestCancel.mock.calls.length === 0 && test.queued.length > 0) {
      await consumeMediaProviderJobAdvance(test.queued.shift(), test.env)
    }
    const repeated = await app().request(`/v1/images/batches/${id}/cancel`, {
      method: 'POST', headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    expect(repeated.status).toBe(200)
    while (test.queued.length > 0) {
      await consumeMediaProviderJobAdvance(test.queued.shift(), test.env)
    }
    expect(requestCancel).toHaveBeenCalledTimes(1)
    expect(test.cancel).toHaveBeenCalledTimes(1)
    const final = await app().request(`/v1/images/batches/${id}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(final.json()).resolves.toMatchObject({ id, status: 'cancelled', actual_cost: 0 })
  })

  it('reports a provider deadline as a terminal failure instead of a user cancellation', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '54545454-5454-4454-8454-545454545454',
    )
    test.env.BATCH_PROVIDER_JOBS_ENABLED = 'true'
    test.env.MEDIA_PROVIDER_JOB_ACCOUNT_RESOLVER = {
      select: vi.fn(async () => ({ id: 'account-1', baseUrl: 'https://gemini.test', apiKey: 'secret' })),
      exact: vi.fn(async () => ({ id: 'account-1', baseUrl: 'https://gemini.test', apiKey: 'secret' })),
    }
    const requestCancel = vi.fn(async () => ({ requested: true as const }))
    test.env.MEDIA_PROVIDER_JOB_CLIENT = {
      submit: vi.fn(async () => ({
        providerJobId: 'batches/job-deadline', rawState: 'JOB_STATE_PENDING', pollAfterMs: 1_000,
      })),
      poll: vi.fn(async () => ({
        state: 'cancelled' as const,
        rawState: 'JOB_STATE_CANCELLED',
        done: true,
        pollAfterMs: 1_000,
        error: { code: 'GEMINI_BATCH_CANCELLED', message: 'cancelled' },
      })),
      cancel: requestCancel,
      findByDisplayName: vi.fn(async () => ({ status: 'absent' as const })),
    }

    const submitted = await submit(test)
    const id = String(submitted.id)
    await consumeMediaProviderJobAdvance(test.queued.shift(), test.env)
    test.raw.prepare(
      'UPDATE media_provider_jobs SET deadline_at_ms = created_at_ms WHERE task_id = ?',
    ).run(id)
    while (test.queued.length > 0) {
      await consumeMediaProviderJobAdvance(test.queued.shift(), test.env)
    }

    expect(requestCancel).toHaveBeenCalledTimes(1)
    expect(test.cancel).toHaveBeenCalledTimes(1)
    const final = await app().request(`/v1/images/batches/${id}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(final.json()).resolves.toMatchObject({
      id,
      status: 'completed',
      actual_cost: 0,
      error: { code: 'GEMINI_BATCH_DEADLINE_EXCEEDED' },
    })
  })

  it('settles a provider-initiated cancellation without local cancel metadata', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '56565656-5656-4656-8656-565656565656',
    )
    test.env.BATCH_PROVIDER_JOBS_ENABLED = 'true'
    test.env.MEDIA_PROVIDER_JOB_ACCOUNT_RESOLVER = {
      select: vi.fn(async () => ({ id: 'account-1', baseUrl: 'https://gemini.test', apiKey: 'secret' })),
      exact: vi.fn(async () => ({ id: 'account-1', baseUrl: 'https://gemini.test', apiKey: 'secret' })),
    }
    const requestCancel = vi.fn(async () => ({ requested: true as const }))
    test.env.MEDIA_PROVIDER_JOB_CLIENT = {
      submit: vi.fn(async () => ({
        providerJobId: 'batches/job-provider-cancel', rawState: 'JOB_STATE_PENDING', pollAfterMs: 1_000,
      })),
      poll: vi.fn(async () => ({
        state: 'cancelled' as const,
        rawState: 'JOB_STATE_CANCELLED',
        done: true,
        pollAfterMs: 1_000,
        error: { code: 'GEMINI_BATCH_CANCELLED', message: 'cancelled upstream' },
      })),
      cancel: requestCancel,
      findByDisplayName: vi.fn(async () => ({ status: 'absent' as const })),
    }

    const submitted = await submit(test)
    const id = String(submitted.id)
    while (test.queued.length > 0) {
      await consumeMediaProviderJobAdvance(test.queued.shift(), test.env)
    }

    expect(requestCancel).not.toHaveBeenCalled()
    expect(test.cancel).toHaveBeenCalledTimes(1)
    const final = await app().request(`/v1/images/batches/${id}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(final.json()).resolves.toMatchObject({ id, status: 'cancelled', actual_cost: 0 })
  })

  it('never blindly resubmits when the paid create response is ambiguous', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '51515151-5151-4151-8151-515151515151',
    )
    test.env.BATCH_PROVIDER_JOBS_ENABLED = 'true'
    test.env.MEDIA_PROVIDER_JOB_ACCOUNT_RESOLVER = {
      select: vi.fn(async () => ({ id: 'account-1', baseUrl: 'https://gemini.test', apiKey: 'secret' })),
      exact: vi.fn(async () => ({ id: 'account-1', baseUrl: 'https://gemini.test', apiKey: 'secret' })),
    }
    const submitBatch = vi.fn(async () => { throw new Error('response lost after create') })
    const findByDisplayName = vi.fn(async () => ({ status: 'absent' as const }))
    test.env.MEDIA_PROVIDER_JOB_CLIENT = {
      submit: submitBatch,
      poll: vi.fn(),
      cancel: vi.fn(async () => ({ requested: true as const })),
      findByDisplayName,
    }

    const submitted = await submit(test)
    const id = String(submitted.id)
    while (test.queued.length > 0) {
      await consumeMediaProviderJobAdvance(test.queued.shift(), test.env)
    }

    expect(submitBatch).toHaveBeenCalledTimes(1)
    expect(findByDisplayName).toHaveBeenCalledTimes(3)
    expect(test.raw.prepare(
      'SELECT phase, last_error_code FROM media_provider_jobs WHERE task_id = ?',
    ).get(id)).toEqual({ phase: 'attention', last_error_code: 'GEMINI_BATCH_SUBMIT_UNRESOLVED' })
    expect(test.settle).not.toHaveBeenCalled()
    expect(test.cancel).not.toHaveBeenCalled()
  })

  it('marks missing provider records failed and releases a zero-success hold', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '53535353-5353-4353-8353-535353535353',
    )
    test.env.BATCH_PROVIDER_JOBS_ENABLED = 'true'
    test.env.MEDIA_PROVIDER_JOB_ACCOUNT_RESOLVER = {
      select: vi.fn(async () => ({ id: 'account-1', baseUrl: 'https://gemini.test', apiKey: 'secret' })),
      exact: vi.fn(async () => ({ id: 'account-1', baseUrl: 'https://gemini.test', apiKey: 'secret' })),
    }
    test.env.MEDIA_PROVIDER_JOB_CLIENT = {
      submit: vi.fn(async () => ({
        providerJobId: 'batches/job-missing', rawState: 'JOB_STATE_PENDING', pollAfterMs: 1_000,
      })),
      poll: vi.fn(async () => ({
        state: 'succeeded' as const,
        rawState: 'JOB_STATE_SUCCEEDED',
        done: true,
        pollAfterMs: 1_000,
        items: [],
      })),
      cancel: vi.fn(async () => ({ requested: true as const })),
      findByDisplayName: vi.fn(async () => ({ status: 'absent' as const })),
    }

    const submitted = await submit(test)
    const id = String(submitted.id)
    while (test.queued.length > 0) {
      await consumeMediaProviderJobAdvance(test.queued.shift(), test.env)
    }

    expect(test.cancel).toHaveBeenCalledTimes(1)
    expect(test.settle).not.toHaveBeenCalled()
    const final = await app().request(`/v1/images/batches/${id}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(final.json()).resolves.toMatchObject({
      id,
      status: 'completed',
      success_count: 0,
      fail_count: 2,
      actual_cost: 0,
      error: { code: 'BATCH_IMAGE_ALL_ITEMS_FAILED' },
    })
  })

  it('charges completed outputs and releases the unused hold when cancellation races execution', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '45454545-4545-4545-8545-454545454545',
    )
    test.env.MEDIA_PROVIDER = {
      generate: vi.fn(async (input: Parameters<MediaProvider['generate']>[0]) => ({
        accountId: 'account-1',
        items: [{
          customId: input.manifest.items[0].custom_id,
          outputs: [{ bytes: new Uint8Array([1, 2, 3]).buffer, mimeType: 'image/png' as const }],
        }],
      })),
    }
    const submitted = await submit(test)
    const id = String(submitted.id)

    expect(await consumeMediaTaskExecute(test.queued.shift(), test.env)).toBe(true)
    const cancelled = await app().request(`/v1/images/batches/${id}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)

    expect(cancelled.status).toBe(200)
    await expect(cancelled.json()).resolves.toMatchObject({
      status: 'cancelled', success_count: 1, actual_cost: 0.05,
    })
    expect(test.settle).toHaveBeenCalledWith(expect.objectContaining({ amountMicros: 50_000 }))
    expect(test.cancel).not.toHaveBeenCalled()
  })

  it('recovers a committed queued task when queue publication was not recorded', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '55555555-5555-4555-8555-555555555555',
    )
    const submitted = await submit(test)
    const id = String(submitted.id)
    test.queued.splice(0)
    test.raw.prepare('UPDATE media_tasks SET enqueued_at_ms = NULL WHERE id = ?').run(id)

    await expect(recoverPendingMediaTasks(test.env, 10)).resolves.toMatchObject({ enqueued: 1 })
    expect(test.queued).toEqual([expect.objectContaining({ aggregate_id: id })])
  })

  it('fails and releases billing after a bounded number of permanent processing errors', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '66666666-6666-4666-8666-666666666666',
    )
    const generate = vi.fn(async () => { throw new Error('permanent provider configuration error') })
    test.env.MEDIA_PROVIDER = { generate }
    const submitted = await app().request('/v1/images/batches', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${RAW_KEY}`,
        'content-type': 'application/json',
        'idempotency-key': 'media-permanent-error-0001',
      },
      body: JSON.stringify({ model: 'gemini-image', items: [{ prompt: 'will fail' }] }),
    }, test.env)
    const id = String((await submitted.json() as { id: string }).id)
    const event = test.queued.shift()

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(consumeMediaTaskExecute(event, test.env)).rejects.toThrow('permanent provider')
    }
    await expect(consumeMediaTaskExecute(event, test.env)).resolves.toBe(true)

    const row = test.raw.prepare(
      'SELECT status, billing_status, actual_cost_micros FROM media_tasks WHERE id = ?',
    ).get(id) as Record<string, unknown>
    expect(row).toEqual({ status: 'completed', billing_status: 'released', actual_cost_micros: 0 })
    expect(generate).toHaveBeenCalledTimes(5)
    expect(test.cancel).toHaveBeenCalledTimes(1)

    const detail = await app().request(`/v1/images/batches/${id}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(detail.json()).resolves.toMatchObject({
      status: 'completed',
      error: { code: 'BATCH_IMAGE_ALL_ITEMS_FAILED' },
    })
    const failedContent = await app().request(
      `/v1/images/batches/${id}/items/item_000001/content`,
      { headers: { authorization: `Bearer ${RAW_KEY}` } },
      test.env,
    )
    expect(failedContent.status).toBe(409)
    await expect(failedContent.json()).resolves.toMatchObject({
      error: { code: 'BATCH_IMAGE_ITEM_FAILED' },
    })
  })

  it('replays idempotently, protects parent ownership, and supports legacy offset cursors', async () => {
    const test = await fixture()
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('77777777-7777-4777-8777-777777777777')
      .mockReturnValueOnce('88888888-8888-4888-8888-888888888888')
    const payload = {
      model: 'gemini-image',
      items: [{ custom_id: 'root', prompt: 'root image' }],
    }
    const headers = {
      authorization: `Bearer ${RAW_KEY}`,
      'content-type': 'application/json',
      'idempotency-key': 'media-idempotency-parent-0001',
    }
    const first = await app().request('/v1/images/batches', {
      method: 'POST', headers, body: JSON.stringify(payload),
    }, test.env)
    const replay = await app().request('/v1/images/batches', {
      method: 'POST', headers, body: JSON.stringify(payload),
    }, test.env)
    const root = await first.json() as { id: string }
    expect(await replay.json()).toMatchObject({ id: root.id })
    expect(test.reserve).toHaveBeenCalledTimes(1)
    expect(test.queued).toHaveLength(1)

    const conflict = await app().request('/v1/images/batches', {
      method: 'POST', headers, body: JSON.stringify({ ...payload, task_name: 'different' }),
    }, test.env)
    expect(conflict.status).toBe(409)
    const child = await app().request('/v1/images/batches', {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'media-idempotency-parent-0002' },
      body: JSON.stringify({ ...payload, parent_batch_id: root.id }),
    }, test.env)
    expect(child.status).toBe(200)
    const childBody = await child.json() as { id: string }

    const firstPage = await app().request('/v1/images/batches?limit=1&cursor=0', {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    const secondPage = await app().request('/v1/images/batches?limit=1&cursor=1', {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(firstPage.json()).resolves.toMatchObject({
      data: [{ id: childBody.id }], has_more: true, next_cursor: '1',
    })
    await expect(secondPage.json()).resolves.toMatchObject({ data: [{ id: root.id }] })

    const otherKey = 'sk-parent-other-key'
    test.raw.prepare(
      `INSERT INTO api_keys (
         id, user_id, key_hash, name, enabled, group_id, key_prefix, created_at_ms, updated_at_ms
       ) VALUES ('key-parent-other', 'user-1', ?, 'Other parent key', 1, 'group-1', 'sk-other', 1, 1)`,
    ).run(await apiKeyDigest(otherKey, PEPPER))
    const crossOwner = await app().request('/v1/images/batches', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${otherKey}`,
        'content-type': 'application/json',
        'idempotency-key': 'media-cross-parent-0001',
      },
      body: JSON.stringify({ ...payload, parent_batch_id: root.id }),
    }, test.env)
    expect(crossOwner.status).toBe(400)
    await expect(crossOwner.json()).resolves.toMatchObject({
      error: { code: 'BATCH_IMAGE_PARENT_NOT_FOUND' },
    })
  })
})
