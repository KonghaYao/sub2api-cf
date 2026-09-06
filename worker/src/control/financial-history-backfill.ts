import type { Context } from 'hono'

import type { Env, UserFinancialEventPayload } from '../env'
import { apiKeyDigest, constantTimeEqual, sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { financialSourceForMutation } from '../shared/user-financial-event'
import {
  controlError,
  controlSuccess,
  optionalString,
  readOptionalJsonObject,
  requireResourceId,
} from './http'
import { authenticateAdminSession, type AdminActor } from './admin-auth'

type ControlBindings = { Bindings: Env }

interface BackfillUserRow {
  id: string
  financial_history_complete: number
}

interface LedgerExportSnapshot {
  user_id: string
  state_version: number
  balance_micros: number
  spend_debt_micros: number
  ledger_count: number
  high_water_sequence: number
}

interface LedgerExportEntry {
  ledger_sequence: number
  state_version: number
  schema_version: 1
  mutation_key: string
  mutation_id: string
  entry_type: 'opening_balance' | 'balance_adjustment' | 'enabled_change' | 'settlement'
  user_id: string
  request_id: string | null
  amount_delta_micros: number
  balance_after_micros: number
  enabled_after: boolean | null
  created_at_ms: number
}

interface LedgerExportPage {
  snapshot: LedgerExportSnapshot
  entries: LedgerExportEntry[]
  complete: boolean
  next_cursor: string | null
}

interface BackfillFinancialRow extends UserFinancialEventPayload {
  event_id: string
  user_id: string
  state_version: number
  occurred_at_ms: number
}

interface StoredFinancialRow extends BackfillFinancialRow {
  projected_at_ms: number
}

interface BackfillCursorPayload {
  v: 1
  user_id: string
  do_cursor: string
  snapshot: LedgerExportSnapshot
  ledger_entries_scanned: number
  financial_events_verified: number
  pages_scanned: number
  previous_sequence: number
  previous_state_version: number
  previous_balance_micros: number
  spend_debt_micros: number
  opening_state_version: number
}

type BackfillAuditResult = 'progress' | 'completed' | 'blocked' | 'failed'

const EXPORT_PAGE_SIZE = 100
const MAX_BACKFILL_CURSOR_BYTES = 8_192

/**
 * Rebuild a legacy user's immutable D1 financial projection from the complete
 * authoritative Durable Object ledger. Pages may commit independently, but
 * the completeness watermark is raised only after end-to-end reconciliation.
 */
export async function backfillAdminUserFinancialHistory(
  context: Context<ControlBindings>,
): Promise<Response> {
  let auditActor: AdminActor | null = null
  let auditTargetUserId: string | null = null
  let auditSnapshot: LedgerExportSnapshot | null = null
  let auditLedgerEntriesScanned = 0
  let auditFinancialEventsVerified = 0
  let auditPagesScanned = 0
  try {
    const userId = requireResourceId(context.req.param('id'), 'user')
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    auditActor = actor
    const input = await readOptionalJsonObject(context.req.raw, MAX_BACKFILL_CURSOR_BYTES + 256)
    const cursorRaw = optionalString(input, 'cursor', MAX_BACKFILL_CURSOR_BYTES)
    const user = await context.env.DB.prepare(
      `SELECT id, financial_history_complete
         FROM users
        WHERE id = ?`,
    ).bind(userId).first<BackfillUserRow>()
    if (user === null) throw new GatewayError(404, 'user_not_found', 'User was not found')
    auditTargetUserId = userId
    if (user.financial_history_complete === 1) {
      return controlSuccess({
        user_id: userId,
        ledger_entries_scanned: 0,
        financial_events_verified: 0,
        pages_scanned: 0,
        history_complete: true,
        idempotent: true,
      })
    }
    if (user.financial_history_complete !== 0) {
      throw new GatewayError(
        503,
        'invalid_financial_history_watermark',
        'Financial history watermark is invalid',
        'server_error',
      )
    }

    const progress = cursorRaw === undefined
      ? null
      : await decodeBackfillCursor(context.env, userId, cursorRaw)
    let snapshot = progress?.snapshot ?? null
    let ledgerEntriesScanned = progress?.ledger_entries_scanned ?? 0
    let financialEventsVerified = progress?.financial_events_verified ?? 0
    let pagesScanned = progress?.pages_scanned ?? 0
    let previousSequence = progress?.previous_sequence ?? 0
    let previousStateVersion = progress?.previous_state_version ?? -1
    let previousBalanceMicros = progress?.previous_balance_micros ?? 0
    let spendDebtMicros = progress?.spend_debt_micros ?? 0
    let openingStateVersion: number | null = progress?.opening_state_version ?? null
    auditSnapshot = snapshot
    auditLedgerEntriesScanned = ledgerEntriesScanned
    auditFinancialEventsVerified = financialEventsVerified
    auditPagesScanned = pagesScanned

    const response = await fetchLedgerExportPage(context.env, userId, progress?.do_cursor ?? null)
    if (!response.ok) {
      throw response.status === 409
        ? financialBackfillConflict()
        : new GatewayError(
            503,
            'financial_history_export_failed',
            'Authoritative financial ledger export failed',
            'server_error',
          )
    }
    const page = await parseLedgerExportPage(response, userId)
    pagesScanned += 1
    if (snapshot === null) snapshot = page.snapshot
    else if (!sameSnapshot(snapshot, page.snapshot)) throw financialBackfillConflict()
    auditSnapshot = snapshot
    auditPagesScanned = pagesScanned

    const projected: BackfillFinancialRow[] = []
    const nonFinancialVersions: number[] = []
    for (const entry of page.entries) {
      if (
        entry.ledger_sequence <= previousSequence ||
        entry.ledger_sequence > snapshot.high_water_sequence
      ) throw financialBackfillConflict()
      previousSequence = entry.ledger_sequence
      const ordinal = ledgerEntriesScanned
      ledgerEntriesScanned += 1
      auditLedgerEntriesScanned = ledgerEntriesScanned

      if (ordinal === 0) {
        if (entry.entry_type !== 'opening_balance') throw financialBackfillConflict()
        openingStateVersion = openingVersion(entry, snapshot)
      } else if (entry.entry_type === 'opening_balance') {
        throw financialBackfillConflict()
      }
      if (openingStateVersion === null) throw financialBackfillConflict()
      const stateVersion = entry.state_version
      if (
        stateVersion <= previousStateVersion ||
        stateVersion !== checkedAdd(openingStateVersion, ordinal)
      ) throw financialBackfillConflict()
      previousStateVersion = stateVersion
      const transition = convertLedgerEntry(
        entry,
        stateVersion,
        previousBalanceMicros,
        spendDebtMicros,
        ordinal === 0,
      )
      previousBalanceMicros = transition.balance_after_micros
      spendDebtMicros = transition.spend_debt_after_micros
      if (transition.event !== null) projected.push(transition.event)
      else nonFinancialVersions.push(stateVersion)
    }
    await verifyAndProjectFinancialRows(context.env, projected)
    await verifyNoUnexpectedFinancialRows(context.env, userId, nonFinancialVersions)
    financialEventsVerified += projected.length
    auditFinancialEventsVerified = financialEventsVerified

    if (!page.complete) {
      if (
        page.entries.length === 0 || page.next_cursor === null ||
        page.next_cursor.length === 0 || page.next_cursor.length > 2_048 ||
        ledgerEntriesScanned >= snapshot.ledger_count || openingStateVersion === null
      ) throw financialBackfillConflict()
      const nextCursor = await encodeBackfillCursor(context.env, {
        v: 1,
        user_id: userId,
        do_cursor: page.next_cursor,
        snapshot,
        ledger_entries_scanned: ledgerEntriesScanned,
        financial_events_verified: financialEventsVerified,
        pages_scanned: pagesScanned,
        previous_sequence: previousSequence,
        previous_state_version: previousStateVersion,
        previous_balance_micros: previousBalanceMicros,
        spend_debt_micros: spendDebtMicros,
        opening_state_version: openingStateVersion,
      })
      const audit = await buildBackfillAuditStatement(
        context.env, actor, userId, snapshot, ledgerEntriesScanned,
        financialEventsVerified, pagesScanned, 'progress',
      )
      const recorded = await audit.run()
      if (recorded.meta.changes !== 1) throw auditWriteFailed()
      return controlSuccess({
        user_id: userId,
        ledger_entries_scanned: ledgerEntriesScanned,
        financial_events_verified: financialEventsVerified,
        pages_scanned: pagesScanned,
        history_complete: false,
        idempotent: false,
        next_cursor: nextCursor,
      })
    }
    if (page.next_cursor !== null) throw financialBackfillConflict()

    if (
      snapshot === null || openingStateVersion === null ||
      ledgerEntriesScanned !== snapshot.ledger_count ||
      previousBalanceMicros !== snapshot.balance_micros ||
      spendDebtMicros !== snapshot.spend_debt_micros ||
      checkedAdd(openingStateVersion, ledgerEntriesScanned - 1) !== snapshot.state_version
    ) throw financialBackfillConflict()

    const completionAudit = await buildBackfillAuditStatement(
      context.env, actor, userId, snapshot, ledgerEntriesScanned,
      financialEventsVerified, pagesScanned, 'completed', true,
    )
    const [auditRecorded, completed] = await context.env.DB.batch([
      completionAudit,
      context.env.DB.prepare(
      `UPDATE users
          SET financial_history_complete = 1
        WHERE id = ? AND financial_history_complete = 0
        RETURNING id`,
      ).bind(userId),
    ])
    if (!completed.success || !auditRecorded.success) {
      throw financialBackfillConflict()
    }
    const wonCompletion = completed.results.length === 1 && auditRecorded.results.length === 1
    const convergedCompletion = completed.results.length === 0 && auditRecorded.results.length === 0
    if (!wonCompletion && !convergedCompletion) throw financialBackfillConflict()

    return controlSuccess({
      user_id: userId,
      ledger_entries_scanned: ledgerEntriesScanned,
      financial_events_verified: financialEventsVerified,
      pages_scanned: pagesScanned,
      history_complete: true,
      idempotent: convergedCompletion,
      next_cursor: null,
    })
  } catch (error) {
    const failure = asGatewayError(error)
    if (auditActor !== null && auditTargetUserId !== null) {
      const result = failure.status === 409 ? 'blocked' : 'failed'
      try {
        const statement = await buildBackfillAuditStatement(
          context.env,
          auditActor,
          auditTargetUserId,
          auditSnapshot,
          auditLedgerEntriesScanned,
          auditFinancialEventsVerified,
          auditPagesScanned,
          result,
        )
        await statement.run()
      } catch {
        console.error('financial history backfill failure audit could not be recorded', {
          code: failure.code,
        })
      }
    }
    return controlError(failure)
  }
}

async function verifyNoUnexpectedFinancialRows(
  env: Env,
  userId: string,
  stateVersions: number[],
): Promise<void> {
  if (stateVersions.length === 0) return
  const results = await env.DB.batch(stateVersions.map((stateVersion) => env.DB.prepare(
    `SELECT 1 AS present
       FROM user_financial_events
      WHERE user_id = ? AND state_version = ?
      LIMIT 1`,
  ).bind(userId, stateVersion)))
  if (results.some((result) => result.results.length !== 0)) throw financialBackfillConflict()
}

async function buildBackfillAuditStatement(
  env: Env,
  actor: AdminActor,
  userId: string,
  snapshot: LedgerExportSnapshot | null,
  ledgerEntriesScanned: number,
  financialEventsVerified: number,
  pagesScanned: number,
  result: BackfillAuditResult,
  conditionalOnIncomplete = false,
): Promise<D1PreparedStatement> {
  const snapshotDigest = snapshot === null ? null : await sha256Hex(JSON.stringify({
    user_id: snapshot.user_id,
    state_version: snapshot.state_version,
    balance_micros: snapshot.balance_micros,
    spend_debt_micros: snapshot.spend_debt_micros,
    ledger_count: snapshot.ledger_count,
    high_water_sequence: snapshot.high_water_sequence,
  }))
  const action = `financial_history.backfill.${result}`
  const outcome = result === 'completed' ? 'succeeded' : result === 'progress' ? 'recorded' : result
  return env.DB.prepare(
    `INSERT INTO admin_financial_history_backfill_audit_events (
       id, actor_user_id, actor_session_id, target_user_id, action, outcome,
       snapshot_state_version, snapshot_high_water_sequence, snapshot_ledger_count,
       snapshot_digest, ledger_entries_scanned, financial_events_verified,
       pages_scanned, occurred_at_ms
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ? = 0 OR EXISTS (
        SELECT 1 FROM users WHERE id = ? AND financial_history_complete = 0
      )
     RETURNING id`,
  ).bind(
    crypto.randomUUID(), actor.user_id, actor.session_id, userId,
    action, outcome, snapshot?.state_version ?? null,
    snapshot?.high_water_sequence ?? null, snapshot?.ledger_count ?? null, snapshotDigest,
    ledgerEntriesScanned, financialEventsVerified, pagesScanned, Date.now(),
    conditionalOnIncomplete ? 1 : 0, userId,
  )
}

function auditWriteFailed(): GatewayError {
  return new GatewayError(
    503,
    'financial_history_backfill_audit_failed',
    'Financial history backfill audit could not be recorded',
    'server_error',
  )
}

function fetchLedgerExportPage(
  env: Env,
  userId: string,
  cursor: string | null,
): Promise<Response> {
  const url = new URL('https://user-state.internal/ledger/export')
  url.searchParams.set('limit', String(EXPORT_PAGE_SIZE))
  if (cursor !== null) url.searchParams.set('cursor', cursor)
  const stub = env.USER_STATE.get(env.USER_STATE.idFromName(userId))
  return stub.fetch(new Request(url))
}

async function parseLedgerExportPage(response: Response, userId: string): Promise<LedgerExportPage> {
  let value: unknown
  try {
    value = await response.json()
  } catch {
    throw financialBackfillConflict()
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw financialBackfillConflict()
  }
  const body = value as Record<string, unknown>
  if (body.schema_version !== 1 || !Array.isArray(body.entries) || typeof body.complete !== 'boolean') {
    throw financialBackfillConflict()
  }
  if (body.next_cursor !== null && typeof body.next_cursor !== 'string') {
    throw financialBackfillConflict()
  }
  const snapshot = parseSnapshot(body.snapshot, userId)
  const entries = body.entries.map((entry) => parseLedgerEntry(entry, userId))
  if (entries.length > EXPORT_PAGE_SIZE) throw financialBackfillConflict()
  return {
    snapshot,
    entries,
    complete: body.complete,
    next_cursor: body.next_cursor as string | null,
  }
}

function parseSnapshot(value: unknown, userId: string): LedgerExportSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw financialBackfillConflict()
  }
  const snapshot = value as Partial<LedgerExportSnapshot>
  if (
    snapshot.user_id !== userId ||
    !isNonNegativeSafeInteger(snapshot.state_version) ||
    !isNonNegativeSafeInteger(snapshot.balance_micros) ||
    !isNonNegativeSafeInteger(snapshot.spend_debt_micros) ||
    !isNonNegativeSafeInteger(snapshot.ledger_count) ||
    !isNonNegativeSafeInteger(snapshot.high_water_sequence) ||
    (snapshot.high_water_sequence as number) < (snapshot.ledger_count as number)
  ) throw financialBackfillConflict()
  return snapshot as LedgerExportSnapshot
}

function parseLedgerEntry(value: unknown, userId: string): LedgerExportEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw financialBackfillConflict()
  }
  const entry = value as Partial<LedgerExportEntry>
  if (
    entry.schema_version !== 1 || !isPositiveSafeInteger(entry.ledger_sequence) ||
    !isNonNegativeSafeInteger(entry.state_version) ||
    !isIdentifier(entry.mutation_key, 256) || !isIdentifier(entry.mutation_id, 128) ||
    !['opening_balance', 'balance_adjustment', 'enabled_change', 'settlement'].includes(entry.entry_type ?? '') ||
    entry.user_id !== userId ||
    (entry.request_id !== null && !isIdentifier(entry.request_id, 128)) ||
    !Number.isSafeInteger(entry.amount_delta_micros) ||
    !isNonNegativeSafeInteger(entry.balance_after_micros) ||
    (entry.enabled_after !== null && typeof entry.enabled_after !== 'boolean') ||
    !isNonNegativeSafeInteger(entry.created_at_ms) ||
    (entry.created_at_ms as number) > 8_640_000_000_000_000
  ) throw financialBackfillConflict()
  return entry as LedgerExportEntry
}

function openingVersion(entry: LedgerExportEntry, snapshot: LedgerExportSnapshot): number {
  if (
    entry.request_id !== null || entry.enabled_after === null ||
    entry.mutation_key !== `balance:${entry.mutation_id}` ||
    entry.amount_delta_micros !== entry.balance_after_micros
  ) throw financialBackfillConflict()
  const d1Version = /^d1-user:(0|[1-9]\d*)$/.exec(entry.mutation_id)
  if (d1Version !== null) {
    const parsed = Number(d1Version[1])
    if (Number.isSafeInteger(parsed) && parsed === entry.state_version) return parsed
  }
  if (entry.mutation_id.startsWith('admin-create:') && entry.state_version === 0) return 0
  // Any older creation flow that began at version zero is still provable from
  // the complete ledger cardinality. A deleted/superseded entry creates a gap
  // and makes this equality false, so it remains fail-closed.
  if (snapshot.state_version === snapshot.ledger_count - 1 && entry.state_version === 0) return 0
  throw financialBackfillConflict()
}

function convertLedgerEntry(
  entry: LedgerExportEntry,
  stateVersion: number,
  previousBalanceMicros: number,
  previousDebtMicros: number,
  opening: boolean,
): {
  balance_after_micros: number
  spend_debt_after_micros: number
  event: BackfillFinancialRow | null
} {
  let grossAmountMicros = entry.amount_delta_micros
  let amountDeltaMicros: number
  let debtDeltaMicros: number
  if (opening) {
    amountDeltaMicros = entry.balance_after_micros
    debtDeltaMicros = 0
  } else {
    amountDeltaMicros = checkedSubtract(entry.balance_after_micros, previousBalanceMicros)
    if (entry.entry_type === 'enabled_change') {
      if (
        entry.mutation_key !== `enabled:${entry.mutation_id}` ||
        entry.request_id !== null || entry.enabled_after === null ||
        entry.amount_delta_micros !== 0 || amountDeltaMicros !== 0
      ) throw financialBackfillConflict()
      return {
        balance_after_micros: entry.balance_after_micros,
        spend_debt_after_micros: previousDebtMicros,
        event: null,
      }
    }
    if (entry.entry_type === 'balance_adjustment') {
      if (
        entry.mutation_key !== `balance:${entry.mutation_id}` ||
        entry.request_id !== null || entry.enabled_after !== null ||
        entry.amount_delta_micros === 0 ||
        (entry.amount_delta_micros < 0 && amountDeltaMicros !== entry.amount_delta_micros) ||
        (entry.amount_delta_micros > 0 && (
          amountDeltaMicros < 0 || amountDeltaMicros > entry.amount_delta_micros
        ))
      ) throw financialBackfillConflict()
      debtDeltaMicros = checkedSubtract(amountDeltaMicros, entry.amount_delta_micros)
    } else if (entry.entry_type === 'settlement') {
      if (
        entry.request_id === null || entry.mutation_id !== entry.request_id ||
        entry.mutation_key !== `settlement:${entry.request_id}` ||
        entry.enabled_after !== null || entry.amount_delta_micros > 0 || amountDeltaMicros > 0
      ) throw financialBackfillConflict()
      grossAmountMicros = -entry.amount_delta_micros
      debtDeltaMicros = checkedAdd(grossAmountMicros, amountDeltaMicros)
      if (debtDeltaMicros < 0 || debtDeltaMicros > grossAmountMicros) {
        throw financialBackfillConflict()
      }
    } else {
      throw financialBackfillConflict()
    }
  }
  const spendDebtAfterMicros = checkedAdd(previousDebtMicros, debtDeltaMicros)
  if (spendDebtAfterMicros < 0) throw financialBackfillConflict()
  const eventType = entry.entry_type as UserFinancialEventPayload['event_type']
  const source = financialSourceForMutation(entry.mutation_id, eventType, entry.request_id)
  return {
    balance_after_micros: entry.balance_after_micros,
    spend_debt_after_micros: spendDebtAfterMicros,
    event: {
      event_id: `user-state:${entry.user_id}:${stateVersion}`,
      user_id: entry.user_id,
      state_version: stateVersion,
      event_type: eventType,
      ...source,
      request_id: entry.request_id,
      actor_user_id: null,
      actor_session_id: null,
      amount_delta_micros: amountDeltaMicros,
      gross_amount_micros: grossAmountMicros,
      spend_debt_delta_micros: debtDeltaMicros,
      balance_after_micros: entry.balance_after_micros,
      spend_debt_after_micros: spendDebtAfterMicros,
      occurred_at_ms: entry.created_at_ms,
    },
  }
}

async function verifyAndProjectFinancialRows(env: Env, expected: BackfillFinancialRow[]): Promise<void> {
  if (expected.length === 0) return
  let existing = await loadStoredFinancialRows(env, expected)
  const inserts: D1PreparedStatement[] = []
  for (let index = 0; index < expected.length; index += 1) {
    const row = existing[index]
    if (row !== null) {
      assertSameFinancialRow(row, expected[index]!)
      continue
    }
    const value = expected[index]!
    inserts.push(env.DB.prepare(
      `INSERT INTO user_financial_events (
         event_id, user_id, state_version, event_type, source_type, source_id,
         request_id, actor_user_id, actor_session_id,
         amount_delta_micros, gross_amount_micros,
         spend_debt_delta_micros, balance_after_micros, spend_debt_after_micros,
         occurred_at_ms, projected_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      value.event_id,
      value.user_id,
      value.state_version,
      value.event_type,
      value.source_type,
      value.source_id,
      value.request_id,
      value.amount_delta_micros,
      value.gross_amount_micros,
      value.spend_debt_delta_micros,
      value.balance_after_micros,
      value.spend_debt_after_micros,
      value.occurred_at_ms,
      Date.now(),
    ))
  }
  if (inserts.length > 0) {
    try {
      await env.DB.batch(inserts)
    } catch {
      // A concurrent projector may have won. The authoritative comparison
      // below accepts only the exact row and turns every other collision into
      // a deterministic conflict without ever mutating an existing event.
    }
    existing = await loadStoredFinancialRows(env, expected)
  }
  for (let index = 0; index < expected.length; index += 1) {
    const row = existing[index]
    if (row === null) throw financialBackfillConflict()
    assertSameFinancialRow(row, expected[index]!)
  }
}

async function loadStoredFinancialRows(
  env: Env,
  expected: BackfillFinancialRow[],
): Promise<Array<StoredFinancialRow | null>> {
  const results = await env.DB.batch(expected.map((row) => env.DB.prepare(
    `SELECT event_id, user_id, state_version, event_type, source_type, source_id,
            request_id, actor_user_id, actor_session_id,
            amount_delta_micros, gross_amount_micros,
            spend_debt_delta_micros, balance_after_micros, spend_debt_after_micros,
            occurred_at_ms, projected_at_ms
       FROM user_financial_events
      WHERE event_id = ? OR (user_id = ? AND state_version = ?)
      LIMIT 1`,
  ).bind(row.event_id, row.user_id, row.state_version)))
  return results.map((result) => (result.results[0] as unknown as StoredFinancialRow | undefined) ?? null)
}

function assertSameFinancialRow(stored: StoredFinancialRow, expected: BackfillFinancialRow): void {
  for (const field of [
    'event_id', 'user_id', 'state_version', 'event_type', 'source_type', 'source_id',
    'request_id', 'amount_delta_micros', 'gross_amount_micros',
    'spend_debt_delta_micros', 'balance_after_micros', 'spend_debt_after_micros',
    'occurred_at_ms',
  ] as const) {
    if (stored[field] !== expected[field]) throw financialBackfillConflict()
  }
}

async function encodeBackfillCursor(env: Env, payload: BackfillCursorPayload): Promise<string> {
  const unsigned = JSON.stringify(payload)
  const signature = await apiKeyDigest(
    `financial-history-backfill-cursor:v1\0${env.ENVIRONMENT}\0${unsigned}`,
    backfillCursorPepper(env),
  )
  return base64UrlEncode(JSON.stringify({ v: 1, payload, signature }))
}

async function decodeBackfillCursor(
  env: Env,
  userId: string,
  raw: string,
): Promise<BackfillCursorPayload> {
  if (
    raw.length === 0 || raw.length > MAX_BACKFILL_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  ) throw invalidBackfillCursor()
  try {
    const envelope = JSON.parse(base64UrlDecode(raw)) as Record<string, unknown>
    if (
      envelope.v !== 1 || envelope.payload === null ||
      typeof envelope.payload !== 'object' || Array.isArray(envelope.payload) ||
      typeof envelope.signature !== 'string' || envelope.signature.length !== 64
    ) throw invalidBackfillCursor()
    const unsigned = JSON.stringify(envelope.payload)
    const expected = await apiKeyDigest(
      `financial-history-backfill-cursor:v1\0${env.ENVIRONMENT}\0${unsigned}`,
      backfillCursorPepper(env),
    )
    if (!constantTimeEqual(expected, envelope.signature)) throw invalidBackfillCursor()
    return parseBackfillCursorPayload(envelope.payload, userId)
  } catch (error) {
    if (error instanceof GatewayError) throw error
    throw invalidBackfillCursor()
  }
}

function parseBackfillCursorPayload(value: unknown, userId: string): BackfillCursorPayload {
  const payload = value as Partial<BackfillCursorPayload>
  const snapshot = parseSnapshot(payload.snapshot, userId)
  if (
    payload.v !== 1 || payload.user_id !== userId ||
    !isIdentifier(payload.do_cursor, 2_048) ||
    !isPositiveSafeInteger(payload.ledger_entries_scanned) ||
    (payload.ledger_entries_scanned as number) >= snapshot.ledger_count ||
    !isNonNegativeSafeInteger(payload.financial_events_verified) ||
    (payload.financial_events_verified as number) > (payload.ledger_entries_scanned as number) ||
    !isPositiveSafeInteger(payload.pages_scanned) ||
    (payload.pages_scanned as number) > (payload.ledger_entries_scanned as number) ||
    !isPositiveSafeInteger(payload.previous_sequence) ||
    (payload.previous_sequence as number) > snapshot.high_water_sequence ||
    !isNonNegativeSafeInteger(payload.previous_state_version) ||
    (payload.previous_state_version as number) > snapshot.state_version ||
    !isNonNegativeSafeInteger(payload.previous_balance_micros) ||
    !isNonNegativeSafeInteger(payload.spend_debt_micros) ||
    !isNonNegativeSafeInteger(payload.opening_state_version) ||
    checkedAdd(
      payload.opening_state_version as number,
      (payload.ledger_entries_scanned as number) - 1,
    ) > snapshot.state_version ||
    payload.previous_state_version !== checkedAdd(
      payload.opening_state_version as number,
      (payload.ledger_entries_scanned as number) - 1,
    )
  ) throw invalidBackfillCursor()
  return payload as BackfillCursorPayload
}

function backfillCursorPepper(env: Env): string {
  if (!env.API_KEY_PEPPER || env.API_KEY_PEPPER.length < 32) {
    throw new GatewayError(
      503,
      'financial_history_backfill_cursor_unavailable',
      'Financial history backfill cursor signing is unavailable',
      'server_error',
    )
  }
  return env.API_KEY_PEPPER
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function invalidBackfillCursor(): GatewayError {
  return new GatewayError(
    400,
    'invalid_financial_history_backfill_cursor',
    'Financial history backfill cursor is invalid',
  )
}

function sameSnapshot(left: LedgerExportSnapshot, right: LedgerExportSnapshot): boolean {
  return left.user_id === right.user_id &&
    left.state_version === right.state_version &&
    left.balance_micros === right.balance_micros &&
    left.spend_debt_micros === right.spend_debt_micros &&
    left.ledger_count === right.ledger_count &&
    left.high_water_sequence === right.high_water_sequence
}

function isIdentifier(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function checkedAdd(left: number, right: number): number {
  const value = left + right
  if (!Number.isSafeInteger(value)) throw financialBackfillConflict()
  return value
}

function checkedSubtract(left: number, right: number): number {
  const value = left - right
  if (!Number.isSafeInteger(value)) throw financialBackfillConflict()
  return value
}

function financialBackfillConflict(): GatewayError {
  return new GatewayError(
    409,
    'financial_history_backfill_conflict',
    'Authoritative financial history cannot be reconciled safely',
  )
}
