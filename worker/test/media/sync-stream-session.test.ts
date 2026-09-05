import { describe, expect, it } from 'vitest'
import { prepareSyncImageLiveStream } from '../../src/media/sync-stream-session'

const encoder = new TextEncoder()

function options(response: Response, overrides: Record<string, unknown> = {}) {
  return {
    response,
    operation: 'generation' as const,
    responseFormat: 'b64_json' as const,
    publicModel: 'gpt-image-2',
    leaseSignal: new AbortController().signal,
    maxEventBytes: 64 * 1024,
    maxTrackedImageBytes: 64 * 1024,
    maxCompletedImages: 4,
    maxResponseBytes: 64 * 1024,
    maxAggregateBytes: 64 * 1024,
    keepaliveMs: 60_000,
    ...overrides,
  }
}

describe('sync image live stream session', () => {
  it('commits Direct passthrough on the first recognized SSE bytes before image output', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const first = encoder.encode(': provider-ready\r\n\r\n')
    const response = new Response(new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
        value.enqueue(first)
      },
    }), { headers: { 'content-type': 'text/event-stream' } })

    const prepared = await prepareSyncImageLiveStream({
      ...options(response), outputMode: 'passthrough', detectJsonFallback: true,
    })
    expect(prepared.kind).toBe('committed')
    if (prepared.kind !== 'committed') throw new Error('expected Direct bytes to commit')
    const reader = prepared.body.getReader()
    expect((await reader.read()).value).toEqual(first)

    controller.enqueue(encoder.encode('data: [DONE]\r\n\r\n'))
    controller.close()
    await reader.read()
    await expect(prepared.completion).resolves.toMatchObject({ clientDisconnected: false })
  })

  it('preserves arbitrary Direct SSE chunks byte-for-byte without generated terminal frames', async () => {
    const chunks = [
      encoder.encode(': c\r\nid: 9\r\nretry: 12\r\nevent: vendor.future\r\ndata: {"a":'),
      encoder.encode('1}\r\ndata: second-line\r\n\r\nevent: image_generation.completed\r\ndata: {"type":"image_generation.completed","id":"after-malformed","b64_json":"aW1hZ2U=","size":"1024x1024"}\r\n\r\n'),
    ]
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }), { headers: { 'content-type': 'text/event-stream' } })

    const prepared = await prepareSyncImageLiveStream({
      ...options(response), outputMode: 'passthrough', detectJsonFallback: true,
    })
    if (prepared.kind !== 'committed') throw new Error('expected Direct bytes to commit')
    const actual = new Uint8Array(await new Response(prepared.body).arrayBuffer())
    const expected = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
    expected.set(chunks[0], 0)
    expected.set(chunks[1], chunks[0].byteLength)
    expect(actual).toEqual(expected)
    await expect(prepared.completion).resolves.toMatchObject({
      snapshot: { state: 'completed', imageCount: 1, paidOutputCount: 1 },
    })
  })

  it('bounds whitespace while sniffing a mislabeled Direct JSON response', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(' '.repeat(65)))
      },
    }), { headers: { 'content-type': 'text/event-stream' } })

    await expect(prepareSyncImageLiveStream({
      ...options(response, { maxResponseBytes: 64 }),
      outputMode: 'passthrough',
      detectJsonFallback: true,
    })).rejects.toMatchObject({ code: 'IMAGE_RESPONSES_BODY_TOO_LARGE' })
  })

  it('does not treat cumulative Direct passthrough egress as retained memory', async () => {
    const chunks = [
      encoder.encode(': ready\n\n'),
      encoder.encode(`event: vendor.progress\ndata: ${'x'.repeat(96)}\n\n`),
      encoder.encode(`event: vendor.progress\ndata: ${'y'.repeat(96)}\n\n`),
    ]
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }), { headers: { 'content-type': 'text/event-stream' } })

    const prepared = await prepareSyncImageLiveStream({
      ...options(response, { maxResponseBytes: 64, maxAggregateBytes: 512 }),
      outputMode: 'passthrough',
      detectJsonFallback: true,
    })
    if (prepared.kind !== 'committed') throw new Error('expected Direct bytes to commit')
    expect((await new Response(prepared.body).text()).length).toBeGreaterThan(200)
    await prepared.completion
  })

  it('recovers accounting after an oversized native observer event', async () => {
    const chunks = [
      encoder.encode(': ready\n\n'),
      encoder.encode(`event: vendor.large\ndata: ${'x'.repeat(300)}\n\n`),
      encoder.encode('event: image_generation.completed\ndata: {"type":"image_generation.completed","id":"after-large","b64_json":"aW1hZ2U=","size":"1024x1024"}\n\ndata: [DONE]\n\n'),
    ]
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    }), { headers: { 'content-type': 'text/event-stream' } })

    const prepared = await prepareSyncImageLiveStream({
      ...options(response, { maxEventBytes: 256 }),
      outputMode: 'passthrough',
      detectJsonFallback: true,
    })
    if (prepared.kind !== 'committed') throw new Error('expected Direct bytes to commit')
    const output = await new Response(prepared.body).text()
    expect(output).toContain('vendor.large')
    expect(output).toContain('after-large')
    await expect(prepared.completion).resolves.toMatchObject({
      snapshot: { state: 'completed', imageCount: 1, paidOutputCount: 1 },
    })
  })

  it('always completes after a post-commit aggregate-budget failure', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"cGFydGlhbA==","partial_image_index":0}\n\n',
        ))
        controller.enqueue(new Uint8Array(2_048))
      },
    }), { headers: { 'content-type': 'text/event-stream' } })

    const prepared = await prepareSyncImageLiveStream(options(response, { maxAggregateBytes: 1_024 }))
    expect(prepared.kind).toBe('committed')
    if (prepared.kind !== 'committed') throw new Error('expected committed stream')
    const output = await new Response(prepared.body).text()
    const completion = await prepared.completion

    expect(output).toContain('event: image_generation.partial_image')
    expect(output).toContain('IMAGE_RESPONSES_BODY_TOO_LARGE')
    expect(completion.transportError?.code).toBe('IMAGE_RESPONSES_BODY_TOO_LARGE')
  })

  it('settles a completed output item without failover when the stream then becomes malformed', async () => {
    let read = 0
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        read += 1
        if (read === 1) {
          controller.enqueue(encoder.encode(
          'data: {"type":"response.output_item.done","item":{"id":"paid","type":"image_generation_call","result":"aW1hZ2U=","output_format":"png"}}\n\n',
          ))
          return
        }
        controller.enqueue(encoder.encode('data: {not-json}\n\n'))
        controller.close()
      },
    }), { headers: { 'content-type': 'text/event-stream' } })

    const prepared = await prepareSyncImageLiveStream(options(response))
    expect(prepared.kind).toBe('committed')
    if (prepared.kind !== 'committed') throw new Error('expected paid work to commit')
    const output = await new Response(prepared.body).text()
    const completion = await prepared.completion

    expect(output).toContain('event: error')
    expect(completion.snapshot).toMatchObject({ state: 'error', imageCount: 1, paidOutputCount: 1, usage: { images: 1 } })
    expect(completion.transportError).toBeNull()
  })

  it('publishes an output-item retained for accounting when response.completed arrives', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"type":"response.output_item.done","item":{"id":"paid","type":"image_generation_call","result":"aW1hZ2U="}}\n\n' +
          'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"paid","type":"image_generation_call","result":"aW1hZ2U="}]}}\n\n',
        ))
        controller.close()
      },
    }))

    const prepared = await prepareSyncImageLiveStream(options(response))
    if (prepared.kind !== 'committed') throw new Error('expected committed stream')
    const output = await new Response(prepared.body).text()
    expect(output.match(/event: image_generation\.completed/g)).toHaveLength(1)
    await expect(prepared.completion).resolves.toMatchObject({ snapshot: { imageCount: 1 } })
  })

  it('retains a paid output item that arrives after the public stream committed', async () => {
    let read = 0
    const chunks = [
      'data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"cGFydGlhbA==","partial_image_index":0}\n\n',
      'data: {"type":"response.output_item.done","item":{"id":"paid-late","type":"image_generation_call","result":"aW1hZ2U="}}\n\n',
      'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"late failure"}}}\n\n',
    ]
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (read < chunks.length) controller.enqueue(encoder.encode(chunks[read++]))
        else controller.close()
      },
    }))

    const prepared = await prepareSyncImageLiveStream(options(response))
    if (prepared.kind !== 'committed') throw new Error('expected committed stream')
    const output = await new Response(prepared.body).text()
    const completion = await prepared.completion

    expect(output).toContain('partial_image')
    expect(output).toContain('event: error')
    expect(completion.snapshot).toMatchObject({ state: 'error', imageCount: 1, usage: { images: 1 } })
  })

  it('commits paid work even when the completed image exceeds the local tracking cap', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"type":"response.output_item.done","item":{"id":"oversized","type":"image_generation_call","result":"aW1hZ2U="}}\n\n',
        ))
        controller.close()
      },
    }))

    const prepared = await prepareSyncImageLiveStream(options(response, { maxTrackedImageBytes: 4 }))
    if (prepared.kind !== 'committed') throw new Error('paid work must never return to failover')
    expect(await new Response(prepared.body).text()).toContain('IMAGE_INVALID_PROVIDER_OUTPUT')
    await expect(prepared.completion).resolves.toMatchObject({
      snapshot: { state: 'error', imageCount: 0, paidOutputCount: 1, usage: { images: 1 } },
    })
  })

  it('commits an untrackable response.completed image without output-item.done', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"type":"response.completed","response":{"status":"completed","output":[{"id":"oversized-completed","type":"image_generation_call","result":"aW1hZ2U="}]}}\n\n',
        ))
        controller.close()
      },
    }))

    const prepared = await prepareSyncImageLiveStream(options(response, { maxTrackedImageBytes: 4 }))
    if (prepared.kind !== 'committed') throw new Error('response.completed paid work must not fail over')
    expect(await new Response(prepared.body).text()).toContain('IMAGE_INVALID_PROVIDER_OUTPUT')
    await expect(prepared.completion).resolves.toMatchObject({
      snapshot: { state: 'error', imageCount: 0, paidOutputCount: 1 },
    })
  })

  it('normalizes malformed pre-commit SSE as a provider protocol error', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {not-json}\n\n'))
      },
    }))

    await expect(prepareSyncImageLiveStream(options(response))).rejects.toMatchObject({
      status: 502,
      code: 'IMAGE_SSE_INVALID_JSON',
    })
  })
})
