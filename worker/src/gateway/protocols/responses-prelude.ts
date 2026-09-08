import { ResponsesOutputEvidence, ChatResponsesOutputEvidence, responsesEventCommitsOutput, type ResponsesPreludeEvidence } from './responses-output-evidence'
import { GatewayError } from '../errors'
import {
  isResponsesFailedTerminal,
  responsesFailureDetails,
  type ResponsesFailureDetails,
} from './chat-from-responses'

type JsonObject = Record<string, unknown>

export type ResponsesPreludeDecision =
  | { kind: 'visible' | 'completed' | 'unresolved' | 'empty_completed' }
  | { kind: 'failed'; failure: ResponsesFailureDetails }

const MAX_PRELUDE_EVENT_CHARS = 256 * 1024
const MAX_PRELUDE_BYTES = 16 * 1024 * 1024
// Match the original gateway's default interval between upstream stream data.
// Bound inspection itself using the Worker's existing stream-duration default.
const MAX_PRELUDE_WAIT_MS = 15 * 60_000
const DEFAULT_IDLE_TIMEOUT_MS = 180_000
const RENEW_INTERVAL_MS = 20_000

export interface ResponsesPreludeInspection {
  decision: ResponsesPreludeDecision
  response: Response
  timedOut?: boolean
}

const deterministicFailureCodes = new Set([
  'cyber_policy',
  'invalid_input',
  'invalid_request',
  'invalid_request_error',
  'context_length_exceeded',
  'context_too_large',
  'content_filter',
  'content_policy_violation',
  'max_output_tokens',
  'model_not_found',
  'permission_denied',
  'insufficient_permissions',
  'unsupported_parameter',
])

/**
 * Inspect a Responses SSE prelude before exposing it to the client. The body is
 * read directly and rebuilt from the consumed prefix plus the same reader, so a
 * tee branch cannot retain an unbounded duplicate of the upstream response.
 */
export async function inspectResponsesSsePrelude(
  response: Response,
  options: { stopAtVisible?: boolean; rejectEmptyCompleted?: boolean; rejectSilentChat?: boolean; maxWaitMs?: number; idleTimeoutMs?: number; signal?: AbortSignal; keepAlive?: () => Promise<void> } = {},
): Promise<ResponsesPreludeInspection> {
  if (response.body === null) {
    return { decision: { kind: 'unresolved' }, response }
  }

  const evidence = options.rejectEmptyCompleted ? new ResponsesOutputEvidence() : options.rejectSilentChat ? new ChatResponsesOutputEvidence() : undefined
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + (options.maxWaitMs ?? MAX_PRELUDE_WAIT_MS)
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  let lastDataAt = Date.now()
  const renewal = { nextAt: Date.now() + RENEW_INTERVAL_MS, keepAlive: options.keepAlive }
  const prefix: Uint8Array[] = []
  let prefixBytes = 0
  let buffer = ''
  try {
    while (true) {
      const remaining = Math.min(deadline - Date.now(), idleTimeoutMs - (Date.now() - lastDataAt))
      if (remaining <= 0) {
        return { ...inspectedResponse(response, reader, prefix, preludeTimeoutFailure()), timedOut: true }
      }
      const timedRead = await readBefore(reader, remaining, options.signal, renewal)
      if (timedRead.kind === 'timeout') {
        return { ...inspectedResponse(response, reader, prefix, preludeTimeoutFailure(), timedRead.pending), timedOut: true }
      }
      const { result } = timedRead
      if (result.done) {
        buffer += decoder.decode()
        return inspectedResponse(
          response,
          reader,
          prefix,
          inspectBufferedFrames(
            buffer,
            true,
            options.stopAtVisible !== false,
            evidence,
          ).decision ?? { kind: 'unresolved' },
        )
      }
      if (result.value.byteLength > 0) lastDataAt = Date.now()
      prefix.push(result.value)
      prefixBytes += result.value.byteLength
      if (prefixBytes > MAX_PRELUDE_BYTES) {
        return inspectedResponse(response, reader, prefix, { kind: 'unresolved' })
      }
      buffer += decoder.decode(result.value, { stream: true })
      const inspected = inspectBufferedFrames(
        buffer,
        false,
        options.stopAtVisible !== false,
        evidence,
      )
      buffer = inspected.remainder
      if (inspected.decision !== null) {
        return inspectedResponse(response, reader, prefix, inspected.decision)
      }
      if (buffer.length > MAX_PRELUDE_EVENT_CHARS) {
        return inspectedResponse(response, reader, prefix, { kind: 'unresolved' })
      }
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined)
    reader.releaseLock()
    throw error
  }
}

function preludeTimeoutFailure(): Extract<ResponsesPreludeDecision, { kind: 'failed' }> {
  return {
    kind: 'failed',
    failure: {
      code: 'upstream_idle_timeout',
      message: 'Upstream did not produce visible output before the prelude timeout',
      cyberPolicy: false,
    },
  }
}

function inspectedResponse(
  original: Response,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: Uint8Array[],
  decision: ResponsesPreludeDecision,
  pending?: Promise<ReadableStreamReadResult<Uint8Array>>,
): ResponsesPreludeInspection {
  let prefixIndex = 0
  let nextRead = pending
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefixIndex < prefix.length) {
        const chunk = prefix[prefixIndex]
        prefix[prefixIndex++] = new Uint8Array(0)
        controller.enqueue(chunk)
        return
      }
      try {
        const result = await (nextRead ?? reader.read())
        nextRead = undefined
        if (result.done) { reader.releaseLock(); controller.close() }
        else controller.enqueue(result.value)
      } catch (error) { reader.releaseLock(); controller.error(error) }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined)
      reader.releaseLock()
    },
  })
  return {
    decision,
    response: new Response(body, {
      status: original.status,
      statusText: original.statusText,
      headers: original.headers,
    }),
  }
}

export function isRetryableResponsesFailure(failure: ResponsesFailureDetails): boolean {
  const code = failure.code.trim().toLowerCase()
  return !deterministicFailureCodes.has(code) &&
    !code.startsWith('invalid_') &&
    !code.startsWith('unsupported_')
}

function inspectBufferedFrames(
  source: string,
  flush: boolean,
  stopAtVisible: boolean,
  evidence?: ResponsesPreludeEvidence,
): { decision: ResponsesPreludeDecision | null; remainder: string } {
  let remainder = source
  while (true) {
    const match = /\r?\n\r?\n/.exec(remainder)
    if (match === null) break
    const frame = remainder.slice(0, match.index)
    remainder = remainder.slice(match.index + match[0].length)
    const decision = inspectFrame(frame, stopAtVisible, evidence)
    if (decision !== null) return { decision, remainder }
  }
  if (flush && remainder !== '') {
    const decision = inspectFrame(remainder, stopAtVisible, evidence)
    return { decision, remainder: '' }
  }
  return { decision: null, remainder }
}

function inspectFrame(frame: string, stopAtVisible: boolean, evidence?: ResponsesPreludeEvidence): ResponsesPreludeDecision | null {
  let eventName: string | undefined
  const data: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  const serialized = data.join('\n')
  if (serialized === '' || serialized === '[DONE]') return null
  let parsed: JsonObject
  try {
    const value: unknown = JSON.parse(serialized)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    parsed = value as JsonObject
  } catch {
    return { kind: 'unresolved' }
  }
  const type = typeof parsed.type === 'string' ? parsed.type : eventName
  const normalized = typeof parsed.type === 'string' || type === undefined
    ? parsed
    : { ...parsed, type }
  evidence?.observe(type, parsed)
  if (isResponsesFailedTerminal(normalized)) {
    return { kind: 'failed', failure: responsesFailureDetails(normalized) }
  }
  if ((type === 'response.completed' || type === 'response.done') && evidence?.isEmptyCompleted(parsed)) return { kind: 'empty_completed' }
  if (type === 'response.completed' || type === 'response.incomplete') return { kind: 'completed' }
  if (type === 'response.done') {
    const response = objectValue(parsed.response)
    if (response?.status === 'completed' || response?.status === 'incomplete') {
      return { kind: 'completed' }
    }
  }
  if (stopAtVisible && (evidence?.canRelease() ?? responsesEventCommitsOutput(type, parsed))) return { kind: 'visible' }
  return null
}

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

async function readBefore(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal,
  renewal?: { nextAt: number; keepAlive?: () => Promise<void> },
): Promise<
  | { kind: 'read'; result: ReadableStreamReadResult<Uint8Array> }
  | { kind: 'timeout'; pending: Promise<ReadableStreamReadResult<Uint8Array>> }
> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = reader.read()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_,reject) => {
    onAbort = () => {
      reject(new GatewayError(499,'client_cancelled','Client cancelled the request','invalid_request_error'))
      void reader.cancel('client cancelled prelude').catch(() => undefined)
    }
    signal?.addEventListener('abort',onAbort,{once:true})
    if(signal?.aborted)onAbort()
  })
  const deadline = Date.now() + timeoutMs
  // Observe abort even while a lease renewal is in flight.
  void aborted.catch(() => undefined)
  try {
    while (true) {
      if (renewal && Date.now() >= renewal.nextAt) {
        await renewal.keepAlive?.()
        renewal.nextAt = Date.now() + RENEW_INTERVAL_MS
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { kind: 'timeout', pending }
      const result = await Promise.race([
        aborted,
        pending.then((result) => ({ kind: 'read' as const, result })),
        new Promise<{ kind: 'tick' }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'tick' }), Math.max(1,
            Math.min(remaining, renewal ? renewal.nextAt - Date.now() : remaining)))
        }),
      ])
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      if (result.kind === 'read') return result
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if(onAbort)signal?.removeEventListener('abort',onAbort)
  }
}
