import type { Context } from 'hono'

import { authenticateAdminSession } from '../control/admin-auth'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  optionalString,
  queryInteger,
  readOptionalJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
  requireString,
} from '../control/http'
import type { Env } from '../env'
import { sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'

type PaymentBindings = { Bindings: Env }

const STALE_PENDING_MS = 5 * 60_000
const MAX_SCAN_LIMIT = 100
const EVIDENCE_CONTENT_TYPE = 'application/json'

const ISSUE_TYPES = [
  'late_paid_refund_required',
  'webhook_pending',
  'webhook_failed',
  'fulfillment_pending',
  'fulfillment_failed',
  'refund_pending',
  'refund_failed',
  'provider_amount_mismatch',
  'provider_status_mismatch',
] as const
const ISSUE_STATUSES = ['open', 'acknowledged', 'resolved'] as const
const ISSUE_SEVERITIES = ['warning', 'error', 'critical'] as const
const SOURCE_KINDS = ['order', 'webhook', 'fulfillment', 'refund'] as const
const ACTIONS = ['acknowledge', 'resolve', 'reopen'] as const
const SCAN_PHASES = ['order', 'webhook', 'fulfillment', 'refund'] as const

type IssueType = typeof ISSUE_TYPES[number]
type IssueStatus = typeof ISSUE_STATUSES[number]
type IssueSeverity = typeof ISSUE_SEVERITIES[number]
type SourceKind = typeof SOURCE_KINDS[number]
type ReconciliationAction = typeof ACTIONS[number]
type ScanPhase = typeof SCAN_PHASES[number]

interface ScanStateRow {
  cursor: string
  version: number
}

interface CandidateRow {
  issue_type: IssueType
  severity: IssueSeverity
  source_kind: SourceKind
  source_id: string
  order_id: string | null
  provider_instance_id: string | null
  source_status: string
  source_updated_at_ms: number
  expected_amount_micros: number | null
  observed_amount_micros: number | null
  currency: string | null
  attempts: number | null
  event_type: string | null
}

interface ScannedSourceRow extends Omit<CandidateRow, 'issue_type' | 'severity'> {
  paid_at_ms: number | null
  late_payment_requires_refund: number | null
}

interface ScanCursor {
  phase: ScanPhase
  updatedAtMs: number
  id: string
}

interface IssueRow {
  id: string
  fingerprint: string
  issue_type: IssueType
  severity: IssueSeverity
  status: IssueStatus
  source_kind: SourceKind
  source_id: string
  order_id: string | null
  provider_instance_id: string | null
  summary: string
  evidence_r2_key: string | null
  evidence_sha256: string | null
  evidence_content_length: number | null
  version: number
  acknowledged_by_user_id: string | null
  acknowledged_at_ms: number | null
  resolution_code: string | null
  resolution_note: string | null
  resolved_by_user_id: string | null
  resolved_at_ms: number | null
  first_observed_at_ms: number
  last_seen_at_ms: number
  updated_at_ms: number
}

interface ActionRow {
  id: string
  issue_id: string
  actor_user_id: string
  action: ReconciliationAction
  expected_version: number
  result_version: number
  idempotency_key_hash: string
  request_hash: string
  response_json: string
  occurred_at_ms: number
}

interface EventRow {
  id: string
  action: ReconciliationAction
  from_status: IssueStatus
  to_status: IssueStatus
  issue_version: number
  actor_user_id: string
  detail_json: string
  occurred_at_ms: number
}

export interface PaymentReconciliationScanResult {
  scanned: number
  issues_created: number
  issues_seen: number
  evidence_failures: number
  previous_cursor: string
  next_cursor: string
  cursor_conflict: boolean
}

/**
 * Bounded, replay-safe Cron scanner. Each invocation scans one source through
 * an index-backed (updated_at_ms, id) seek and stores one sanitized evidence
 * snapshot per logical issue in R2.
 */
export async function scanPaymentReconciliationIssues(
  env: Env,
  requestedLimit = 25,
): Promise<PaymentReconciliationScanResult> {
  const limit = normalizedScanLimit(requestedLimit)
  const startedAt = Date.now()
  const state = await env.DB.prepare(
    `SELECT cursor, version FROM payment_reconciliation_scan_state WHERE id = 'global'`,
  ).first<ScanStateRow>()
  if (state === null) {
    throw new GatewayError(
      503,
      'payment_reconciliation_state_unavailable',
      'Payment reconciliation state is unavailable',
      'server_error',
    )
  }
  const staleBefore = startedAt - STALE_PENDING_MS
  const cursor = parseScanCursor(state.cursor)
  const scannedRows = await loadScannedRows(env, cursor, limit)
  const candidates = scannedRows.results
    .map((row) => classifyCandidate(row, staleBefore))
    .filter((candidate): candidate is CandidateRow => candidate !== null)

  let created = 0
  let seen = 0
  let evidenceFailures = 0
  for (const candidate of candidates) {
    const fingerprint = await sha256Hex(
      `payment-reconciliation-issue:v1\0${candidate.issue_type}\0${candidate.source_kind}\0${candidate.source_id}`,
    )
    const issueId = await deterministicUuid('payment.reconciliation.issue.v1', fingerprint)
    const existing = await findIssueByFingerprint(env, fingerprint)
    const evidence = renderEvidence(candidate)
    const bytes = new TextEncoder().encode(evidence)
    const evidenceDigest = await sha256Hex(evidence)
    const evidenceKey = `payment-reconciliation-evidence/v2/${issueId}.json`
    const evidenceChanged = existing === null ||
      existing.evidence_sha256 !== evidenceDigest ||
      existing.evidence_r2_key !== evidenceKey
    if (evidenceChanged) {
      try {
        await env.OBJECTS.put(evidenceKey, evidence, {
          httpMetadata: { contentType: EVIDENCE_CONTENT_TYPE },
          customMetadata: { schema_version: '1', issue_id: issueId },
        })
      } catch (error) {
        evidenceFailures += 1
        console.error('payment reconciliation evidence R2 write failed', {
          name: error instanceof Error ? error.name : 'unknown',
        })
        continue
      }
    }

    await env.DB.prepare(
      `INSERT INTO payment_reconciliation_issues (
         id, fingerprint, issue_type, severity, status, source_kind, source_id,
         order_id, provider_instance_id, summary,
         evidence_r2_key, evidence_sha256, evidence_content_length,
         first_observed_at_ms, last_seen_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         severity = excluded.severity,
         summary = excluded.summary,
         evidence_r2_key = excluded.evidence_r2_key,
         evidence_sha256 = excluded.evidence_sha256,
         evidence_content_length = excluded.evidence_content_length,
         last_seen_at_ms = MAX(payment_reconciliation_issues.last_seen_at_ms,
                               excluded.last_seen_at_ms),
         updated_at_ms = MAX(payment_reconciliation_issues.updated_at_ms,
                             excluded.updated_at_ms)`,
    ).bind(
      issueId,
      fingerprint,
      candidate.issue_type,
      candidate.severity,
      candidate.source_kind,
      candidate.source_id,
      candidate.order_id,
      candidate.provider_instance_id,
      issueSummary(candidate.issue_type),
      evidenceKey,
      evidenceDigest,
      bytes.byteLength,
      startedAt,
      startedAt,
      startedAt,
    ).run()
    if (existing === null) created += 1
    else seen += 1
  }

  const nextCursor = advanceScanCursor(cursor, scannedRows.results, limit)
  const completedAt = Date.now()
  const advanced = await env.DB.prepare(
    `UPDATE payment_reconciliation_scan_state
        SET cursor = ?, version = version + 1,
            last_started_at_ms = ?, last_completed_at_ms = ?,
            updated_at_ms = MAX(updated_at_ms, ?)
      WHERE id = 'global' AND version = ? AND cursor = ?`,
  ).bind(
    nextCursor,
    startedAt,
    completedAt,
    completedAt,
    state.version,
    state.cursor,
  ).run()

  return {
    scanned: scannedRows.results.length,
    issues_created: created,
    issues_seen: seen,
    evidence_failures: evidenceFailures,
    previous_cursor: state.cursor,
    next_cursor: nextCursor,
    cursor_conflict: advanced.meta.changes !== 1,
  }
}

/** GET /api/v1/admin/payment/reconciliation */
export async function listAdminPaymentReconciliationIssues(
  context: Context<PaymentBindings>,
): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const status = optionalEnum(context.req.query('status'), 'status', ISSUE_STATUSES)
    const type = optionalEnum(context.req.query('type'), 'type', ISSUE_TYPES)
    const severity = optionalEnum(context.req.query('severity'), 'severity', ISSUE_SEVERITIES)
    const sourceKind = optionalEnum(
      context.req.query('source_kind'),
      'source_kind',
      SOURCE_KINDS,
    )
    const rawOrderId = context.req.query('order_id')
    const orderId = rawOrderId === undefined || rawOrderId === ''
      ? undefined
      : requireResourceId(rawOrderId, 'payment_order')
    const filters: string[] = []
    const values: unknown[] = []
    for (const [column, value] of [
      ['status', status],
      ['issue_type', type],
      ['severity', severity],
      ['source_kind', sourceKind],
      ['order_id', orderId],
    ] as const) {
      if (value !== undefined) {
        filters.push(`${column} = ?`)
        values.push(value)
      }
    }
    const where = filters.length === 0 ? '' : `WHERE ${filters.join(' AND ')}`
    const [countResult, rowsResult] = await context.env.DB.batch([
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM payment_reconciliation_issues ${where}`,
      ).bind(...values),
      context.env.DB.prepare(
        `${issueSelect()} ${where}
         ORDER BY last_seen_at_ms DESC, id DESC LIMIT ? OFFSET ?`,
      ).bind(...values, pageSize, (page - 1) * pageSize),
    ])
    const total = requireCount(
      (countResult.results[0] as { total?: unknown } | undefined)?.total,
    )
    return controlSuccess({
      items: (rowsResult.results as unknown as IssueRow[]).map(issueProjection),
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** GET /api/v1/admin/payment/reconciliation/:id */
export async function getAdminPaymentReconciliationIssue(
  context: Context<PaymentBindings>,
): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const issueId = requireResourceId(context.req.param('id'), 'payment_reconciliation_issue')
    const issue = await requireIssue(context.env, issueId)
    const [actions, events] = await Promise.all([
      context.env.DB.prepare(
        `SELECT id, issue_id, actor_user_id, action, expected_version,
                result_version, idempotency_key_hash, request_hash,
                response_json, occurred_at_ms
           FROM payment_reconciliation_actions WHERE issue_id = ?
          ORDER BY result_version DESC, occurred_at_ms DESC, id DESC`,
      ).bind(issue.id).all<ActionRow>(),
      context.env.DB.prepare(
        `SELECT id, action, from_status, to_status, issue_version,
                actor_user_id, detail_json, occurred_at_ms
           FROM payment_reconciliation_events WHERE issue_id = ?
          ORDER BY issue_version DESC, occurred_at_ms DESC, id DESC`,
      ).bind(issue.id).all<EventRow>(),
    ])
    return issueResponse({
      issue: issueProjection(issue),
      actions: actions.results.map(actionProjection),
      events: events.results.map(eventProjection),
    }, issue.version)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** GET /api/v1/admin/payment/reconciliation/:id/evidence */
export async function downloadAdminPaymentReconciliationEvidence(
  context: Context<PaymentBindings>,
): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const issueId = requireResourceId(context.req.param('id'), 'payment_reconciliation_issue')
    const issue = await requireIssue(context.env, issueId)
    if (issue.evidence_r2_key === null || issue.evidence_sha256 === null) {
      throw new GatewayError(
        404,
        'payment_reconciliation_evidence_not_found',
        'Payment reconciliation evidence was not found',
      )
    }
    const object = await context.env.OBJECTS.get(issue.evidence_r2_key)
    if (object === null) {
      throw new GatewayError(
        503,
        'payment_reconciliation_evidence_unavailable',
        'Payment reconciliation evidence is temporarily unavailable',
        'server_error',
      )
    }
    return new Response(object.body, {
      status: 200,
      headers: {
        'cache-control': 'private, no-store',
        'content-type': EVIDENCE_CONTENT_TYPE,
        'content-disposition': `attachment; filename="reconciliation-evidence-${issue.id}.json"`,
        etag: `"${issue.evidence_sha256}"`,
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** POST /api/v1/admin/payment/reconciliation/:id/:action */
export async function actOnAdminPaymentReconciliationIssue(
  context: Context<PaymentBindings>,
): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const issueId = requireResourceId(context.req.param('id'), 'payment_reconciliation_issue')
    const action = requireAction(context.req.param('action'))
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const body = await readOptionalJsonObject(context.req.raw, 8 * 1024)
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const input = parseActionInput(action, body)
    const keyHash = await sha256Hex(
      `payment-reconciliation-action-key:v1\0${issueId}\0${idempotencyKey}`,
    )
    const requestHash = await sha256Hex(
      `payment-reconciliation-action-request:v1\0${issueId}\0${expectedVersion}\0${JSON.stringify({
        action,
        note: input.note,
        resolution_code: input.resolutionCode,
      })}`,
    )
    const replay = await findActionByKey(context.env, issueId, keyHash)
    if (replay !== null) return actionReplay(replay, requestHash)

    const issue = await requireIssue(context.env, issueId)
    requireTransition(issue, action, expectedVersion)
    const occurredAt = Date.now()
    const next = transitionIssue(issue, actor.user_id, action, input, occurredAt)
    const responseJson = JSON.stringify(issueProjection(next))
    const actionId = await deterministicUuid(
      'payment.reconciliation.action.v1',
      `${issue.id}\0${keyHash}`,
    )
    const eventId = await deterministicUuid('payment.reconciliation.event.v1', actionId)
    const update = actionUpdateStatement(
      context.env,
      issue,
      actor.user_id,
      action,
      input,
      occurredAt,
    )
    await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO payment_reconciliation_actions (
           id, issue_id, actor_user_id, actor_session_id, action,
           expected_version, result_version, idempotency_key_hash,
           request_hash, response_json, occurred_at_ms
         )
         SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM payment_reconciliation_issues
          WHERE id = ? AND version = ? AND status = ?`,
      ).bind(
        actionId,
        actor.user_id,
        actor.session_id,
        action,
        issue.version,
        next.version,
        keyHash,
        requestHash,
        responseJson,
        occurredAt,
        issue.id,
        issue.version,
        issue.status,
      ),
      update,
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO payment_reconciliation_events (
           id, issue_id, action_id, action, from_status, to_status,
           issue_version, actor_user_id, detail_json, occurred_at_ms
         )
         SELECT ?, reconciliation_action.issue_id, reconciliation_action.id,
                reconciliation_action.action, ?, ?, reconciliation_action.result_version,
                reconciliation_action.actor_user_id, ?, reconciliation_action.occurred_at_ms
           FROM payment_reconciliation_actions reconciliation_action
           JOIN payment_reconciliation_issues issue
             ON issue.id = reconciliation_action.issue_id
            AND issue.version = reconciliation_action.result_version
            AND issue.status = ?
          WHERE reconciliation_action.id = ?`,
      ).bind(
        eventId,
        issue.status,
        next.status,
        JSON.stringify({ note: input.note, resolution_code: input.resolutionCode }),
        next.status,
        actionId,
      ),
    ])

    const persisted = await findActionByKey(context.env, issue.id, keyHash)
    if (persisted === null) {
      throw new GatewayError(
        409,
        'payment_reconciliation_issue_changed',
        'Payment reconciliation issue changed; reload and retry',
      )
    }
    return actionReplay(persisted, requestHash)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function loadScannedRows(
  env: Env,
  cursor: ScanCursor,
  limit: number,
): Promise<D1Result<ScannedSourceRow>> {
  const statement = env.DB.prepare(candidateQuery(cursor.phase))
  return statement.bind(cursor.updatedAtMs, cursor.id, limit).all<ScannedSourceRow>()
}

function candidateQuery(phase: ScanPhase): string {
  if (phase === 'order') return orderCandidateQuery()
  if (phase === 'webhook') return webhookCandidateQuery()
  if (phase === 'fulfillment') return fulfillmentCandidateQuery()
  return refundCandidateQuery()
}

function orderCandidateQuery(): string {
  return `SELECT
      'order' AS source_kind,
      payment_order.id AS source_id,
      payment_order.id AS order_id,
      payment_order.provider_instance_id,
      payment_order.status AS source_status,
      payment_order.updated_at_ms AS source_updated_at_ms,
      payment_order.pay_amount_micros AS expected_amount_micros,
      payment_order.paid_amount_micros AS observed_amount_micros,
      payment_order.currency,
      NULL AS attempts,
      NULL AS event_type,
      payment_order.paid_at_ms,
      CASE WHEN payment_order.status = 'REFUND_REQUESTED'
                  AND payment_order.last_error LIKE 'late_payment_requires_refund%'
           THEN 1 ELSE 0 END AS late_payment_requires_refund
    FROM payment_orders payment_order INDEXED BY idx_payment_reconciliation_order_seek
    WHERE payment_order.status IN (
            'PENDING', 'PAID', 'RECHARGING', 'COMPLETED', 'EXPIRED', 'CANCELLED',
            'FAILED', 'REFUND_REQUESTED', 'REFUNDING', 'REFUND_PENDING',
            'PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_FAILED'
          )
      AND (payment_order.updated_at_ms, payment_order.id) > (?, ?)
    ORDER BY payment_order.updated_at_ms, payment_order.id
    LIMIT ?`
}

function webhookCandidateQuery(): string {
  return `SELECT
      'webhook' AS source_kind,
      inbox.id AS source_id,
      NULL AS order_id,
      provider.id AS provider_instance_id,
      inbox.status AS source_status,
      inbox.updated_at_ms AS source_updated_at_ms,
      NULL AS expected_amount_micros,
      NULL AS observed_amount_micros,
      NULL AS currency,
      inbox.attempts,
      inbox.event_type,
      NULL AS paid_at_ms,
      NULL AS late_payment_requires_refund
    FROM payment_webhook_inbox inbox INDEXED BY idx_payment_reconciliation_webhook_seek
    LEFT JOIN payment_provider_instances provider ON provider.provider_key = inbox.provider_key
    WHERE inbox.status IN ('received', 'processing', 'failed', 'dead_letter')
      AND (inbox.updated_at_ms, inbox.id) > (?, ?)
    ORDER BY inbox.updated_at_ms, inbox.id
    LIMIT ?`
}

function fulfillmentCandidateQuery(): string {
  return `SELECT
      'fulfillment' AS source_kind,
      fulfillment.id AS source_id,
      fulfillment.order_id,
      payment_order.provider_instance_id,
      fulfillment.status AS source_status,
      fulfillment.updated_at_ms AS source_updated_at_ms,
      payment_order.pay_amount_micros AS expected_amount_micros,
      payment_order.paid_amount_micros AS observed_amount_micros,
      payment_order.currency,
      fulfillment.attempts,
      NULL AS event_type,
      NULL AS paid_at_ms,
      NULL AS late_payment_requires_refund
    FROM payment_fulfillments fulfillment INDEXED BY idx_payment_reconciliation_fulfillment_seek
    JOIN payment_orders payment_order ON payment_order.id = fulfillment.order_id
    WHERE fulfillment.status IN ('pending', 'processing', 'failed', 'dead_letter')
      AND (fulfillment.updated_at_ms, fulfillment.id) > (?, ?)
    ORDER BY fulfillment.updated_at_ms, fulfillment.id
    LIMIT ?`
}

function refundCandidateQuery(): string {
  return `SELECT
      'refund' AS source_kind,
      refund.id AS source_id,
      refund.order_id,
      payment_order.provider_instance_id,
      refund.status AS source_status,
      refund.updated_at_ms AS source_updated_at_ms,
      refund.amount_micros AS expected_amount_micros,
      refund.settled_amount_micros AS observed_amount_micros,
      refund.currency,
      NULL AS attempts,
      NULL AS event_type,
      NULL AS paid_at_ms,
      NULL AS late_payment_requires_refund
    FROM payment_refunds refund INDEXED BY idx_payment_reconciliation_refund_seek
    JOIN payment_orders payment_order ON payment_order.id = refund.order_id
    WHERE refund.status IN ('requested', 'processing', 'pending', 'failed')
      AND (refund.updated_at_ms, refund.id) > (?, ?)
    ORDER BY refund.updated_at_ms, refund.id
    LIMIT ?`
}

function classifyCandidate(
  row: ScannedSourceRow,
  staleBefore: number,
): CandidateRow | null {
  let issueType: IssueType | null = null
  let severity: IssueSeverity | null = null
  if (row.source_kind === 'order') {
    const paidAmount = row.observed_amount_micros
    const expectedAmount = row.expected_amount_micros
    const paidStatus = [
      'PAID', 'RECHARGING', 'COMPLETED', 'REFUND_REQUESTED', 'REFUNDING',
      'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_FAILED',
    ].includes(row.source_status)
    if (row.late_payment_requires_refund === 1) {
      issueType = 'late_paid_refund_required'
      severity = 'critical'
    } else if (
      paidAmount !== null && expectedAmount !== null &&
      paidAmount > 0 && paidAmount !== expectedAmount
    ) {
      issueType = 'provider_amount_mismatch'
      severity = 'error'
    } else if (
      (paidStatus && ((paidAmount ?? 0) <= 0 || row.paid_at_ms === null)) ||
      (['PENDING', 'EXPIRED', 'CANCELLED'].includes(row.source_status) &&
        ((paidAmount ?? 0) > 0 || row.paid_at_ms !== null))
    ) {
      issueType = 'provider_status_mismatch'
      severity = 'error'
    }
  } else if (row.source_kind === 'webhook') {
    if (['failed', 'dead_letter'].includes(row.source_status)) {
      issueType = 'webhook_failed'
      severity = 'error'
    } else if (row.source_updated_at_ms <= staleBefore) {
      issueType = 'webhook_pending'
      severity = 'warning'
    }
  } else if (row.source_kind === 'fulfillment') {
    if (['failed', 'dead_letter'].includes(row.source_status)) {
      issueType = 'fulfillment_failed'
      severity = 'error'
    } else if (row.source_updated_at_ms <= staleBefore) {
      issueType = 'fulfillment_pending'
      severity = 'warning'
    }
  } else if (row.source_status === 'failed') {
    issueType = 'refund_failed'
    severity = 'error'
  } else if (row.source_updated_at_ms <= staleBefore) {
    issueType = 'refund_pending'
    severity = 'warning'
  }

  return issueType === null || severity === null
    ? null
    : { ...row, issue_type: issueType, severity }
}

function parseScanCursor(value: string): ScanCursor {
  if (value !== '') {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>
      if (
        parsed.version === 2 &&
        typeof parsed.phase === 'string' &&
        (SCAN_PHASES as readonly string[]).includes(parsed.phase) &&
        Number.isSafeInteger(parsed.updated_at_ms) &&
        (parsed.updated_at_ms as number) >= -1 &&
        typeof parsed.id === 'string'
      ) {
        return {
          phase: parsed.phase as ScanPhase,
          updatedAtMs: parsed.updated_at_ms as number,
          id: parsed.id,
        }
      }
    } catch {
      // An older scanner cursor restarts at the first indexed phase once.
    }
  }
  return { phase: 'order', updatedAtMs: -1, id: '' }
}

function encodeScanCursor(cursor: ScanCursor): string {
  return JSON.stringify({
    version: 2,
    phase: cursor.phase,
    updated_at_ms: cursor.updatedAtMs,
    id: cursor.id,
  })
}

function advanceScanCursor(
  cursor: ScanCursor,
  scannedRows: ScannedSourceRow[],
  limit: number,
): string {
  const last = scannedRows.at(-1)
  if (scannedRows.length === limit && last !== undefined) {
    return encodeScanCursor({
      phase: cursor.phase,
      updatedAtMs: last.source_updated_at_ms,
      id: last.source_id,
    })
  }
  const nextPhase = SCAN_PHASES[SCAN_PHASES.indexOf(cursor.phase) + 1]
  return nextPhase === undefined
    ? ''
    : encodeScanCursor({ phase: nextPhase, updatedAtMs: -1, id: '' })
}

function renderEvidence(candidate: CandidateRow): string {
  return `${JSON.stringify({
    schema_version: 1,
    issue_type: candidate.issue_type,
    source: { kind: candidate.source_kind, id: candidate.source_id },
    observation: {
      order_id: candidate.order_id,
      provider_instance_id: candidate.provider_instance_id,
      status: candidate.source_status,
      updated_at: iso(candidate.source_updated_at_ms),
      expected_amount_micros: candidate.expected_amount_micros,
      paid_amount_micros: candidate.observed_amount_micros,
      currency: candidate.currency,
      attempts: candidate.attempts,
      event_type: candidate.event_type,
      has_error: ['webhook_failed', 'fulfillment_failed', 'refund_failed'].includes(
        candidate.issue_type,
      ),
    },
  }, null, 2)}\n`
}

function issueSummary(type: IssueType): string {
  const summaries: Record<IssueType, string> = {
    late_paid_refund_required: 'Payment arrived after expiry and requires the refund workflow',
    webhook_pending: 'Payment webhook processing has remained pending',
    webhook_failed: 'Payment webhook processing failed',
    fulfillment_pending: 'Paid-order fulfillment has remained pending',
    fulfillment_failed: 'Paid-order fulfillment failed',
    refund_pending: 'Provider refund has remained pending',
    refund_failed: 'Provider refund failed',
    provider_amount_mismatch: 'Recorded provider payment amount does not match the order',
    provider_status_mismatch: 'Payment status does not match the recorded payment facts',
  }
  return summaries[type]
}

function parseActionInput(
  action: ReconciliationAction,
  body: Record<string, unknown>,
): { note: string; resolutionCode: string | null } {
  if (action === 'resolve') {
    return {
      note: requireString(body, 'note', 2_000),
      resolutionCode: requireString(body, 'resolution_code', 100),
    }
  }
  return {
    note: optionalString(body, 'note', 2_000) ?? '',
    resolutionCode: null,
  }
}

function requireTransition(
  issue: IssueRow,
  action: ReconciliationAction,
  expectedVersion: number,
): void {
  if (issue.version !== expectedVersion) {
    throw new GatewayError(
      409,
      'payment_reconciliation_issue_changed',
      'Payment reconciliation issue changed; reload and retry',
    )
  }
  const valid = action === 'acknowledge'
    ? issue.status === 'open'
    : action === 'resolve'
      ? issue.status === 'open' || issue.status === 'acknowledged'
      : issue.status === 'resolved'
  if (!valid) {
    throw new GatewayError(
      409,
      'payment_reconciliation_transition_invalid',
      `Cannot ${action} a ${issue.status} payment reconciliation issue`,
    )
  }
}

function transitionIssue(
  issue: IssueRow,
  actorUserId: string,
  action: ReconciliationAction,
  input: { note: string; resolutionCode: string | null },
  now: number,
): IssueRow {
  if (action === 'acknowledge') {
    return {
      ...issue,
      status: 'acknowledged',
      version: issue.version + 1,
      acknowledged_by_user_id: actorUserId,
      acknowledged_at_ms: now,
      updated_at_ms: Math.max(issue.updated_at_ms, now),
    }
  }
  if (action === 'resolve') {
    return {
      ...issue,
      status: 'resolved',
      version: issue.version + 1,
      resolution_code: input.resolutionCode,
      resolution_note: input.note,
      resolved_by_user_id: actorUserId,
      resolved_at_ms: now,
      updated_at_ms: Math.max(issue.updated_at_ms, now),
    }
  }
  return {
    ...issue,
    status: 'open',
    version: issue.version + 1,
    acknowledged_by_user_id: null,
    acknowledged_at_ms: null,
    resolution_code: null,
    resolution_note: null,
    resolved_by_user_id: null,
    resolved_at_ms: null,
    updated_at_ms: Math.max(issue.updated_at_ms, now),
  }
}

function actionUpdateStatement(
  env: Env,
  issue: IssueRow,
  actorUserId: string,
  action: ReconciliationAction,
  input: { note: string; resolutionCode: string | null },
  now: number,
): D1PreparedStatement {
  if (action === 'acknowledge') {
    return env.DB.prepare(
      `UPDATE payment_reconciliation_issues
          SET status = 'acknowledged', version = version + 1,
              acknowledged_by_user_id = ?, acknowledged_at_ms = ?,
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND version = ? AND status = 'open'`,
    ).bind(actorUserId, now, now, issue.id, issue.version)
  }
  if (action === 'resolve') {
    return env.DB.prepare(
      `UPDATE payment_reconciliation_issues
          SET status = 'resolved', version = version + 1,
              resolution_code = ?, resolution_note = ?,
              resolved_by_user_id = ?, resolved_at_ms = ?,
              updated_at_ms = MAX(updated_at_ms, ?)
        WHERE id = ? AND version = ? AND status IN ('open', 'acknowledged')`,
    ).bind(
      input.resolutionCode,
      input.note,
      actorUserId,
      now,
      now,
      issue.id,
      issue.version,
    )
  }
  return env.DB.prepare(
    `UPDATE payment_reconciliation_issues
        SET status = 'open', version = version + 1,
            acknowledged_by_user_id = NULL, acknowledged_at_ms = NULL,
            resolution_code = NULL, resolution_note = NULL,
            resolved_by_user_id = NULL, resolved_at_ms = NULL,
            updated_at_ms = MAX(updated_at_ms, ?)
      WHERE id = ? AND version = ? AND status = 'resolved'`,
  ).bind(now, issue.id, issue.version)
}

function issueProjection(row: IssueRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.issue_type,
    severity: row.severity,
    status: row.status,
    source: { kind: row.source_kind, id: row.source_id },
    order_id: row.order_id,
    provider_instance_id: row.provider_instance_id,
    summary: row.summary,
    evidence: {
      available: row.evidence_r2_key !== null,
      content_sha256: row.evidence_sha256,
      content_length: row.evidence_content_length,
      download_url: row.evidence_r2_key === null
        ? null
        : `/api/v1/admin/payment/reconciliation/${encodeURIComponent(row.id)}/evidence`,
    },
    version: row.version,
    acknowledged: row.acknowledged_by_user_id === null || row.acknowledged_at_ms === null
      ? null
      : {
          by_user_id: row.acknowledged_by_user_id,
          at: iso(row.acknowledged_at_ms),
        },
    resolution: row.resolution_code === null || row.resolution_note === null ||
      row.resolved_by_user_id === null || row.resolved_at_ms === null
      ? null
      : {
          code: row.resolution_code,
          note: row.resolution_note,
          by_user_id: row.resolved_by_user_id,
          at: iso(row.resolved_at_ms),
        },
    first_observed_at: iso(row.first_observed_at_ms),
    last_seen_at: iso(row.last_seen_at_ms),
    updated_at: iso(row.updated_at_ms),
  }
}

function actionProjection(row: ActionRow): Record<string, unknown> {
  return {
    id: row.id,
    action: row.action,
    actor_user_id: row.actor_user_id,
    expected_version: row.expected_version,
    result_version: row.result_version,
    occurred_at: iso(row.occurred_at_ms),
  }
}

function eventProjection(row: EventRow): Record<string, unknown> {
  return {
    id: row.id,
    action: row.action,
    from_status: row.from_status,
    to_status: row.to_status,
    issue_version: row.issue_version,
    actor_user_id: row.actor_user_id,
    detail: safeJsonObject(row.detail_json),
    occurred_at: iso(row.occurred_at_ms),
  }
}

function actionReplay(row: ActionRow, requestHash: string): Response {
  if (row.request_hash !== requestHash) {
    throw new GatewayError(
      409,
      'idempotency_conflict',
      'Idempotency-Key was already used with a different request',
    )
  }
  return issueResponse(safeJsonObject(row.response_json), row.result_version)
}

function issueResponse(data: unknown, version: number): Response {
  const response = controlSuccess(data)
  response.headers.set('etag', `"${version}"`)
  return response
}

async function findIssueByFingerprint(env: Env, fingerprint: string): Promise<IssueRow | null> {
  return env.DB.prepare(
    `${issueSelect()} WHERE fingerprint = ?`,
  ).bind(fingerprint).first<IssueRow>()
}

async function requireIssue(env: Env, id: string): Promise<IssueRow> {
  const row = await env.DB.prepare(`${issueSelect()} WHERE id = ?`).bind(id).first<IssueRow>()
  if (row === null) {
    throw new GatewayError(
      404,
      'payment_reconciliation_issue_not_found',
      'Payment reconciliation issue was not found',
    )
  }
  return row
}

async function findActionByKey(
  env: Env,
  issueId: string,
  keyHash: string,
): Promise<ActionRow | null> {
  return env.DB.prepare(
    `SELECT id, issue_id, actor_user_id, action, expected_version,
            result_version, idempotency_key_hash, request_hash,
            response_json, occurred_at_ms
       FROM payment_reconciliation_actions
      WHERE issue_id = ? AND idempotency_key_hash = ?`,
  ).bind(issueId, keyHash).first<ActionRow>()
}

function issueSelect(): string {
  return `SELECT id, fingerprint, issue_type, severity, status, source_kind,
                 source_id, order_id, provider_instance_id, summary,
                 evidence_r2_key, evidence_sha256, evidence_content_length,
                 version, acknowledged_by_user_id, acknowledged_at_ms,
                 resolution_code, resolution_note, resolved_by_user_id,
                 resolved_at_ms, first_observed_at_ms, last_seen_at_ms, updated_at_ms
            FROM payment_reconciliation_issues`
}

function requireAction(value: string | undefined): ReconciliationAction {
  if (!ACTIONS.includes(value as ReconciliationAction)) {
    throw new GatewayError(
      400,
      'invalid_payment_reconciliation_action',
      'Payment reconciliation action is invalid',
    )
  }
  return value as ReconciliationAction
}

function optionalEnum<T extends string>(
  value: string | undefined,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === '') return undefined
  if (!allowed.includes(value as T)) {
    throw new GatewayError(400, `invalid_${name}`, `${name} is invalid`)
  }
  return value as T
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function requireCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GatewayError(
      500,
      'invalid_payment_reconciliation_count',
      'Payment reconciliation count is invalid',
      'server_error',
    )
  }
  return value as number
}

function normalizedScanLimit(value: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : 25
  return Math.max(1, Math.min(MAX_SCAN_LIMIT, normalized))
}

function iso(value: number): string {
  return new Date(value).toISOString()
}
