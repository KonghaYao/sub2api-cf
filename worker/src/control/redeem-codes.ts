import type { Context } from 'hono'
import type { Env } from '../env'
import { commercialCodeDigest } from '../commercial/registration'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { decryptCredential, encryptCredential } from '../gateway/crypto'
import { redeemCodeDigest } from '../user/redeem'
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
  deterministicUuid,
  optionalSafeInteger,
  queryInteger,
  readJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
  requireSafeInteger,
  requireString,
} from './http'

type ControlBindings = { Bindings: Env }

type RedeemCodeStatus = 'unused' | 'processing' | 'used' | 'expired' | 'disabled'
type RedeemCodeType = 'balance' | 'concurrency' | 'subscription' | 'invitation'

interface RedeemCodeRow {
  id: string
  code_hash: string
  code_prefix: string
  type: RedeemCodeType
  value_micros: number
  group_id: string | null
  validity_days: number | null
  status: RedeemCodeStatus
  expires_at_ms: number | null
  used_by_user_id: string | null
  claimed_by_redemption_id: string | null
  used_at_ms: number | null
  notes: string
  control_version: number
  created_by_user_id: string | null
  created_at_ms: number
  updated_at_ms: number
  user_email?: string | null
  user_display_name?: string | null
  group_name?: string | null
  group_platform?: string | null
}

interface RedeemGroupRow {
  id: string
  name: string
  platform: string
  enabled: number
  group_type: 'standard' | 'subscription'
}

interface GenerateRedeemCodesInput {
  count: number
  type: RedeemCodeType
  value_micros: number
  group_id: string | null
  validity_days: number | null
  expires_at_ms: number | null
  notes: string
}

interface InvitationMirror {
  id: string
  code_hash: string
  code_prefix: string
  secret_nonce_b64: string
  secret_ciphertext_b64: string
  expires_at_ms: number | null
  notes: string
  created_at_ms: number
}

interface RedeemCodeSecret {
  redeem_code_id: string
  secret_key_version: number
  secret_nonce_b64: string
  secret_ciphertext_b64: string
  created_at_ms: number
}

interface RedeemCodeExportRow extends RedeemCodeRow {
  secret_key_version: number | null
  secret_nonce_b64: string | null
  secret_ciphertext_b64: string | null
}

interface RedeemCodeBatchInput {
  ids: string[]
  expected: Record<string, number>
}

interface RedeemCodePatch {
  status?: 'unused' | 'disabled'
  notes?: string
  expires_at_ms?: number | null
  group_id?: string | null
}

const MAX_DATE_MS = 8_640_000_000_000_000
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const REDEEM_COLUMNS = `id, code_hash, code_prefix, type, value_micros, group_id,
  validity_days, status, expires_at_ms, used_by_user_id, claimed_by_redemption_id,
  used_at_ms, notes, control_version, created_by_user_id, created_at_ms, updated_at_ms`
const REDEEM_SELECT = REDEEM_COLUMNS.split(',').map((column) => `rc.${column.trim()}`).join(', ')

export async function listAdminRedeemCodes(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 1_000)
    const current = Date.now()
    const conditions: string[] = []
    const values: unknown[] = []
    const type = context.req.query('type')
    if (type !== undefined && type !== '') {
      if (!['balance', 'concurrency', 'subscription', 'invitation'].includes(type)) {
        throw new GatewayError(400, 'unsupported_redeem_code_type', 'type is invalid')
      }
      conditions.push('rc.type = ?')
      values.push(type)
    }
    const status = context.req.query('status')
    if (status !== undefined && status !== '') {
      if (!['unused', 'processing', 'used', 'expired', 'disabled'].includes(status)) {
        throw new GatewayError(400, 'invalid_redeem_code_status', 'status is invalid')
      }
      if (status === 'unused') {
        conditions.push(`rc.status = 'unused' AND (rc.expires_at_ms IS NULL OR rc.expires_at_ms > ?)`)
        values.push(current)
      } else if (status === 'expired') {
        conditions.push(`(rc.status = 'expired' OR (rc.status = 'unused' AND rc.expires_at_ms <= ?))`)
        values.push(current)
      } else {
        conditions.push('rc.status = ?')
        values.push(status)
      }
    }
    const search = context.req.query('search')?.trim()
    if (search) {
      if (search.length > 128) {
        throw new GatewayError(400, 'invalid_search', 'search must not exceed 128 characters')
      }
      const pattern = `%${escapeLike(search)}%`
      const digest = await redeemCodeDigest(search, requirePepper(context.env))
      conditions.push(`(
        rc.code_hash = ? OR rc.code_prefix LIKE ? ESCAPE '\\'
        OR rc.id LIKE ? ESCAPE '\\' OR rc.notes LIKE ? ESCAPE '\\'
      )`)
      values.push(digest, pattern, pattern, pattern)
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const sortKey = context.req.query('sort_by') ?? 'id'
    const sortExpression = redeemSortExpression(sortKey)
    const sortOrder = (context.req.query('sort_order') ?? 'desc').toLowerCase()
    if (sortOrder !== 'asc' && sortOrder !== 'desc') {
      throw new GatewayError(400, 'invalid_sort_order', 'sort_order must be asc or desc')
    }
    const [countResult, rowsResult] = await context.env.DB.batch([
      context.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM redeem_codes rc ${where}`,
      ).bind(...values),
      context.env.DB.prepare(
        `${redeemSelectSql()} ${where}
         ORDER BY ${sortExpression} ${sortOrder.toUpperCase()}, rc.id ${sortOrder.toUpperCase()}
         LIMIT ? OFFSET ?`,
      ).bind(...values, pageSize, (page - 1) * pageSize),
    ])
    const total = validCount(countResult.results[0])
    return controlSuccess({
      items: (rowsResult.results as unknown as RedeemCodeRow[]).map((row) => publicRedeemCode(row, current)),
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminRedeemCode(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    return controlSuccess(publicRedeemCode(
      await requireRedeemCode(context.env, context.req.param('id')),
    ))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function exportAdminRedeemCodes(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const current = Date.now()
    const conditions: string[] = []
    const values: unknown[] = []
    const type = context.req.query('type')
    if (type !== undefined && type !== '') {
      if (!['balance', 'concurrency', 'subscription', 'invitation'].includes(type)) {
        throw new GatewayError(400, 'unsupported_redeem_code_type', 'type is invalid')
      }
      conditions.push('rc.type = ?')
      values.push(type)
    }
    const status = context.req.query('status')
    if (status !== undefined && status !== '') {
      if (!['unused', 'processing', 'used', 'expired', 'disabled'].includes(status)) {
        throw new GatewayError(400, 'invalid_redeem_code_status', 'status is invalid')
      }
      if (status === 'unused') {
        conditions.push(`rc.status = 'unused' AND (rc.expires_at_ms IS NULL OR rc.expires_at_ms > ?)`)
        values.push(current)
      } else if (status === 'expired') {
        conditions.push(`(rc.status = 'expired' OR (rc.status = 'unused' AND rc.expires_at_ms <= ?))`)
        values.push(current)
      } else {
        conditions.push('rc.status = ?')
        values.push(status)
      }
    }
    const search = context.req.query('search')?.trim()
    if (search) {
      if (search.length > 128) {
        throw new GatewayError(400, 'invalid_search', 'search must not exceed 128 characters')
      }
      const pattern = `%${escapeLike(search)}%`
      const digest = await redeemCodeDigest(search, requirePepper(context.env))
      conditions.push(`(
        rc.code_hash = ? OR rc.code_prefix LIKE ? ESCAPE '\\'
        OR rc.id LIKE ? ESCAPE '\\' OR rc.notes LIKE ? ESCAPE '\\'
      )`)
      values.push(digest, pattern, pattern, pattern)
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const sortExpression = redeemSortExpression(context.req.query('sort_by') ?? 'id')
    const sortOrder = (context.req.query('sort_order') ?? 'desc').toLowerCase()
    if (sortOrder !== 'asc' && sortOrder !== 'desc') {
      throw new GatewayError(400, 'invalid_sort_order', 'sort_order must be asc or desc')
    }
    const result = await context.env.DB.prepare(
      `${redeemExportSelectSql()} ${where}
       ORDER BY ${sortExpression} ${sortOrder.toUpperCase()}, rc.id ${sortOrder.toUpperCase()}
       LIMIT 10000`,
    ).bind(...values).all<RedeemCodeExportRow>()
    const header = [
      'id', 'code', 'type', 'value', 'status', 'used_by', 'used_by_email',
      'used_at', 'expires_at', 'created_at',
    ]
    const exportedRows = await Promise.all(result.results.map(async (row) => {
      const code = publicRedeemCode(row, current)
      const plaintext = await decryptRedeemCodeForExport(context.env, row)
      return [
        code.id,
        plaintext,
        code.type,
        String(code.value),
        code.status,
        code.used_by ?? '',
        code.user?.email ?? '',
        code.used_at ?? '',
        code.expires_at ?? '',
        code.created_at,
      ]
    }))
    const lines = [header, ...exportedRows].map((row) => row.map(csvCell).join(','))
    return new Response(`\uFEFF${lines.join('\r\n')}\r\n`, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename=redeem_codes.csv',
      },
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminRedeemCodeStats(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const current = Date.now()
    const row = await context.env.DB.prepare(
      `SELECT
         COUNT(*) AS total_codes,
         SUM(CASE WHEN status = 'unused' AND (expires_at_ms IS NULL OR expires_at_ms > ?) THEN 1 ELSE 0 END) AS active_codes,
         SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing_codes,
         SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) AS used_codes,
         SUM(CASE WHEN status = 'expired' OR (status = 'unused' AND expires_at_ms <= ?) THEN 1 ELSE 0 END) AS expired_codes,
         SUM(CASE WHEN status = 'used' AND type = 'balance' THEN value_micros ELSE 0 END) AS distributed_micros,
         SUM(CASE WHEN type = 'balance' THEN 1 ELSE 0 END) AS balance_codes,
         SUM(CASE WHEN type = 'concurrency' THEN 1 ELSE 0 END) AS concurrency_codes,
         SUM(CASE WHEN type = 'subscription' THEN 1 ELSE 0 END) AS subscription_codes,
         SUM(CASE WHEN type = 'invitation' THEN 1 ELSE 0 END) AS invitation_codes
       FROM redeem_codes`,
    ).bind(current, current).first<Record<string, number | null>>()
    if (row === null) {
      throw new GatewayError(500, 'redeem_code_stats_unavailable', 'Redeem code statistics are unavailable', 'server_error')
    }
    const value = (name: string): number => {
      const candidate = row[name] ?? 0
      if (!Number.isSafeInteger(candidate) || candidate < 0) {
        throw new GatewayError(500, 'invalid_redeem_code_stats', 'Redeem code statistics are invalid', 'server_error')
      }
      return candidate
    }
    const distributedMicros = value('distributed_micros')
    return controlSuccess({
      total_codes: value('total_codes'),
      active_codes: value('active_codes'),
      processing_codes: value('processing_codes'),
      used_codes: value('used_codes'),
      expired_codes: value('expired_codes'),
      total_value_distributed: distributedMicros / 1_000_000,
      total_value_distributed_micros: distributedMicros,
      by_type: {
        balance: value('balance_codes'),
        concurrency: value('concurrency_codes'),
        subscription: value('subscription_codes'),
        invitation: value('invitation_codes'),
      },
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function expireAdminRedeemCode(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const id = requireResourceId(context.req.param('id'), 'redeem_code')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readOptionalJson(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const idem = await controlIdempotency('admin.redeem-codes.expire.v1', key, { id, expected })
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) {
      return controlSuccess(parseIdempotentResponse(previous, 'redeem_code'))
    }
    const current = await requireRedeemCode(context.env, id)
    assertControlVersion(current.control_version, expected)
    if (current.status === 'processing' || current.status === 'used') throw redeemCodeNotMutable()

    const updatedAt = Date.now()
    const next = current.status === 'expired'
      ? current
      : { ...current, status: 'expired' as const, control_version: expected + 1, updated_at_ms: updatedAt }
    const response = publicRedeemCode(next, updatedAt)
    const statements: D1PreparedStatement[] = []
    if (current.status !== 'expired') {
      statements.push(context.env.DB.prepare(
        `UPDATE redeem_codes
            SET status = 'expired',
                control_version = CASE
                  WHEN control_version = ? AND status = 'unused' THEN ? ELSE -1
                END,
                updated_at_ms = ?
          WHERE id = ?`,
      ).bind(expected, expected + 1, updatedAt, id))
      if (current.type === 'invitation') {
        statements.push(context.env.DB.prepare(
          `UPDATE invitation_codes
              SET status = 'disabled', expires_at_ms = ?,
                  control_version = control_version + 1, updated_at_ms = ?
            WHERE id = ?`,
        ).bind(updatedAt, updatedAt, id))
      }
    }
    statements.unshift(guardedIdempotencyInsert(
      context.env,
      idem,
      'redeem_code',
      id,
      response,
      updatedAt,
      `EXISTS (
        SELECT 1 FROM redeem_codes
         WHERE id = ? AND control_version = ? AND status = ?
      )`,
      [id, expected, current.status],
    ))
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'redeem_code'))
      throw mapRedeemWriteError(error)
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function deleteAdminRedeemCode(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const id = requireResourceId(context.req.param('id'), 'redeem_code')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readOptionalJson(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const idem = await controlIdempotency('admin.redeem-codes.delete.v1', key, { id, expected })
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) {
      return controlSuccess(parseIdempotentResponse(previous, 'redeem_code_delete'))
    }
    const current = await requireRedeemCode(context.env, id)
    assertControlVersion(current.control_version, expected)
    if (current.status === 'processing' || current.status === 'used') throw redeemCodeNotMutable()
    const response = { id, deleted: 1, message: 'Redeem code deleted successfully' }
    const currentTime = Date.now()
    try {
      await context.env.DB.batch([
        guardedIdempotencyInsert(
          context.env,
          idem,
          'redeem_code_delete',
          id,
          response,
          currentTime,
          `EXISTS (
            SELECT 1 FROM redeem_codes
             WHERE id = ? AND control_version = ? AND status IN ('unused', 'expired', 'disabled')
          )`,
          [id, expected],
        ),
        context.env.DB.prepare(
          `UPDATE redeem_codes
              SET control_version = CASE
                WHEN control_version = ? AND status IN ('unused', 'expired', 'disabled')
                  THEN control_version ELSE -1
              END
            WHERE id = ?`,
        ).bind(expected, id),
        ...(current.type === 'invitation'
          ? [context.env.DB.prepare(`DELETE FROM invitation_codes WHERE id = ?`).bind(id)]
          : []),
        context.env.DB.prepare(
          `DELETE FROM redeem_codes
            WHERE id = ? AND control_version = ? AND status IN ('unused', 'expired', 'disabled')`,
        ).bind(id, expected),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) {
        return controlSuccess(parseIdempotentResponse(recovered, 'redeem_code_delete'))
      }
      throw mapRedeemWriteError(error)
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function batchUpdateAdminRedeemCodes(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const batch = parseBatchInput(body)
    const patch = parseBatchPatch(body)
    const idem = await controlIdempotency('admin.redeem-codes.batch-update.v1', key, {
      ids: batch.ids,
      expected_control_versions: batch.expected,
      fields: patch,
    })
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) {
      return controlSuccess(parseIdempotentResponse(previous, 'redeem_code_batch_update'))
    }
    const rows = await requireBatchRedeemCodes(context.env, batch.ids)
    for (const row of rows) {
      assertControlVersion(row.control_version, batch.expected[row.id])
      if (
        row.status !== 'unused' && row.status !== 'disabled' && row.status !== 'expired'
      ) {
        throw redeemCodeNotMutable()
      }
      if (patch.group_id !== undefined && row.type !== 'subscription') {
        throw new GatewayError(
          409,
          'redeem_code_type_mismatch',
          'Only unused subscription redeem codes can change subscription group',
        )
      }
    }
    if (patch.group_id !== undefined && patch.group_id !== null) {
      await requireSubscriptionGroup(context.env, patch.group_id)
    }
    const response = { updated: rows.length, message: 'Redeem codes updated successfully' }
    const statements = rows.map((row) => redeemCodeUpdateStatement(
      context.env,
      row,
      patch,
      batch.expected[row.id],
      Date.now(),
    ))
    statements.push(...rows
      .filter((row) => row.type === 'invitation')
      .map((row) => invitationMirrorUpdateStatement(context.env, row, patch, Date.now())))
    statements.unshift(guardedIdempotencyInsert(
      context.env,
      idem,
      'redeem_code_batch_update',
      await deterministicUuid('admin.redeem-codes.batch-update.v1', key),
      response,
      Date.now(),
      batchGuardExpression(rows, true),
      batchGuardValues(rows, batch.expected),
    ))
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) {
        return controlSuccess(parseIdempotentResponse(recovered, 'redeem_code_batch_update'))
      }
      throw mapRedeemWriteError(error)
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function batchDeleteAdminRedeemCodes(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const batch = parseBatchInput(body)
    const idem = await controlIdempotency('admin.redeem-codes.batch-delete.v1', key, {
      ids: batch.ids,
      expected_control_versions: batch.expected,
    })
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) {
      return controlSuccess(parseIdempotentResponse(previous, 'redeem_code_batch_delete'))
    }
    const rows = await requireBatchRedeemCodes(context.env, batch.ids)
    for (const row of rows) {
      assertControlVersion(row.control_version, batch.expected[row.id])
      if (row.status === 'processing' || row.status === 'used') throw redeemCodeNotMutable()
    }
    const response = { deleted: rows.length, message: 'Redeem codes deleted successfully' }
    const current = Date.now()
    const statements: D1PreparedStatement[] = []
    for (const row of rows) {
      const expected = batch.expected[row.id]
      statements.push(
        context.env.DB.prepare(
          `UPDATE redeem_codes
              SET control_version = CASE
                WHEN control_version = ? AND status IN ('unused', 'expired', 'disabled')
                  THEN control_version ELSE -1
              END
            WHERE id = ?`,
        ).bind(expected, row.id),
        ...(row.type === 'invitation'
          ? [context.env.DB.prepare(`DELETE FROM invitation_codes WHERE id = ?`).bind(row.id)]
          : []),
        context.env.DB.prepare(
          `DELETE FROM redeem_codes
            WHERE id = ? AND control_version = ? AND status IN ('unused', 'expired', 'disabled')`,
        ).bind(row.id, expected),
      )
    }
    statements.unshift(guardedIdempotencyInsert(
      context.env,
      idem,
      'redeem_code_batch_delete',
      await deterministicUuid('admin.redeem-codes.batch-delete.v1', key),
      response,
      current,
      batchGuardExpression(rows, false),
      batchGuardValues(rows, batch.expected),
    ))
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) {
        return controlSuccess(parseIdempotentResponse(recovered, 'redeem_code_batch_delete'))
      }
      throw mapRedeemWriteError(error)
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function generateAdminRedeemCodes(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const key = requireIdempotencyKey(context.req.raw)
    const input = parseGenerateInput(await readJsonObject(context.req.raw))
    const idem = await controlIdempotency('admin.redeem-codes.generate.v1', key, input)
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) {
      const replay = parseIdempotentResponse<Record<string, unknown>[]>(previous, 'redeem_code_batch')
      return controlSuccess(await restoreGeneratedPlaintext(context.env, replay))
    }

    const pepper = requirePepper(context.env)
    const group = input.group_id === null
      ? null
      : await requireSubscriptionGroup(context.env, input.group_id)
    const current = Date.now()
    const batchId = await deterministicUuid('admin.redeem-codes.generate.batch.v1', key)
    const rows: RedeemCodeRow[] = []
    const plaintext: string[] = []
    const invitationMirrors: InvitationMirror[] = []
    const redeemSecrets: RedeemCodeSecret[] = []
    for (let index = 0; index < input.count; index += 1) {
      const code = randomRedeemCode()
      plaintext.push(code)
      rows.push({
        id: await deterministicUuid('admin.redeem-codes.generate.item.v1', `${key}\0${index}`),
        code_hash: await redeemCodeDigest(code, pepper),
        code_prefix: code.slice(0, 8),
        type: input.type,
        value_micros: input.value_micros,
        group_id: input.group_id,
        validity_days: input.validity_days,
        status: 'unused',
        expires_at_ms: input.expires_at_ms,
        used_by_user_id: null,
        claimed_by_redemption_id: null,
        used_at_ms: null,
        notes: input.notes,
        control_version: 0,
        created_by_user_id: null,
        created_at_ms: current,
        updated_at_ms: current,
        group_name: group?.name ?? null,
        group_platform: group?.platform ?? null,
      })
      const redeemSecret = await encryptCredential(
        { api_key: code },
        requireCredentialMasterKey(context.env),
        `redeem-code:v1:${rows[rows.length - 1].id}:1`,
      )
      redeemSecrets.push({
        redeem_code_id: rows[rows.length - 1].id,
        secret_key_version: 1,
        secret_nonce_b64: redeemSecret.nonce_b64,
        secret_ciphertext_b64: redeemSecret.ciphertext_b64,
        created_at_ms: current,
      })
      if (input.type === 'invitation') {
        const row = rows[rows.length - 1]
        const secret = await encryptCredential(
          { api_key: code },
          requireCredentialMasterKey(context.env),
          `invitation-code:v1:${row.id}:1`,
        )
        invitationMirrors.push({
          id: row.id,
          code_hash: await commercialCodeDigest('invitation', code, pepper),
          code_prefix: row.code_prefix,
          secret_nonce_b64: secret.nonce_b64,
          secret_ciphertext_b64: secret.ciphertext_b64,
          expires_at_ms: row.expires_at_ms,
          notes: row.notes,
          created_at_ms: current,
        })
      }
    }
    const safe = rows.map((row) => publicRedeemCode(row))
    const statements = rows.map((row) => context.env.DB.prepare(
      `INSERT INTO redeem_codes (
         id, code_hash, code_prefix, type, value_micros, group_id, validity_days,
         status, expires_at_ms, notes, created_by_user_id, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unused', ?, ?, ?, ?, ?)`,
    ).bind(
      row.id,
      row.code_hash,
      row.code_prefix,
      row.type,
      row.value_micros,
      row.group_id,
      row.validity_days,
      row.expires_at_ms,
      row.notes,
      row.created_by_user_id,
      current,
      current,
    ))
    statements.push(...invitationMirrors.map((mirror) => context.env.DB.prepare(
      `INSERT INTO invitation_codes (
         id, code_hash, code_prefix, secret_key_version, secret_nonce_b64,
         secret_ciphertext_b64, max_uses, status, expires_at_ms, notes,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 1, ?, ?, 1, 'active', ?, ?, ?, ?)`,
    ).bind(
      mirror.id,
      mirror.code_hash,
      mirror.code_prefix,
      mirror.secret_nonce_b64,
      mirror.secret_ciphertext_b64,
      mirror.expires_at_ms,
      mirror.notes,
      mirror.created_at_ms,
      mirror.created_at_ms,
    )))
    statements.push(...redeemSecrets.map((secret) => context.env.DB.prepare(
      `INSERT INTO redeem_code_secrets (
         redeem_code_id, secret_key_version, secret_nonce_b64,
         secret_ciphertext_b64, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      secret.redeem_code_id,
      secret.secret_key_version,
      secret.secret_nonce_b64,
      secret.secret_ciphertext_b64,
      secret.created_at_ms,
      secret.created_at_ms,
    )))
    statements.push(controlIdempotencyInsert(
      context.env,
      idem,
      'redeem_code_batch',
      batchId,
      safe,
      current,
    ))
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) {
        const replay = parseIdempotentResponse<Record<string, unknown>[]>(recovered, 'redeem_code_batch')
        return controlSuccess(await restoreGeneratedPlaintext(context.env, replay))
      }
      throw mapRedeemWriteError(error)
    }

    return controlSuccess(safe.map((code, index) => ({
      ...code,
      code: plaintext[index],
      warning: 'Each redeem code is shown once and is not persisted in plaintext.',
    })), 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function parseGenerateInput(body: Record<string, unknown>): GenerateRedeemCodesInput {
  const count = requireSafeInteger(body, 'count', 1, 100)
  const type = requireString(body, 'type', 32)
  if (!['balance', 'concurrency', 'subscription', 'invitation'].includes(type)) {
    throw new GatewayError(
      400,
      'unsupported_redeem_code_type',
      'type must be balance, concurrency, subscription, or invitation',
    )
  }
  const expires_at_ms = parseExpiry(body)
  const notes = optionalText(body, 'notes', 1_024) ?? ''
  if (type === 'balance') {
    return {
      count,
      type,
      value_micros: parseValueMicros(body),
      group_id: null,
      validity_days: null,
      expires_at_ms,
      notes,
    }
  }
  if (type === 'concurrency') {
    return {
      count,
      type,
      value_micros: requireSafeInteger(body, 'value', 1, Number.MAX_SAFE_INTEGER),
      group_id: null,
      validity_days: null,
      expires_at_ms,
      notes,
    }
  }
  if (type === 'invitation') {
    if (body.value !== undefined && body.value !== 0) {
      throw new GatewayError(400, 'invalid_value', 'invitation redeem codes must have zero value')
    }
    return {
      count,
      type,
      value_micros: 0,
      group_id: null,
      validity_days: null,
      expires_at_ms,
      notes,
    }
  }
  if (body.value_micros !== undefined && body.value_micros !== 0) {
    throw new GatewayError(400, 'invalid_value_micros', 'subscription redeem codes must have zero value_micros')
  }
  return {
    count,
    type: 'subscription',
    value_micros: 0,
    group_id: requireResourceId(requireString(body, 'group_id', 128), 'group'),
    validity_days: requireSafeInteger(body, 'validity_days', 1, 36_500),
    expires_at_ms,
    notes,
  }
}

function parseBatchInput(body: Record<string, unknown>): RedeemCodeBatchInput {
  if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 50) {
    throw new GatewayError(400, 'invalid_redeem_code_ids', 'ids must contain between 1 and 50 redeem code ids')
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const value of body.ids) {
    if (typeof value !== 'string') {
      throw new GatewayError(400, 'invalid_redeem_code_id', 'redeem code ids must be Worker string ids')
    }
    const id = requireResourceId(value, 'redeem_code')
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  const versions = body.expected_control_versions
  if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) {
    throw new GatewayError(
      428,
      'control_versions_required',
      'expected_control_versions is required for every redeem code',
    )
  }
  const expected: Record<string, number> = Object.create(null) as Record<string, number>
  for (const id of ids) {
    const version = (versions as Record<string, unknown>)[id]
    if (!Number.isSafeInteger(version) || (version as number) < 0) {
      throw new GatewayError(
        428,
        'control_versions_required',
        'expected_control_versions is required for every redeem code',
      )
    }
    expected[id] = version as number
  }
  return { ids, expected }
}

function parseBatchPatch(body: Record<string, unknown>): RedeemCodePatch {
  const fields = body.fields
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new GatewayError(400, 'invalid_redeem_code_fields', 'fields must be a JSON object')
  }
  const source = fields as Record<string, unknown>
  if (source.type !== undefined || source.value !== undefined || source.value_micros !== undefined) {
    throw new GatewayError(
      400,
      'redeem_code_core_fields_immutable',
      'Redeem code type and value cannot be batch updated',
    )
  }
  const result: RedeemCodePatch = {}
  if (source.status !== undefined) {
    if (source.status !== 'unused' && source.status !== 'disabled') {
      throw new GatewayError(400, 'invalid_redeem_code_status', 'status must be unused or disabled')
    }
    result.status = source.status
  }
  if (source.notes !== undefined) {
    if (typeof source.notes !== 'string' || source.notes.length > 1_024) {
      throw new GatewayError(400, 'invalid_notes', 'notes must be a string no longer than 1024 characters')
    }
    result.notes = source.notes.trim()
  }
  if (source.expires_at !== undefined) {
    if (source.expires_at === null || source.expires_at === '') {
      result.expires_at_ms = null
    } else {
      if (typeof source.expires_at !== 'string') {
        throw new GatewayError(400, 'invalid_expires_at', 'expires_at must be an ISO timestamp or null')
      }
      const expires = Date.parse(source.expires_at)
      if (!Number.isSafeInteger(expires) || expires <= Date.now() || expires > MAX_DATE_MS) {
        throw new GatewayError(400, 'invalid_expires_at', 'expires_at must be a future ISO timestamp')
      }
      result.expires_at_ms = expires
    }
  }
  if (source.group_id !== undefined) {
    if (source.group_id === null) {
      result.group_id = null
    } else {
      if (typeof source.group_id !== 'string') {
        throw new GatewayError(400, 'invalid_group_id', 'group_id must be a Worker group id string or null')
      }
      result.group_id = requireResourceId(source.group_id, 'group')
    }
  }
  if (Object.keys(result).length === 0) {
    throw new GatewayError(400, 'empty_update', 'At least one supported field is required')
  }
  return result
}

function parseValueMicros(body: Record<string, unknown>): number {
  if (body.value_micros !== undefined) {
    if (body.value !== undefined) {
      throw new GatewayError(400, 'ambiguous_value', 'Specify value or value_micros, not both')
    }
    return requireSafeInteger(body, 'value_micros', 1, Number.MAX_SAFE_INTEGER)
  }
  const value = body.value
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new GatewayError(400, 'invalid_value', 'value or value_micros must be a positive amount')
  }
  const micros = Math.round(value * 1_000_000)
  if (!Number.isSafeInteger(micros) || micros <= 0) {
    throw new GatewayError(400, 'invalid_value', 'value is outside the supported micro-unit range')
  }
  return micros
}

function parseExpiry(body: Record<string, unknown>): number | null {
  const direct = optionalSafeInteger(body, 'expires_at_ms', 0, MAX_DATE_MS)
  const days = optionalSafeInteger(body, 'expires_in_days', 1, 3_650)
  const legacy = body.expires_at
  const supplied = Number(direct !== undefined) + Number(days !== undefined) + Number(legacy !== undefined)
  if (supplied > 1) {
    throw new GatewayError(400, 'redeem_code_expiry_conflict', 'Specify only one redeem code expiry')
  }
  let value = direct
  if (days !== undefined) value = Date.now() + days * 86_400_000
  if (legacy !== undefined) {
    if (typeof legacy !== 'string') {
      throw new GatewayError(400, 'invalid_expires_at', 'expires_at must be an ISO timestamp')
    }
    value = Date.parse(legacy)
    if (!Number.isSafeInteger(value)) {
      throw new GatewayError(400, 'invalid_expires_at', 'expires_at must be an ISO timestamp')
    }
  }
  if (value === undefined) return null
  if (value <= Date.now() || value > MAX_DATE_MS) {
    throw new GatewayError(400, 'invalid_expires_at', 'redeem code expiry must be in the future')
  }
  return value
}

function optionalText(
  body: Record<string, unknown>,
  field: string,
  maximum: number,
): string | undefined {
  if (body[field] === undefined) return undefined
  if (typeof body[field] !== 'string' || (body[field] as string).length > maximum) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a string no longer than ${maximum} characters`)
  }
  return (body[field] as string).trim()
}

async function requireSubscriptionGroup(env: Env, id: string): Promise<RedeemGroupRow> {
  const group = await env.DB.prepare(
    `SELECT id, name, platform, enabled, group_type FROM "groups" WHERE id = ? AND deleted_at_ms IS NULL`,
  ).bind(id).first<RedeemGroupRow>()
  if (group === null) throw new GatewayError(404, 'group_not_found', 'Group was not found')
  if (group.group_type !== 'subscription') {
    throw new GatewayError(409, 'redeem_code_requires_subscription_group', 'Subscription redeem codes require a subscription group')
  }
  if (group.enabled !== 1) {
    throw new GatewayError(409, 'group_disabled', 'Cannot generate a redeem code for a disabled group')
  }
  return group
}

async function requireRedeemCode(env: Env, idValue: string | undefined): Promise<RedeemCodeRow> {
  const id = requireResourceId(idValue, 'redeem_code')
  const row = await env.DB.prepare(
    `${redeemSelectSql()} WHERE rc.id = ?`,
  ).bind(id).first<RedeemCodeRow>()
  if (row === null) throw new GatewayError(404, 'redeem_code_not_found', 'Redeem code was not found')
  return row
}

async function requireBatchRedeemCodes(env: Env, ids: string[]): Promise<RedeemCodeRow[]> {
  const placeholders = ids.map(() => '?').join(', ')
  const result = await env.DB.prepare(
    `${redeemSelectSql()} WHERE rc.id IN (${placeholders})`,
  ).bind(...ids).all<RedeemCodeRow>()
  if (result.results.length !== ids.length) {
    throw new GatewayError(404, 'redeem_code_not_found', 'One or more redeem codes were not found')
  }
  const byId = new Map(result.results.map((row) => [row.id, row]))
  return ids.map((id) => byId.get(id)!)
}

function redeemCodeUpdateStatement(
  env: Env,
  row: RedeemCodeRow,
  patch: RedeemCodePatch,
  expected: number,
  updatedAt: number,
): D1PreparedStatement {
  const next = { ...row, ...patch }
  return env.DB.prepare(
    `UPDATE redeem_codes
        SET status = ?, notes = ?, expires_at_ms = ?, group_id = ?,
            control_version = CASE
              WHEN control_version = ? AND status IN ('unused', 'disabled', 'expired')
              THEN ? ELSE -1
            END,
            updated_at_ms = ?
      WHERE id = ?`,
  ).bind(
    next.status,
    next.notes,
    next.expires_at_ms,
    next.group_id,
    expected,
    expected + 1,
    updatedAt,
    row.id,
  )
}

function invitationMirrorUpdateStatement(
  env: Env,
  row: RedeemCodeRow,
  patch: RedeemCodePatch,
  updatedAt: number,
): D1PreparedStatement {
  const next = { ...row, ...patch }
  return env.DB.prepare(
    `UPDATE invitation_codes
        SET status = ?, expires_at_ms = ?, notes = ?,
            control_version = control_version + 1, updated_at_ms = ?
      WHERE id = ?`,
  ).bind(
    next.status === 'unused' ? 'active' : 'disabled',
    next.expires_at_ms,
    next.notes,
    updatedAt,
    row.id,
  )
}

function batchGuardExpression(rows: RedeemCodeRow[], update: boolean): string {
  const state = update
    ? `status IN ('unused', 'disabled', 'expired')`
    : `status IN ('unused', 'expired', 'disabled')`
  const entries = rows.map(() => `(id = ? AND control_version = ? AND ${state})`)
  return `(SELECT COUNT(*) FROM redeem_codes WHERE ${entries.join(' OR ')}) = ${rows.length}`
}

function batchGuardValues(
  rows: RedeemCodeRow[],
  expected: Record<string, number>,
): unknown[] {
  return rows.flatMap((row) => [
    row.id,
    expected[row.id],
  ])
}

function guardedIdempotencyInsert(
  env: Env,
  value: ControlIdempotency,
  resourceType: string,
  resourceId: string,
  response: unknown,
  now: number,
  guardExpression: string,
  guardValues: unknown[],
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO control_idempotency (
       scope, key_hash, request_hash, resource_type, resource_id,
       response_json, created_at_ms, expires_at_ms
     ) VALUES (?, ?, ?, ?, CASE WHEN ${guardExpression} THEN ? ELSE NULL END, ?, ?, ?)`,
  ).bind(
    value.scope,
    value.key_hash,
    value.request_hash,
    resourceType,
    ...guardValues,
    resourceId,
    JSON.stringify(response),
    now,
    now + IDEMPOTENCY_TTL_MS,
  )
}

function redeemSelectSql(): string {
  return `SELECT ${REDEEM_SELECT},
      u.email AS user_email, u.display_name AS user_display_name,
      g.name AS group_name, g.platform AS group_platform
    FROM redeem_codes rc
    LEFT JOIN users u ON u.id = rc.used_by_user_id
    LEFT JOIN "groups" g ON g.id = rc.group_id`
}

function redeemExportSelectSql(): string {
  return `SELECT ${REDEEM_SELECT},
      u.email AS user_email, u.display_name AS user_display_name,
      g.name AS group_name, g.platform AS group_platform,
      secret.secret_key_version, secret.secret_nonce_b64, secret.secret_ciphertext_b64
    FROM redeem_codes rc
    LEFT JOIN users u ON u.id = rc.used_by_user_id
    LEFT JOIN "groups" g ON g.id = rc.group_id
    LEFT JOIN redeem_code_secrets secret ON secret.redeem_code_id = rc.id`
}

function redeemSortExpression(value: string): string {
  const expressions: Record<string, string> = {
    id: 'rc.created_at_ms',
    type: 'rc.type',
    value: 'rc.value_micros',
    status: 'rc.status',
    used_at: 'rc.used_at_ms',
    expires_at: 'rc.expires_at_ms',
    created_at: 'rc.created_at_ms',
  }
  const expression = expressions[value]
  if (expression === undefined) throw new GatewayError(400, 'invalid_sort_by', 'sort_by is invalid')
  return expression
}

function validCount(row: unknown): number {
  const value = (row as { total?: unknown } | undefined)?.total
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GatewayError(500, 'invalid_redeem_code_count', 'Redeem code count is invalid', 'server_error')
  }
  return value as number
}

function assertControlVersion(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new GatewayError(412, 'control_version_conflict', 'Resource changed; reload it and retry')
  }
  if (expected >= Number.MAX_SAFE_INTEGER) {
    throw new GatewayError(409, 'control_version_exhausted', 'Resource control version is exhausted')
  }
}

function redeemCodeNotMutable(): GatewayError {
  return new GatewayError(
    409,
    'redeem_code_not_mutable',
    'Processing and used redeem codes cannot be modified or deleted',
  )
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

async function decryptRedeemCodeForExport(
  env: Env,
  row: RedeemCodeExportRow,
): Promise<string> {
  if (
    row.secret_key_version === null ||
    row.secret_nonce_b64 === null ||
    row.secret_ciphertext_b64 === null
  ) {
    throw new GatewayError(
      409,
      'redeem_code_plaintext_unavailable',
      'One or more selected redeem codes predate secure export storage and cannot be exported',
    )
  }
  const secret = await decryptCredential(
    row.secret_nonce_b64,
    row.secret_ciphertext_b64,
    requireCredentialMasterKey(env),
    `redeem-code:v1:${row.id}:${row.secret_key_version}`,
  )
  if (typeof secret.api_key !== 'string' || secret.api_key.trim() === '') {
    throw new GatewayError(500, 'invalid_redeem_code_secret', 'Redeem code secret is invalid', 'server_error')
  }
  return secret.api_key
}

async function restoreGeneratedPlaintext(
  env: Env,
  replay: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  return Promise.all(replay.map(async (code) => {
    if (typeof code.id !== 'string') {
      throw new GatewayError(500, 'invalid_redeem_code_replay', 'Redeem code replay is invalid', 'server_error')
    }
    const secret = await env.DB.prepare(
      `SELECT secret_key_version, secret_nonce_b64, secret_ciphertext_b64
         FROM redeem_code_secrets WHERE redeem_code_id = ?`,
    ).bind(code.id).first<{
      secret_key_version: number
      secret_nonce_b64: string
      secret_ciphertext_b64: string
    }>()
    if (secret === null) {
      throw new GatewayError(
        409,
        'redeem_code_plaintext_unavailable',
        'Generated redeem code plaintext is unavailable',
      )
    }
    const plaintext = await decryptCredential(
      secret.secret_nonce_b64,
      secret.secret_ciphertext_b64,
      requireCredentialMasterKey(env),
      `redeem-code:v1:${code.id}:${secret.secret_key_version}`,
    )
    return {
      ...code,
      code: plaintext.api_key,
      warning: 'Redeem code recovered from encrypted storage.',
    }
  }))
}

function publicRedeemCode(row: RedeemCodeRow, current = Date.now()) {
  const effectiveStatus = row.status === 'unused' && row.expires_at_ms !== null && row.expires_at_ms <= current
    ? 'expired' as const
    : row.status
  return {
    id: row.id,
    code: `${row.code_prefix}…`,
    code_prefix: row.code_prefix,
    type: row.type,
    value: row.type === 'balance' ? row.value_micros / 1_000_000
      : row.type === 'concurrency' ? row.value_micros : 0,
    value_micros: row.value_micros,
    status: effectiveStatus,
    used_by: row.used_by_user_id,
    used_at: nullableIso(row.used_at_ms),
    created_at: iso(row.created_at_ms),
    expires_at: nullableIso(row.expires_at_ms),
    updated_at: iso(row.updated_at_ms),
    notes: row.notes,
    group_id: row.group_id,
    validity_days: row.validity_days ?? undefined,
    control_version: row.control_version,
    user: row.used_by_user_id === null ? undefined : {
      id: row.used_by_user_id,
      email: row.user_email,
      username: row.user_display_name,
    },
    group: row.group_id === null ? undefined : {
      id: row.group_id,
      name: row.group_name,
      platform: row.group_platform,
      subscription_type: 'subscription',
    },
  }
}

function randomRedeemCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const encoded = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
  return encoded.match(/.{8}/g)!.join('-')
}

function requirePepper(env: Env): string {
  if (!env.API_KEY_PEPPER || env.API_KEY_PEPPER.length < 32) {
    throw new GatewayError(503, 'redeem_code_pepper_missing', 'Redeem code hashing is not configured', 'server_error')
  }
  return env.API_KEY_PEPPER
}

function requireCredentialMasterKey(env: Env): string {
  const key = env.CREDENTIALS_MASTER_KEY
  if (!key || new TextEncoder().encode(key).byteLength < 32) {
    throw new GatewayError(
      503,
      'invitation_code_encryption_not_configured',
      'Invitation code encryption is not configured',
      'server_error',
    )
  }
  return key
}

function nullableIso(value: number | null): string | null {
  return value === null ? null : iso(value)
}

function iso(value: number): string {
  return new Date(value).toISOString()
}

function mapRedeemWriteError(error: unknown): unknown {
  if (error instanceof GatewayError) return error
  const message = error instanceof Error ? error.message : ''
  if (message.includes('control_version')) {
    return new GatewayError(412, 'control_version_conflict', 'Resource changed; reload it and retry')
  }
  if (message.includes('control_idempotency.resource_id')) {
    return new GatewayError(412, 'control_version_conflict', 'Resource changed; reload it and retry')
  }
  if (message.includes('UNIQUE constraint')) {
    return new GatewayError(409, 'redeem_code_conflict', 'A redeem code conflict occurred; retry with a new idempotency key')
  }
  if (message.includes('subscription_redeem_code_') || message.includes('FOREIGN KEY')) {
    return new GatewayError(409, 'redeem_code_relation_changed', 'Redeem code relation changed; reload and retry')
  }
  return error
}

async function readOptionalJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (text.trim() === '') return {}
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object')
    return value as Record<string, unknown>
  } catch {
    throw new GatewayError(400, 'invalid_json', 'Request body must be a JSON object')
  }
}
