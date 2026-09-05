import type { Context } from 'hono'
import { authenticateAdminSession } from '../control/admin-auth'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  readOptionalJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
} from '../control/http'
import {
  controlIdempotency,
  findControlIdempotency,
  parseIdempotentResponse,
  type ControlIdempotency,
  type ControlIdempotencyRow,
} from '../control/idempotency'
import { asGatewayError, GatewayError } from '../gateway/errors'
import type { ObservabilityEnv, RequestLifecycle } from './types'

type Bindings = { Bindings: ObservabilityEnv }
type ResolutionAction = 'resolve' | 'reopen'
type ResolutionFamily = 'errors' | 'upstream'

const IDEMPOTENCY_SCOPE = 'admin.request-observation.resolution.v1'
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const RESOURCE_TYPE = 'request_observation_resolution'

interface ResolutionObservationRow {
  id: string
  lifecycle: RequestLifecycle
  error_phase: string
  error_owner: string
  resolved: number
  updated_at_ms: number
  resolution_version: number
}

interface ResolutionResult {
  id: string
  resolved: boolean
  resolved_at: string | null
  resolved_by_user_id: string | null
  control_version: number
}

export const actOnAdminRequestError = (context: Context<Bindings>) =>
  actOnAdminError(context, 'errors')

export const actOnAdminUpstreamError = (context: Context<Bindings>) =>
  actOnAdminError(context, 'upstream')

async function actOnAdminError(
  context: Context<Bindings>,
  family: ResolutionFamily,
): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const observationId = requireResourceId(context.req.param('id'), 'observation')
    const action = requireAction(context.req.param('action'))
    const body = await readOptionalJsonObject(context.req.raw, 1_024)
    requireActionBody(body)
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const idempotency = await controlIdempotency(
      IDEMPOTENCY_SCOPE,
      requireIdempotencyKey(context.req.raw),
      { family, observation_id: observationId, action, expected_control_version: expectedVersion },
    )
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) return replayResponse(replay, observationId)

    const row = await findObservation(context.env, observationId)
    if (row === null) throw notFound()
    if (family === 'upstream' && !isUpstreamFailure(row)) throw notFound()
    requireTransition(row, action, expectedVersion)

    const resolved = action === 'resolve'
    const occurredAt = Math.max(row.updated_at_ms + 1, Date.now())
    const nextVersion = expectedVersion + 1
    const result: ResolutionResult = {
      id: row.id,
      resolved,
      resolved_at: resolved ? new Date(occurredAt).toISOString() : null,
      resolved_by_user_id: resolved ? actor.user_id : null,
      control_version: nextVersion,
    }
    const auditId = await deterministicUuid(
      'request-observation.resolution-audit.v1',
      `${observationId}\0${expectedVersion}\0${idempotency.key_hash}`,
    )

    try {
      await context.env.DB.batch([
        guardedIdempotencyInsert(
          context.env,
          idempotency,
          observationId,
          expectedVersion,
          row.resolved,
          result,
          occurredAt,
        ),
        resolutionUpdate(
          context.env,
          idempotency,
          observationId,
          row.resolved,
          expectedVersion,
          resolved,
          actor.user_id,
          occurredAt,
        ),
        auditInsert(
          context.env,
          idempotency,
          auditId,
          observationId,
          expectedVersion,
          resolved,
          actor.user_id,
          occurredAt,
        ),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) return replayResponse(recovered, observationId)
      throw error
    }

    const persisted = await findControlIdempotency(context.env, idempotency)
    if (persisted !== null) return replayResponse(persisted, observationId)
    throw changed()
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function findObservation(
  env: ObservabilityEnv,
  id: string,
): Promise<ResolutionObservationRow | null> {
  return env.DB.prepare(
    `SELECT id, lifecycle, error_phase, error_owner, resolved, updated_at_ms,
            (SELECT COUNT(*) FROM request_observation_resolution_audit
              WHERE observation_id = request_observations.id) AS resolution_version
       FROM request_observations
      WHERE id = ?`,
  ).bind(id).first<ResolutionObservationRow>()
}

function requireAction(value: string | undefined): ResolutionAction {
  if (value !== 'resolve' && value !== 'reopen') {
    throw new GatewayError(400, 'invalid_observation_resolution_action', 'Resolution action is invalid')
  }
  return value
}

function requireActionBody(body: Record<string, unknown>): void {
  if (Object.keys(body).some((key) => key !== 'expected_control_version')) {
    throw new GatewayError(
      400,
      'invalid_observation_resolution_body',
      'Resolution body accepts only expected_control_version',
    )
  }
}

function requireTransition(
  row: ResolutionObservationRow,
  action: ResolutionAction,
  expectedVersion: number,
): void {
  if (row.lifecycle !== 'failed') {
    throw new GatewayError(409, 'observation_not_failed', 'Only failed request observations can be resolved')
  }
  if (row.resolution_version !== expectedVersion) throw changed()
  const expectedResolved = action === 'resolve' ? 0 : 1
  if (row.resolved !== expectedResolved) {
    throw new GatewayError(
      409,
      'observation_resolution_transition_invalid',
      `Cannot ${action} an observation that is already ${row.resolved === 1 ? 'resolved' : 'open'}`,
    )
  }
}

function isUpstreamFailure(row: ResolutionObservationRow): boolean {
  return row.lifecycle === 'failed' && row.error_owner === 'provider' &&
    ['upstream', 'account_auth', 'network'].includes(row.error_phase)
}

function guardedIdempotencyInsert(
  env: ObservabilityEnv,
  idempotency: ControlIdempotency,
  observationId: string,
  expectedVersion: number,
  expectedResolved: number,
  result: ResolutionResult,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO control_idempotency (
       scope, key_hash, request_hash, resource_type, resource_id,
       response_json, created_at_ms, expires_at_ms
     )
     SELECT ?, ?, ?, ?, observation.id, ?, ?, ?
       FROM request_observations AS observation
      WHERE observation.id = ? AND observation.lifecycle = 'failed'
        AND observation.resolved = ?
        AND (SELECT COUNT(*) FROM request_observation_resolution_audit
              WHERE observation_id = observation.id) = ?`,
  ).bind(
    idempotency.scope,
    idempotency.key_hash,
    idempotency.request_hash,
    RESOURCE_TYPE,
    JSON.stringify(result),
    now,
    now + IDEMPOTENCY_TTL_MS,
    observationId,
    expectedResolved,
    expectedVersion,
  )
}

function resolutionUpdate(
  env: ObservabilityEnv,
  idempotency: ControlIdempotency,
  observationId: string,
  expectedResolved: number,
  expectedVersion: number,
  resolved: boolean,
  actorUserId: string,
  occurredAt: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE request_observations
        SET resolved = ?, resolved_at_ms = ?, resolved_by_user_id = ?, updated_at_ms = ?
      WHERE id = ? AND lifecycle = 'failed' AND resolved = ?
        AND (SELECT COUNT(*) FROM request_observation_resolution_audit
              WHERE observation_id = request_observations.id) = ?
        AND EXISTS (
          SELECT 1 FROM control_idempotency
           WHERE scope = ? AND key_hash = ? AND request_hash = ?
             AND resource_type = ? AND resource_id = ?
        )`,
  ).bind(
    resolved ? 1 : 0,
    resolved ? occurredAt : null,
    resolved ? actorUserId : null,
    occurredAt,
    observationId,
    expectedResolved,
    expectedVersion,
    idempotency.scope,
    idempotency.key_hash,
    idempotency.request_hash,
    RESOURCE_TYPE,
    observationId,
  )
}

function auditInsert(
  env: ObservabilityEnv,
  idempotency: ControlIdempotency,
  auditId: string,
  observationId: string,
  expectedVersion: number,
  resolved: boolean,
  actorUserId: string,
  occurredAt: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO request_observation_resolution_audit (
       id, observation_id, actor_user_id, resolved, occurred_at_ms
     )
     SELECT ?, observation.id, ?, ?, ?
       FROM request_observations AS observation
       JOIN control_idempotency AS idempotency
         ON idempotency.scope = ? AND idempotency.key_hash = ?
        AND idempotency.request_hash = ?
        AND idempotency.resource_type = ? AND idempotency.resource_id = observation.id
      WHERE observation.id = ? AND observation.lifecycle = 'failed'
        AND observation.updated_at_ms = ? AND observation.resolved = ?
        AND (SELECT COUNT(*) FROM request_observation_resolution_audit
              WHERE observation_id = observation.id) = ?`,
  ).bind(
    auditId,
    actorUserId,
    resolved ? 1 : 0,
    occurredAt,
    idempotency.scope,
    idempotency.key_hash,
    idempotency.request_hash,
    RESOURCE_TYPE,
    observationId,
    occurredAt,
    resolved ? 1 : 0,
    expectedVersion,
  )
}

function replayResponse(row: ControlIdempotencyRow, observationId: string): Response {
  if (row.resource_id !== observationId) {
    throw new GatewayError(409, 'idempotency_conflict', 'Idempotency record belongs to another observation')
  }
  const result = parseIdempotentResponse<ResolutionResult>(row, RESOURCE_TYPE)
  const response = controlSuccess(result)
  response.headers.set('etag', `"${result.control_version}"`)
  return response
}

function changed(): GatewayError {
  return new GatewayError(409, 'request_observation_changed', 'Request observation changed; reload and retry')
}

function notFound(): GatewayError {
  return new GatewayError(404, 'observation_not_found', 'Request observation was not found')
}
