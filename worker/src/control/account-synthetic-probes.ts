import { normalizeProviderResponse } from '../gateway/providers'
import { effectiveProviderAccount } from './provider-runtime'
import { accountFetcher } from '../proxy/account-fetch'
import type { Context } from 'hono'

import type { Env, PlatformEvent } from '../env'
import { decryptCredential } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import {
  buildProviderRequest,
  type ProviderAuthScheme,
  type ProviderConfig,
  type ProviderOperation,
  type ProviderPlatform,
  type ProviderProtocol,
} from '../gateway/providers'
import { credentialAad } from '../gateway/repository'
import { authenticateAdminSession, type AdminActor } from './admin-auth'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
  type ControlIdempotency,
} from './idempotency'
import {
  controlError,
  controlSuccess,
  queryInteger,
  readJsonObject,
  requireIdempotencyKey,
  requireResourceId,
} from './http'

type Bindings = { Bindings: Env }
export type SyntheticProbeCapability = 'chat_completions' | 'responses' | 'embeddings'

const CAPABILITIES: SyntheticProbeCapability[] = ['chat_completions', 'responses', 'embeddings']
const MAX_TARGETS = 25
const SHARD_SIZE = 5
const LEASE_MS = 30_000
const NEXT_PROBE_MS = 5 * 60_000
const ALERT_FAILURE_THRESHOLD = 3
const MAX_HISTORY_CURSOR_BYTES = 1_024
const MAX_DISPATCH_ATTEMPTS = 8
const MAX_PROCESSING_ATTEMPTS = 5
const RECOVERY_BATCH_SIZE = 5
const DISPATCH_RETRY_MS = 15_000

interface Target {
  account_id: string
  expected_control_version: number
  model_id: string
  capability: SyntheticProbeCapability
}

interface TargetRow {
  account_id: string
  expected_control_version: number
  model_id: string
  capability: SyntheticProbeCapability
  actual_account_id: string | null
  enabled: number | null
  account_config_version: number | null
  account_control_version: number | null
  credential_ref: string | null
  platform: ProviderPlatform | null
  actual_model_id: string | null
  model_platform: string | null
  model_enabled: number | null
  upstream_model: string | null
  model_updated_at_ms: number | null
  account_model_control_version: number | null
  capability_enabled: number | null
  monitor_generation: number | null
}

interface QueuedResult extends Target {
  success: boolean
  generation?: number
  job_id?: string
  error?: { code: string; message: string }
}

interface JobRow {
  id: string
  account_id: string
  model_id: string
  capability: SyntheticProbeCapability
  generation: number
  account_config_version: number
  account_control_version: number
  credential_ref: string
  account_model_control_version: number
  model_updated_at_ms: number
  upstream_model: string
  requested_by_user_id: string
  status: 'queued' | 'probing' | 'completed' | 'stale' | 'failed'
  processing_attempts: number
}

interface DispatchJobRow extends AccountSyntheticProbePayload {
  dispatch_attempts: number
}

interface ProbeAccountRow extends JobRow {
  proxy_id?: number | null
  credential_kind?: string
  platform: ProviderPlatform
  protocol: ProviderProtocol
  auth_scheme: ProviderAuthScheme
  base_url: string
  provider_config_json: string
  secret_id: string
  key_version: number
  nonce_b64: string
  ciphertext_b64: string
  consecutive_failures: number
  alert_state: 'resolved' | 'firing'
}

interface ProbeObservation {
  outcome: 'succeeded' | 'failed'
  errorCode: 'provider_configuration_unavailable' | 'upstream_timeout' |
    'upstream_transport_failed' | 'upstream_http_error' | 'upstream_invalid_response' | null
  upstreamStatus: number | null
  checkedAtMs: number
  latencyMs: number
}

export interface AccountSyntheticProbePayload {
  job_id: string
  account_id: string
  model_id: string
  capability: SyntheticProbeCapability
  generation: number
}

export type AccountSyntheticProbeEvent = PlatformEvent<AccountSyntheticProbePayload>

export async function queueAdminAccountSyntheticProbes(context: Context<Bindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw, 24 * 1024)
    rejectUnknownKeys(body, ['targets'])
    const targets = parseTargets(body.targets)
    const parent = await controlIdempotency('admin.accounts.synthetic-probes.v1', key, { targets })
    const replay = await findControlIdempotency(context.env, parent)
    if (replay !== null) {
      return controlSuccess(parseIdempotentResponse(replay, 'account_synthetic_probe_batch'), 202)
    }

    const nowMs = Date.now()
    const results: QueuedResult[] = []
    for (let offset = 0; offset < targets.length; offset += SHARD_SIZE) {
      const shard = targets.slice(offset, offset + SHARD_SIZE)
      const child = await controlIdempotency(
        `${parent.scope}.shard.v1`, `${parent.key_hash}:${offset / SHARD_SIZE}`,
        { parent_request_hash: parent.request_hash, targets: shard },
      )
      const childReplay = await findControlIdempotency(context.env, child)
      if (childReplay !== null) {
        results.push(...parseIdempotentResponse<QueuedResult[]>(childReplay, 'account_synthetic_probe_shard'))
        continue
      }
      results.push(...await queueShard(context.env, actor, child, shard, nowMs))
    }

    const response = batchResponse(results)
    await controlIdempotencyInsert(
      context.env, parent, 'account_synthetic_probe_batch', parent.key_hash, response, nowMs,
    ).run()
    const queued = results.filter((result): result is QueuedResult & { job_id: string; generation: number } =>
      result.success && result.job_id !== undefined && result.generation !== undefined)
    await dispatchJobs(context.env, queued, nowMs)
    return controlSuccess(response, 202)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminAccountSyntheticProbeHistory(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const limit = queryInteger(context.req.query('limit'), 'limit', 25, 1, 100)
    const accountId = optionalId(context.req.query('account_id'), 'account')
    const modelId = optionalId(context.req.query('model_id'), 'model')
    const capability = optionalCapability(context.req.query('capability'))
    const cursor = decodeHistoryCursor(context.req.query('cursor'))
    const conditions: string[] = []
    const values: unknown[] = []
    if (accountId !== undefined) { conditions.push('account_id = ?'); values.push(accountId) }
    if (modelId !== undefined) { conditions.push('model_id = ?'); values.push(modelId) }
    if (capability !== undefined) { conditions.push('capability = ?'); values.push(capability) }
    if (cursor !== null) {
      conditions.push('(checked_at_ms < ? OR (checked_at_ms = ? AND id < ?))')
      values.push(cursor.checked_at_ms, cursor.checked_at_ms, cursor.id)
    }
    const page = await context.env.DB.prepare(
      `SELECT id, job_id, account_id, model_id, capability, generation,
              outcome, error_code, upstream_status, latency_ms,
              alert_transition, checked_at_ms
         FROM account_synthetic_probe_history
        ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
        ORDER BY checked_at_ms DESC, id DESC LIMIT ?`,
    ).bind(...values, limit + 1).all<Record<string, unknown>>()
    const items = page.results.slice(0, limit)
    const last = items.at(-1)
    return controlSuccess({
      items,
      has_more: page.results.length > limit,
      next_cursor: page.results.length > limit && last !== undefined
        ? encodeHistoryCursor(Number(last.checked_at_ms), String(last.id))
        : null,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export function isAccountSyntheticProbeEvent(value: unknown): value is AccountSyntheticProbeEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Partial<PlatformEvent<Partial<AccountSyntheticProbePayload>>>
  const payload = event.payload
  if (
    event.schema_version !== 1 || event.event_type !== 'account.synthetic_probe.v1' ||
    event.aggregate_type !== 'account_model' || typeof event.event_id !== 'string' ||
    typeof event.aggregate_id !== 'string' || !Number.isSafeInteger(event.occurred_at_ms) ||
    payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
    Object.keys(payload).some((key) => ![
      'job_id', 'account_id', 'model_id', 'capability', 'generation',
    ].includes(key)) ||
    typeof payload.job_id !== 'string' || payload.job_id.length === 0 || payload.job_id.length > 512 ||
    typeof payload.account_id !== 'string' || typeof payload.model_id !== 'string' ||
    !CAPABILITIES.includes(payload.capability as SyntheticProbeCapability) ||
    !Number.isSafeInteger(payload.generation) || (payload.generation as number) <= 0
  ) return false
  return event.event_id === `account-synthetic:${payload.job_id}` &&
    event.aggregate_id === `${payload.account_id}:${payload.model_id}:${payload.capability}`
}

export async function consumeAccountSyntheticProbe(
  event: AccountSyntheticProbeEvent,
  env: Env,
  nowMs = Date.now(),
): Promise<void> {
  if (!isAccountSyntheticProbeEvent(event)) return
  const job = await findJob(env, event.payload.job_id)
  if (job === null || ['completed', 'stale', 'failed'].includes(job.status)) return
  if (!sameIdentity(job, event.payload)) {
    await markStale(env, job.id, nowMs)
    return
  }
  const runToken = crypto.randomUUID()
  const claimed = await env.DB.prepare(
    `UPDATE account_synthetic_probe_jobs AS job
        SET status = 'probing', processing_attempts = processing_attempts + 1,
            run_token = ?, run_lease_until_ms = ?, updated_at_ms = ?
      WHERE id = ? AND status = 'queued' AND processing_attempts < 5
        AND EXISTS (
          SELECT 1
            FROM account_synthetic_probe_monitors monitor
            JOIN accounts account ON account.id = monitor.account_id
            JOIN account_models relation
              ON relation.account_id = monitor.account_id AND relation.model_id = monitor.model_id
            JOIN models model ON model.id = relation.model_id
           WHERE monitor.account_id = job.account_id AND monitor.model_id = job.model_id
             AND monitor.capability = job.capability AND monitor.generation = job.generation
             AND monitor.enabled = 1 AND account.enabled = 1
             AND account.config_version = job.account_config_version
             AND account.control_version = job.account_control_version
             AND account.credential_ref = job.credential_ref
             AND relation.control_version = job.account_model_control_version
             AND model.updated_at_ms = job.model_updated_at_ms AND model.enabled = 1
             AND model.platform = account.platform AND model.upstream_name = job.upstream_model
             AND CASE job.capability
               WHEN 'chat_completions' THEN relation.chat_completions
               WHEN 'responses' THEN relation.responses
               WHEN 'embeddings' THEN relation.embeddings END = 1
        )`,
  ).bind(runToken, nowMs + LEASE_MS, nowMs, job.id).run()
  if (claimed.meta.changes !== 1) {
    await markStaleIfConfigurationChanged(env, job.id, nowMs)
    return
  }
  const account = await loadProbeAccount(env, job.id, runToken)
  if (account === null) { await markStaleIfOwned(env, job.id, runToken, nowMs); return }
  const observation = await observeProvider(env, account, nowMs)
  const failures = observation.outcome === 'succeeded' ? 0 : account.consecutive_failures + 1
  const transition = observation.outcome === 'failed' && failures >= ALERT_FAILURE_THRESHOLD && account.alert_state === 'resolved'
    ? 'firing'
    : observation.outcome === 'succeeded' && account.alert_state === 'firing'
      ? 'resolved'
      : null
  const historyId = `history:${job.id}`
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE account_synthetic_probe_jobs AS job
          SET status = 'completed', run_token = NULL, run_lease_until_ms = NULL,
              updated_at_ms = ?, last_internal_error = NULL
        WHERE id = ? AND status = 'probing' AND run_token = ?
          AND EXISTS (
            SELECT 1
              FROM account_synthetic_probe_monitors monitor
              JOIN accounts account ON account.id = monitor.account_id
              JOIN account_models relation
                ON relation.account_id = monitor.account_id AND relation.model_id = monitor.model_id
              JOIN models model ON model.id = relation.model_id
             WHERE monitor.account_id = job.account_id AND monitor.model_id = job.model_id
               AND monitor.capability = job.capability AND monitor.generation = job.generation
               AND monitor.enabled = 1 AND account.enabled = 1
               AND account.config_version = job.account_config_version
               AND account.control_version = job.account_control_version
               AND account.credential_ref = job.credential_ref
               AND relation.control_version = job.account_model_control_version
               AND model.updated_at_ms = job.model_updated_at_ms AND model.enabled = 1
               AND model.platform = account.platform AND model.upstream_name = job.upstream_model
               AND CASE job.capability
                 WHEN 'chat_completions' THEN relation.chat_completions
                 WHEN 'responses' THEN relation.responses
                 WHEN 'embeddings' THEN relation.embeddings END = 1
          )`,
    ).bind(observation.checkedAtMs, job.id, runToken),
    env.DB.prepare(
      `INSERT INTO account_synthetic_probe_history (
         id, job_id, account_id, model_id, capability, generation, outcome,
         error_code, upstream_status, latency_ms, alert_transition, checked_at_ms, created_at_ms
       ) SELECT ?, id, account_id, model_id, capability, generation, ?, ?, ?, ?, ?, ?, ?
           FROM account_synthetic_probe_jobs
          WHERE id = ? AND status = 'completed' AND updated_at_ms = ?`,
    ).bind(
      historyId, observation.outcome, observation.errorCode, observation.upstreamStatus,
      observation.latencyMs, transition, observation.checkedAtMs, observation.checkedAtMs,
      job.id, observation.checkedAtMs,
    ),
    env.DB.prepare(
      `UPDATE account_synthetic_probe_monitors
          SET consecutive_failures = ?, alert_state = COALESCE(?, alert_state),
              next_probe_at_ms = ?, lease_until_ms = NULL, updated_at_ms = ?
        WHERE account_id = ? AND model_id = ? AND capability = ? AND generation = ?
          AND EXISTS (SELECT 1 FROM account_synthetic_probe_history WHERE id = ?)`,
    ).bind(
      failures, transition, observation.checkedAtMs + NEXT_PROBE_MS, observation.checkedAtMs,
      job.account_id, job.model_id, job.capability, job.generation, historyId,
    ),
    env.DB.prepare(
      `INSERT INTO account_synthetic_alert_events (
         id, job_id, account_id, model_id, capability, status,
         consecutive_failures, email_delivery_state, occurred_at_ms
       ) SELECT ?, ?, ?, ?, ?, ?, ?, 'unavailable', ?
          WHERE ? IS NOT NULL AND EXISTS (
            SELECT 1 FROM account_synthetic_probe_history WHERE id = ?
          )`,
    ).bind(
      `alert:${job.id}`, job.id, job.account_id, job.model_id, job.capability,
      transition, failures, observation.checkedAtMs, transition, historyId,
    ),
  ])
  await markStaleIfOwned(env, job.id, runToken, observation.checkedAtMs)
}

async function queueShard(
  env: Env,
  actor: AdminActor,
  idempotency: ControlIdempotency,
  targets: Target[],
  nowMs: number,
): Promise<QueuedResult[]> {
  const values = targets.map(() => '(?, ?, ?, ?)').join(', ')
  const rows = await env.DB.prepare(
    `WITH requested(account_id, expected_control_version, model_id, capability) AS (VALUES ${values})
     SELECT requested.*,
            account.id AS actual_account_id, account.enabled,
            account.config_version AS account_config_version,
            account.control_version AS account_control_version,
            account.credential_ref, account.platform,
            model.id AS actual_model_id, model.platform AS model_platform,
            model.enabled AS model_enabled, model.upstream_name AS upstream_model,
            model.updated_at_ms AS model_updated_at_ms,
            relation.control_version AS account_model_control_version,
            CASE requested.capability
              WHEN 'chat_completions' THEN relation.chat_completions
              WHEN 'responses' THEN relation.responses
              WHEN 'embeddings' THEN relation.embeddings END AS capability_enabled,
            monitor.generation AS monitor_generation
       FROM requested
       LEFT JOIN accounts account ON account.id = requested.account_id
       LEFT JOIN models model ON model.id = requested.model_id
       LEFT JOIN account_models relation
         ON relation.account_id = requested.account_id AND relation.model_id = requested.model_id
       LEFT JOIN account_synthetic_probe_monitors monitor
         ON monitor.account_id = requested.account_id AND monitor.model_id = requested.model_id
        AND monitor.capability = requested.capability`,
  ).bind(...targets.flatMap((target) => [
    target.account_id, target.expected_control_version, target.model_id, target.capability,
  ])).all<TargetRow>()
  const byIdentity = new Map(rows.results.map((row) => [targetIdentity(row), row]))
  const successful: Array<QueuedResult & Required<Pick<QueuedResult, 'generation' | 'job_id'>>> = []
  const results = targets.map((target): QueuedResult => {
    const row = byIdentity.get(targetIdentity(target))
    const error = targetError(target, row)
    if (error !== null) return { ...target, success: false, error }
    const generation = (row!.monitor_generation ?? 0) + 1
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new GatewayError(409, 'synthetic_probe_generation_exhausted', 'Synthetic probe generation is exhausted')
    }
    const result = {
      ...target, success: true, generation,
      job_id: syntheticJobId(target.account_id, target.model_id, target.capability, generation),
    }
    successful.push(result)
    return result
  })
  const statements: D1PreparedStatement[] = []
  if (successful.length > 0) {
    statements.push(monitorUpsert(env, successful, nowMs))
    statements.push(jobInsert(env, actor, successful, byIdentity, nowMs))
    statements.push(auditInsert(env, actor, idempotency, successful, nowMs))
  }
  statements.push(controlIdempotencyInsert(
    env, idempotency, 'account_synthetic_probe_shard', idempotency.key_hash, results, nowMs,
  ))
  await env.DB.batch(statements)
  return results
}

function monitorUpsert(
  env: Env,
  results: Array<QueuedResult & { generation: number }>,
  nowMs: number,
): D1PreparedStatement {
  const values = results.map(() => '(?, ?, ?, ?, 1, ?, ?, ?)').join(', ')
  return env.DB.prepare(
    `INSERT INTO account_synthetic_probe_monitors (
       account_id, model_id, capability, generation, enabled,
       next_probe_at_ms, created_at_ms, updated_at_ms
     ) VALUES ${values}
     ON CONFLICT(account_id, model_id, capability) DO UPDATE SET
       generation = excluded.generation, enabled = 1,
       next_probe_at_ms = excluded.next_probe_at_ms,
       lease_until_ms = excluded.next_probe_at_ms,
       updated_at_ms = excluded.updated_at_ms
     WHERE account_synthetic_probe_monitors.generation = excluded.generation - 1`,
  ).bind(...results.flatMap((result) => [
    result.account_id, result.model_id, result.capability, result.generation,
    nowMs, nowMs, nowMs,
  ]))
}

function jobInsert(
  env: Env,
  actor: AdminActor,
  results: Array<QueuedResult & { generation: number; job_id: string }>,
  rows: Map<string, TargetRow>,
  nowMs: number,
): D1PreparedStatement {
  const values = results.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
  return env.DB.prepare(
    `INSERT INTO account_synthetic_probe_jobs (
       id, account_id, model_id, capability, generation,
       account_config_version, account_control_version, credential_ref,
       account_model_control_version, model_updated_at_ms, upstream_model,
       requested_by_user_id, status, next_dispatch_at_ms, created_at_ms, updated_at_ms
     ) VALUES ${values}`,
  ).bind(...results.flatMap((result) => {
    const row = rows.get(targetIdentity(result))!
    return [
      result.job_id, result.account_id, result.model_id, result.capability, result.generation,
      row.account_config_version, row.account_control_version, row.credential_ref,
      row.account_model_control_version, row.model_updated_at_ms, row.upstream_model,
      actor.user_id, 'queued', nowMs, nowMs, nowMs,
    ]
  }))
}

function auditInsert(
  env: Env,
  actor: AdminActor,
  idempotency: ControlIdempotency,
  results: Array<QueuedResult & { generation: number; job_id: string }>,
  nowMs: number,
): D1PreparedStatement {
  const values = results.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')
  return env.DB.prepare(
    `INSERT INTO admin_account_synthetic_probe_audit_events (
       id, actor_user_id, actor_session_id, account_id, model_id, capability,
       generation, job_id, idempotency_key_hash, occurred_at_ms
     )
     WITH audit(id, account_id, model_id, capability, generation, job_id) AS (VALUES ${values})
     SELECT audit.id, ?, ?, audit.account_id, audit.model_id, audit.capability,
            audit.generation, audit.job_id, ?, ? FROM audit`,
  ).bind(
    ...results.flatMap((result) => [
      crypto.randomUUID(), result.account_id, result.model_id,
      result.capability, result.generation, result.job_id,
    ]),
    actor.user_id, actor.session_id, idempotency.key_hash, nowMs,
  )
}

async function dispatchJobs(
  env: Env,
  jobs: Array<QueuedResult & { job_id: string; generation: number }>,
  nowMs: number,
): Promise<void> {
  if (jobs.length === 0) return
  const failed = new Set<string>()
  for (const job of jobs) {
    try {
      await env.EVENTS_QUEUE.send(createEvent(job, nowMs))
    } catch {
      failed.add(job.job_id)
    }
  }
  const placeholders = jobs.map(() => '?').join(', ')
  const failureCases = jobs.map(() => 'WHEN ? THEN ?').join(' ')
  await env.DB.prepare(
    `UPDATE account_synthetic_probe_jobs
        SET dispatch_attempts = MIN(dispatch_attempts + 1, 8),
            next_dispatch_at_ms = ?, updated_at_ms = ?,
            last_internal_error = CASE id ${failureCases} ELSE last_internal_error END
      WHERE id IN (${placeholders}) AND status = 'queued' AND dispatch_attempts = 0`,
  ).bind(
    nowMs + DISPATCH_RETRY_MS,
    nowMs,
    ...jobs.flatMap((job) => [job.job_id, failed.has(job.job_id) ? 'Queue dispatch failed' : null]),
    ...jobs.map((job) => job.job_id),
  ).run()
}

export async function recoverAccountSyntheticProbes(env: Env, nowMs = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE account_synthetic_probe_jobs
          SET status = 'queued', run_token = NULL, run_lease_until_ms = NULL,
              next_dispatch_at_ms = ?, updated_at_ms = ?,
              last_internal_error = 'Expired consumer lease recovered'
        WHERE status = 'probing' AND run_lease_until_ms <= ?
          AND processing_attempts < ?`,
    ).bind(nowMs, nowMs, nowMs, MAX_PROCESSING_ATTEMPTS),
    env.DB.prepare(
      `UPDATE account_synthetic_probe_jobs
          SET status = 'failed', run_token = NULL, run_lease_until_ms = NULL,
              updated_at_ms = ?, last_internal_error = 'Probe processing attempts exhausted'
        WHERE status = 'probing' AND run_lease_until_ms <= ?
          AND processing_attempts >= ?`,
    ).bind(nowMs, nowMs, MAX_PROCESSING_ATTEMPTS),
    env.DB.prepare(
      `UPDATE account_synthetic_probe_jobs
          SET status = 'failed', updated_at_ms = ?,
              last_internal_error = 'Queue dispatch attempts exhausted'
        WHERE status = 'queued' AND next_dispatch_at_ms <= ?
          AND dispatch_attempts >= ?`,
    ).bind(nowMs, nowMs, MAX_DISPATCH_ATTEMPTS),
  ])

  const due = await env.DB.prepare(
    `SELECT id AS job_id, account_id, model_id, capability, generation, dispatch_attempts
       FROM account_synthetic_probe_jobs
      WHERE status = 'queued' AND next_dispatch_at_ms <= ? AND dispatch_attempts < ?
      ORDER BY next_dispatch_at_ms ASC, created_at_ms ASC, id ASC
      LIMIT ?`,
  ).bind(nowMs, MAX_DISPATCH_ATTEMPTS, RECOVERY_BATCH_SIZE).all<DispatchJobRow>()
  if (due.results.length === 0) return

  const outcomes: Array<DispatchJobRow & { error: string | null }> = []
  for (const job of due.results) {
    let error: string | null = null
    try {
      await env.EVENTS_QUEUE.send(createEvent(job, nowMs))
    } catch {
      error = 'Queue dispatch failed'
    }
    outcomes.push({ ...job, error })
  }
  const updateCases = outcomes.map(() => 'WHEN ? THEN ?').join(' ')
  const guards = outcomes.map(() => '(id = ? AND dispatch_attempts = ?)').join(' OR ')
  await env.DB.prepare(
    `UPDATE account_synthetic_probe_jobs
        SET dispatch_attempts = dispatch_attempts + 1,
            next_dispatch_at_ms = CASE id ${updateCases} ELSE next_dispatch_at_ms END,
            updated_at_ms = ?,
            last_internal_error = CASE id ${updateCases} ELSE last_internal_error END
      WHERE status = 'queued' AND (${guards}) AND dispatch_attempts < ?`,
  ).bind(
    ...outcomes.flatMap((job) => [job.job_id, nextDispatchAt(nowMs, job.dispatch_attempts + 1)]),
    nowMs,
    ...outcomes.flatMap((job) => [job.job_id, job.error]),
    ...outcomes.flatMap((job) => [job.job_id, job.dispatch_attempts]),
    MAX_DISPATCH_ATTEMPTS,
  ).run()
}

function nextDispatchAt(nowMs: number, attempts: number): number {
  return nowMs + Math.min(5 * 60_000, DISPATCH_RETRY_MS * 2 ** Math.max(0, attempts - 1))
}

function createEvent(
  job: Pick<QueuedResult, 'account_id' | 'model_id' | 'capability'> & { job_id: string; generation: number },
  nowMs: number,
): AccountSyntheticProbeEvent {
  return {
    schema_version: 1,
    event_id: `account-synthetic:${job.job_id}`,
    event_type: 'account.synthetic_probe.v1',
    occurred_at_ms: nowMs,
    aggregate_type: 'account_model',
    aggregate_id: `${job.account_id}:${job.model_id}:${job.capability}`,
    payload: {
      job_id: job.job_id, account_id: job.account_id, model_id: job.model_id,
      capability: job.capability, generation: job.generation,
    },
  }
}

async function loadProbeAccount(env: Env, id: string, token: string): Promise<ProbeAccountRow | null> {
  return env.DB.prepare(
    `SELECT job.*, account.platform, account.protocol, account.auth_scheme,
            account.base_url, account.provider_config_json, account.credential_kind, json_extract(account.ui_config_json, '$.proxy_id') AS proxy_id,
            secret.id AS secret_id, secret.key_version, secret.nonce_b64, secret.ciphertext_b64,
            monitor.consecutive_failures, monitor.alert_state
       FROM account_synthetic_probe_jobs job
       JOIN accounts account ON account.id = job.account_id
       JOIN account_secrets secret
         ON secret.id = job.credential_ref AND secret.account_id = job.account_id
       JOIN account_synthetic_probe_monitors monitor
         ON monitor.account_id = job.account_id AND monitor.model_id = job.model_id
        AND monitor.capability = job.capability AND monitor.generation = job.generation
      WHERE job.id = ? AND job.status = 'probing' AND job.run_token = ?`,
  ).bind(id, token).first<ProbeAccountRow>()
}

async function observeProvider(env: Env, account: ProbeAccountRow, startedAtMs: number): Promise<ProbeObservation> {
  let plan: ReturnType<typeof buildProviderRequest>
  try {
    const providerConfig = JSON.parse(account.provider_config_json) as ProviderConfig
    const credential = await decryptCredential(
      account.nonce_b64, account.ciphertext_b64, requireMasterKey(env),
      credentialAad(env.ENVIRONMENT, account.account_id, account.secret_id, account.key_version),
    )
    const operation = providerOperation(account.platform, account.capability)
    plan = buildProviderRequest({
      account: await effectiveProviderAccount(env, {
        platform: account.platform, protocol: account.protocol,
        auth_scheme: account.auth_scheme, base_url: account.base_url,
        provider_config: providerConfig,
      }),
      credential,
      operation,
      model: account.upstream_model,
      body: minimalProbeBody(account.platform, account.capability, account.upstream_model),
    })
  } catch {
    return observation('failed', 'provider_configuration_unavailable', null, startedAtMs)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(plan.timeout_ms, 8_000))
  try {
    let response = await accountFetcher(env, account.proxy_id, account)(plan.url, {
      method: plan.method, headers: plan.headers,
      body: plan.body === undefined ? undefined : JSON.stringify(plan.body),
      redirect: 'manual', cache: 'no-store', signal: controller.signal,
    })
    response = await normalizeProviderResponse(plan, response, controller.signal)
    if (response.ok) {
      const body = await readBoundedProviderJson(response)
      if (!validProviderResponse(account.platform, account.capability, body)) {
        return observation('failed', 'upstream_invalid_response', response.status, startedAtMs)
      }
    } else {
      try { await response.body?.cancel() } catch { /* status is already known */ }
    }
    return observation(
      response.ok ? 'succeeded' : 'failed',
      response.ok ? null : 'upstream_http_error',
      response.status,
      startedAtMs,
    )
  } catch (error) {
    return observation(
      'failed',
      error instanceof DOMException && error.name === 'AbortError'
        ? 'upstream_timeout' : 'upstream_transport_failed',
      null,
      startedAtMs,
    )
  } finally { clearTimeout(timer) }
}

function providerOperation(platform: ProviderPlatform, capability: SyntheticProbeCapability): ProviderOperation {
  if (capability === 'embeddings') return 'embeddings'
  if (platform === 'anthropic') return 'messages'
  if (platform === 'gemini' || platform === 'antigravity') return 'generate_content'
  if (platform === 'codex') return 'responses'
  return capability
}

export function minimalProbeBody(
  platform: ProviderPlatform,
  capability: SyntheticProbeCapability,
  model: string,
): Record<string, unknown> {
  const prompt = 'Reply with OK.'
  if (platform === 'anthropic') {
    return { model, max_tokens: 1, stream: false, messages: [{ role: 'user', content: prompt }] }
  }
  if (platform === 'gemini' || platform === 'antigravity') {
    return capability === 'embeddings'
      ? { content: { parts: [{ text: prompt }] } }
      : { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1 } }
  }
  if (platform === 'codex') return { model, input: prompt, max_output_tokens: 1, stream: false }
  if (capability === 'responses') return { model, input: prompt, max_output_tokens: 1, stream: false }
  if (capability === 'embeddings') return { model, input: prompt }
  return { model, messages: [{ role: 'user', content: prompt }], max_tokens: 1, stream: false }
}

export async function readBoundedProviderJson(response: Response): Promise<unknown> {
  if (response.body === null) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > 64 * 1024) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown } catch { return null }
}

export function validProviderResponse(
  platform: ProviderPlatform,
  capability: SyntheticProbeCapability,
  value: unknown,
): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  if (capability === 'embeddings') {
    if (platform === 'gemini' || platform === 'antigravity') {
      return hasFiniteEmbeddingValue(objectRecord(body.embedding)?.values)
    }
    return Array.isArray(body.data) && body.data.some((item) =>
      hasFiniteEmbeddingValue(objectRecord(item)?.embedding))
  }
  if (platform === 'anthropic') {
    return Array.isArray(body.content) && body.content.some((item) => {
      const part = objectRecord(item)
      return part?.type === 'text' && nonEmptyText(part.text)
    })
  }
  if (platform === 'gemini' || platform === 'antigravity') {
    return Array.isArray(body.candidates) && body.candidates.some((candidate) => {
      const parts = objectRecord(objectRecord(candidate)?.content)?.parts
      return Array.isArray(parts) && parts.some((part) => nonEmptyText(objectRecord(part)?.text))
    })
  }
  if (platform === 'codex' || capability === 'responses') {
    return Array.isArray(body.output) && body.output.some((item) => {
      const output = objectRecord(item)
      if (output?.type !== 'message' || !Array.isArray(output.content)) return false
      return output.content.some((part) => {
        const content = objectRecord(part)
        return content?.type === 'output_text' && nonEmptyText(content.text)
      })
    })
  }
  return Array.isArray(body.choices) && body.choices.some((choice) => {
    const content = objectRecord(objectRecord(choice)?.message)?.content
    if (nonEmptyText(content)) return true
    return Array.isArray(content) && content.some((part) => nonEmptyText(objectRecord(part)?.text))
  })
}

function hasFiniteEmbeddingValue(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => typeof entry === 'number' && Number.isFinite(entry))
}

function nonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function observation(
  outcome: ProbeObservation['outcome'],
  errorCode: ProbeObservation['errorCode'],
  upstreamStatus: number | null,
  startedAtMs: number,
): ProbeObservation {
  const checkedAtMs = Math.max(startedAtMs, Date.now())
  return { outcome, errorCode, upstreamStatus, checkedAtMs, latencyMs: checkedAtMs - startedAtMs }
}

async function findJob(env: Env, id: string): Promise<JobRow | null> {
  return env.DB.prepare(
    `SELECT id, account_id, model_id, capability, generation,
            account_config_version, account_control_version, credential_ref,
            account_model_control_version, model_updated_at_ms, upstream_model,
            requested_by_user_id, status, processing_attempts
       FROM account_synthetic_probe_jobs WHERE id = ?`,
  ).bind(id).first<JobRow>()
}

async function markStale(env: Env, id: string, nowMs: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE account_synthetic_probe_jobs
        SET status = 'stale', run_token = NULL, run_lease_until_ms = NULL,
            updated_at_ms = ?, last_internal_error = NULL
      WHERE id = ? AND status IN ('queued', 'probing')`,
  ).bind(nowMs, id).run()
}

async function markStaleIfOwned(env: Env, id: string, runToken: string, nowMs: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE account_synthetic_probe_jobs
        SET status = 'stale', run_token = NULL, run_lease_until_ms = NULL,
            updated_at_ms = ?, last_internal_error = NULL
      WHERE id = ? AND status = 'probing' AND run_token = ?`,
  ).bind(nowMs, id, runToken).run()
}

async function markStaleIfConfigurationChanged(env: Env, id: string, nowMs: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE account_synthetic_probe_jobs AS job
        SET status = 'stale', run_token = NULL, run_lease_until_ms = NULL,
            updated_at_ms = ?, last_internal_error = NULL
      WHERE id = ? AND status IN ('queued', 'probing')
        AND NOT EXISTS (
          SELECT 1
            FROM account_synthetic_probe_monitors monitor
            JOIN accounts account ON account.id = monitor.account_id
            JOIN account_models relation
              ON relation.account_id = monitor.account_id AND relation.model_id = monitor.model_id
            JOIN models model ON model.id = relation.model_id
           WHERE monitor.account_id = job.account_id AND monitor.model_id = job.model_id
             AND monitor.capability = job.capability AND monitor.generation = job.generation
             AND monitor.enabled = 1 AND account.enabled = 1
             AND account.config_version = job.account_config_version
             AND account.control_version = job.account_control_version
             AND account.credential_ref = job.credential_ref
             AND relation.control_version = job.account_model_control_version
             AND model.updated_at_ms = job.model_updated_at_ms AND model.enabled = 1
             AND model.platform = account.platform AND model.upstream_name = job.upstream_model
             AND CASE job.capability
               WHEN 'chat_completions' THEN relation.chat_completions
               WHEN 'responses' THEN relation.responses
               WHEN 'embeddings' THEN relation.embeddings END = 1
        )`,
  ).bind(nowMs, id).run()
}

function parseTargets(value: unknown): Target[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TARGETS) {
    throw new GatewayError(400, 'invalid_targets', `targets must contain between 1 and ${MAX_TARGETS} entries`)
  }
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new GatewayError(400, 'invalid_targets', `targets[${index}] must be an object`)
    }
    const row = item as Record<string, unknown>
    rejectUnknownKeys(row, ['account_id', 'expected_control_version', 'model_id', 'capability'])
    const accountId = requireResourceId(typeof row.account_id === 'string' ? row.account_id : undefined, 'account')
    const modelId = requireResourceId(typeof row.model_id === 'string' ? row.model_id : undefined, 'model')
    const capability = optionalCapability(typeof row.capability === 'string' ? row.capability : undefined)
    if (capability === undefined) throw new GatewayError(400, 'invalid_capability', 'capability is required')
    if (!Number.isSafeInteger(row.expected_control_version) || (row.expected_control_version as number) < 0) {
      throw new GatewayError(400, 'invalid_expected_control_version', 'expected_control_version is invalid')
    }
    const target = {
      account_id: accountId, model_id: modelId, capability,
      expected_control_version: row.expected_control_version as number,
    }
    const identity = targetIdentity(target)
    if (seen.has(identity)) throw new GatewayError(400, 'duplicate_target', 'targets contains a duplicate')
    seen.add(identity)
    return target
  })
}

function targetError(target: Target, row: TargetRow | undefined): QueuedResult['error'] | null {
  if (row?.actual_account_id === null || row === undefined) return error('account_not_found', 'Account was not found')
  if (row.account_control_version !== target.expected_control_version) {
    return error('account_version_conflict', 'Account changed; reload it and retry')
  }
  if (row.enabled !== 1) return error('account_disabled', 'Disabled accounts cannot be probed')
  if (row.actual_model_id === null || row.model_enabled !== 1 || row.model_platform !== row.platform) {
    return error('account_model_not_available', 'Model is unavailable for this account')
  }
  if (row.account_model_control_version === null || row.capability_enabled !== 1) {
    return error('account_model_capability_not_enabled', 'Capability is not enabled for this account and model')
  }
  return null
}

function error(code: string, message: string): { code: string; message: string } { return { code, message } }

function batchResponse(results: QueuedResult[]) {
  const queued = results.filter((result) => result.success)
  const failed = results.filter((result) => !result.success)
  return {
    total: results.length, queued: queued.length, failed: failed.length,
    queued_ids: queued.map((result) => result.account_id),
    failed_ids: failed.map((result) => result.account_id), results,
  }
}

function syntheticJobId(
  accountId: string, modelId: string, capability: SyntheticProbeCapability, generation: number,
): string {
  return `${accountId}:synthetic:${modelId}:${capability}:${generation}`
}

function targetIdentity(value: Pick<Target, 'account_id' | 'model_id' | 'capability'>): string {
  return JSON.stringify([value.account_id, value.model_id, value.capability])
}

function sameIdentity(job: JobRow, payload: AccountSyntheticProbePayload): boolean {
  return job.id === payload.job_id && job.account_id === payload.account_id &&
    job.model_id === payload.model_id && job.capability === payload.capability &&
    job.generation === payload.generation &&
    job.id === syntheticJobId(job.account_id, job.model_id, job.capability, job.generation)
}

function optionalId(value: string | undefined, kind: string): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return requireResourceId(value, kind)
}

function optionalCapability(value: string | undefined): SyntheticProbeCapability | undefined {
  if (value === undefined || value.trim() === '') return undefined
  if (!CAPABILITIES.includes(value as SyntheticProbeCapability)) {
    throw new GatewayError(400, 'invalid_capability', `capability must be one of: ${CAPABILITIES.join(', ')}`)
  }
  return value as SyntheticProbeCapability
}

function encodeHistoryCursor(checkedAtMs: number, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, checked_at_ms: checkedAtMs, id }))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeHistoryCursor(raw: string | undefined): { checked_at_ms: number; id: string } | null {
  if (raw === undefined || raw === '') return null
  if (raw.length > MAX_HISTORY_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalidCursor()
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - raw.length % 4) % 4)
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
    )) as Record<string, unknown>
    if (value.v !== 1 || !Number.isSafeInteger(value.checked_at_ms) || Number(value.checked_at_ms) < 0 ||
      typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 512) throw invalidCursor()
    return { checked_at_ms: Number(value.checked_at_ms), id: value.id }
  } catch { throw invalidCursor() }
}

function invalidCursor(): GatewayError {
  return new GatewayError(400, 'invalid_synthetic_probe_cursor', 'Synthetic probe history cursor is invalid')
}

function requireMasterKey(env: Env): string {
  if (typeof env.CREDENTIALS_MASTER_KEY !== 'string' || env.CREDENTIALS_MASTER_KEY.length < 32) {
    throw new Error('Credentials master key is unavailable')
  }
  return env.CREDENTIALS_MASTER_KEY
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[]): void {
  const supported = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !supported.has(key))
  if (unknown !== undefined) throw new GatewayError(400, 'invalid_body_field', `Unsupported request field: ${unknown}`)
}
