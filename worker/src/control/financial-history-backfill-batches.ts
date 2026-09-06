import type { Context } from 'hono'

import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { authenticateAdminSession, type AdminActor } from './admin-auth'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  optionalSafeInteger,
  readJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
} from './http'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
  type ControlIdempotency,
  type ControlIdempotencyRow,
} from './idempotency'
import {
  requiresFinancialHistoryManualReconciliation,
  runFinancialHistoryBackfillPage,
} from './financial-history-backfill'

type ControlBindings = { Bindings: Env }

export type FinancialHistoryBackfillBatchStatus =
  'queued' | 'running' | 'blocked' | 'completed' | 'failed'
export type FinancialHistoryBackfillUserStatus =
  FinancialHistoryBackfillBatchStatus | 'manual_reconciliation'

type BatchStatus = FinancialHistoryBackfillBatchStatus
type UserStatus = FinancialHistoryBackfillUserStatus

interface BatchRow {
  id: string
  status: BatchStatus
  control_version: number
  total_users: number
  created_by_user_id: string
  created_by_session_id: string
  last_run_by_user_id: string | null
  last_run_by_session_id: string | null
  runner_lease_token: string | null
  runner_lease_expires_at_ms: number | null
  created_at_ms: number
  updated_at_ms: number
  completed_at_ms: number | null
}

interface BatchUserRow {
  batch_id: string
  user_id: string
  ordinal: number
  status: UserStatus
  continuation_cursor: string | null
  pages_processed: number
  attempts: number
  lease_token: string | null
  lease_expires_at_ms: number | null
  error_code: string | null
  error_message: string | null
  version: number
  created_at_ms: number
  updated_at_ms: number
  completed_at_ms: number | null
}

export interface FinancialHistoryBackfillBatchView
  extends Omit<BatchRow,
    'created_by_session_id' | 'last_run_by_session_id' |
    'runner_lease_token' | 'runner_lease_expires_at_ms'> {
  items: Array<Omit<BatchUserRow, 'batch_id' | 'lease_token' | 'lease_expires_at_ms'>>
  run?: { users_attempted: number; pages_attempted: number }
}

type BatchView = FinancialHistoryBackfillBatchView

const MAX_BATCH_USERS = 25
const DEFAULT_RUN_USER_BUDGET = 5
const DEFAULT_RUN_PAGE_BUDGET = 1
const MAX_RUN_USER_BUDGET = 10
// One Worker invocation performs at most one DO ledger export page. This keeps
// CPU/SQL subrequest cost bounded even when a page contains 100 projections.
const MAX_RUN_PAGE_BUDGET = 1
const RUN_LEASE_MS = 60_000
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_CREATE_BODY_BYTES = 4_096
const MAX_CONTINUE_BODY_BYTES = 1_024
const OPERATION_RESOURCE_TYPE = 'financial_history_backfill_batch_operation'

interface BackfillStepOperation {
  state: 'in_progress'
  batch_id: string
  expected_control_version: number
  from_status: BatchStatus
  lease_token: string
  lease_expires_at_ms: number
  selected_user_id: string | null
  page_finished: boolean
}

export async function createAdminFinancialHistoryBackfillBatch(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const key = requireIdempotencyKey(context.req.raw)
    const input = await readJsonObject(context.req.raw, MAX_CREATE_BODY_BYTES)
    const userIds = parseUserIds(input.user_ids)
    const idempotency = await controlIdempotency(
      'admin.financial_history.backfill_batches.create.v1', key, { user_ids: userIds },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      return controlSuccess(parseIdempotentResponse<BatchView>(previous, 'financial_history_backfill_batch'))
    }

    const users = await context.env.DB.batch(userIds.map((userId) => context.env.DB.prepare(
      `SELECT id, financial_history_complete FROM users WHERE id = ?`,
    ).bind(userId)))
    for (let index = 0; index < userIds.length; index += 1) {
      if (users[index]!.results.length !== 1) {
        throw new GatewayError(404, 'user_not_found', `User was not found: ${userIds[index]}`)
      }
    }

    const batchId = await deterministicUuid('admin.financial_history.backfill_batch.v1', key)
    const now = Date.now()
    const batch: BatchRow = {
      id: batchId,
      status: users.every((result) => Number((result.results[0] as any).financial_history_complete) === 1)
        ? 'completed'
        : 'queued',
      control_version: 0,
      total_users: userIds.length,
      created_by_user_id: actor.user_id,
      created_by_session_id: actor.session_id,
      last_run_by_user_id: null,
      last_run_by_session_id: null,
      runner_lease_token: null,
      runner_lease_expires_at_ms: null,
      created_at_ms: now,
      updated_at_ms: now,
      completed_at_ms: null,
    }
    if (batch.status === 'completed') batch.completed_at_ms = now
    const itemRows: BatchUserRow[] = userIds.map((userId, ordinal) => {
      const complete = Number((users[ordinal]!.results[0] as any).financial_history_complete) === 1
      return {
        batch_id: batchId, user_id: userId, ordinal,
        status: complete ? 'completed' : 'queued', continuation_cursor: null,
        pages_processed: 0, attempts: 0, lease_token: null, lease_expires_at_ms: null,
        error_code: null, error_message: null, version: 0,
        created_at_ms: now, updated_at_ms: now, completed_at_ms: complete ? now : null,
      }
    })
    const response = batchView(batch, itemRows)
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO admin_financial_history_backfill_batches (
           id, status, control_version, total_users, created_by_user_id, created_by_session_id,
           created_at_ms, updated_at_ms, completed_at_ms
         ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        batch.id, batch.status, batch.total_users, actor.user_id, actor.session_id,
        now, now, batch.completed_at_ms,
      ),
      ...itemRows.map((item) => context.env.DB.prepare(
        `INSERT INTO admin_financial_history_backfill_batch_users (
           batch_id, user_id, ordinal, status, continuation_cursor, pages_processed,
           attempts, version, created_at_ms, updated_at_ms, completed_at_ms
         ) VALUES (?, ?, ?, ?, NULL, 0, 0, 0, ?, ?, ?)`,
      ).bind(batchId, item.user_id, item.ordinal, item.status, now, now, item.completed_at_ms)),
      batchAuditStatement(context.env, actor, batchId, 'created', null, batch.status, 0, now),
      controlIdempotencyInsert(
        context.env, idempotency, 'financial_history_backfill_batch', batchId, response, now,
      ),
    ])
    return controlSuccess(response, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminFinancialHistoryBackfillBatch(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const batchId = requireResourceId(context.req.param('id'), 'financial_history_backfill_batch')
    return controlSuccess(await loadBatchView(context.env, batchId))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function continueAdminFinancialHistoryBackfillBatch(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const batchId = requireResourceId(context.req.param('id'), 'financial_history_backfill_batch')
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const key = requireIdempotencyKey(context.req.raw)
    const input = await readJsonObject(context.req.raw, MAX_CONTINUE_BODY_BYTES)
    const expectedVersion = requireExpectedControlVersion(context.req.raw, input)
    const userBudget = optionalSafeInteger(
      input, 'user_budget', 1, MAX_RUN_USER_BUDGET,
    ) ?? DEFAULT_RUN_USER_BUDGET
    const pageBudget = optionalSafeInteger(
      input, 'page_budget', 1, MAX_RUN_PAGE_BUDGET,
    ) ?? DEFAULT_RUN_PAGE_BUDGET
    const requestShape = {
      expected_control_version: expectedVersion,
      user_budget: userBudget,
      page_budget: pageBudget,
    }
    const idempotency = await controlIdempotency(
      `admin.financial_history.backfill_batches.continue.v1:${batchId}`, key, requestShape,
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      if (previous.resource_type === 'financial_history_backfill_batch') {
        return controlSuccess(parseIdempotentResponse<BatchView>(previous, 'financial_history_backfill_batch'))
      }
    }
    return controlSuccess(await runFinancialHistoryBackfillBatchStep(
      context.env,
      actor,
      { batch_id: batchId, expected_control_version: expectedVersion, user_budget: userBudget,
        page_budget: pageBudget },
      idempotency,
      previous === null ? undefined : parseStepOperation(previous, batchId, expectedVersion),
    ))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export interface FinancialHistoryBackfillBatchStepInput {
  batch_id: string
  expected_control_version: number
  user_budget: number
  page_budget: number
}

interface StepOwnership {
  current: BatchRow
  batchLeaseToken: string
  operation?: BackfillStepOperation
}

interface ClaimTransition {
  status: UserStatus
  cursor: string | null
  errorCode: string | null
  errorMessage: string | null
  completedAt: number | null
  pageSucceeded: boolean
}

/**
 * One bounded coordinator step. Cron or Queue consumers can call this directly
 * with a durable system actor; the HTTP adapter additionally supplies an
 * idempotency record that commits atomically with the resulting batch state.
 */
export async function runFinancialHistoryBackfillBatchStep(
  env: Env,
  actor: AdminActor,
  input: FinancialHistoryBackfillBatchStepInput,
  idempotency?: ControlIdempotency,
  existingOperation?: BackfillStepOperation,
): Promise<BatchView> {
  const batchId = requireResourceId(input.batch_id, 'financial_history_backfill_batch')
  const expectedVersion = boundedBudget(
    input.expected_control_version, 'expected_control_version', 0, Number.MAX_SAFE_INTEGER,
  )
  const userBudget = boundedBudget(input.user_budget, 'user_budget', 1, MAX_RUN_USER_BUDGET)
  const pageBudget = boundedBudget(input.page_budget, 'page_budget', 1, MAX_RUN_PAGE_BUDGET)
  const ownership = idempotency === undefined
    ? await startDirectStep(env, actor, batchId, expectedVersion)
    : await acquireIdempotentStep(
      env, actor, batchId, expectedVersion, idempotency, existingOperation,
    )
  const { current, batchLeaseToken } = ownership
  let operation = ownership.operation
  let item: BatchUserRow | null = null
  if (operation?.selected_user_id !== null && operation?.selected_user_id !== undefined) {
    item = await requireBatchUser(env, batchId, operation.selected_user_id)
  } else if (operation?.page_finished !== true) {
    item = await findRunnableBatchUser(env, batchId, Date.now(), Math.min(userBudget, pageBudget))
  }
  let pagesAttempted = operation?.selected_user_id === null ? 0 : 1
  if (operation?.page_finished !== true && item !== null) {
    const claimed = idempotency === undefined
      ? await claimDirectItem(env, batchId, batchLeaseToken, item)
      : await claimOperationItem(env, batchId, batchLeaseToken, idempotency, operation!, item)
    operation = claimed.operation
    pagesAttempted = 1
    let transition: ClaimTransition
    try {
      const result = await runFinancialHistoryBackfillPage(
        env, actor, item.user_id, item.continuation_cursor ?? undefined,
      )
      transition = {
        status: result.history_complete ? 'completed' : 'queued',
        cursor: result.next_cursor ?? null,
        errorCode: null,
        errorMessage: null,
        completedAt: result.history_complete ? Date.now() : null,
        pageSucceeded: true,
      }
    } catch (error) {
      const failure = asGatewayError(error)
      transition = {
        status: requiresFinancialHistoryManualReconciliation(error)
          ? 'manual_reconciliation'
          : failure.status === 409 ? 'blocked' : 'failed',
        cursor: item.continuation_cursor,
        errorCode: failure.code,
        errorMessage: failure.message,
        completedAt: null,
        pageSucceeded: false,
      }
    }
    if (idempotency === undefined) {
      await finishClaim(env, batchId, item.user_id, claimed.token, transition)
      operation = undefined
    } else {
      operation = await finishOperationClaim(
        env, batchId, item.user_id, claimed.token, transition, idempotency, operation!,
      )
    }
  } else if (idempotency !== undefined && operation?.page_finished !== true) {
    operation = await markOperationPageFinished(
      env, batchId, batchLeaseToken, idempotency, operation!,
    )
  }

  const items = await loadBatchUsers(env, batchId)
  const finalStatus = deriveBatchStatus(items)
  const finishedAt = Date.now()
  const completedAt = finalStatus === 'completed' ? finishedAt : null
  const finalVersion = expectedVersion + 1
  const response = batchView({
    ...current,
    status: finalStatus,
    control_version: finalVersion,
    last_run_by_user_id: actor.user_id,
    last_run_by_session_id: actor.session_id,
    updated_at_ms: finishedAt,
    completed_at_ms: completedAt,
  }, items, { users_attempted: pagesAttempted, pages_attempted: pagesAttempted })
  const fromStatus = operation?.from_status ?? current.status
  const finalStatements: D1PreparedStatement[] = []
  if (idempotency !== undefined) {
    finalStatements.push(conditionalBatchAuditForOperation(
      env, actor, batchId, fromStatus, finalStatus, finalVersion, finishedAt,
      batchLeaseToken, idempotency, operation!,
    ))
    finalStatements.push(completeOperationStatement(
      env, idempotency, operation!, batchId, response, finalVersion, batchLeaseToken,
    ))
  } else {
    finalStatements.push(conditionalBatchAuditStatement(
      env, actor, batchId, fromStatus, finalStatus, finalVersion, finishedAt, batchLeaseToken,
    ))
  }
  finalStatements.push(env.DB.prepare(
      `UPDATE admin_financial_history_backfill_batches
          SET status = ?, updated_at_ms = ?, completed_at_ms = ?,
              runner_lease_token = NULL, runner_lease_expires_at_ms = NULL
        WHERE id = ? AND control_version = ? AND status = 'running'
          AND runner_lease_token = ?
        RETURNING id`,
    ).bind(finalStatus, finishedAt, completedAt, batchId, finalVersion, batchLeaseToken))
  const results = await env.DB.batch(finalStatements)
  const updated = results[results.length - 1]!
  if (updated!.results.length !== 1) throw batchChanged()
  return response
}

async function startDirectStep(
  env: Env,
  actor: AdminActor,
  batchId: string,
  expectedVersion: number,
): Promise<StepOwnership> {
  const current = await requireStartableBatch(env, batchId, expectedVersion)
  const now = Date.now()
  const token = crypto.randomUUID()
  const [started] = await env.DB.batch([startBatchStatement(
    env, actor, batchId, expectedVersion, token, now, false,
  )])
  if (started!.results.length !== 1) throw batchChanged()
  return { current, batchLeaseToken: token }
}

async function acquireIdempotentStep(
  env: Env,
  actor: AdminActor,
  batchId: string,
  expectedVersion: number,
  idempotency: ControlIdempotency,
  existing?: BackfillStepOperation,
): Promise<StepOwnership> {
  if (existing !== undefined) {
    const now = Date.now()
    if (existing.lease_expires_at_ms > now) throw operationInProgress()
    const current = await requireBatch(env, batchId)
    const token = crypto.randomUUID()
    const resumed: BackfillStepOperation = {
      ...existing,
      lease_token: token,
      lease_expires_at_ms: now + RUN_LEASE_MS,
    }
    const oldJson = JSON.stringify(existing)
    const resumedJson = JSON.stringify(resumed)
    const [owned, batchOwned] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE control_idempotency SET response_json = ?
          WHERE scope = ? AND key_hash = ? AND request_hash = ?
            AND resource_type = ? AND response_json = ?
            AND EXISTS (
              SELECT 1 FROM admin_financial_history_backfill_batches
               WHERE id = ? AND status = 'running' AND control_version = ?
                 AND runner_lease_token = ? AND runner_lease_expires_at_ms <= ?
            )
          RETURNING scope`,
      ).bind(
        resumedJson, idempotency.scope, idempotency.key_hash,
        idempotency.request_hash, OPERATION_RESOURCE_TYPE, oldJson,
        batchId, expectedVersion + 1, existing.lease_token, now,
      ),
      env.DB.prepare(
        `UPDATE admin_financial_history_backfill_batches
            SET runner_lease_token = ?, runner_lease_expires_at_ms = ?,
                last_run_by_user_id = ?, last_run_by_session_id = ?, updated_at_ms = ?
          WHERE id = ? AND status = 'running' AND control_version = ?
            AND runner_lease_token = ? AND runner_lease_expires_at_ms <= ?
            AND EXISTS (
              SELECT 1 FROM control_idempotency
               WHERE scope = ? AND key_hash = ? AND request_hash = ?
                 AND resource_type = ? AND response_json = ?
            )
          RETURNING id`,
      ).bind(
        token, resumed.lease_expires_at_ms, actor.user_id, actor.session_id, now,
        batchId, expectedVersion + 1, existing.lease_token, now,
        idempotency.scope, idempotency.key_hash, idempotency.request_hash,
        OPERATION_RESOURCE_TYPE, resumedJson,
      ),
    ])
    if (owned!.results.length !== 1 || batchOwned!.results.length !== 1) throw batchChanged()
    return { current, batchLeaseToken: token, operation: resumed }
  }

  const current = await requireStartableBatch(env, batchId, expectedVersion)
  const now = Date.now()
  const token = crypto.randomUUID()
  const operation: BackfillStepOperation = {
    state: 'in_progress',
    batch_id: batchId,
    expected_control_version: expectedVersion,
    from_status: current.status,
    lease_token: token,
    lease_expires_at_ms: now + RUN_LEASE_MS,
    selected_user_id: null,
    page_finished: false,
  }
  try {
    const [recorded, started] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO control_idempotency (
           scope, key_hash, request_hash, resource_type, resource_id,
           response_json, created_at_ms, expires_at_ms
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM admin_financial_history_backfill_batches
             WHERE id = ? AND control_version = ?
               AND status NOT IN ('running', 'completed')
          )
         RETURNING scope`,
      ).bind(
        idempotency.scope, idempotency.key_hash, idempotency.request_hash,
        OPERATION_RESOURCE_TYPE, batchId, JSON.stringify(operation),
        now, now + IDEMPOTENCY_TTL_MS, batchId, expectedVersion,
      ),
      startBatchStatement(env, actor, batchId, expectedVersion, token, now, false),
    ])
    if (recorded!.results.length !== 1 || started!.results.length !== 1) throw batchChanged()
  } catch (error) {
    const concurrent = await findControlIdempotency(env, idempotency)
    if (concurrent !== null) {
      if (concurrent.resource_type === 'financial_history_backfill_batch') {
        throw batchChanged()
      }
      const concurrentOperation = parseStepOperation(concurrent, batchId, expectedVersion)
      if (concurrentOperation.lease_expires_at_ms > Date.now()) throw operationInProgress()
    }
    throw error
  }
  return { current, batchLeaseToken: token, operation }
}

async function requireStartableBatch(
  env: Env,
  batchId: string,
  expectedVersion: number,
): Promise<BatchRow> {
  const current = await requireBatch(env, batchId)
  if (current.control_version !== expectedVersion) throw batchChanged()
  if (current.status === 'completed') {
    throw new GatewayError(409, 'financial_history_backfill_batch_completed', 'Backfill batch is complete')
  }
  if (current.status === 'running') throw batchChanged()
  return current
}

function startBatchStatement(
  env: Env,
  actor: AdminActor,
  batchId: string,
  expectedVersion: number,
  token: string,
  now: number,
  allowRunning: boolean,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE admin_financial_history_backfill_batches
        SET status = 'running', control_version = control_version + 1,
            last_run_by_user_id = ?, last_run_by_session_id = ?, updated_at_ms = ?,
            runner_lease_token = ?, runner_lease_expires_at_ms = ?
      WHERE id = ? AND control_version = ? AND status <> 'completed'
        AND (? = 1 OR status <> 'running')
      RETURNING id`,
  ).bind(
    actor.user_id, actor.session_id, now, token, now + RUN_LEASE_MS,
    batchId, expectedVersion, allowRunning ? 1 : 0,
  )
}

async function findRunnableBatchUser(
  env: Env,
  batchId: string,
  now: number,
  limit: number,
): Promise<BatchUserRow | null> {
  return env.DB.prepare(
    `SELECT batch_id, user_id, ordinal, status, continuation_cursor, pages_processed,
            attempts, lease_token, lease_expires_at_ms, error_code, error_message,
            version, created_at_ms, updated_at_ms, completed_at_ms
       FROM admin_financial_history_backfill_batch_users
      WHERE batch_id = ?
        AND (status IN ('queued', 'failed')
          OR (status = 'running' AND lease_expires_at_ms <= ?))
      ORDER BY ordinal LIMIT ?`,
  ).bind(batchId, now, limit).first<BatchUserRow>()
}

async function requireBatchUser(env: Env, batchId: string, userId: string): Promise<BatchUserRow> {
  const row = await env.DB.prepare(
    `SELECT batch_id, user_id, ordinal, status, continuation_cursor, pages_processed,
            attempts, lease_token, lease_expires_at_ms, error_code, error_message,
            version, created_at_ms, updated_at_ms, completed_at_ms
       FROM admin_financial_history_backfill_batch_users
      WHERE batch_id = ? AND user_id = ?`,
  ).bind(batchId, userId).first<BatchUserRow>()
  if (row === null) throw batchChanged()
  return row
}

async function claimDirectItem(
  env: Env,
  batchId: string,
  batchToken: string,
  item: BatchUserRow,
): Promise<{ token: string; operation?: BackfillStepOperation }> {
  const now = Date.now()
  const token = crypto.randomUUID()
  const [batchLease, claimed] = await env.DB.batch([
    renewBatchLeaseStatement(env, batchId, batchToken, now),
    claimItemStatement(env, batchId, item, token, now),
  ])
  if (batchLease!.results.length !== 1 || claimed!.results.length !== 1) throw batchChanged()
  return { token }
}

async function claimOperationItem(
  env: Env,
  batchId: string,
  batchToken: string,
  idempotency: ControlIdempotency,
  operation: BackfillStepOperation,
  item: BatchUserRow,
): Promise<{ token: string; operation: BackfillStepOperation }> {
  const now = Date.now()
  const next: BackfillStepOperation = {
    ...operation,
    selected_user_id: item.user_id,
    lease_expires_at_ms: now + RUN_LEASE_MS,
  }
  const [owned, batchLease, claimed] = await env.DB.batch([
    updateOperationStatement(env, idempotency, operation, next, batchId, batchToken),
    renewBatchLeaseStatement(env, batchId, batchToken, now),
    claimOperationItemStatement(
      env, batchId, item, batchToken, now, idempotency, next, operation.expected_control_version,
    ),
  ])
  if (
    owned!.results.length !== 1 || batchLease!.results.length !== 1 ||
    claimed!.results.length !== 1
  ) throw batchChanged()
  return { token: batchToken, operation: next }
}

function claimOperationItemStatement(
  env: Env,
  batchId: string,
  item: BatchUserRow,
  token: string,
  now: number,
  idempotency: ControlIdempotency,
  operation: BackfillStepOperation,
  expectedControlVersion: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE admin_financial_history_backfill_batch_users
        SET status = 'running', lease_token = ?, lease_expires_at_ms = ?,
            attempts = attempts + 1, error_code = NULL, error_message = NULL,
            version = version + 1, updated_at_ms = ?
      WHERE batch_id = ? AND user_id = ? AND version = ?
        AND (status IN ('queued', 'failed')
          OR (status = 'running' AND lease_expires_at_ms <= ?))
        AND EXISTS (
          SELECT 1 FROM admin_financial_history_backfill_batches
           WHERE id = ? AND status = 'running' AND control_version = ?
             AND runner_lease_token = ?
        )
        AND EXISTS (
          SELECT 1 FROM control_idempotency
           WHERE scope = ? AND key_hash = ? AND request_hash = ?
             AND resource_type = ? AND response_json = ?
        )
      RETURNING user_id`,
  ).bind(
    token, now + RUN_LEASE_MS, now,
    batchId, item.user_id, item.version, now,
    batchId, expectedControlVersion + 1, token,
    idempotency.scope, idempotency.key_hash, idempotency.request_hash,
    OPERATION_RESOURCE_TYPE, JSON.stringify(operation),
  )
}

function renewBatchLeaseStatement(
  env: Env,
  batchId: string,
  token: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE admin_financial_history_backfill_batches
        SET runner_lease_expires_at_ms = ?, updated_at_ms = MAX(updated_at_ms, ?)
      WHERE id = ? AND status = 'running' AND runner_lease_token = ?
      RETURNING id`,
  ).bind(now + RUN_LEASE_MS, now, batchId, token)
}

function claimItemStatement(
  env: Env,
  batchId: string,
  item: BatchUserRow,
  token: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE admin_financial_history_backfill_batch_users
        SET status = 'running', lease_token = ?, lease_expires_at_ms = ?,
            attempts = attempts + 1, error_code = NULL, error_message = NULL,
            version = version + 1, updated_at_ms = ?
      WHERE batch_id = ? AND user_id = ? AND version = ?
        AND (status IN ('queued', 'failed')
          OR (status = 'running' AND lease_expires_at_ms <= ?))
      RETURNING user_id`,
  ).bind(token, now + RUN_LEASE_MS, now, batchId, item.user_id, item.version, now)
}

function updateOperationStatement(
  env: Env,
  idempotency: ControlIdempotency,
  current: BackfillStepOperation,
  next: BackfillStepOperation,
  batchId: string,
  batchToken: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE control_idempotency SET response_json = ?
      WHERE scope = ? AND key_hash = ? AND request_hash = ?
        AND resource_type = ? AND response_json = ?
        AND EXISTS (
          SELECT 1 FROM admin_financial_history_backfill_batches
           WHERE id = ? AND status = 'running' AND runner_lease_token = ?
        )
      RETURNING scope`,
  ).bind(
    JSON.stringify(next), idempotency.scope, idempotency.key_hash, idempotency.request_hash,
    OPERATION_RESOURCE_TYPE, JSON.stringify(current), batchId, batchToken,
  )
}

async function markOperationPageFinished(
  env: Env,
  batchId: string,
  batchToken: string,
  idempotency: ControlIdempotency,
  operation: BackfillStepOperation,
): Promise<BackfillStepOperation> {
  const next = { ...operation, page_finished: true }
  const result = await updateOperationStatement(
    env, idempotency, operation, next, batchId, batchToken,
  ).run()
  if (result.meta.changes !== 1) throw batchChanged()
  return next
}

async function finishClaim(
  env: Env,
  batchId: string,
  userId: string,
  token: string,
  transition: ClaimTransition,
): Promise<void> {
  const result = await finishClaimStatement(env, batchId, userId, token, transition).run()
  if (result.meta.changes !== 1) throw batchChanged()
}

async function finishOperationClaim(
  env: Env,
  batchId: string,
  userId: string,
  token: string,
  transition: ClaimTransition,
  idempotency: ControlIdempotency,
  operation: BackfillStepOperation,
): Promise<BackfillStepOperation> {
  const next = { ...operation, page_finished: true }
  const [owned, item] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE control_idempotency SET response_json = ?
        WHERE scope = ? AND key_hash = ? AND request_hash = ?
          AND resource_type = ? AND response_json = ?
          AND EXISTS (
            SELECT 1 FROM admin_financial_history_backfill_batch_users
             WHERE batch_id = ? AND user_id = ? AND status = 'running' AND lease_token = ?
          )
          AND EXISTS (
            SELECT 1 FROM admin_financial_history_backfill_batches
             WHERE id = ? AND status = 'running' AND control_version = ?
               AND runner_lease_token = ?
          )
        RETURNING scope`,
    ).bind(
      JSON.stringify(next), idempotency.scope, idempotency.key_hash, idempotency.request_hash,
      OPERATION_RESOURCE_TYPE, JSON.stringify(operation), batchId, userId, token,
      batchId, operation.expected_control_version + 1, operation.lease_token,
    ),
    finishOperationItemStatement(
      env, batchId, userId, token, transition, idempotency, next, operation.lease_token,
    ),
  ])
  if (owned!.results.length !== 1 || item!.results.length !== 1) throw batchChanged()
  return next
}

function finishOperationItemStatement(
  env: Env,
  batchId: string,
  userId: string,
  token: string,
  transition: ClaimTransition,
  idempotency: ControlIdempotency,
  operation: BackfillStepOperation,
  batchToken: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE admin_financial_history_backfill_batch_users
        SET status = ?, continuation_cursor = ?, pages_processed = pages_processed + ?,
            lease_token = NULL, lease_expires_at_ms = NULL,
            error_code = ?, error_message = ?, version = version + 1,
            updated_at_ms = ?, completed_at_ms = ?
      WHERE batch_id = ? AND user_id = ? AND status = 'running' AND lease_token = ?
        AND EXISTS (
          SELECT 1 FROM admin_financial_history_backfill_batches
           WHERE id = ? AND status = 'running' AND control_version = ?
             AND runner_lease_token = ?
        )
        AND EXISTS (
          SELECT 1 FROM control_idempotency
           WHERE scope = ? AND key_hash = ? AND request_hash = ?
             AND resource_type = ? AND response_json = ?
        )
      RETURNING user_id`,
  ).bind(
    transition.status,
    transition.cursor,
    transition.pageSucceeded ? 1 : 0,
    transition.errorCode,
    transition.errorMessage,
    Date.now(),
    transition.completedAt,
    batchId, userId, token,
    batchId, operation.expected_control_version + 1, batchToken,
    idempotency.scope, idempotency.key_hash, idempotency.request_hash,
    OPERATION_RESOURCE_TYPE, JSON.stringify(operation),
  )
}

function finishClaimStatement(
  env: Env,
  batchId: string,
  userId: string,
  token: string,
  transition: ClaimTransition,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE admin_financial_history_backfill_batch_users
        SET status = ?, continuation_cursor = ?, pages_processed = pages_processed + ?,
            lease_token = NULL, lease_expires_at_ms = NULL,
            error_code = ?, error_message = ?, version = version + 1,
            updated_at_ms = ?, completed_at_ms = ?
      WHERE batch_id = ? AND user_id = ? AND status = 'running' AND lease_token = ?
      RETURNING user_id`,
  ).bind(
    transition.status,
    transition.cursor,
    transition.pageSucceeded ? 1 : 0,
    transition.errorCode,
    transition.errorMessage,
    Date.now(),
    transition.completedAt,
    batchId, userId, token,
  )
}

function parseUserIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BATCH_USERS) {
    throw new GatewayError(
      400, 'invalid_user_ids', `user_ids must contain between 1 and ${MAX_BATCH_USERS} users`,
    )
  }
  const ids = value.map((entry) => requireResourceId(
    typeof entry === 'string' ? entry : undefined, 'user',
  ))
  if (new Set(ids).size !== ids.length) {
    throw new GatewayError(400, 'duplicate_user_ids', 'user_ids must not contain duplicates')
  }
  return ids
}

function boundedBudget(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new GatewayError(400, `invalid_${name}`, `${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

async function requireBatch(env: Env, batchId: string): Promise<BatchRow> {
  const row = await env.DB.prepare(
    `SELECT id, status, control_version, total_users,
            created_by_user_id, created_by_session_id,
            last_run_by_user_id, last_run_by_session_id,
            runner_lease_token, runner_lease_expires_at_ms,
            created_at_ms, updated_at_ms, completed_at_ms
       FROM admin_financial_history_backfill_batches WHERE id = ?`,
  ).bind(batchId).first<BatchRow>()
  if (row === null) {
    throw new GatewayError(
      404, 'financial_history_backfill_batch_not_found', 'Backfill batch was not found',
    )
  }
  return row
}

async function loadBatchUsers(env: Env, batchId: string): Promise<BatchUserRow[]> {
  const result = await env.DB.prepare(
    `SELECT batch_id, user_id, ordinal, status, continuation_cursor, pages_processed,
            attempts, lease_token, lease_expires_at_ms, error_code, error_message,
            version, created_at_ms, updated_at_ms, completed_at_ms
       FROM admin_financial_history_backfill_batch_users
      WHERE batch_id = ? ORDER BY ordinal LIMIT ?`,
  ).bind(batchId, MAX_BATCH_USERS).all<BatchUserRow>()
  return result.results
}

async function loadBatchView(env: Env, batchId: string): Promise<BatchView> {
  const batch = await requireBatch(env, batchId)
  const items = await loadBatchUsers(env, batchId)
  if (items.length !== batch.total_users) {
    throw new GatewayError(
      503, 'financial_history_backfill_batch_corrupt', 'Backfill batch is incomplete', 'server_error',
    )
  }
  return batchView(batch, items)
}

function batchView(
  batch: BatchRow,
  items: BatchUserRow[],
  run?: { users_attempted: number; pages_attempted: number },
): BatchView {
  return {
    id: batch.id,
    status: batch.status,
    control_version: batch.control_version,
    total_users: batch.total_users,
    created_by_user_id: batch.created_by_user_id,
    last_run_by_user_id: batch.last_run_by_user_id,
    created_at_ms: batch.created_at_ms,
    updated_at_ms: batch.updated_at_ms,
    completed_at_ms: batch.completed_at_ms,
    items: items.map(({ batch_id: _batch, lease_token: _lease, lease_expires_at_ms: _expiry, ...item }) => item),
    ...(run === undefined ? {} : { run }),
  }
}

function deriveBatchStatus(items: BatchUserRow[]): BatchStatus {
  if (items.every((item) => item.status === 'completed')) return 'completed'
  if (items.some((item) => item.status === 'failed')) return 'failed'
  if (items.some((item) => item.status === 'queued' || item.status === 'running')) return 'queued'
  return 'blocked'
}

function batchAuditStatement(
  env: Env,
  actor: AdminActor,
  batchId: string,
  action: 'created' | 'continued',
  fromStatus: BatchStatus | null,
  toStatus: BatchStatus,
  version: number,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO admin_financial_history_backfill_batch_audit_events (
       id, batch_id, actor_user_id, actor_session_id, action,
       from_status, to_status, batch_control_version, occurred_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), batchId, actor.user_id, actor.session_id,
    `financial_history.backfill_batch.${action}`, fromStatus, toStatus, version, now,
  )
}

function conditionalBatchAuditStatement(
  env: Env,
  actor: AdminActor,
  batchId: string,
  fromStatus: BatchStatus,
  toStatus: BatchStatus,
  version: number,
  now: number,
  leaseToken: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO admin_financial_history_backfill_batch_audit_events (
       id, batch_id, actor_user_id, actor_session_id, action,
       from_status, to_status, batch_control_version, occurred_at_ms
     )
     SELECT ?, ?, ?, ?, 'financial_history.backfill_batch.continued', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM admin_financial_history_backfill_batches
         WHERE id = ? AND status = 'running' AND control_version = ?
           AND runner_lease_token = ?
      )`,
  ).bind(
    crypto.randomUUID(), batchId, actor.user_id, actor.session_id,
    fromStatus, toStatus, version, now, batchId, version, leaseToken,
  )
}

function conditionalBatchAuditForOperation(
  env: Env,
  actor: AdminActor,
  batchId: string,
  fromStatus: BatchStatus,
  toStatus: BatchStatus,
  version: number,
  now: number,
  leaseToken: string,
  idempotency: ControlIdempotency,
  operation: BackfillStepOperation,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO admin_financial_history_backfill_batch_audit_events (
       id, batch_id, actor_user_id, actor_session_id, action,
       from_status, to_status, batch_control_version, occurred_at_ms
     )
     SELECT ?, ?, ?, ?, 'financial_history.backfill_batch.continued', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM admin_financial_history_backfill_batches
         WHERE id = ? AND status = 'running' AND control_version = ?
           AND runner_lease_token = ?
      ) AND EXISTS (
        SELECT 1 FROM control_idempotency
         WHERE scope = ? AND key_hash = ? AND request_hash = ?
           AND resource_type = ? AND response_json = ?
      )`,
  ).bind(
    crypto.randomUUID(), batchId, actor.user_id, actor.session_id,
    fromStatus, toStatus, version, now,
    batchId, version, leaseToken,
    idempotency.scope, idempotency.key_hash, idempotency.request_hash,
    OPERATION_RESOURCE_TYPE, JSON.stringify(operation),
  )
}

function completeOperationStatement(
  env: Env,
  idempotency: ControlIdempotency,
  operation: BackfillStepOperation,
  batchId: string,
  response: BatchView,
  version: number,
  leaseToken: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE control_idempotency
        SET resource_type = 'financial_history_backfill_batch', response_json = ?
      WHERE scope = ? AND key_hash = ? AND request_hash = ?
        AND resource_type = ? AND response_json = ?
        AND EXISTS (
          SELECT 1 FROM admin_financial_history_backfill_batches
           WHERE id = ? AND status = 'running' AND control_version = ?
             AND runner_lease_token = ?
        )
      RETURNING scope`,
  ).bind(
    JSON.stringify(response), idempotency.scope, idempotency.key_hash,
    idempotency.request_hash, OPERATION_RESOURCE_TYPE, JSON.stringify(operation),
    batchId, version, leaseToken,
  )
}

function parseStepOperation(
  row: ControlIdempotencyRow,
  batchId: string,
  expectedVersion: number,
): BackfillStepOperation {
  if (row.resource_type !== OPERATION_RESOURCE_TYPE || row.resource_id !== batchId) {
    throw new GatewayError(409, 'idempotency_conflict', 'Idempotency record has a different resource type')
  }
  let value: unknown
  try {
    value = JSON.parse(row.response_json)
  } catch {
    throw invalidOperation()
  }
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    (value as any).state !== 'in_progress' ||
    (value as any).batch_id !== batchId ||
    (value as any).expected_control_version !== expectedVersion ||
    !['queued', 'running', 'blocked', 'completed', 'failed'].includes((value as any).from_status) ||
    typeof (value as any).lease_token !== 'string' ||
    (value as any).lease_token.length < 1 || (value as any).lease_token.length > 128 ||
    !Number.isSafeInteger((value as any).lease_expires_at_ms) ||
    (value as any).lease_expires_at_ms < 0 ||
    ((value as any).selected_user_id !== null &&
      (typeof (value as any).selected_user_id !== 'string' ||
        (value as any).selected_user_id.length < 1 || (value as any).selected_user_id.length > 128)) ||
    typeof (value as any).page_finished !== 'boolean'
  ) throw invalidOperation()
  return value as BackfillStepOperation
}

function invalidOperation(): GatewayError {
  return new GatewayError(
    503,
    'invalid_financial_history_backfill_operation',
    'Backfill operation state is invalid',
    'server_error',
  )
}

function operationInProgress(): GatewayError {
  return new GatewayError(
    409,
    'financial_history_backfill_operation_in_progress',
    'This idempotent backfill operation is still running',
  )
}

function batchChanged(): GatewayError {
  return new GatewayError(
    409,
    'financial_history_backfill_batch_changed',
    'Backfill batch changed; reload and retry',
  )
}
