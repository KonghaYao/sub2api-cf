import type { Context } from 'hono'

import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { dispatchAccountHealthProbeJobs } from './account-lifecycle'
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
  readJsonObject,
  requireIdempotencyKey,
  requireResourceId,
} from './http'

type Bindings = { Bindings: Env }

const MAX_BODY_BYTES = 16 * 1024
const MAX_BATCH_SIZE = 25
// Each shard is independently guarded and idempotent. There is deliberately no
// cross-shard atomicity claim: 13 keeps every statement below D1's bind ceiling
// and even the three-attempt race path below the Free 50-query invocation limit.
const OPERATION_SHARD_SIZE = 13
const HEALTH_CLAIM_LEASE_MS = 2 * 60_000
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60_000
const MAX_CAS_ATTEMPTS = 3

interface AccountOperationInput {
  id: string
  expected_control_version: number
}

interface OperationAccountRow {
  id: string
  enabled: number
  config_version: number
  control_version: number
  credential_ref: string
  health_probe_generation: number
  recovery_revision: number
}

interface OperationError {
  code: 'account_not_found' | 'account_version_conflict' | 'account_disabled'
  message: string
}

interface StatusResult {
  account_id: string
  success: boolean
  control_version?: number
  enabled?: boolean
  error?: OperationError
}

interface ProbeResult {
  account_id: string
  success: boolean
  control_version?: number
  job_id?: string
  generation?: number
  error?: OperationError
}

export async function bulkUpdateAdminAccounts(context: Context<Bindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw, MAX_BODY_BYTES)
    rejectUnknownKeys(body, ['accounts', 'enabled'])
    if (typeof body.enabled !== 'boolean') {
      throw new GatewayError(400, 'invalid_enabled', 'enabled must be a boolean')
    }
    const accounts = parseAccounts(body.accounts)
    const requestValue = { accounts, enabled: body.enabled }
    const idempotency = await controlIdempotency('admin.accounts.bulk-status.v1', key, requestValue)
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) {
      return controlSuccess(parseIdempotentResponse(replay, 'account_bulk_status'))
    }

    const results: StatusResult[] = []
    for (const [index, shard] of shards(accounts).entries()) {
      const shardIdempotency = await childIdempotency(idempotency, index, {
        operation: 'bulk-status', accounts: shard, enabled: body.enabled,
      })
      results.push(...await applyStatusShard(
        context.env, actor, shardIdempotency, shard, body.enabled, Date.now(),
      ))
    }
    const response = statusResponse(results)
    return controlSuccess(await finalizeOperation(
      context.env, idempotency, 'account_bulk_status', response, Date.now(),
    ))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function queueAdminAccountHealthProbes(context: Context<Bindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw, MAX_BODY_BYTES)
    rejectUnknownKeys(body, ['accounts'])
    const accounts = parseAccounts(body.accounts)
    const idempotency = await controlIdempotency('admin.accounts.health-probes.v1', key, { accounts })
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) {
      return controlSuccess(parseIdempotentResponse(replay, 'account_health_probe_batch'), 202)
    }

    const results: ProbeResult[] = []
    for (const [index, shard] of shards(accounts).entries()) {
      const shardIdempotency = await childIdempotency(idempotency, index, {
        operation: 'health-probe', accounts: shard,
      })
      results.push(...await applyProbeShard(
        context.env, actor, shardIdempotency, shard, Date.now(),
      ))
    }
    const successful = results.filter((result): result is ProbeResult & {
      control_version: number; generation: number; job_id: string
    } => result.success && result.control_version !== undefined &&
      result.generation !== undefined && result.job_id !== undefined)
    await dispatchAccountHealthProbeJobs(context.env, successful, Date.now())
    const response = probeResponse(results)
    return controlSuccess(await finalizeOperation(
      context.env, idempotency, 'account_health_probe_batch', response, Date.now(),
    ), 202)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/**
 * Clears recoverable runtime state for an entire selected account set.  This is
 * deliberately one D1 transaction: a missing or stale account leaves every
 * selected account unchanged.
 */
export async function resetAdminAccountStatuses(context: Context<Bindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw, MAX_BODY_BYTES)
    rejectUnknownKeys(body, ['accounts'])
    const accounts = parseAccounts(body.accounts)
    const idempotency = await controlIdempotency('admin.accounts.status-reset.v1', key, { accounts })
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) return controlSuccess(parseIdempotentResponse(replay, 'account_status_reset_batch'))

    const rows = await loadAccounts(context.env, accounts)
    if (rows.size !== accounts.length) {
      throw new GatewayError(404, 'account_not_found', 'One or more accounts were not found')
    }
    const orderedRows = accounts.map((input) => rows.get(input.id)!)
    for (const input of accounts) {
      const row = rows.get(input.id)!
      if (row.control_version !== input.expected_control_version) {
        throw new GatewayError(409, 'account_version_conflict', 'Account changed; reload it and retry')
      }
      if (
        row.control_version >= Number.MAX_SAFE_INTEGER ||
        row.config_version >= Number.MAX_SAFE_INTEGER ||
        row.health_probe_generation >= Number.MAX_SAFE_INTEGER ||
        row.recovery_revision >= Number.MAX_SAFE_INTEGER
      ) {
        throw new GatewayError(409, 'account_version_exhausted', 'Account version is exhausted')
      }
    }

    const now = Date.now()
    const results: Array<StatusResult & { control_version: number }> = orderedRows.map((row) => ({
      account_id: row.id,
      success: true,
      control_version: row.control_version + 1,
      enabled: row.enabled === 1,
    }))
    const action = 'account.status_reset'
    const response = statusResponse(results)
    const statements: D1PreparedStatement[] = [
      operationGuardInsert(context.env, idempotency, action, orderedRows, now),
      resetStatusUpdate(context.env, idempotency, results, now),
      staleHealthProbesUpdate(context.env, idempotency, results, now),
      accountAuditBatchInsert(
        context.env, actor, idempotency, action,
        results.map((result) => ({
          accountId: result.account_id,
          version: result.control_version,
          metadata: { recovery_revision_incremented: true },
        })),
        now,
      ),
      guardedIdempotencyInsert(
        context.env, idempotency, 'account_status_reset_batch', response,
        action, results.length, now,
      ),
    ]
    try {
      await context.env.DB.batch(statements)
      return controlSuccess(response)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'account_status_reset_batch'))
      throw mapWriteError(error)
    }
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function parseAccounts(value: unknown): AccountOperationInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_SIZE) {
    throw new GatewayError(
      400, 'invalid_accounts', `accounts must contain between 1 and ${MAX_BATCH_SIZE} entries`,
    )
  }
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new GatewayError(400, 'invalid_accounts', `accounts[${index}] must be an object`)
    }
    const row = item as Record<string, unknown>
    rejectUnknownKeys(row, ['id', 'expected_control_version'])
    const id = requireResourceId(typeof row.id === 'string' ? row.id : undefined, 'account')
    if (seen.has(id)) throw new GatewayError(400, 'duplicate_account_id', 'accounts contains a duplicate id')
    seen.add(id)
    if (!Number.isSafeInteger(row.expected_control_version) || (row.expected_control_version as number) < 0) {
      throw new GatewayError(
        400, 'invalid_expected_control_version',
        `accounts[${index}].expected_control_version must be a non-negative safe integer`,
      )
    }
    return { id, expected_control_version: row.expected_control_version as number }
  })
}

async function loadAccounts(
  env: Env,
  inputs: AccountOperationInput[],
): Promise<Map<string, OperationAccountRow>> {
  const placeholders = inputs.map(() => '?').join(', ')
  const response = await env.DB.prepare(
    `SELECT id, enabled, config_version, control_version, credential_ref,
            health_probe_generation, recovery_revision
       FROM accounts WHERE id IN (${placeholders})`,
  ).bind(...inputs.map((input) => input.id)).all<OperationAccountRow>()
  const rows = new Map<string, OperationAccountRow>()
  for (const row of response.results) rows.set(row.id, row)
  return rows
}

function shards(inputs: AccountOperationInput[]): AccountOperationInput[][] {
  const values: AccountOperationInput[][] = []
  for (let index = 0; index < inputs.length; index += OPERATION_SHARD_SIZE) {
    values.push(inputs.slice(index, index + OPERATION_SHARD_SIZE))
  }
  return values
}

async function childIdempotency(
  parent: ControlIdempotency,
  index: number,
  operationPayload: unknown,
): Promise<ControlIdempotency> {
  return await controlIdempotency(
    `${parent.scope}.shard.v1`, `${parent.key_hash}:${index}`, {
      parent_request_hash: parent.request_hash,
      index,
      operation: operationPayload,
    },
  )
}

async function applyStatusShard(
  env: Env,
  actor: AdminActor,
  idempotency: ControlIdempotency,
  accounts: AccountOperationInput[],
  enabled: boolean,
  now: number,
): Promise<StatusResult[]> {
  const replay = await findControlIdempotency(env, idempotency)
  if (replay !== null) return parseIdempotentResponse(replay, 'account_bulk_status_shard')
  const action = enabled ? 'account.enable' : 'account.disable'
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const rows = await loadAccounts(env, accounts)
    const results: StatusResult[] = accounts.map((input) => {
      const row = rows.get(input.id)
      if (row === undefined) return failure(input.id, 'account_not_found', 'Account was not found')
      if (row.control_version !== input.expected_control_version) {
        return failure(input.id, 'account_version_conflict', 'Account changed; reload it and retry')
      }
      if (row.control_version >= Number.MAX_SAFE_INTEGER || row.config_version >= Number.MAX_SAFE_INTEGER) {
        throw new GatewayError(409, 'account_version_exhausted', 'Account version is exhausted')
      }
      return {
        account_id: row.id,
        success: true,
        control_version: row.control_version + 1,
        enabled,
      }
    })
    const successful = results.filter((result): result is StatusResult & { control_version: number } =>
      result.success && result.control_version !== undefined)
    const successfulRows = successful.map((result) => rows.get(result.account_id)!)
    const statements: D1PreparedStatement[] = [
      operationGuardInsert(env, idempotency, action, successfulRows, now),
    ]
    if (successful.length > 0) {
      statements.push(
        statusShardUpdate(env, idempotency, successful, enabled, now),
        accountAuditBatchInsert(
          env, actor, idempotency, action,
          successful.map((result) => ({
            accountId: result.account_id,
            version: result.control_version,
            metadata: { enabled },
          })),
          now,
        ),
      )
    }
    statements.push(guardedIdempotencyInsert(
      env, idempotency, 'account_bulk_status_shard', results,
      action, successful.length, now,
    ))
    try {
      await env.DB.batch(statements)
      return results
    } catch (error) {
      const recovered = await findControlIdempotency(env, idempotency)
      if (recovered !== null) return parseIdempotentResponse(recovered, 'account_bulk_status_shard')
      if (!isCasFailure(error) || attempt === MAX_CAS_ATTEMPTS - 1) throw mapWriteError(error)
    }
  }
  throw new GatewayError(409, 'account_version_conflict', 'Accounts changed; reload and retry')
}

async function applyProbeShard(
  env: Env,
  actor: AdminActor,
  idempotency: ControlIdempotency,
  accounts: AccountOperationInput[],
  now: number,
): Promise<ProbeResult[]> {
  const replay = await findControlIdempotency(env, idempotency)
  if (replay !== null) return parseIdempotentResponse(replay, 'account_health_probe_shard')
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const rows = await loadAccounts(env, accounts)
    const results: ProbeResult[] = accounts.map((input) => {
      const row = rows.get(input.id)
      if (row === undefined) return failure(input.id, 'account_not_found', 'Account was not found')
      if (row.control_version !== input.expected_control_version) {
        return failure(input.id, 'account_version_conflict', 'Account changed; reload it and retry')
      }
      if (row.enabled !== 1) return failure(input.id, 'account_disabled', 'Disabled accounts cannot be probed')
      if (row.health_probe_generation >= Number.MAX_SAFE_INTEGER) {
        throw new GatewayError(409, 'health_probe_generation_exhausted', 'Health probe generation is exhausted')
      }
      const generation = row.health_probe_generation + 1
      return {
        account_id: row.id,
        success: true,
        control_version: row.control_version,
        generation,
        job_id: `${row.id}:health:${generation}`,
      }
    })
    const successful = results.filter((result): result is ProbeResult & {
      control_version: number; generation: number; job_id: string
    } => result.success && result.control_version !== undefined &&
      result.generation !== undefined && result.job_id !== undefined)
    const successfulRows = successful.map((result) => rows.get(result.account_id)!)
    const statements: D1PreparedStatement[] = [
      operationGuardInsert(env, idempotency, 'account.health_probe.queue', successfulRows, now),
    ]
    if (successful.length > 0) {
      statements.push(
        probeShardUpdate(env, idempotency, successful, now),
        probeJobsInsert(env, idempotency, successful, rows, now),
        accountAuditBatchInsert(
          env, actor, idempotency, 'account.health_probe.queue',
          successful.map((result) => ({
            accountId: result.account_id,
            version: result.control_version,
            metadata: { job_id: result.job_id, generation: result.generation },
          })),
          now,
        ),
      )
    }
    statements.push(guardedIdempotencyInsert(
      env, idempotency, 'account_health_probe_shard', results,
      'account.health_probe.queue', successful.length, now,
    ))
    try {
      await env.DB.batch(statements)
      return results
    } catch (error) {
      const recovered = await findControlIdempotency(env, idempotency)
      if (recovered !== null) return parseIdempotentResponse(recovered, 'account_health_probe_shard')
      if (!isCasFailure(error) || attempt === MAX_CAS_ATTEMPTS - 1) throw mapWriteError(error)
    }
  }
  throw new GatewayError(409, 'account_version_conflict', 'Accounts changed; reload and retry')
}

function failure(accountId: string, code: OperationError['code'], message: string): StatusResult & ProbeResult {
  return { account_id: accountId, success: false, error: { code, message } }
}

function statusResponse(results: StatusResult[]) {
  const successIds = results.filter((value) => value.success).map((value) => value.account_id)
  const failedIds = results.filter((value) => !value.success).map((value) => value.account_id)
  return {
    total: results.length,
    success: successIds.length,
    failed: failedIds.length,
    success_ids: successIds,
    failed_ids: failedIds,
    results,
  }
}

function probeResponse(results: ProbeResult[]) {
  const queuedIds = results.filter((value) => value.success).map((value) => value.account_id)
  const failedIds = results.filter((value) => !value.success).map((value) => value.account_id)
  return {
    total: results.length,
    queued: queuedIds.length,
    failed: failedIds.length,
    queued_ids: queuedIds,
    failed_ids: failedIds,
    results,
  }
}

function statusShardUpdate(
  env: Env,
  idempotency: ControlIdempotency,
  results: Array<StatusResult & { control_version: number }>,
  enabled: boolean,
  now: number,
): D1PreparedStatement {
  const ids = results.map(() => '?').join(', ')
  return env.DB.prepare(
    `UPDATE accounts
        SET enabled = ?, config_version = config_version + 1,
            control_version = control_version + 1,
            health_status = 'unknown', last_checked_at_ms = NULL,
            last_latency_ms = NULL, last_health_error = NULL,
            health_probe_generation = health_probe_generation + 1,
            health_probe_lease_until_ms = NULL,
            next_health_probe_at_ms = ?, updated_at_ms = ?
      WHERE id IN (${ids})
        AND EXISTS (
          SELECT 1 FROM admin_account_operation_guards
           WHERE scope = ? AND idempotency_key_hash = ?
        )`,
  ).bind(
    enabled ? 1 : 0, now, now, ...results.map((result) => result.account_id),
    idempotency.scope, idempotency.key_hash,
  )
}

function resetStatusUpdate(
  env: Env,
  idempotency: ControlIdempotency,
  results: Array<StatusResult & { control_version: number }>,
  now: number,
): D1PreparedStatement {
  const ids = results.map(() => '?').join(', ')
  return env.DB.prepare(
    `UPDATE accounts
        SET config_version = config_version + 1,
            control_version = control_version + 1,
            health_status = 'unknown', last_checked_at_ms = NULL,
            last_latency_ms = NULL, last_health_error = NULL,
            consecutive_health_failures = 0,
            health_probe_generation = health_probe_generation + 1,
            health_probe_lease_until_ms = NULL,
            next_health_probe_at_ms = ?, recovery_revision = recovery_revision + 1,
            updated_at_ms = ?
      WHERE id IN (${ids})
        AND EXISTS (
          SELECT 1 FROM admin_account_operation_guards
           WHERE scope = ? AND idempotency_key_hash = ?
        )`,
  ).bind(
    now, now, ...results.map((result) => result.account_id),
    idempotency.scope, idempotency.key_hash,
  )
}

function staleHealthProbesUpdate(
  env: Env,
  idempotency: ControlIdempotency,
  results: Array<StatusResult & { control_version: number }>,
  now: number,
): D1PreparedStatement {
  const ids = results.map(() => '?').join(', ')
  return env.DB.prepare(
    `UPDATE account_health_probes
        SET status = 'stale', run_token = NULL, run_lease_until_ms = NULL, updated_at_ms = ?
      WHERE account_id IN (${ids}) AND status IN ('queued', 'probing')
        AND EXISTS (
          SELECT 1 FROM admin_account_operation_guards
           WHERE scope = ? AND idempotency_key_hash = ?
        )`,
  ).bind(now, ...results.map((result) => result.account_id), idempotency.scope, idempotency.key_hash)
}

function probeShardUpdate(
  env: Env,
  idempotency: ControlIdempotency,
  results: Array<ProbeResult & { generation: number }>,
  now: number,
): D1PreparedStatement {
  const ids = results.map(() => '?').join(', ')
  return env.DB.prepare(
    `UPDATE accounts
        SET health_probe_generation = health_probe_generation + 1,
            health_probe_lease_until_ms = ?, next_health_probe_at_ms = ?,
            updated_at_ms = MAX(updated_at_ms, ?)
      WHERE id IN (${ids}) AND enabled = 1
        AND EXISTS (
          SELECT 1 FROM admin_account_operation_guards
           WHERE scope = ? AND idempotency_key_hash = ?
        )`,
  ).bind(
    now + HEALTH_CLAIM_LEASE_MS, now + HEALTH_CLAIM_LEASE_MS, now,
    ...results.map((result) => result.account_id), idempotency.scope, idempotency.key_hash,
  )
}

function probeJobsInsert(
  env: Env,
  idempotency: ControlIdempotency,
  results: Array<ProbeResult & { control_version: number; generation: number; job_id: string }>,
  rows: Map<string, OperationAccountRow>,
  now: number,
): D1PreparedStatement {
  const values = results.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')
  return env.DB.prepare(
    `INSERT INTO account_health_probes (
       id, account_id, generation, config_version, credential_ref,
       status, next_dispatch_at_ms, created_at_ms, updated_at_ms
     )
     WITH targets(job_id, account_id, generation, control_version, config_version, credential_ref) AS (
       VALUES ${values}
     )
     SELECT target.job_id, account.id, target.generation,
            account.config_version, account.credential_ref, 'queued', ?, ?, ?
       FROM targets target
       JOIN accounts account ON account.id = target.account_id
      WHERE account.enabled = 1 AND account.control_version = target.control_version
        AND account.config_version = target.config_version
        AND account.credential_ref = target.credential_ref
        AND account.health_probe_generation = target.generation
        AND EXISTS (
          SELECT 1 FROM admin_account_operation_guards
           WHERE scope = ? AND idempotency_key_hash = ?
        )`,
  ).bind(
    ...results.flatMap((result) => {
      const row = rows.get(result.account_id)!
      return [
        result.job_id, result.account_id, result.generation,
        result.control_version, row.config_version, row.credential_ref,
      ]
    }),
    now, now, now, idempotency.scope, idempotency.key_hash,
  )
}

function accountAuditBatchInsert(
  env: Env,
  actor: AdminActor,
  idempotency: ControlIdempotency,
  action: string,
  audits: Array<{ accountId: string; version: number; metadata: Record<string, unknown> }>,
  now: number,
): D1PreparedStatement {
  const values = JSON.stringify(audits.map((audit) => ({
    id: crypto.randomUUID(),
    resource_id: audit.accountId,
    resource_version: audit.version,
    metadata_json: JSON.stringify(audit.metadata),
  })))
  return env.DB.prepare(
    `INSERT INTO admin_account_audit_events (
       id, actor_user_id, actor_session_id, action, resource_id,
       resource_version, idempotency_key_hash, metadata_json, occurred_at_ms
     )
     WITH audits AS (
       SELECT json_extract(value, '$.id') AS id,
              json_extract(value, '$.resource_id') AS resource_id,
              json_extract(value, '$.resource_version') AS resource_version,
              json_extract(value, '$.metadata_json') AS metadata_json
         FROM json_each(?)
     )
     SELECT audit.id, ?, ?, ?, audit.resource_id, audit.resource_version, ?, audit.metadata_json, ?
       FROM audits audit
      WHERE EXISTS (
        SELECT 1 FROM admin_account_operation_guards
         WHERE scope = ? AND idempotency_key_hash = ?
      )`,
  ).bind(
    values, actor.user_id, actor.session_id, action, idempotency.key_hash, now,
    idempotency.scope, idempotency.key_hash,
  )
}

async function finalizeOperation<T>(
  env: Env,
  idempotency: ControlIdempotency,
  resourceType: string,
  response: T,
  now: number,
): Promise<T> {
  try {
    await controlIdempotencyInsert(
      env, idempotency, resourceType, idempotency.key_hash, response, now,
    ).run()
    return response
  } catch (error) {
    const recovered = await findControlIdempotency(env, idempotency)
    if (recovered !== null) return parseIdempotentResponse(recovered, resourceType)
    throw error
  }
}

function operationGuardInsert(
  env: Env,
  value: ControlIdempotency,
  action: string,
  rows: OperationAccountRow[],
  now: number,
): D1PreparedStatement {
  const snapshots = JSON.stringify(rows)
  const exactRows = rows.length === 0 ? '1 = 1' : `? = (
    SELECT COUNT(*) FROM accounts account
      JOIN json_each(?) snapshot ON account.id = json_extract(snapshot.value, '$.id')
     WHERE account.enabled = json_extract(snapshot.value, '$.enabled')
       AND account.config_version = json_extract(snapshot.value, '$.config_version')
       AND account.control_version = json_extract(snapshot.value, '$.control_version')
       AND account.credential_ref = json_extract(snapshot.value, '$.credential_ref')
       AND account.health_probe_generation = json_extract(snapshot.value, '$.health_probe_generation')
       AND account.recovery_revision = json_extract(snapshot.value, '$.recovery_revision')
  )`
  return env.DB.prepare(
    `INSERT INTO admin_account_operation_guards (
       scope, idempotency_key_hash, request_hash, action,
       target_count, created_at_ms, expires_at_ms
     ) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${exactRows}`,
  ).bind(
    value.scope, value.key_hash, value.request_hash, action,
    rows.length, now, now + IDEMPOTENCY_TTL_MS,
    ...(rows.length === 0 ? [] : [rows.length, snapshots]),
  )
}

function guardedIdempotencyInsert(
  env: Env,
  value: ControlIdempotency,
  resourceType: string,
  response: unknown,
  action: string,
  successful: number,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO control_idempotency (
       scope, key_hash, request_hash, resource_type, resource_id,
       response_json, created_at_ms, expires_at_ms
     ) VALUES (?, ?, ?, ?,
       CASE WHEN (
         SELECT COUNT(*) FROM admin_account_audit_events
          WHERE idempotency_key_hash = ? AND action = ?
       ) = ? AND EXISTS (
         SELECT 1 FROM admin_account_operation_guards
          WHERE scope = ? AND idempotency_key_hash = ?
       ) THEN ? ELSE NULL END,
       ?, ?, ?)`,
  ).bind(
    value.scope, value.key_hash, value.request_hash, resourceType,
    value.key_hash, action, successful, value.scope, value.key_hash, value.key_hash,
    JSON.stringify(response), now, now + IDEMPOTENCY_TTL_MS,
  )
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unknown !== undefined) {
    throw new GatewayError(400, 'invalid_body_field', `Unsupported request field: ${unknown}`)
  }
}

function isCasFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /NOT NULL constraint failed: (?:admin_account_audit_events\.id|control_idempotency\.resource_id)/i.test(message)
}

function mapWriteError(error: unknown): unknown {
  if (isCasFailure(error)) {
    return new GatewayError(409, 'account_version_conflict', 'Accounts changed; reload and retry')
  }
  return error
}
