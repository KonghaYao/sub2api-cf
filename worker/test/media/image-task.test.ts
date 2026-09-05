import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { apiKeyDigest, encryptCredential } from '../../src/gateway/crypto'
import {
  consumeImageTaskExecute,
  getAsyncImageTask,
  getAsyncImageTaskContent,
  recoverImageTasks,
  submitAsyncImageTask,
} from '../../src/media/image-task'
import type { SyncImageBilling } from '../../src/media/sync-billing'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const RAW_KEY = 'sk-async-image-owner'
const OTHER_RAW_KEY = 'sk-async-image-other-key'
const PEPPER = 'async-image-pepper-value-at-least-32-bytes'
const MASTER_KEY = 'async-image-master-key-value-at-least-32-bytes'

interface StoredObject {
  bytes: Uint8Array
  contentType: string | null
}

async function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  raw.prepare(`INSERT INTO users (
    id,email,display_name,balance_micros,concurrency,rpm_limit,created_at_ms,updated_at_ms
  ) VALUES ('user-1','async-image@example.test','Async Image User',10000000,2,60,?,?)`).run(now, now)
  raw.prepare(`INSERT INTO "groups" (
    id,name,platform,enabled,rate_multiplier_ppm,group_type,is_exclusive,
    allow_image_generation,image_rate_independent,image_rate_multiplier_ppm,
    image_price_1k_micros,image_price_2k_micros,image_price_4k_micros,created_at_ms,updated_at_ms
  ) VALUES ('group-1','Async Images','openai',1,1000000,'standard',0,1,1,1000000,
    100000,200000,400000,?,?)`).run(now, now)
  raw.prepare(`INSERT INTO api_keys (
    id,user_id,key_hash,name,enabled,group_id,key_prefix,created_at_ms,updated_at_ms
  ) VALUES ('key-1','user-1',?,'Owner key',1,'group-1','sk-owner',?,?)`)
    .run(await apiKeyDigest(RAW_KEY, PEPPER), now, now)
  raw.prepare(`INSERT INTO api_keys (
    id,user_id,key_hash,name,enabled,group_id,key_prefix,created_at_ms,updated_at_ms
  ) VALUES ('key-2','user-1',?,'Other key',1,'group-1','sk-other',?,?)`)
    .run(await apiKeyDigest(OTHER_RAW_KEY, PEPPER), now, now)

  const encrypted = await encryptCredential(
    { api_key: 'upstream-secret' },
    MASTER_KEY,
    'test/account-1/secret-1/1',
  )
  raw.exec(`INSERT INTO models (
    id,platform,public_name,upstream_name,endpoint,image_generation,enabled,created_at_ms,updated_at_ms
  ) VALUES ('model-1','openai','gpt-image-2','gpt-image-upstream','responses',1,1,1,1);
  INSERT INTO group_models (group_id,model_id,enabled,catalog_visible,created_at_ms,updated_at_ms)
    VALUES ('group-1','model-1',1,1,1,1);
  INSERT INTO model_prices (
    id,group_id,model_id,version,active,input_micros_per_million,output_micros_per_million,
    cache_read_micros_per_million,per_request_micros,minimum_reservation_micros,effective_at_ms,created_at_ms
  ) VALUES ('price-1','group-1','model-1',1,1,0,0,0,0,1,1,1);
  INSERT INTO accounts (
    id,platform,name,credential_ref,enabled,max_concurrency,created_at_ms,updated_at_ms,
    protocol,base_url,auth_scheme,health_status,image_adapter,credential_kind
  ) VALUES ('account-1','openai','Image upstream','secret-1',1,2,1,1,'openai',
    'https://api.openai.com','bearer','healthy','direct_images','api_key');
  INSERT INTO account_secrets (
    id,account_id,key_version,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms
  ) VALUES ('secret-1','account-1',1,'${encrypted.nonce_b64}','${encrypted.ciphertext_b64}',1,1);
  INSERT INTO account_groups (account_id,group_id,priority,weight,created_at_ms,updated_at_ms)
    VALUES ('account-1','group-1',1,1,1,1);
  INSERT INTO account_models (
    account_id,model_id,chat_completions,responses,embeddings,image_generation,created_at_ms,updated_at_ms
  ) VALUES ('account-1','model-1',0,0,0,1,1,1);`)

  const objects = new Map<string, StoredObject>()
  let outputPutCount = 0
  let failedOutputPut = Number.POSITIVE_INFINITY
  let failedResultPut = false
  const putObject = async (key: string, value: string | ArrayBuffer | ArrayBufferView) => {
    if (key.includes('/outputs/')) {
      outputPutCount += 1
      if (outputPutCount === failedOutputPut) throw new Error('R2 write failed')
    }
    if (key.endsWith('/result.json') && failedResultPut) throw new Error('R2 result write failed')
    const bytes = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value.slice(0))
        : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
    objects.set(key, { bytes, contentType: null })
  }
  const bucket = {
    put: vi.fn(putObject),
    get: vi.fn(async (key: string) => {
      const stored = objects.get(key)
      if (stored === undefined) return null
      const buffer = stored.bytes.buffer.slice(
        stored.bytes.byteOffset,
        stored.bytes.byteOffset + stored.bytes.byteLength,
      ) as ArrayBuffer
      return {
        body: new Blob([buffer]).stream(),
        size: stored.bytes.byteLength,
        arrayBuffer: async () => buffer.slice(0),
        text: async () => new TextDecoder().decode(stored.bytes),
        json: async <T>() => JSON.parse(new TextDecoder().decode(stored.bytes)) as T,
      }
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key) }),
    list: vi.fn(async (options: R2ListOptions) => ({
      objects: [...objects.keys()]
        .filter((key) => key.startsWith(options.prefix ?? ''))
        .map((key) => ({ key })),
      truncated: false,
    })),
  } as unknown as R2Bucket
  const queued: unknown[] = []
  const reserve = vi.fn(async () => undefined)
  const settle = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  const billing: SyncImageBilling = { reserve, settle, cancel }
  const stateCalls: string[] = []
  const namespace = {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({ fetch: async (request: Request) => {
      const path = new URL(request.url).pathname
      stateCalls.push(path)
      if (path === '/admit') {
        const body = await request.json() as { request_id: string }
        return Response.json({ admitted: true, lease: { request_id: body.request_id, status: 'active' } })
      }
      if (path === '/reserve') return Response.json({ lease: { account_id: 'account-1', status: 'active' } })
      return Response.json({ ok: true })
    } }),
  } as unknown as DurableObjectNamespace
  const imageBytes = new Uint8Array(24)
  imageBytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  imageBytes.set([0, 0, 4, 0, 0, 0, 4, 0], 16)
  const upstreamFetch = vi.fn(async () => Response.json({
    created: 1710000000,
    data: [{ b64_json: encodeBase64(imageBytes), revised_prompt: 'A quiet lighthouse' }],
  }))
  const downloadFetch = vi.fn<typeof fetch>(async () => {
    throw new Error('unexpected image download')
  })
  const env = {
    APP_VERSION: 'test',
    ENVIRONMENT: 'test',
    API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: MASTER_KEY,
    DB: d1,
    CONFIG_KV: {} as KVNamespace,
    OBJECTS: bucket,
    EVENTS_QUEUE: { send: vi.fn(async (event: unknown) => { queued.push(event) }) } as unknown as Queue,
    USER_STATE: namespace,
    API_KEY_LIMIT_STATE: namespace,
    POOL_STATE: namespace,
    ASSETS: {} as Fetcher,
    SYNC_IMAGE_BILLING: billing,
    SYNC_IMAGE_UPSTREAM_FETCH: upstreamFetch,
    ASYNC_IMAGE_DOWNLOAD_FETCH: downloadFetch,
  } as unknown as Env
  return {
    raw, env, objects, queued, upstreamFetch, downloadFetch, reserve, settle, cancel, imageBytes,
    failOutputPutAt: (index: number) => { failedOutputPut = index },
    failResultPut: () => { failedResultPut = true },
  }
}

function app() {
  const api = new Hono<{ Bindings: Env }>()
  api.post('/v1/images/generations/async', (context) => submitAsyncImageTask(context, 'generations'))
  api.post('/images/generations/async', (context) => submitAsyncImageTask(context, 'generations'))
  api.post('/v1/images/edits/async', (context) => submitAsyncImageTask(context, 'edits'))
  api.post('/images/edits/async', (context) => submitAsyncImageTask(context, 'edits'))
  api.get('/v1/images/tasks/:id', getAsyncImageTask)
  api.get('/images/tasks/:id', getAsyncImageTask)
  api.get('/v1/images/tasks/:id/content/:index', getAsyncImageTaskContent)
  return api
}

async function submit(test: Awaited<ReturnType<typeof fixture>>): Promise<{
  response: Response
  body: Record<string, unknown>
}> {
  const response = await app().request('/v1/images/generations/async', {
    method: 'POST',
    headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-2', prompt: 'A quiet lighthouse', size: '1024x1024' }),
  }, test.env)
  return { response, body: await response.clone().json() as Record<string, unknown> }
}

describe('ordinary asynchronous Images contract', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('accepts a task with the legacy polling envelope and response headers', async () => {
    const test = await fixture()
    const { response, body } = await submit(test)

    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('retry-after')).toBe('3')
    expect(response.headers.get('location')).toBe(`/v1/images/tasks/${String(body.task_id)}`)
    expect(body).toMatchObject({
      id: expect.stringMatching(/^imgtask_[a-f0-9]{32}$/),
      task_id: expect.stringMatching(/^imgtask_[a-f0-9]{32}$/),
      object: 'image.generation.task',
      status: 'processing',
      created_at: expect.any(Number),
      expires_at: expect.any(Number),
      poll_url: `/v1/images/tasks/${String(body.task_id)}`,
    })
    expect(body.id).toBe(body.task_id)
    expect(test.queued).toHaveLength(1)
  })

  it('rejects stream:true before creating durable state', async () => {
    const test = await fixture()
    const response = await app().request('/v1/images/generations/async', {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'cat', stream: true }),
    }, test.env)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'IMAGE_ASYNC_STREAM_UNSUPPORTED' },
    })
    expect(test.raw.prepare('SELECT count(*) AS count FROM image_tasks').get() as { count: number }).toEqual({ count: 0 })
    expect(test.objects.size).toBe(0)
    expect(test.queued).toHaveLength(0)
  })

  it('rejects disabled image groups before creating durable state', async () => {
    const test = await fixture()
    test.raw.prepare("UPDATE \"groups\" SET allow_image_generation=0 WHERE id='group-1'").run()

    const { response } = await submit(test)

    expect(response.status).toBe(403)
    expect(test.raw.prepare('SELECT count(*) AS count FROM image_tasks').get()).toEqual({ count: 0 })
    expect(test.objects.size).toBe(0)
    expect(test.queued).toHaveLength(0)
  })

  it('runs configured moderation before creating durable state', async () => {
    const test = await fixture()
    const check = vi.fn(async () => ({ allowed: false, message: 'blocked prompt' }))
    ;(test.env as Env & { SYNC_IMAGE_MODERATOR: { check: typeof check } }).SYNC_IMAGE_MODERATOR = { check }

    const { response } = await submit(test)

    expect(response.status).toBe(400)
    expect(check).toHaveBeenCalledTimes(1)
    expect(test.raw.prepare('SELECT count(*) AS count FROM image_tasks').get()).toEqual({ count: 0 })
    expect(test.objects.size).toBe(0)
    expect(test.queued).toHaveLength(0)
  })

  it('polls processing tasks for the exact API-key owner and hides them from another key', async () => {
    const test = await fixture()
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)

    const owned = await app().request(`/v1/images/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    expect(owned.status).toBe(200)
    expect(owned.headers.get('cache-control')).toBe('no-store')
    expect(owned.headers.get('retry-after')).toBe('3')
    await expect(owned.json()).resolves.toMatchObject({ task_id: taskId, status: 'processing' })

    const hidden = await app().request(`/v1/images/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${OTHER_RAW_KEY}` },
    }, test.env)
    expect(hidden.status).toBe(404)
    await expect(hidden.json()).resolves.toMatchObject({ error: { code: 'IMAGE_TASK_NOT_FOUND' } })
  })

  it('keeps polling available after balance exhaustion or image feature disablement', async () => {
    const test = await fixture()
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)
    test.raw.prepare("UPDATE users SET balance_micros=0 WHERE id='user-1'").run()
    test.raw.prepare("UPDATE \"groups\" SET allow_image_generation=0 WHERE id='group-1'").run()

    const response = await app().request(`/v1/images/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ task_id: taskId, status: 'processing' })
  })

  it('executes a duplicate Queue delivery at most once', async () => {
    const test = await fixture()
    await submit(test)
    const event = test.queued[0]

    await expect(consumeImageTaskExecute(event, test.env)).resolves.toBe(true)
    await expect(consumeImageTaskExecute(event, test.env)).resolves.toBe(true)

    expect(test.upstreamFetch).toHaveBeenCalledTimes(1)
    expect(test.settle).toHaveBeenCalledTimes(1)
  })

  it('releases the claim for a retryable input read failure before provider execution', async () => {
    const test = await fixture()
    await submit(test)
    const event = test.queued[0]
    vi.mocked(test.env.OBJECTS.get).mockRejectedValueOnce(new Error('temporary R2 outage'))

    await expect(consumeImageTaskExecute(event, test.env)).rejects.toThrow('temporary R2 outage')
    expect(test.raw.prepare('SELECT status FROM image_tasks').get()).toEqual({ status: 'queued' })
    expect(test.upstreamFetch).not.toHaveBeenCalled()

    await expect(consumeImageTaskExecute(event, test.env)).resolves.toBe(true)
    expect(test.upstreamFetch).toHaveBeenCalledTimes(1)
  })

  it('persists an upstream failure for polling instead of retrying paid work', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(Response.json({
      error: { type: 'invalid_request_error', code: 'bad_prompt', message: 'prompt rejected' },
    }, { status: 400 }))
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)

    await consumeImageTaskExecute(test.queued[0], test.env)

    const response = await app().request(`/v1/images/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    expect(response.status).toBe(200)
    expect(response.headers.get('retry-after')).toBeNull()
    await expect(response.json()).resolves.toMatchObject({
      task_id: taskId,
      status: 'failed',
      http_status: 400,
      error: { type: 'invalid_request_error', code: 'bad_prompt', message: 'prompt rejected' },
    })
  })

  it('marks partial R2 offload failure as 502 and removes already uploaded images', async () => {
    const test = await fixture()
    const secondImage = test.imageBytes.slice()
    secondImage[secondImage.length - 1] = 1
    test.upstreamFetch.mockResolvedValueOnce(Response.json({
      created: 1710000000,
      data: [
        { b64_json: encodeBase64(secondImage) },
        { b64_json: encodeBase64(test.imageBytes) },
      ],
    }))
    const submittedResponse = await app().request('/v1/images/generations/async', {
      method: 'POST',
      headers: { authorization: `Bearer ${RAW_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'Two lighthouses', n: 2 }),
    }, test.env)
    const submitted = await submittedResponse.json() as Record<string, unknown>
    const taskId = String(submitted.task_id)
    test.failOutputPutAt(2)

    await consumeImageTaskExecute(test.queued[0], test.env)

    const response = await app().request(`/v1/images/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(response.json()).resolves.toMatchObject({
      status: 'failed',
      http_status: 502,
      error: { code: 'IMAGE_TASK_OFFLOAD_FAILED' },
    })
    expect([...test.objects.keys()].filter((key) => key.includes(taskId))).toEqual([])
    expect(test.raw.prepare('SELECT count(*) AS count FROM image_task_outputs').get()).toEqual({ count: 0 })
  })

  it('offloads b64_json to R2 and exposes only the owned content URL after completion', async () => {
    const test = await fixture()
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)
    await consumeImageTaskExecute(test.queued[0], test.env)

    const completed = await app().request(`/v1/images/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    expect(completed.status).toBe(200)
    expect(completed.headers.get('retry-after')).toBeNull()
    const body = await completed.json() as Record<string, unknown>
    expect(body).toMatchObject({
      id: taskId,
      task_id: taskId,
      status: 'completed',
      http_status: 200,
      image_url: `/v1/images/tasks/${taskId}/content/0`,
      result: {
        created: 1710000000,
        data: [{
          url: `/v1/images/tasks/${taskId}/content/0`,
          revised_prompt: 'A quiet lighthouse',
        }],
      },
      completed_at: expect.any(Number),
    })
    expect(JSON.stringify(body)).not.toContain('b64_json')

    const outputKeys = [...test.objects.keys()].filter((key) => key.includes('/outputs/'))
    expect(outputKeys).toEqual([`test/image-tasks/${taskId}/outputs/0.png`])
    expect(test.objects.get(outputKeys[0])?.bytes).toEqual(test.imageBytes)

    const content = await app().request(`/v1/images/tasks/${taskId}/content/0`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(test.imageBytes)
    expect([...test.objects.keys()].some((key) => key.endsWith('/input.bin'))).toBe(false)
  })

  it('offloads a mixed-case image data URL without making a download request', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(Response.json({
      created: 1710000000,
      data: [{
        url: `DATA:image/jpeg;name="generated;image.png";BaSe64,${encodeBase64(test.imageBytes)}`,
        revised_prompt: 'Stored data URL',
      }],
    }))
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)

    await consumeImageTaskExecute(test.queued[0], test.env)

    const completed = await app().request(`/v1/images/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(completed.json()).resolves.toMatchObject({
      status: 'completed',
      result: {
        data: [{
          url: `/v1/images/tasks/${taskId}/content/0`,
          revised_prompt: 'Stored data URL',
        }],
      },
    })
    expect(test.downloadFetch).not.toHaveBeenCalled()
    expect([...test.objects.keys()].filter((key) => key.includes('/outputs/')))
      .toEqual([`test/image-tasks/${taskId}/outputs/0.png`])
  })

  it('prefers trimmed b64_json over a URL source', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(Response.json({
      data: [{
        b64_json: `  ${encodeBase64(test.imageBytes)}  `,
        url: 'https://127.0.0.1/must-not-be-used.png',
      }],
    }))
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)

    await consumeImageTaskExecute(test.queued[0], test.env)

    const completed = await app().request(`/v1/images/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(completed.json()).resolves.toMatchObject({ status: 'completed' })
    expect(test.downloadFetch).not.toHaveBeenCalled()
  })

  it('fails a provider data array containing a non-image item', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(Response.json({ data: [null] }))
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)

    await consumeImageTaskExecute(test.queued[0], test.env)

    const failed = await app().request(`/v1/images/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(failed.json()).resolves.toMatchObject({ status: 'failed', http_status: 502 })
    expect([...test.objects.keys()].filter((key) => key.includes(taskId))).toEqual([])
  })

  it('downloads a public HTTPS image with redirects disabled and offloads it to R2', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(Response.json({
      created: 1710000000,
      data: [{ url: 'https://cdn.example.test/generated/lighthouse.png?token=opaque' }],
    }))
    test.downloadFetch.mockResolvedValueOnce(new Response(test.imageBytes, {
      status: 206,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(test.imageBytes.byteLength) },
    }))
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)

    await consumeImageTaskExecute(test.queued[0], test.env)

    const completed = await app().request(`/v1/images/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(completed.json()).resolves.toMatchObject({
      status: 'completed',
      result: { data: [{ url: `/v1/images/tasks/${taskId}/content/0` }] },
    })
    expect(test.downloadFetch).toHaveBeenCalledTimes(1)
    const [url, init] = test.downloadFetch.mock.calls[0]
    expect(String(url)).toBe('https://cdn.example.test/generated/lighthouse.png?token=opaque')
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect([...test.objects.keys()].filter((key) => key.includes('/outputs/')))
      .toEqual([`test/image-tasks/${taskId}/outputs/0.png`])
  })

  it('rejects private remote image URLs before making a download request', async () => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(Response.json({
      data: [{ url: 'https://169.254.169.254/latest/meta-data/' }],
    }))
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)

    await consumeImageTaskExecute(test.queued[0], test.env)

    const failed = await app().request(`/v1/images/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(failed.json()).resolves.toMatchObject({
      status: 'failed',
      http_status: 502,
      error: { code: 'IMAGE_TASK_OFFLOAD_FAILED' },
    })
    expect(test.downloadFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['redirect response', (bytes: Uint8Array) => new Response(new Uint8Array(bytes).buffer, {
      status: 302, headers: { location: 'https://127.0.0.1/private.png' },
    })],
    ['oversized Content-Length', (bytes: Uint8Array) => new Response(new Uint8Array(bytes).buffer, {
      headers: { 'content-length': String(32 * 1024 * 1024 + 1) },
    })],
    ['spoofed image MIME', () => new Response('<html>not an image</html>', {
      headers: { 'content-type': 'image/png' },
    })],
  ])('fails closed for a remote %s', async (_name, remoteResponse) => {
    const test = await fixture()
    test.upstreamFetch.mockResolvedValueOnce(Response.json({
      data: [{ url: 'https://cdn.example.test/generated/untrusted.png' }],
    }))
    test.downloadFetch.mockResolvedValueOnce(remoteResponse(test.imageBytes))
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)

    await consumeImageTaskExecute(test.queued[0], test.env)

    const failed = await app().request(`/v1/images/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(failed.json()).resolves.toMatchObject({
      status: 'failed',
      http_status: 502,
      error: { code: 'IMAGE_TASK_OFFLOAD_FAILED' },
    })
    expect([...test.objects.keys()].filter((key) => key.includes(taskId))).toEqual([])
  })

  it('removes output rows and objects when writing result.json fails', async () => {
    const test = await fixture()
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)
    test.failResultPut()

    await consumeImageTaskExecute(test.queued[0], test.env)

    expect(test.raw.prepare('SELECT count(*) AS count FROM image_task_outputs').get()).toEqual({ count: 0 })
    expect([...test.objects.keys()].filter((key) => key.includes(taskId))).toEqual([])
    const content = await app().request(`/v1/images/tasks/${taskId}/content/0`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    expect(content.status).toBe(404)
  })

  it('preserves a completed result when D1 commits but the completion acknowledgement is lost', async () => {
    const test = await fixture()
    const originalPrepare = test.env.DB.prepare.bind(test.env.DB)
    vi.spyOn(test.env.DB, 'prepare').mockImplementation((query: string) => {
      const statement = originalPrepare(query)
      if (!query.includes("SET status='completed'")) return statement
      const originalBind = statement.bind.bind(statement)
      vi.spyOn(statement, 'bind').mockImplementation((...values: unknown[]) => {
        const bound = originalBind(...values)
        const originalRun = bound.run.bind(bound)
        vi.spyOn(bound, 'run').mockImplementation(async () => {
          await originalRun()
          throw new Error('lost D1 acknowledgement')
        })
        return bound
      })
      return statement
    })
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)

    await consumeImageTaskExecute(test.queued[0], test.env)

    const completed = await app().request(`/v1/images/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${RAW_KEY}` },
    }, test.env)
    await expect(completed.json()).resolves.toMatchObject({
      status: 'completed',
      result: { data: [{ url: `/v1/images/tasks/${taskId}/content/0` }] },
    })
    expect([...test.objects.keys()].filter((key) => key.includes('/outputs/'))).toHaveLength(1)
  })

  it('fails stale claimed work without regenerating it', async () => {
    const test = await fixture()
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)
    const staleAt = Date.now() - 31 * 60_000
    test.raw.prepare(
      `UPDATE image_tasks SET status='running',attempt_token='stale-attempt-token',
       created_at_ms=?,started_at_ms=?,updated_at_ms=? WHERE id=?`,
    ).run(staleAt - 1_000, staleAt, staleAt, taskId)

    const result = await recoverImageTasks(test.env)

    expect(result.failed).toBe(1)
    expect(test.upstreamFetch).not.toHaveBeenCalled()
    const row = test.raw.prepare(
      'SELECT status,http_status,error_json FROM image_tasks WHERE id=?',
    ).get(taskId) as { status: string; http_status: number; error_json: string }
    expect(row.status).toBe('failed')
    expect(row.http_status).toBe(504)
    expect(JSON.parse(row.error_json)).toMatchObject({ code: 'IMAGE_TASK_TIMEOUT' })
  })

  it('deletes expired task metadata and every R2 object', async () => {
    const test = await fixture()
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)
    await consumeImageTaskExecute(test.queued[0], test.env)
    test.raw.prepare(
      'UPDATE image_tasks SET created_at_ms=0,updated_at_ms=0,expires_at_ms=0 WHERE id=?',
    ).run(taskId)

    const result = await recoverImageTasks(test.env)

    expect(result.deleted).toBe(1)
    expect(test.raw.prepare('SELECT id FROM image_tasks WHERE id=?').get(taskId)).toBeUndefined()
    expect([...test.objects.keys()].filter((key) => key.includes(taskId))).toEqual([])
  })

  it('keeps an expiry tombstone when R2 cleanup fails and retries it safely', async () => {
    const test = await fixture()
    const submitted = await submit(test)
    const taskId = String(submitted.body.task_id)
    await consumeImageTaskExecute(test.queued[0], test.env)
    test.raw.prepare(
      'UPDATE image_tasks SET created_at_ms=0,updated_at_ms=0,expires_at_ms=0 WHERE id=?',
    ).run(taskId)
    vi.mocked(test.env.OBJECTS.delete).mockRejectedValueOnce(new Error('temporary R2 outage'))

    const first = await recoverImageTasks(test.env)

    expect(first.deleted).toBe(0)
    expect(test.raw.prepare('SELECT status FROM image_tasks WHERE id=?').get(taskId)).toEqual({ status: 'deleting' })

    const second = await recoverImageTasks(test.env)
    expect(second.deleted).toBe(1)
    expect(test.raw.prepare('SELECT id FROM image_tasks WHERE id=?').get(taskId)).toBeUndefined()
  })
})

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
