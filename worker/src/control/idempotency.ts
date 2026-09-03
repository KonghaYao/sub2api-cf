import type { Env } from '../env'
import { sha256Hex } from '../gateway/crypto'
import { GatewayError } from '../gateway/errors'

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000

export interface ControlIdempotency {
  scope: string
  key_hash: string
  request_hash: string
}

export interface ControlIdempotencyRow extends ControlIdempotency {
  resource_type: string
  resource_id: string
  response_json: string
  created_at_ms: number
  expires_at_ms: number
}

export async function controlIdempotency(
  scope: string,
  key: string,
  request: unknown,
): Promise<ControlIdempotency> {
  return {
    scope,
    key_hash: await sha256Hex(`control-idempotency-key:v1\u0000${key}`),
    request_hash: await sha256Hex(JSON.stringify(request)),
  }
}

export async function findControlIdempotency(
  env: Env,
  value: ControlIdempotency,
): Promise<ControlIdempotencyRow | null> {
  const row = await env.DB.prepare(
    `SELECT scope, key_hash, request_hash, resource_type, resource_id,
            response_json, created_at_ms, expires_at_ms
       FROM control_idempotency
      WHERE scope = ? AND key_hash = ?`,
  )
    .bind(value.scope, value.key_hash)
    .first<ControlIdempotencyRow>()
  if (row !== null && row.request_hash !== value.request_hash) {
    throw new GatewayError(
      409,
      'idempotency_conflict',
      'Idempotency-Key was already used with different request data',
    )
  }
  return row
}

export function controlIdempotencyInsert(
  env: Env,
  value: ControlIdempotency,
  resourceType: string,
  resourceId: string,
  response: unknown,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO control_idempotency (
       scope, key_hash, request_hash, resource_type, resource_id,
       response_json, created_at_ms, expires_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    value.scope,
    value.key_hash,
    value.request_hash,
    resourceType,
    resourceId,
    JSON.stringify(response),
    now,
    now + IDEMPOTENCY_TTL_MS,
  )
}

export function parseIdempotentResponse<T>(
  row: ControlIdempotencyRow,
  resourceType: string,
): T {
  if (row.resource_type !== resourceType) {
    throw new GatewayError(409, 'idempotency_conflict', 'Idempotency record has a different resource type')
  }
  try {
    return JSON.parse(row.response_json) as T
  } catch {
    throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
  }
}
