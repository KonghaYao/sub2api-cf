import { enqueueOpsSystemLog } from '../control/ops-system-logs'
import { sha256Hex } from '../gateway/crypto'
import {
  encodeObservabilityPayload,
  redactDiagnosticText,
  sanitizeObservabilityPayload,
} from './redaction'
import type {
  ObservationRow,
  ObservabilityEnv,
  ObservabilityPayloadRetryMessage,
  RequestObservationContextUpdate,
  RequestObservationHandle,
  RequestObservationOutcome,
  RequestObservationStart,
} from './types'

const MAX_TIMESTAMP = 8_640_000_000_000_000
const PAYLOAD_LEASE_MS = 60_000

/** Best-effort ingress hook. Observability can never reject a gateway request. */
export async function recordRequestStart(
  env: ObservabilityEnv,
  input: RequestObservationStart,
): Promise<RequestObservationHandle | null> {
  try {
    const occurredAtMs = boundedTimestamp(input.occurredAtMs ?? Date.now())
    const id = crypto.randomUUID()
    const requestId = boundedRequired(input.requestId, 128, 'request id')
    await env.DB.prepare(
      `INSERT INTO request_observations (
         id, request_id, client_request_id, bucket_day, occurred_at_ms,
         lifecycle, user_id, api_key_id, account_id, group_id,
         method, request_path, inbound_endpoint, client_ip, user_agent, platform, requested_model,
         request_type, stream, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, 'started', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      requestId,
      optionalText(input.clientRequestId, 128),
      utcBucketDay(occurredAtMs),
      occurredAtMs,
      optionalText(input.userId, 128),
      optionalText(input.apiKeyId, 128),
      optionalText(input.accountId, 128),
      optionalText(input.groupId, 128),
      normalizeMethod(input.method),
      normalizeRequestPath(input.requestPath),
      boundedText(input.inboundEndpoint, 128),
      optionalText(input.clientIp, 64),
      optionalText(input.userAgent, 512),
      boundedText(input.platform, 64),
      boundedText(input.requestedModel, 200),
      optionalInteger(input.requestType, 0, 32_767),
      input.stream === true ? 1 : 0,
      occurredAtMs,
    ).run()
    return { id, requestId, occurredAtMs }
  } catch (error) {
    logObservabilityFailure('start', error)
    return null
  }
}

/** Adds authenticated and parsed request context without delaying ingress capture. */
export async function recordRequestContext(
  env: ObservabilityEnv,
  handle: RequestObservationHandle,
  input: RequestObservationContextUpdate,
): Promise<boolean> {
  try {
    const updatedAtMs = Math.max(handle.occurredAtMs, Date.now())
    const updated = await env.DB.prepare(
      `UPDATE request_observations
          SET user_id = COALESCE(?, user_id), api_key_id = COALESCE(?, api_key_id),
              group_id = COALESCE(?, group_id), platform = COALESCE(?, platform),
              requested_model = COALESCE(?, requested_model),
              request_type = COALESCE(?, request_type), stream = COALESCE(?, stream),
              upstream_endpoint = COALESCE(?, upstream_endpoint),
              updated_at_ms = ?
        WHERE id = ? AND request_id = ? AND lifecycle = 'started'`,
    ).bind(
      optionalText(input.userId, 128),
      optionalText(input.apiKeyId, 128),
      optionalText(input.groupId, 128),
      input.platform === undefined ? null : boundedText(input.platform, 64),
      input.requestedModel === undefined ? null : boundedText(input.requestedModel, 200),
      input.requestType === undefined ? null : optionalInteger(input.requestType, 0, 32_767),
      input.stream === undefined ? null : input.stream ? 1 : 0,
      input.upstreamEndpoint === undefined ? null : boundedText(input.upstreamEndpoint, 128),
      updatedAtMs,
      handle.id,
      handle.requestId,
    ).run()
    return updated.meta.changes !== 0
  } catch (error) {
    logObservabilityFailure('context', error)
    return false
  }
}

/** Best-effort terminal hook; settlement callers may safely await it after billing commits. */
export async function recordRequestOutcome(
  env: ObservabilityEnv,
  handle: RequestObservationHandle,
  input: RequestObservationOutcome,
): Promise<boolean> {
  try {
    const completedAtMs = Math.max(handle.occurredAtMs, boundedTimestamp(input.completedAtMs ?? Date.now()))
    const durationMs = optionalInteger(
      input.durationMs ?? completedAtMs - handle.occurredAtMs,
      0,
      86_400_000,
    )
    const encoded = input.payload === undefined
      ? null
      : await encodeObservabilityPayload(sanitizeObservabilityPayload(input.payload))
    const objectKey = encoded === null
      ? null
      : await payloadObjectKey(completedAtMs, encoded.sha256)
    const error = input.error
    const updated = await env.DB.prepare(
      `UPDATE request_observations
          SET lifecycle = ?, completed_at_ms = ?, status_code = ?, duration_ms = ?, outcome = ?,
              upstream_model = ?, account_id = COALESCE(?, account_id),
              input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
              amount_micros = ?, error_phase = ?, error_type = ?, error_owner = ?,
              error_source = ?, severity = ?, error_message = ?, upstream_status_code = ?,
              is_business_limited = ?, payload_state = ?, payload_object_key = ?,
              payload_sha256 = ?, payload_bytes = ?, payload_content_type = ?,
              payload_retry_after_ms = NULL, payload_last_error = NULL, updated_at_ms = ?
        WHERE id = ? AND request_id = ? AND lifecycle = 'started'`,
    ).bind(
      input.lifecycle,
      completedAtMs,
      requiredInteger(input.statusCode, 100, 599),
      durationMs,
      input.outcome ?? input.lifecycle,
      boundedText(input.upstreamModel, 200),
      optionalText(input.accountId, 128),
      requiredInteger(input.inputTokens ?? 0, 0, Number.MAX_SAFE_INTEGER),
      requiredInteger(input.outputTokens ?? 0, 0, Number.MAX_SAFE_INTEGER),
      requiredInteger(input.cacheReadTokens ?? 0, 0, Number.MAX_SAFE_INTEGER),
      requiredInteger(input.amountMicros ?? 0, 0, Number.MAX_SAFE_INTEGER),
      boundedText(error?.phase, 32),
      boundedText(error?.type, 100),
      boundedText(error?.owner, 32),
      boundedText(error?.source, 32),
      boundedText(error?.severity, 24),
      redactDiagnosticText(error?.message ?? '').slice(0, 1_000),
      error?.upstreamStatusCode == null
        ? null
        : requiredInteger(error.upstreamStatusCode, 100, 599),
      error?.isBusinessLimited === true ? 1 : 0,
      encoded === null ? 'none' : 'pending',
      objectKey,
      encoded?.sha256 ?? null,
      encoded?.bytes ?? 0,
      encoded?.contentType ?? null,
      completedAtMs,
      handle.id,
      handle.requestId,
    ).run()
    if (updated.meta.changes === 0) {
      const existing = await env.DB.prepare(
        'SELECT lifecycle FROM request_observations WHERE id = ? AND request_id = ?',
      ).bind(handle.id, handle.requestId).first<{ lifecycle: string }>()
      return existing !== null && existing.lifecycle !== 'started'
    }
    if (encoded !== null && objectKey !== null) {
      await persistPayloadOrScheduleRetry(env, handle.id, objectKey, encoded)
    }
    try { await enqueueOpsSystemLog(env, handle.id) } catch { logObservabilityFailure('system_log_enqueue', new Error('queue_unavailable')) }
    return true
  } catch (error) {
    logObservabilityFailure('outcome', error)
    return false
  }
}

export async function consumeObservabilityPayloadRetry(
  env: ObservabilityEnv,
  message: ObservabilityPayloadRetryMessage,
  options: { requeueOnFailure?: boolean } = {},
): Promise<boolean> {
  try {
    validateRetryMessage(message)
  } catch (error) {
    logObservabilityFailure('payload_retry_invalid', error)
    return true
  }
  try {
    // Queue delay is the scheduling authority. Consumers may also invoke this
    // function directly during an operator repair, so not_before is advisory.
    if (await sha256Hex(message.payload) !== message.sha256) return true
    const row = await env.DB.prepare(
      'SELECT payload_state FROM request_observations WHERE id = ?',
    ).bind(message.observation_id).first<{ payload_state: string }>()
    if (row === null || row.payload_state === 'deleted') return true
    if (row.payload_state === 'stored') return true
    const leaseId = crypto.randomUUID()
    const now = Date.now()
    const claimed = await env.DB.prepare(
      `UPDATE request_observations
          SET payload_lease_id = ?, payload_lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND payload_object_key = ? AND payload_sha256 = ?
          AND payload_state IN ('pending', 'retry')
          AND (payload_lease_id IS NULL OR payload_lease_expires_at_ms <= ?)`,
    ).bind(
      leaseId, now + PAYLOAD_LEASE_MS, now, message.observation_id,
      message.object_key, message.sha256, now,
    ).run()
    if (claimed.meta.changes !== 1) return false
    try {
      await observabilityBucket(env).put(message.object_key, message.payload, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { sha256: message.sha256, redacted: 'true' },
      })
      await env.DB.prepare(
        `UPDATE request_observations
            SET payload_state = 'stored', payload_retry_after_ms = NULL,
                payload_lease_id = NULL, payload_lease_expires_at_ms = NULL,
                payload_last_error = NULL, updated_at_ms = ?
          WHERE id = ? AND payload_lease_id = ?`,
      ).bind(Date.now(), message.observation_id, leaseId).run()
      return true
    } catch (error) {
      return await markRetryAndEnqueue(
        env, message, error, leaseId, options.requeueOnFailure !== false,
      )
    }
  } catch (error) {
    logObservabilityFailure('payload_retry', error)
    return false
  }
}

export function isObservabilityPayloadRetryMessage(
  value: unknown,
): value is ObservabilityPayloadRetryMessage {
  if (value === null || typeof value !== 'object') return false
  const message = value as Partial<ObservabilityPayloadRetryMessage>
  return message.schema_version === 1 && message.event_type === 'observability.payload.retry' &&
    typeof message.observation_id === 'string' && typeof message.object_key === 'string' &&
    typeof message.sha256 === 'string' && typeof message.payload === 'string' &&
    message.content_type === 'application/json' && Number.isSafeInteger(message.attempt) &&
    Number.isSafeInteger(message.not_before_ms)
}

async function persistPayloadOrScheduleRetry(
  env: ObservabilityEnv,
  observationId: string,
  objectKey: string,
  encoded: { text: string; bytes: number; sha256: string; contentType: 'application/json' },
): Promise<void> {
  const message: ObservabilityPayloadRetryMessage = {
    schema_version: 1,
    event_type: 'observability.payload.retry',
    observation_id: observationId,
    object_key: objectKey,
    sha256: encoded.sha256,
    content_type: encoded.contentType,
    payload: encoded.text,
    attempt: 0,
    not_before_ms: Date.now(),
  }
  try {
    await observabilityBucket(env).put(objectKey, encoded.text, {
      httpMetadata: { contentType: encoded.contentType },
      customMetadata: { sha256: encoded.sha256, redacted: 'true' },
    })
    await env.DB.prepare(
      `UPDATE request_observations
          SET payload_state = 'stored', payload_attempts = 1, updated_at_ms = ?
        WHERE id = ? AND payload_state = 'pending' AND payload_object_key = ?`,
    ).bind(Date.now(), observationId, objectKey).run()
  } catch (error) {
    await markRetryAndEnqueue(env, message, error, null)
  }
}

async function markRetryAndEnqueue(
  env: ObservabilityEnv,
  message: ObservabilityPayloadRetryMessage,
  error: unknown,
  leaseId: string | null,
  enqueue = true,
): Promise<boolean> {
  const nextAttempt = Math.min(20, message.attempt + 1)
  const retryAfter = Date.now() + Math.min(300_000, 1_000 * 2 ** Math.min(nextAttempt, 8))
  const whereLease = leaseId === null ? '' : ' AND payload_lease_id = ?'
  await env.DB.prepare(
    `UPDATE request_observations
        SET payload_state = 'retry', payload_attempts = MAX(payload_attempts, ?),
            payload_retry_after_ms = ?, payload_lease_id = NULL,
            payload_lease_expires_at_ms = NULL, payload_last_error = ?, updated_at_ms = ?
      WHERE id = ? AND payload_state IN ('pending', 'retry')${whereLease}`,
  ).bind(
    nextAttempt,
    retryAfter,
    safeError(error),
    Date.now(),
    message.observation_id,
    ...(leaseId === null ? [] : [leaseId]),
  ).run()
  if (!enqueue || nextAttempt >= 20) return false
  try {
    await observabilityQueue(env).send({
      ...message,
      attempt: nextAttempt,
      not_before_ms: retryAfter,
    }, { delaySeconds: Math.min(300, 2 ** Math.min(nextAttempt, 8)) })
    return true
  } catch (queueError) {
    logObservabilityFailure('payload_retry_enqueue', queueError)
    return false
  }
}

export function observabilityBucket(env: ObservabilityEnv): R2Bucket {
  return env.OBSERVABILITY_OBJECTS ?? env.OBJECTS
}

export function observabilityQueue(env: ObservabilityEnv): Queue<ObservabilityPayloadRetryMessage> {
  return (env.OBSERVABILITY_QUEUE ?? env.EVENTS_QUEUE) as Queue<ObservabilityPayloadRetryMessage>
}

async function payloadObjectKey(occurredAtMs: number, digest: string): Promise<string> {
  const date = new Date(occurredAtMs)
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `observability/v1/${year}/${month}/${day}/${crypto.randomUUID()}/${digest.slice(0, 16)}.json`
}

function validateRetryMessage(message: ObservabilityPayloadRetryMessage): void {
  if (
    message.schema_version !== 1 || message.event_type !== 'observability.payload.retry' ||
    !/^[a-f0-9]{64}$/.test(message.sha256) || message.content_type !== 'application/json' ||
    message.payload.length === 0 || message.payload.length > 98_304
  ) throw new Error('invalid observability payload retry message')
}

function utcBucketDay(timestamp: number): number {
  const date = new Date(timestamp)
  return date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate()
}

function normalizeMethod(value: string): string {
  const method = value.trim().toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method)) return 'POST'
  return method
}

function normalizeRequestPath(value: string): string {
  const path = value.split(/[?#]/, 1)[0]?.trim() ?? ''
  return boundedRequired(path.startsWith('/') ? path : `/${path}`, 512, 'request path')
}

function boundedTimestamp(value: number): number {
  return requiredInteger(value, 0, MAX_TIMESTAMP)
}

function optionalInteger(value: number | null | undefined, min: number, max: number): number | null {
  return value == null ? null : requiredInteger(value, min, max)
}

function requiredInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid integer metadata')
  return value
}

function optionalText(value: string | null | undefined, max: number): string | null {
  if (value == null || value.trim() === '') return null
  return value.trim().slice(0, max)
}

function boundedText(value: string | null | undefined, max: number): string {
  return value?.trim().slice(0, max) ?? ''
}

function boundedRequired(value: string, max: number, label: string): string {
  const result = value.trim()
  if (result === '' || result.length > max) throw new Error(`invalid ${label}`)
  return result
}

function safeError(error: unknown): string {
  return redactDiagnosticText(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500)
}

function logObservabilityFailure(stage: string, error: unknown): void {
  console.error('observability operation failed', {
    stage,
    name: error instanceof Error ? error.name : 'unknown',
  })
}
