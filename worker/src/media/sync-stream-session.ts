import { GatewayError } from '../gateway/errors'
import {
  createSyncImageSseTransformer,
  type SyncImageOperation,
  SyncImageSseError,
  type SyncImageSseSnapshot,
  type SyncImageSseTransformer,
} from './sync-sse'

const DEFAULT_KEEPALIVE_MS = 10_000
const DEFAULT_CONNECTED_IDLE_MS = 15 * 60_000
const DEFAULT_TOTAL_MS = 30 * 60_000
const DEFAULT_DISCONNECT_IDLE_MS = 10_000
const DEFAULT_DISCONNECT_TOTAL_MS = 30_000

export interface SyncImageLiveStreamOptions {
  response: Response
  operation: SyncImageOperation
  responseFormat: 'b64_json' | 'url'
  publicModel: string
  leaseSignal: AbortSignal
  maxEventBytes: number
  maxTrackedImageBytes: number
  maxCompletedImages: number
  maxResponseBytes: number
  maxAggregateBytes: number
  keepaliveMs?: number
  connectedIdleMs?: number
  totalMs?: number
  disconnectIdleMs?: number
  disconnectTotalMs?: number
  now?: () => number
  waitUntil?: (task: Promise<unknown>) => void
}

export interface SyncImageLiveCompletion {
  snapshot: SyncImageSseSnapshot
  clientDisconnected: boolean
  transportError: GatewayError | null
}

export type SyncImageLivePrelude =
  | {
    kind: 'precommit_failure'
    snapshot: SyncImageSseSnapshot
  }
  | {
    kind: 'committed'
    body: ReadableStream<Uint8Array>
    completion: Promise<SyncImageLiveCompletion>
  }

interface SessionState {
  reader: ReadableStreamDefaultReader<Uint8Array>
  transformer: SyncImageSseTransformer
  options: Required<Pick<
    SyncImageLiveStreamOptions,
    'keepaliveMs' | 'connectedIdleMs' | 'totalMs' | 'disconnectIdleMs' | 'disconnectTotalMs'
  >> & SyncImageLiveStreamOptions
  startedAt: number
  lastChunkAt: number
  lastKeepaliveAt: number
  disconnectStartedAt: number | null
  responseBytes: number
  frameBytes: number
  pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null
}

type ReadResult =
  | { kind: 'read'; result: ReadableStreamReadResult<Uint8Array> }
  | { kind: 'keepalive' }

/**
 * Reads only far enough to establish the Images response commitment point.
 * A semantic failure before a public image frame/keepalive remains available
 * to the handler's existing account retry/failover policy.
 */
export async function prepareSyncImageLiveStream(
  input: SyncImageLiveStreamOptions,
): Promise<SyncImageLivePrelude> {
  if (input.response.body === null) {
    throw new GatewayError(502, 'IMAGE_RESPONSES_BODY_MISSING', 'Image Responses provider returned no stream', 'server_error')
  }
  const now = input.now ?? Date.now
  const startedAt = now()
  const state: SessionState = {
    reader: input.response.body.getReader(),
    transformer: createSyncImageSseTransformer({
      operation: input.operation,
      responseFormat: input.responseFormat,
      publicModel: input.publicModel,
      maxEventBytes: input.maxEventBytes,
      maxTrackedImageBytes: input.maxTrackedImageBytes,
      maxCompletedImages: input.maxCompletedImages,
      now: () => Math.floor(now() / 1_000),
    }),
    options: {
      ...input,
      keepaliveMs: positiveDuration(input.keepaliveMs, DEFAULT_KEEPALIVE_MS),
      connectedIdleMs: positiveDuration(input.connectedIdleMs, DEFAULT_CONNECTED_IDLE_MS),
      totalMs: positiveDuration(input.totalMs, DEFAULT_TOTAL_MS),
      disconnectIdleMs: positiveDuration(input.disconnectIdleMs, DEFAULT_DISCONNECT_IDLE_MS),
      disconnectTotalMs: positiveDuration(input.disconnectTotalMs, DEFAULT_DISCONNECT_TOTAL_MS),
    },
    startedAt,
    lastChunkAt: startedAt,
    lastKeepaliveAt: startedAt,
    disconnectStartedAt: null,
    responseBytes: 0,
    frameBytes: 0,
    pendingRead: null,
  }

  try {
    while (true) {
      const next = await readNext(state, false)
      if (next.kind === 'keepalive') {
        const frames = state.transformer.keepalive()
        accountFrames(state, frames)
        return committedSession(state, frames)
      }
      if (next.result.done) {
        const frames = state.transformer.finish()
        frames.push(...retainPaidOutput(state))
        accountFrames(state, frames)
        if (state.transformer.currentState() === 'error' && !state.transformer.imageOutputStarted()) {
          if (state.transformer.providerOutputCompleted()) {
            return committedSession(state, frames)
          }
          return precommitFailure(state)
        }
        return committedSession(state, frames)
      }
      state.lastChunkAt = state.options.now?.() ?? Date.now()
      accountResponseChunk(state, next.result.value)
      const frames = state.transformer.push(next.result.value)
      frames.push(...retainPaidOutput(state))
      accountFrames(state, frames)
      if (state.transformer.currentState() === 'error' && !state.transformer.imageOutputStarted()) {
        if (state.transformer.providerOutputCompleted()) {
          return committedSession(state, frames)
        }
        return precommitFailure(state)
      }
      if (frames.length > 0) return committedSession(state, frames)
    }
  } catch (error) {
    const mapped = streamFailure(error)
    if (state.transformer.providerOutputCompleted()) {
      const frames = retainPaidOutput(state)
      frames.push(...state.transformer.failTransport(mapped.code, mapped.message, mapped.type, mapped.param))
      return committedSession(state, frames)
    }
    void state.reader.cancel(error)
    throw mapped
  }
}

function precommitFailure(state: SessionState): SyncImageLivePrelude {
  void state.reader.cancel('image stream failed before response commitment')
  return { kind: 'precommit_failure', snapshot: state.transformer.snapshot() }
}

function committedSession(state: SessionState, initialFrames: Uint8Array[]): SyncImageLivePrelude {
  let downstreamCancelled = false
  let finished = false
  let operationChain = Promise.resolve()
  let resolveCompletion!: (value: SyncImageLiveCompletion) => void
  let completionResolved = false
  const disconnectSignal = new AbortController()
  const pendingFrames = [...initialFrames]
  const completion = new Promise<SyncImageLiveCompletion>((resolve) => { resolveCompletion = resolve })

  const complete = (transportError: GatewayError | null): void => {
    if (completionResolved) return
    completionResolved = true
    resolveCompletion({
      snapshot: state.transformer.snapshot(),
      clientDisconnected: downstreamCancelled,
      transportError,
    })
  }

  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const next = operationChain.then(operation, operation)
    operationChain = next.catch(() => undefined)
    return next
  }

  const enqueueOne = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    const frame = pendingFrames.shift()
    if (frame === undefined) return false
    controller.enqueue(frame)
    return true
  }

  const finish = (
    controller: ReadableStreamDefaultController<Uint8Array> | null,
    transportError: GatewayError | null,
  ): void => {
    if (finished) return
    finished = true
    void state.reader.cancel('image stream terminal reached')
    complete(transportError)
    if (controller !== null && !downstreamCancelled) controller.close()
  }

  const processRead = (
    result: ReadableStreamReadResult<Uint8Array>,
    controller: ReadableStreamDefaultController<Uint8Array> | null,
  ): void => {
    if (result.done) {
      const frames = state.transformer.finish()
      frames.push(...retainPaidOutput(state))
      accountFrames(state, frames)
      if (controller !== null && !downstreamCancelled) pendingFrames.push(...frames)
      if (pendingFrames.length === 0 || controller === null || downstreamCancelled) finish(controller, null)
      return
    }
    state.lastChunkAt = state.options.now?.() ?? Date.now()
    accountResponseChunk(state, result.value)
    const frames = state.transformer.push(result.value)
    frames.push(...retainPaidOutput(state))
    accountFrames(state, frames)
    if (controller !== null && !downstreamCancelled) pendingFrames.push(...frames)
    if (state.transformer.currentState() !== 'open' && pendingFrames.length === 0) finish(controller, null)
  }

  const failCommitted = (
    error: unknown,
    controller: ReadableStreamDefaultController<Uint8Array> | null,
  ): void => {
    const mapped = streamFailure(error)
    void state.reader.cancel(mapped)
    try {
      const frames = state.transformer.failTransport(mapped.code, mapped.message, mapped.type, mapped.param)
      // A terminal diagnostic must never be subjected to the already-exceeded
      // aggregate budget; completion owns settlement and resource release.
      if (controller !== null && !downstreamCancelled) {
        for (const frame of frames) controller.enqueue(frame)
      }
    } finally {
      finish(controller, mapped)
    }
  }

  const drainAfterCancellation = async (): Promise<void> => {
    if (finished) {
      complete(null)
      return
    }
    try {
      while (!finished) {
        const next = await readNext(state, true, disconnectSignal.signal)
        if (next.kind === 'keepalive') continue
        processRead(next.result, null)
      }
    } catch (error) {
      failCommitted(error, null)
    }
  }

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      return serialize(async () => {
        if (finished || downstreamCancelled) return
        if (enqueueOne(controller)) {
          if (pendingFrames.length === 0 && state.transformer.currentState() !== 'open') finish(controller, null)
          return
        }
        try {
          while (!finished && !downstreamCancelled) {
            const next = await readNext(state, false, disconnectSignal.signal)
            if (next.kind === 'keepalive') {
              const frames = state.transformer.keepalive()
              accountFrames(state, frames)
              pendingFrames.push(...frames)
            } else {
              processRead(next.result, controller)
            }
            if (enqueueOne(controller)) {
              if (pendingFrames.length === 0 && state.transformer.currentState() !== 'open') finish(controller, null)
              return
            }
          }
        } catch (error) {
          if (downstreamCancelled) return
          failCommitted(error, controller)
        }
      })
    },
    cancel() {
      if (!downstreamCancelled) {
        downstreamCancelled = true
        state.transformer.disconnectOutput()
        state.disconnectStartedAt = state.options.now?.() ?? Date.now()
        state.lastChunkAt = state.disconnectStartedAt
        disconnectSignal.abort()
      }
      const task = serialize(drainAfterCancellation)
      if (state.options.waitUntil !== undefined) {
        try {
          state.options.waitUntil(task)
          return
        } catch {
          // Unit tests and local Hono helpers may not expose ExecutionContext.
        }
      }
      return task
    },
  })

  return { kind: 'committed', body, completion }
}

function retainPaidOutput(state: SessionState): Uint8Array[] {
  return state.transformer.providerOutputCompleted()
    ? state.transformer.retainCompletedProviderOutput()
    : []
}

async function readNext(
  state: SessionState,
  disconnected: boolean,
  disconnectSignal?: AbortSignal,
): Promise<ReadResult> {
  if (state.options.leaseSignal.aborted) throw leaseFailure()
  const now = state.options.now?.() ?? Date.now()
  const idleMs = disconnected ? state.options.disconnectIdleMs : state.options.connectedIdleMs
  const idleDeadline = state.lastChunkAt + idleMs
  const totalDeadline = disconnected
    ? Math.min(
        state.startedAt + state.options.totalMs,
        (state.disconnectStartedAt ?? now) + state.options.disconnectTotalMs,
      )
    : state.startedAt + state.options.totalMs
  if (now >= totalDeadline) throw streamTimeout()
  if (now >= idleDeadline) throw streamIdleTimeout()
  if (!disconnected && now - state.lastKeepaliveAt >= state.options.keepaliveMs) {
    state.lastKeepaliveAt = now
    return { kind: 'keepalive' }
  }

  state.pendingRead ??= state.reader.read()
  const keepaliveDeadline = disconnected ? Number.POSITIVE_INFINITY : state.lastKeepaliveAt + state.options.keepaliveMs
  const wakeAt = Math.min(idleDeadline, totalDeadline, keepaliveDeadline)
  let timer: ReturnType<typeof setTimeout> | undefined
  let leaseAbort: (() => void) | undefined
  let disconnectAbort: (() => void) | undefined
  try {
    const raced = await Promise.race([
      state.pendingRead.then((result) => ({ kind: 'read' as const, result })),
      new Promise<{ kind: 'tick' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'tick' }), Math.max(1, wakeAt - now))
      }),
      new Promise<never>((_resolve, reject) => {
        leaseAbort = () => reject(leaseFailure())
        state.options.leaseSignal.addEventListener('abort', leaseAbort, { once: true })
      }),
      ...(disconnectSignal === undefined
        ? []
        : [new Promise<{ kind: 'disconnect' }>((resolve) => {
            disconnectAbort = () => resolve({ kind: 'disconnect' })
            disconnectSignal.addEventListener('abort', disconnectAbort, { once: true })
          })]),
    ])
    if (raced.kind === 'read') {
      state.pendingRead = null
      return raced
    }
    if (raced.kind === 'disconnect') {
      return readNext(state, true)
    }
    return readNext(state, disconnected, disconnectSignal)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (leaseAbort !== undefined) state.options.leaseSignal.removeEventListener('abort', leaseAbort)
    if (disconnectAbort !== undefined) disconnectSignal?.removeEventListener('abort', disconnectAbort)
  }
}

function accountResponseChunk(state: SessionState, chunk: Uint8Array): void {
  state.responseBytes += chunk.byteLength
  if (state.responseBytes > state.options.maxResponseBytes) throw responseTooLarge()
  enforceAggregateBudget(state)
}

function accountFrames(state: SessionState, frames: readonly Uint8Array[]): void {
  state.frameBytes += frames.reduce((total, frame) => total + frame.byteLength, 0)
  enforceAggregateBudget(state)
}

function enforceAggregateBudget(state: SessionState): void {
  if (
    state.responseBytes + state.frameBytes + state.transformer.retainedImageBytes()
    > state.options.maxAggregateBytes
  ) throw responseTooLarge()
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback
}

function responseTooLarge(): GatewayError {
  return new GatewayError(
    502,
    'IMAGE_RESPONSES_BODY_TOO_LARGE',
    'Image Responses provider exceeded the aggregate memory budget',
    'server_error',
  )
}

function streamTimeout(): GatewayError {
  return new GatewayError(504, 'IMAGE_RESPONSES_BODY_TIMEOUT', 'Image Responses provider body timed out', 'server_error')
}

function streamIdleTimeout(): GatewayError {
  return new GatewayError(504, 'IMAGE_RESPONSES_IDLE_TIMEOUT', 'Image Responses provider stream timed out', 'server_error')
}

function leaseFailure(): GatewayError {
  return new GatewayError(503, 'IMAGE_LEASE_RENEWAL_FAILED', 'Image concurrency lease could not be renewed', 'server_error')
}

function streamFailure(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error
  if (error instanceof SyncImageSseError) {
    return new GatewayError(502, error.code, error.message, 'server_error')
  }
  return new GatewayError(
    502,
    'IMAGE_UPSTREAM_STREAM_FAILED',
    'Image provider stream failed before completion',
    'server_error',
  )
}
