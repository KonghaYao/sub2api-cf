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
