import { env, exports } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

async function workerRequest(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`https://worker.e2e.invalid${path}`, init))
}

async function jsonRequest(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<Response> {
  return workerRequest(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function responseData<T>(response: Response): Promise<T> {
  const body = await response.json() as { code: number; data: T }
  expect(body.code).toBe(0)
  return body.data
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const digestInput = new Uint8Array(bytes.byteLength)
  digestInput.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', digestInput.buffer)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

describe('Batch image Cloudflare binding E2E', () => {
  it('submits, reserves, consumes, settles, downloads, and deletes an R2-only image batch', async () => {
    const bootstrap = await jsonRequest('/api/v1/admin/bootstrap', {
      user: {
        email: 'media-admin@binding-e2e.test',
        display_name: 'Media Binding Admin',
        balance_micros: 1_000_000,
      },
      group: { name: 'Bootstrap placeholder group' },
      account: {
        name: 'Gemini binding account',
        base_url: 'https://upstream.e2e.invalid',
        api_key: 'gemini-binding-secret',
        max_concurrency: 2,
      },
      api_key: { name: 'Media binding key' },
      models: [{
        public_name: 'bootstrap-placeholder',
        upstream_name: 'bootstrap-placeholder',
        endpoint: 'responses',
        input_micros_per_million: 0,
        output_micros_per_million: 0,
        per_request_micros: 0,
        minimum_reservation_micros: 1,
      }],
    }, {
      authorization: `Bearer ${env.ADMIN_TOKEN}`,
    })
    expect(bootstrap.status).toBe(201)
    const setup = await responseData<{
      user_id: string
      group_id: string
      account_id: string
      api_key_id: string
      api_key: string
    }>(bootstrap)

    const mediaGroupId = 'binding-gemini-group'
    const mediaModelId = 'binding-gemini-image-model'
    const mediaPriceId = 'binding-gemini-image-price'
    const topologyNow = Date.now()

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO "groups" (
           id, name, platform, enabled, allow_image_generation,
           allow_batch_image_generation, image_rate_independent,
           image_rate_multiplier_ppm, batch_image_discount_multiplier_ppm,
           batch_image_hold_multiplier_ppm, image_price_1k_micros,
           is_exclusive,
           created_at_ms, updated_at_ms
         ) VALUES (?, 'Gemini image binding group', 'gemini', 1, 1, 1, 1,
                   1000000, 500000, 600000, 100000, 0, ?, ?)`,
      ).bind(mediaGroupId, topologyNow, topologyNow),
      env.DB.prepare(
        `INSERT INTO models (
           id, platform, public_name, upstream_name, endpoint,
           enabled, created_at_ms, updated_at_ms
         ) VALUES (?, 'gemini', 'gemini-image-binding',
                   'gemini-2.5-flash-image', 'responses', 1, ?, ?)`,
      ).bind(mediaModelId, topologyNow, topologyNow),
      env.DB.prepare(
        `INSERT INTO group_models (
           group_id, model_id, enabled, sort_order, max_output_tokens,
           default_max_output_tokens, created_at_ms, updated_at_ms
         ) VALUES (?, ?, 1, 0, 16384, 4096, ?, ?)`,
      ).bind(mediaGroupId, mediaModelId, topologyNow, topologyNow),
      env.DB.prepare(
        `INSERT INTO model_prices (
           id, group_id, model_id, version, active,
           input_micros_per_million, output_micros_per_million,
           cache_read_micros_per_million, per_request_micros,
           minimum_reservation_micros, effective_at_ms, created_at_ms
         ) VALUES (?, ?, ?, 1, 1, 0, 0, 0, 0, 1, ?, ?)`,
      ).bind(mediaPriceId, mediaGroupId, mediaModelId, topologyNow, topologyNow),
      env.DB.prepare('UPDATE api_keys SET group_id = ?, updated_at_ms = ? WHERE id = ?')
        .bind(mediaGroupId, topologyNow, setup.api_key_id),
    ])

    const taskId = 'imgbatch_bindinge2e0000000000000000001'
    const customId = 'cover'
    const idempotencyKey = 'binding-media-completed-0001'
    const requestBody = {
      model: 'gemini-image-binding',
      provider: 'gemini_api',
      task_name: 'Binding cover',
      image_size: '1K',
      response_mime_type: 'image/png',
      items: [{ custom_id: customId, prompt: 'A quiet lighthouse', output_count: 1 }],
    }
    const manifest = {
      model: requestBody.model,
      upstream_model: 'gemini-2.5-flash-image',
      task_name: requestBody.task_name,
      parent_batch_id: null,
      provider: requestBody.provider,
      image_size: requestBody.image_size,
      response_mime_type: requestBody.response_mime_type,
      aspect_ratio: null,
      metadata: {},
      items: [{ ...requestBody.items[0], reference_images: [] }],
    }
    const inputObjectKey = `media/${env.ENVIRONMENT}/${taskId}/input.json`
    const outputObjectKey = `media/${env.ENVIRONMENT}/${taskId}/outputs/0-0.png`
    const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const imageBytes = decodeBase64(imageBase64)
    const [idempotencyHash, requestHash, itemHash, outputHash] = await Promise.all([
      sha256Hex(idempotencyKey),
      sha256Hex(stableJson(requestBody)),
      sha256Hex(JSON.stringify(manifest.items[0])),
      sha256Hex(imageBytes),
    ])
    const now = Date.now()

    await env.OBJECTS.put(inputObjectKey, JSON.stringify(manifest), {
      httpMetadata: { contentType: 'application/json' },
    })
    await env.OBJECTS.put(outputObjectKey, imageBytes, {
      httpMetadata: { contentType: 'image/png' },
    })
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO media_tasks (
           id, user_id, api_key_id, group_id, task_name, provider, model,
           upstream_model, image_size, response_mime_type, status,
           item_count, expected_output_count, base_unit_price_micros, price_id,
           effective_rate_multiplier_ppm, batch_discount_multiplier_ppm,
           hold_multiplier_ppm, billable_unit_price_micros, hold_unit_price_micros,
           estimated_cost_micros, hold_amount_micros, billing_type, billing_status,
           idempotency_key_hash, request_hash, input_object_key, provider_account_id,
           created_at_ms, updated_at_ms
         ) VALUES (
           ?, ?, ?, ?, ?, 'gemini_api', ?, ?, '1K', 'image/png', 'created',
           1, 1, 100000, ?, 1000000, 500000, 600000, 50000, 60000,
           50000, 60000, 'balance', 'unreserved', ?, ?, ?, ?, ?, ?
         )`,
      ).bind(
        taskId,
        setup.user_id,
        setup.api_key_id,
        mediaGroupId,
        requestBody.task_name,
        requestBody.model,
        manifest.upstream_model,
        mediaPriceId,
        idempotencyHash,
        requestHash,
        inputObjectKey,
        setup.account_id,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO media_task_items (
           task_id, custom_id, ordinal, status, output_count, image_count,
           prompt_preview, request_hash, mime_type, file_extension,
           created_at_ms, completed_at_ms
         ) VALUES (?, ?, 0, 'succeeded', 1, 1, ?, ?, 'image/png', 'png', ?, ?)`,
      ).bind(taskId, customId, requestBody.items[0].prompt, itemHash, now, now),
      env.DB.prepare(
        `INSERT INTO media_task_outputs (
           task_id, custom_id, image_index, object_key, mime_type,
           file_extension, byte_length, sha256, created_at_ms
         ) VALUES (?, ?, 0, ?, 'image/png', 'png', ?, ?, ?)`,
      ).bind(taskId, customId, outputObjectKey, imageBytes.byteLength, outputHash, now),
    ])

    const submit = await jsonRequest('/v1/images/batches', requestBody, {
      authorization: `Bearer ${setup.api_key}`,
      'idempotency-key': idempotencyKey,
    })
    expect(submit.status, JSON.stringify(await submit.clone().json())).toBe(200)
    await expect(submit.json()).resolves.toMatchObject({
      id: taskId,
      object: 'image.batch',
      status: 'queued',
      item_count: 1,
      estimated_cost: 0.05,
      hold_amount: 0.06,
    })

    await expect.poll(async () => {
      const response = await workerRequest(`/v1/images/batches/${taskId}`, {
        headers: { authorization: `Bearer ${setup.api_key}` },
      })
      return response.json()
    }, { timeout: 10_000, interval: 25 }).toMatchObject({
      id: taskId,
      status: 'completed',
      success_count: 1,
      actual_cost: 0.05,
    })

    const persisted = await env.DB.prepare(
      `SELECT status, billing_status, success_count, actual_cost_micros,
              enqueued_at_ms, started_at_ms, finished_at_ms, settled_at_ms
         FROM media_tasks WHERE id = ?`,
    ).bind(taskId).first<Record<string, unknown>>()
    expect(persisted).toMatchObject({
      status: 'completed',
      billing_status: 'settled',
      success_count: 1,
      actual_cost_micros: 50_000,
    })
    expect(persisted?.enqueued_at_ms).toEqual(expect.any(Number))
    expect(persisted?.started_at_ms).toEqual(expect.any(Number))
    expect(persisted?.finished_at_ms).toEqual(expect.any(Number))
    expect(persisted?.settled_at_ms).toEqual(expect.any(Number))

    const userState = env.USER_STATE.get(env.USER_STATE.idFromName(setup.user_id))
    const reservation = await runInDurableObject(userState, (_instance, state) =>
      Array.from(state.storage.sql.exec<{
        status: string
        reserved_micros: number
        settled_micros: number
      }>(
        `SELECT status, reserved_micros, settled_micros
           FROM user_requests WHERE request_id = '${`media:${taskId}`}'`,
      )).at(0))
    expect(reservation).toEqual({
      status: 'settled',
      reserved_micros: 60_000,
      settled_micros: 50_000,
    })

    await expect.poll(async () => env.DB.prepare(
      `SELECT amount_micros, billing_mode, outcome
         FROM usage_projection WHERE api_key_id = ? AND requested_model = ?`,
    ).bind(setup.api_key_id, requestBody.model).first(), {
      timeout: 10_000,
      interval: 25,
    }).toEqual({ amount_micros: 50_000, billing_mode: 'image', outcome: 'completed' })

    const mediaRows = await env.DB.prepare(
      `SELECT task_name AS value FROM media_tasks WHERE id = ?
       UNION ALL SELECT prompt_preview FROM media_task_items WHERE task_id = ?
       UNION ALL SELECT object_key FROM media_task_outputs WHERE task_id = ?`,
    ).bind(taskId, taskId, taskId).all<{ value: string }>()
    expect(JSON.stringify(mediaRows.results)).not.toContain(imageBase64)
    expect(await (await env.OBJECTS.get(outputObjectKey))?.arrayBuffer())
      .toEqual(imageBytes.buffer)

    const content = await workerRequest(
      `/v1/images/batches/${taskId}/items/${customId}/content?image_index=0`,
      { headers: { authorization: `Bearer ${setup.api_key}` } },
    )
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(imageBytes)

    const archive = await workerRequest(`/v1/images/batches/${taskId}/download`, {
      headers: { authorization: `Bearer ${setup.api_key}` },
    })
    expect(archive.status).toBe(200)
    expect(archive.headers.get('content-type')).toBe('application/zip')
    const archiveBytes = new Uint8Array(await archive.arrayBuffer())
    expect([...archiveBytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(new TextDecoder().decode(archiveBytes)).toContain('cover.png')

    const deleted = await workerRequest(`/v1/images/batches/${taskId}/outputs`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${setup.api_key}` },
    })
    expect(deleted.status).toBe(200)
    await expect(deleted.json()).resolves.toMatchObject({ id: taskId, status: 'output_deleted' })
    await expect(env.OBJECTS.get(outputObjectKey)).resolves.toBeNull()
    await expect(env.DB.prepare(
      'SELECT COUNT(*) AS total FROM media_task_outputs WHERE task_id = ?',
    ).bind(taskId).first()).resolves.toEqual({ total: 0 })

    const gone = await workerRequest(
      `/v1/images/batches/${taskId}/items/${customId}/content?image_index=0`,
      { headers: { authorization: `Bearer ${setup.api_key}` } },
    )
    expect(gone.status).toBe(410)
  })
})
