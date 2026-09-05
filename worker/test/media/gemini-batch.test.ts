import { describe, expect, it, vi } from 'vitest'
import { GatewayError } from '../../src/gateway/errors'
import { createGeminiBatchClient } from '../../src/media/gemini-batch'

describe('Gemini Batch REST client', () => {
  it('submits inline image requests with custom IDs through the fixed Gemini endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      name: 'batches/job-123',
      state: 'JOB_STATE_PENDING',
    }, { headers: { 'retry-after': '7' } }))
    const client = createGeminiBatchClient(fetcher)

    const result = await client.submit({
      baseUrl: 'https://generativelanguage.googleapis.com/',
      apiKey: 'top-secret',
      upstreamModel: 'gemini-3.1-flash-image',
      displayName: 'worker batch',
      imageSize: '2K',
      aspectRatio: '1:1',
      responseMimeType: 'image/png',
      items: [{
        custom_id: 'cover-1',
        prompt: 'Draw a Worker-native cat',
        output_count: 1,
        reference_images: [{ mime_type: 'image/webp', data: 'd2VicA==' }],
      }],
    })

    expect(result).toEqual({
      providerJobId: 'batches/job-123',
      rawState: 'JOB_STATE_PENDING',
      pollAfterMs: 7_000,
    })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:batchGenerateContent',
    )
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('top-secret')
    expect(new Headers(init?.headers).get('authorization')).toBeNull()
    expect(JSON.parse(String(init?.body))).toEqual({
      batch: {
        displayName: 'worker batch',
        inputConfig: {
          requests: {
            requests: [{
              metadata: { key: 'cover-1' },
              request: {
                contents: [{ role: 'user', parts: [
                  { text: 'Draw a Worker-native cat' },
                  { inlineData: { mimeType: 'image/webp', data: 'd2VicA==' } },
                ] }],
                generationConfig: {
                  responseModalities: ['TEXT', 'IMAGE'],
                  imageConfig: { imageSize: '2K', aspectRatio: '1:1' },
                },
              },
            }],
          },
        },
      },
    })
  })

  it('polls a succeeded job and returns only keyed, validated inline results', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      name: 'batches/job-123',
      state: 'JOB_STATE_SUCCEEDED',
      response: {
        inlinedResponses: [
          {
            metadata: { key: 'cover-1' },
            response: { candidates: [{ content: { parts: [
              { text: 'not exposed' },
              { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
              { inline_data: { mime_type: 'image/webp', data: 'd2VicA==' } },
            ] } }] },
          },
          {
            metadata: { key: 'cover-2' },
            error: { status: 'INVALID_ARGUMENT', message: 'unsafe prompt' },
          },
        ],
      },
      providerInternalField: 'must-not-escape',
    }, { headers: { 'retry-after': '999999' } }))

    const result = await createGeminiBatchClient(fetcher).poll({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'top-secret',
      providerJobId: 'batches/job-123',
    })

    expect(result.state).toBe('succeeded')
    expect(result.rawState).toBe('JOB_STATE_SUCCEEDED')
    expect(result.done).toBe(true)
    expect(result.pollAfterMs).toBe(15 * 60_000)
    expect(result.items).toHaveLength(2)
    expect(result.items?.[0]?.customId).toBe('cover-1')
    expect(result.items?.[0]?.outputs?.map((output) => [output.mimeType, new TextDecoder().decode(output.bytes)]))
      .toEqual([['image/png', 'hello'], ['image/webp', 'webp']])
    expect(result.items?.[1]).toEqual({
      customId: 'cover-2',
      error: { code: 'INVALID_ARGUMENT', message: 'unsafe prompt' },
    })
    expect(JSON.stringify(result)).not.toContain('providerInternalField')

    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/batches/job-123')
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
  })

  it('rejects duplicate result keys as an integrity failure', async () => {
    const item = {
      metadata: { key: 'cover-1' },
      response: { candidates: [{ content: { parts: [
        { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
      ] } }] },
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      name: 'batches/job-123',
      state: 'JOB_STATE_SUCCEEDED',
      response: { inlinedResponses: [item, item] },
    }))

    await expect(createGeminiBatchClient(fetcher).poll({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'top-secret',
      providerJobId: 'batches/job-123',
    })).rejects.toMatchObject({
      status: 502,
      code: 'GEMINI_BATCH_DUPLICATE_ITEM_KEY',
    } satisfies Partial<GatewayError>)
  })

  it.each([
    ['JOB_STATE_PENDING', 'pending', false, undefined],
    ['JOB_STATE_RUNNING', 'running', false, undefined],
    ['JOB_STATE_FAILED', 'failed', true, 'BAD_PROMPT'],
    ['JOB_STATE_CANCELLED', 'cancelled', true, 'GEMINI_BATCH_CANCELLED'],
    ['JOB_STATE_EXPIRED', 'expired', true, 'GEMINI_BATCH_EXPIRED'],
  ] as const)('maps %s into a bounded internal state', async (rawState, state, done, errorCode) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      name: 'batches/job-123',
      state: rawState,
      ...(rawState === 'JOB_STATE_FAILED'
        ? { error: { status: 'BAD_PROMPT', message: `bad top-secret ${'x'.repeat(500)}` } }
        : {}),
    }))

    const result = await createGeminiBatchClient(fetcher).poll({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'top-secret',
      providerJobId: 'batches/job-123',
    })

    expect(result.state).toBe(state)
    expect(result.done).toBe(done)
    expect(result.error?.code).toBe(errorCode)
    if (result.error !== undefined) {
      expect(result.error.message).not.toContain('top-secret')
      expect(result.error.message.length).toBeLessThanOrEqual(240)
    }
  })

  it('requests cancellation at the fixed job endpoint without trusting response locations', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 204,
      headers: { location: 'https://attacker.example/continue' },
    }))

    const result = await createGeminiBatchClient(fetcher).cancel({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'top-secret',
      providerJobId: 'batches/job-123',
    })

    expect(result).toEqual({ requested: true })
    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/batches/job-123:cancel')
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('manual')
    expect(init?.body).toBe('{}')
  })

  it('finds exactly one safe job by display name across bounded list pages', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        batches: [{ name: 'batches/other', displayName: 'another task', state: 'JOB_STATE_RUNNING' }],
        nextPageToken: 'page 2',
      }))
      .mockResolvedValueOnce(Response.json({
        batches: [{
          name: 'batches/recovered-123',
          metadata: { displayName: 'submission-token-123' },
          state: 'JOB_STATE_PENDING',
        }],
      }, { headers: { 'retry-after': '4' } }))

    const result = await createGeminiBatchClient(fetcher).findByDisplayName({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'top-secret',
      displayName: 'submission-token-123',
    })

    expect(result).toEqual({
      status: 'found',
      providerJobId: 'batches/recovered-123',
      rawState: 'JOB_STATE_PENDING',
      pollAfterMs: 4_000,
    })
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/batches?pageSize=100',
      'https://generativelanguage.googleapis.com/v1beta/batches?pageSize=100&pageToken=page%202',
    ])
  })

  it.each([
    '../models/secret',
    'batches/../../secret',
    'batches/job:cancel',
    'https://attacker.example/batches/job',
  ])('rejects unsafe provider job ID %s without fetching', async (providerJobId) => {
    const fetcher = vi.fn<typeof fetch>()
    const client = createGeminiBatchClient(fetcher)
    await expect(client.poll({
      baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'secret', providerJobId,
    })).rejects.toMatchObject({ status: 400, code: 'GEMINI_BATCH_INVALID_JOB_ID' } satisfies Partial<GatewayError>)
    await expect(client.cancel({
      baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'secret', providerJobId,
    })).rejects.toMatchObject({ status: 400, code: 'GEMINI_BATCH_INVALID_JOB_ID' } satisfies Partial<GatewayError>)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects submit bodies over the 20 MB UTF-8 limit before fetching', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(createGeminiBatchClient(fetcher).submit({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'secret',
      upstreamModel: 'gemini-image',
      displayName: 'oversize',
      imageSize: '1K',
      aspectRatio: null,
      responseMimeType: 'image/png',
      items: [{ custom_id: 'one', prompt: '界'.repeat(7_000_000), output_count: 1, reference_images: [] }],
    })).rejects.toMatchObject({ status: 413, code: 'GEMINI_BATCH_SUBMIT_TOO_LARGE' } satisfies Partial<GatewayError>)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('bounds response and image payloads and enforces the expected response MIME', async () => {
    const largeResponse = createGeminiBatchClient(
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ state: 'JOB_STATE_RUNNING', padding: 'x'.repeat(100) })),
      { maxResponseBytes: 32 },
    )
    await expect(largeResponse.poll({
      baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'secret', providerJobId: 'batches/job',
    })).rejects.toMatchObject({ code: 'GEMINI_BATCH_RESPONSE_TOO_LARGE' } satisfies Partial<GatewayError>)

    const wrongMime = createGeminiBatchClient(vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      state: 'JOB_STATE_SUCCEEDED',
      response: { inlinedResponses: [{
        metadata: { key: 'one' },
        response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/webp', data: 'd2VicA==' } }] } }] },
      }] },
    })))
    await expect(wrongMime.poll({
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'secret',
      providerJobId: 'batches/job',
      responseMimeType: 'image/png',
    })).rejects.toMatchObject({ code: 'GEMINI_BATCH_INVALID_RESPONSE' } satisfies Partial<GatewayError>)

    const badBase64 = createGeminiBatchClient(vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      state: 'JOB_STATE_SUCCEEDED',
      response: { inlinedResponses: [{
        metadata: { key: 'one' },
        response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: '%%%=' } }] } }] },
      }] },
    })))
    await expect(badBase64.poll({
      baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'secret', providerJobId: 'batches/job',
    })).rejects.toMatchObject({ code: 'GEMINI_BATCH_INVALID_RESPONSE' } satisfies Partial<GatewayError>)
  })

  it('turns upstream and timeout failures into bounded errors without reflecting secrets', async () => {
    const rateLimited = createGeminiBatchClient(vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: `leaked top-secret ${'x'.repeat(1_000)}` } }),
      { status: 429, headers: { 'retry-after': '999999' } },
    )))
    await expect(rateLimited.poll({
      baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'top-secret', providerJobId: 'batches/job',
    })).rejects.toMatchObject({
      status: 503,
      code: 'GEMINI_BATCH_UPSTREAM_429',
      retryAfter: '900',
    } satisfies Partial<GatewayError>)

    const timedOut = createGeminiBatchClient(vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })), { timeoutMs: 5 })
    await expect(timedOut.poll({
      baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'top-secret', providerJobId: 'batches/job',
    })).rejects.toMatchObject({ status: 504, code: 'GEMINI_BATCH_TIMEOUT' } satisfies Partial<GatewayError>)
  })

  it('does not treat duplicate recovery matches as safe to resubmit', async () => {
    const listResponse = () => Response.json({ batches: [
      { name: 'batches/one', displayName: 'submission-token' },
      { name: 'batches/two', displayName: 'submission-token' },
    ] })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => listResponse())
    await expect(createGeminiBatchClient(fetcher).findByDisplayName({
      baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'secret', displayName: 'missing',
    })).resolves.toEqual({ status: 'absent' })
    await expect(createGeminiBatchClient(fetcher).findByDisplayName({
      baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'secret', displayName: 'submission-token',
    })).resolves.toEqual({ status: 'ambiguous' })
  })
})
