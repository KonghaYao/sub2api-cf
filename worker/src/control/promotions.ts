import type { Context } from 'hono'

import { authenticateAdminSession, type AdminActor } from './admin-auth'
import {
  controlError,
  controlSuccess,
  optionalSafeInteger,
  optionalString,
  queryInteger,
  readJsonObject,
  readOptionalJsonObject,
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
import { commercialCodeDigest, normalizeCommercialCode } from '../commercial/registration'
import type { Env } from '../env'
import { decryptCredential, encryptCredential, randomToken } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { redeemCodeDigest } from '../user/redeem'

type ControlBindings = { Bindings: Env }
type CodeKind = 'promotion' | 'invitation'
const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000

interface StoredCodeRow {
  id: string
  code_hash: string
  code_prefix: string
  secret_key_version: number
  secret_nonce_b64: string
  secret_ciphertext_b64: string
  bonus_micros?: number
  max_uses: number
  used_count: number
  status: 'active' | 'disabled'
  expires_at_ms: number | null
  notes: string
  control_version: number
  created_at_ms: number
  updated_at_ms: number
}

interface CodePatch {
  code?: string
  bonusMicros?: number
  maxUses?: number
  status?: 'active' | 'disabled'
  expiresAtMs?: number | null
  notes?: string
}

interface LegacyRedeemInvitationMirror {
  status: 'unused' | 'processing' | 'used' | 'expired' | 'disabled'
  secret_key_version: number | null
}

export async function listAdminPromotionCodes(context: Context<ControlBindings>): Promise<Response> {
  return listCodes(context, 'promotion')
}

export async function getAdminPromotionCode(context: Context<ControlBindings>): Promise<Response> {
  return getCode(context, 'promotion')
}

export async function createAdminPromotionCode(context: Context<ControlBindings>): Promise<Response> {
  return createCode(context, 'promotion')
}

export async function updateAdminPromotionCode(context: Context<ControlBindings>): Promise<Response> {
  return updateCode(context, 'promotion')
}

export async function deleteAdminPromotionCode(context: Context<ControlBindings>): Promise<Response> {
  return deleteCode(context, 'promotion')
}

export async function listAdminPromotionUsages(context: Context<ControlBindings>): Promise<Response> {
  return listUsages(context, 'promotion')
}

export async function listAdminInvitationCodes(context: Context<ControlBindings>): Promise<Response> {
  return listCodes(context, 'invitation')
}

export async function getAdminInvitationCode(context: Context<ControlBindings>): Promise<Response> {
  return getCode(context, 'invitation')
}

export async function createAdminInvitationCode(context: Context<ControlBindings>): Promise<Response> {
  return createCode(context, 'invitation')
}

export async function updateAdminInvitationCode(context: Context<ControlBindings>): Promise<Response> {
  return updateCode(context, 'invitation')
}

export async function deleteAdminInvitationCode(context: Context<ControlBindings>): Promise<Response> {
  return deleteCode(context, 'invitation')
}

export async function listAdminInvitationUsages(context: Context<ControlBindings>): Promise<Response> {
  return listUsages(context, 'invitation')
}

export async function getAdminCommercialConfig(context: Context<ControlBindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const row = await context.env.DB.prepare(
      `SELECT control_version, affiliate_rebate_rate_ppm,
              affiliate_rebate_freeze_hours, affiliate_rebate_duration_days,
              affiliate_rebate_per_invitee_cap_micros,
              affiliate_admin_recharge_enabled, updated_at_ms
         FROM commercial_config WHERE id = 'global'`,
    ).first<Record<string, number>>()
    if (row === null) throw unavailable()
    return commercialConfigResponse(publicCommercialConfig(row))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updateAdminCommercialConfig(context: Context<ControlBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw, 8_192)
    const idempotency = await controlIdempotency(
      'commercial-config.update',
      requireIdempotencyKey(context.req.raw),
      body,
    )
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) {
      return commercialConfigResponse(
        parseIdempotentResponse<Record<string, unknown>>(replay, 'commercial_config'),
      )
    }
    const current = await context.env.DB.prepare(
      `SELECT control_version, affiliate_rebate_rate_ppm,
              affiliate_rebate_freeze_hours, affiliate_rebate_duration_days,
              affiliate_rebate_per_invitee_cap_micros,
              affiliate_admin_recharge_enabled, updated_at_ms
         FROM commercial_config WHERE id = 'global'`,
    ).first<Record<string, number>>()
    if (current === null) throw unavailable()
    const expected = requireExpectedControlVersion(context.req.raw, body)
    if (expected !== current.control_version) throw versionConflict()
    const ratePercent = optionalFiniteNumber(body.affiliate_rebate_rate, 'affiliate_rebate_rate', 0, 100)
    const freezeHours = optionalSafeInteger(body, 'affiliate_rebate_freeze_hours', 0, 720)
    const durationDays = optionalSafeInteger(body, 'affiliate_rebate_duration_days', 0, 3650)
    const capMicros = body.affiliate_rebate_per_invitee_cap_micros === undefined
      ? amountToMicros(body.affiliate_rebate_per_invitee_cap, 'affiliate_rebate_per_invitee_cap', true)
      : optionalSafeInteger(body, 'affiliate_rebate_per_invitee_cap_micros', 0)
    const adminRecharge = optionalBoolean(body.affiliate_admin_recharge_enabled, 'affiliate_admin_recharge_enabled')
    const next = {
      rate: ratePercent === undefined ? current.affiliate_rebate_rate_ppm : Math.round(ratePercent * 10_000),
      freeze: freezeHours ?? current.affiliate_rebate_freeze_hours,
      duration: durationDays ?? current.affiliate_rebate_duration_days,
      cap: capMicros ?? current.affiliate_rebate_per_invitee_cap_micros,
      admin: adminRecharge === undefined
        ? current.affiliate_admin_recharge_enabled
        : adminRecharge ? 1 : 0,
    }
    const now = Date.now()
    const changed = Object.keys(body).filter((key) => key !== 'expected_control_version')
    const response = publicCommercialConfig({
      control_version: expected + 1,
      affiliate_rebate_rate_ppm: next.rate,
      affiliate_rebate_freeze_hours: next.freeze,
      affiliate_rebate_duration_days: next.duration,
      affiliate_rebate_per_invitee_cap_micros: next.cap,
      affiliate_admin_recharge_enabled: next.admin,
      updated_at_ms: now,
    })
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE commercial_config
              SET control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                  affiliate_rebate_rate_ppm = ?, affiliate_rebate_freeze_hours = ?,
                  affiliate_rebate_duration_days = ?, affiliate_rebate_per_invitee_cap_micros = ?,
                  affiliate_admin_recharge_enabled = ?, updated_at_ms = ?
            WHERE id = 'global'`,
        ).bind(
          expected, expected + 1, next.rate, next.freeze, next.duration,
          next.cap, next.admin, now,
        ),
        auditStatement(
          context.env,
          actor,
          'commercial_config.update',
          'commercial_config',
          'global',
          expected + 1,
          changed,
          now,
        ),
        controlIdempotencyInsert(
          context.env,
          idempotency,
          'commercial_config',
          'global',
          response,
          now,
        ),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return commercialConfigResponse(
          parseIdempotentResponse<Record<string, unknown>>(recovered, 'commercial_config'),
        )
      }
      const latest = await context.env.DB.prepare(
        `SELECT control_version FROM commercial_config WHERE id = 'global'`,
      ).first<{ control_version: number }>()
      if (latest !== null && latest.control_version !== expected) throw versionConflict()
      throw error
    }
    const row = await context.env.DB.prepare(
      `SELECT control_version, affiliate_rebate_rate_ppm,
              affiliate_rebate_freeze_hours, affiliate_rebate_duration_days,
              affiliate_rebate_per_invitee_cap_micros,
              affiliate_admin_recharge_enabled, updated_at_ms
         FROM commercial_config WHERE id = 'global'`,
    ).first<Record<string, number>>()
    if (row === null || row.control_version !== expected + 1) throw versionConflict()
    return commercialConfigResponse(publicCommercialConfig(row))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function listCodes(context: Context<ControlBindings>, kind: CodeKind): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const status = context.req.query('status')?.trim()
    if (status !== undefined && status !== '' && status !== 'active' && status !== 'disabled') {
      throw new GatewayError(400, 'invalid_status', 'status must be active or disabled')
    }
    const search = context.req.query('search')?.trim() ?? ''
    if (search.length > 100) throw new GatewayError(400, 'invalid_search', 'search is too long')
    const table = codeTable(kind)
    const conditions: string[] = []
    const values: unknown[] = []
    if (status) { conditions.push('status = ?'); values.push(status) }
    if (search) {
      let digest = ''
      try { digest = await commercialCodeDigest(kind, search, requirePepper(context.env)) } catch { /* text search */ }
      conditions.push(`(code_hash = ? OR code_prefix LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')`)
      const like = `%${escapeLike(search.toUpperCase())}%`
      values.push(digest, like, `%${escapeLike(search)}%`)
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const count = await context.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM ${table} ${where}`,
    ).bind(...values).first<{ total: number }>()
    const rows = await context.env.DB.prepare(
      `${codeSelect(kind)} ${where}
       ORDER BY created_at_ms DESC, id DESC LIMIT ? OFFSET ?`,
    ).bind(...values, pageSize, (page - 1) * pageSize).all<StoredCodeRow>()
    const items = await Promise.all(rows.results.map((row) => publicCode(context.env, kind, row)))
    const total = count?.total ?? 0
    return controlSuccess({ items, total, page, page_size: pageSize, pages: Math.ceil(total / pageSize) })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function getCode(context: Context<ControlBindings>, kind: CodeKind): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const row = await findCode(context.env, kind, requireResourceId(context.req.param('id'), `${kind}_code`))
    if (row === null) throw notFound(kind)
    return codeResponse(await publicCode(context.env, kind, row))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function createCode(context: Context<ControlBindings>, kind: CodeKind): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw, 16_384)
    const idempotency = await controlIdempotency(
      `commercial.${kind}-code.create.v1`,
      requireIdempotencyKey(context.req.raw),
      body,
    )
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) {
      return codeResponse(
        await parseSealedIdempotentResponse(context.env, replay, `${kind}_code`),
        201,
      )
    }
    const rawCode = typeof body.code === 'string' && body.code.trim() !== ''
      ? body.code
      : generatedCode(kind)
    const code = normalizeCommercialCode(rawCode, kind)
    const id = crypto.randomUUID()
    const now = Date.now()
    const keyVersion = 1
    const secret = await encryptCode(context.env, kind, id, keyVersion, code)
    const maxUses = optionalSafeInteger(body, 'max_uses', kind === 'promotion' ? 0 : 1, 1_000_000) ??
      (kind === 'promotion' ? 0 : 1)
    if (kind === 'invitation' && maxUses < 1) {
      throw new GatewayError(400, 'invalid_max_uses', 'Invitation max_uses must be positive')
    }
    const bonusMicros = kind === 'promotion'
      ? amountInputMicros(body, 'bonus_amount', 'bonus_micros', false)
      : 0
    const expiresAtMs = parseExpiry(body.expires_at)
    const notes = optionalString(body, 'notes', 1000) ?? ''
    const table = codeTable(kind)
    const columns = kind === 'promotion' ? ', bonus_micros' : ''
    const values = kind === 'promotion' ? ', ?' : ''
    const codeHash = await commercialCodeDigest(kind, code, requirePepper(context.env))
    const response = await publicCode(context.env, kind, {
      id,
      code_hash: codeHash,
      code_prefix: code.slice(0, 8),
      secret_key_version: keyVersion,
      secret_nonce_b64: secret.nonce_b64,
      secret_ciphertext_b64: secret.ciphertext_b64,
      ...(kind === 'promotion' ? { bonus_micros: bonusMicros } : {}),
      max_uses: maxUses,
      used_count: 0,
      status: 'active',
      expires_at_ms: expiresAtMs,
      notes,
      control_version: 0,
      created_at_ms: now,
      updated_at_ms: now,
    })
    const sealedResponse = await sealIdempotentResponse(context.env, idempotency, response)
    try {
      await context.env.DB.batch([
        controlIdempotencyInsert(
          context.env, idempotency, `${kind}_code`, id, sealedResponse, now,
        ),
        context.env.DB.prepare(
          `INSERT INTO ${table} (
             id, code_hash, code_prefix, secret_key_version, secret_nonce_b64,
             secret_ciphertext_b64${columns}, max_uses, expires_at_ms, notes,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?${values}, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          codeHash,
          code.slice(0, 8),
          keyVersion,
          secret.nonce_b64,
          secret.ciphertext_b64,
          ...(kind === 'promotion' ? [bonusMicros] : []),
          maxUses,
          expiresAtMs,
          notes,
          now,
          now,
        ),
        auditStatement(context.env, actor, `${kind}_code.create`, `${kind}_code`, id, 0,
          ['code', ...(kind === 'promotion' ? ['bonus_amount'] : []), 'max_uses', 'expires_at', 'notes'], now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return codeResponse(
          await parseSealedIdempotentResponse(context.env, recovered, `${kind}_code`),
          201,
        )
      }
      if (/UNIQUE constraint failed: .*code_hash/i.test(errorMessage(error))) {
        throw new GatewayError(409, `${kind}_code_taken`, `${title(kind)} code already exists`)
      }
      throw error
    }
    return codeResponse(response, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function updateCode(context: Context<ControlBindings>, kind: CodeKind): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const id = requireResourceId(context.req.param('id'), `${kind}_code`)
    const body = await readJsonObject(context.req.raw, 16_384)
    const patch = parsePatch(body, kind)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const idempotency = await controlIdempotency(
      `commercial.${kind}-code.update.v1`,
      requireIdempotencyKey(context.req.raw),
      { id, expected_control_version: expected, ...patch },
    )
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) {
      return codeResponse(
        await parseSealedIdempotentResponse(context.env, replay, `${kind}_code`),
      )
    }
    const current = await findCode(context.env, kind, id)
    if (current === null) throw notFound(kind)
    if (current.control_version !== expected) throw versionConflict()
    const legacyMirror = kind === 'invitation'
      ? await context.env.DB.prepare(
        `SELECT rc.status, secret.secret_key_version
           FROM redeem_codes rc
           LEFT JOIN redeem_code_secrets secret ON secret.redeem_code_id = rc.id
          WHERE rc.id = ? AND rc.type = 'invitation'`,
      ).bind(id).first<LegacyRedeemInvitationMirror>()
      : null
    if (patch.maxUses !== undefined && patch.maxUses > 0 && patch.maxUses < current.used_count) {
      throw new GatewayError(409, 'max_uses_below_usage', 'max_uses cannot be less than used_count')
    }
    const code = patch.code ?? await decryptCode(context.env, kind, current)
    const nextKeyVersion = patch.code === undefined
      ? current.secret_key_version
      : current.secret_key_version + 1
    const secret = patch.code === undefined
      ? { nonce_b64: current.secret_nonce_b64, ciphertext_b64: current.secret_ciphertext_b64 }
      : await encryptCode(context.env, kind, id, nextKeyVersion, code)
    const nextBonus = kind === 'promotion'
      ? patch.bonusMicros ?? requireStoredBonus(current)
      : undefined
    const nextMax = patch.maxUses ?? current.max_uses
    if (kind === 'invitation' && nextMax < 1) {
      throw new GatewayError(400, 'invalid_max_uses', 'Invitation max_uses must be positive')
    }
    if (legacyMirror !== null && nextMax !== 1) {
      throw new GatewayError(
        409,
        'legacy_invitation_single_use_required',
        'Redeem invitation codes must remain single-use',
      )
    }
    const nextStatus = patch.status ?? current.status
    const nextExpiry = patch.expiresAtMs === undefined ? current.expires_at_ms : patch.expiresAtMs
    const nextNotes = patch.notes ?? current.notes
    const now = Date.now()
    const table = codeTable(kind)
    const bonusSet = kind === 'promotion' ? ', bonus_micros = ?' : ''
    const nextCodeHash = await commercialCodeDigest(kind, code, requirePepper(context.env))
    const response = await publicCode(context.env, kind, {
      ...current,
      code_hash: nextCodeHash,
      code_prefix: code.slice(0, 8),
      secret_key_version: nextKeyVersion,
      secret_nonce_b64: secret.nonce_b64,
      secret_ciphertext_b64: secret.ciphertext_b64,
      ...(kind === 'promotion' ? { bonus_micros: nextBonus } : {}),
      max_uses: nextMax,
      status: nextStatus,
      expires_at_ms: nextExpiry,
      notes: nextNotes,
      control_version: expected + 1,
      updated_at_ms: now,
    })
    const sealedResponse = await sealIdempotentResponse(context.env, idempotency, response)
    const statements: D1PreparedStatement[] = [
      guardedIdempotencyInsert(
        context.env,
        idempotency,
        `${kind}_code`,
        id,
        sealedResponse,
        now,
        `EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND control_version = ?)`,
        [id, expected],
      ),
      context.env.DB.prepare(
        `UPDATE ${table}
            SET code_hash = ?, code_prefix = ?, secret_key_version = ?,
                secret_nonce_b64 = ?, secret_ciphertext_b64 = ?${bonusSet},
                max_uses = ?, status = ?, expires_at_ms = ?, notes = ?,
                control_version = control_version + 1, updated_at_ms = ?
          WHERE id = ? AND control_version = ?`,
      ).bind(
        nextCodeHash,
        code.slice(0, 8), nextKeyVersion, secret.nonce_b64, secret.ciphertext_b64,
        ...(kind === 'promotion' ? [nextBonus] : []),
        nextMax, nextStatus, nextExpiry, nextNotes, now, id, expected,
      ),
    ]
    if (legacyMirror !== null) {
      const redeemHash = await redeemCodeDigest(code, requirePepper(context.env))
      statements.push(context.env.DB.prepare(
        `UPDATE redeem_codes
            SET code_hash = ?, code_prefix = ?,
                status = CASE WHEN status IN ('used', 'processing') THEN status ELSE ? END,
                expires_at_ms = ?, notes = ?, control_version = control_version + 1,
                updated_at_ms = ?
          WHERE id = ? AND type = 'invitation'`,
      ).bind(
        redeemHash,
        code.slice(0, 8),
        nextStatus === 'disabled' ? 'disabled' : 'unused',
        nextExpiry,
        nextNotes,
        now,
        id,
      ))
      if (patch.code !== undefined) {
        if (legacyMirror.secret_key_version === null) {
          throw new GatewayError(
            409,
            'redeem_code_plaintext_unavailable',
            'The mirrored redeem code has no secure plaintext storage',
          )
        }
        const redeemSecretVersion = legacyMirror.secret_key_version + 1
        const redeemSecret = await encryptCredential(
          { api_key: code },
          requireMasterKey(context.env),
          `redeem-code:v1:${id}:${redeemSecretVersion}`,
        )
        statements.push(context.env.DB.prepare(
          `UPDATE redeem_code_secrets
              SET secret_key_version = ?, secret_nonce_b64 = ?, secret_ciphertext_b64 = ?,
                  updated_at_ms = ?
            WHERE redeem_code_id = ?`,
        ).bind(
          redeemSecretVersion,
          redeemSecret.nonce_b64,
          redeemSecret.ciphertext_b64,
          now,
          id,
        ))
      }
    }
    statements.push(auditStatement(context.env, actor, `${kind}_code.update`, `${kind}_code`, id,
      expected + 1, Object.keys(patch), now))
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return codeResponse(
          await parseSealedIdempotentResponse(context.env, recovered, `${kind}_code`),
        )
      }
      if (/UNIQUE constraint failed: .*code_hash/i.test(errorMessage(error))) {
        throw new GatewayError(409, `${kind}_code_taken`, `${title(kind)} code already exists`)
      }
      const latest = await findCode(context.env, kind, id)
      if (latest === null || latest.control_version !== expected) throw versionConflict()
      throw error
    }
    const row = await findCode(context.env, kind, id)
    if (row === null) throw notFound(kind)
    if (row.control_version !== expected + 1) throw versionConflict()
    return codeResponse(await publicCode(context.env, kind, row))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function deleteCode(context: Context<ControlBindings>, kind: CodeKind): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const id = requireResourceId(context.req.param('id'), `${kind}_code`)
    const body = await readOptionalJsonObject(context.req.raw, 4_096)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const idempotency = await controlIdempotency(
      `commercial.${kind}-code.delete.v1`,
      requireIdempotencyKey(context.req.raw),
      { id, expected_control_version: expected },
    )
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) {
      return controlSuccess(
        await parseSealedIdempotentResponse(context.env, replay, `${kind}_code_delete`),
      )
    }
    const row = await findCode(context.env, kind, id)
    if (row === null) throw notFound(kind)
    if (row.control_version !== expected) throw versionConflict()
    const usageTable = kind === 'promotion' ? 'promotion_code_usages' : 'invitation_code_usages'
    const foreignKey = kind === 'promotion' ? 'promotion_code_id' : 'invitation_code_id'
    const usage = await context.env.DB.prepare(
      `SELECT 1 AS present FROM ${usageTable} WHERE ${foreignKey} = ? LIMIT 1`,
    ).bind(id).first<{ present: number }>()
    if (row.used_count > 0 || usage !== null) {
      throw new GatewayError(409, `${kind}_code_used`, `${title(kind)} code with usage history cannot be deleted`)
    }
    const now = Date.now()
    const response = {
      message: kind === 'promotion'
        ? 'Promo code deleted successfully'
        : 'Invitation code deleted successfully',
    }
    const sealedResponse = await sealIdempotentResponse(context.env, idempotency, response)
    const statements = [
      guardedIdempotencyInsert(
        context.env,
        idempotency,
        `${kind}_code_delete`,
        id,
        sealedResponse,
        now,
        `EXISTS (
          SELECT 1 FROM ${codeTable(kind)}
           WHERE id = ? AND control_version = ? AND used_count = 0
        )`,
        [id, expected],
      ),
      auditStatement(context.env, actor, `${kind}_code.delete`, `${kind}_code`, id,
        expected, ['deleted'], now),
      ...(kind === 'invitation'
        ? [context.env.DB.prepare(
          `DELETE FROM redeem_codes WHERE id = ? AND type = 'invitation'`,
        ).bind(id)]
        : []),
      context.env.DB.prepare(
        `DELETE FROM ${codeTable(kind)} WHERE id = ? AND control_version = ? AND used_count = 0`,
      ).bind(id, expected),
    ]
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return controlSuccess(
          await parseSealedIdempotentResponse(context.env, recovered, `${kind}_code_delete`),
        )
      }
      const latest = await findCode(context.env, kind, id)
      if (latest === null || latest.control_version !== expected) throw versionConflict()
      throw error
    }
    if (await findCode(context.env, kind, id) !== null) throw versionConflict()
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function listUsages(context: Context<ControlBindings>, kind: CodeKind): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const id = requireResourceId(context.req.param('id'), `${kind}_code`)
    if (await findCode(context.env, kind, id) === null) throw notFound(kind)
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const usageTable = kind === 'promotion' ? 'promotion_code_usages' : 'invitation_code_usages'
    const foreignKey = kind === 'promotion' ? 'promotion_code_id' : 'invitation_code_id'
    const bonusColumn = kind === 'promotion' ? 'usage.bonus_micros,' : ''
    const count = await context.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM ${usageTable} WHERE ${foreignKey} = ?`,
    ).bind(id).first<{ total: number }>()
    const rows = await context.env.DB.prepare(
      `SELECT usage.id, usage.${foreignKey} AS code_id, usage.user_id,
              ${bonusColumn} usage.used_at_ms, user.email, user.display_name
         FROM ${usageTable} usage
         JOIN users user ON user.id = usage.user_id
        WHERE usage.${foreignKey} = ?
        ORDER BY usage.used_at_ms DESC, usage.id DESC LIMIT ? OFFSET ?`,
    ).bind(id, pageSize, (page - 1) * pageSize).all<Record<string, unknown>>()
    const items = rows.results.map((row) => ({
      id: row.id,
      ...(kind === 'promotion' ? { promo_code_id: row.code_id } : { invitation_code_id: row.code_id }),
      user_id: row.user_id,
      ...(kind === 'promotion'
        ? { bonus_amount: microsToUsd(row.bonus_micros as number), bonus_micros: row.bonus_micros }
        : {}),
      used_at: iso(row.used_at_ms as number),
      user: { id: row.user_id, email: row.email, username: row.display_name },
    }))
    const total = count?.total ?? 0
    return controlSuccess({ items, total, page, page_size: pageSize, pages: Math.ceil(total / pageSize) })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function findCode(env: Env, kind: CodeKind, id: string): Promise<StoredCodeRow | null> {
  return env.DB.prepare(`${codeSelect(kind)} WHERE id = ? LIMIT 1`).bind(id).first<StoredCodeRow>()
}

function codeSelect(kind: CodeKind): string {
  return `SELECT id, code_hash, code_prefix, secret_key_version, secret_nonce_b64,
                 secret_ciphertext_b64, ${kind === 'promotion' ? 'bonus_micros,' : ''}
                 max_uses, used_count, status, expires_at_ms, notes,
                 control_version, created_at_ms, updated_at_ms
            FROM ${codeTable(kind)}`
}

function codeTable(kind: CodeKind): string {
  return kind === 'promotion' ? 'promotion_codes' : 'invitation_codes'
}

async function publicCode(env: Env, kind: CodeKind, row: StoredCodeRow): Promise<Record<string, unknown>> {
  return {
    id: row.id,
    code: await decryptCode(env, kind, row),
    ...(kind === 'promotion'
      ? { bonus_amount: microsToUsd(requireStoredBonus(row)), bonus_micros: requireStoredBonus(row) }
      : {}),
    max_uses: row.max_uses,
    used_count: row.used_count,
    status: row.status,
    expires_at: row.expires_at_ms === null ? null : iso(row.expires_at_ms),
    notes: row.notes || null,
    control_version: row.control_version,
    created_at: iso(row.created_at_ms),
    updated_at: iso(row.updated_at_ms),
  }
}

async function decryptCode(env: Env, kind: CodeKind, row: StoredCodeRow): Promise<string> {
  const master = requireMasterKey(env)
  const credential = await decryptCredential(
    row.secret_nonce_b64,
    row.secret_ciphertext_b64,
    master,
    codeAad(kind, row.id, row.secret_key_version),
  )
  return normalizeCommercialCode(credential.api_key, kind)
}

async function encryptCode(
  env: Env,
  kind: CodeKind,
  id: string,
  keyVersion: number,
  code: string,
): Promise<{ nonce_b64: string; ciphertext_b64: string }> {
  return encryptCredential({ api_key: code }, requireMasterKey(env), codeAad(kind, id, keyVersion))
}

function codeAad(kind: CodeKind, id: string, keyVersion: number): string {
  return `${kind}-code:v1:${id}:${keyVersion}`
}

function parsePatch(body: Record<string, unknown>, kind: CodeKind): CodePatch {
  const patch: CodePatch = {}
  if (body.code !== undefined) {
    if (typeof body.code !== 'string') throw new GatewayError(400, 'invalid_code', 'code must be a string')
    patch.code = normalizeCommercialCode(body.code, kind)
  }
  if (kind === 'promotion' && (body.bonus_amount !== undefined || body.bonus_micros !== undefined)) {
    patch.bonusMicros = amountInputMicros(body, 'bonus_amount', 'bonus_micros', false)
  }
  if (body.max_uses !== undefined) patch.maxUses = optionalSafeInteger(body, 'max_uses', 0, 1_000_000)
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'disabled') {
      throw new GatewayError(400, 'invalid_status', 'status must be active or disabled')
    }
    patch.status = body.status
  }
  if (body.expires_at !== undefined) patch.expiresAtMs = parseExpiry(body.expires_at)
  if (body.notes !== undefined) {
    if (body.notes === null || body.notes === '') patch.notes = ''
    else patch.notes = optionalString(body, 'notes', 1000)
  }
  return patch
}

function amountInputMicros(
  body: Record<string, unknown>,
  decimalField: string,
  microsField: string,
  allowZero: boolean,
): number {
  if (body[microsField] !== undefined) {
    const value = optionalSafeInteger(body, microsField, allowZero ? 0 : 1)
    if (value === undefined) throw new GatewayError(400, `invalid_${microsField}`, `${microsField} is required`)
    return value
  }
  const value = amountToMicros(body[decimalField], decimalField, allowZero)
  if (value === undefined) throw new GatewayError(400, `invalid_${decimalField}`, `${decimalField} is required`)
  return value
}

function amountToMicros(value: unknown, field: string, allowZero: boolean): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (allowZero ? 0 : 0.000001)) {
    throw new GatewayError(400, `invalid_${field}`, `${field} is invalid`)
  }
  const micros = Math.round(value * 1_000_000)
  if (!Number.isSafeInteger(micros) || micros < (allowZero ? 0 : 1)) {
    throw new GatewayError(400, `invalid_${field}`, `${field} is outside the supported range`)
  }
  return micros
}

function parseExpiry(value: unknown): number | null {
  if (value === undefined || value === null || value === 0) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GatewayError(400, 'invalid_expires_at', 'expires_at must be a Unix timestamp')
  }
  const numeric = value as number
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric
  if (!Number.isSafeInteger(milliseconds)) {
    throw new GatewayError(400, 'invalid_expires_at', 'expires_at is outside the supported range')
  }
  return milliseconds
}

function optionalFiniteNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new GatewayError(400, `invalid_${field}`, `${field} must be boolean`)
  return value
}

function auditStatement(
  env: Env,
  actor: AdminActor,
  action: string,
  resourceType: string,
  resourceId: string,
  resourceVersion: number,
  changedFields: string[],
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO commercial_admin_audit_events (
       id, actor_user_id, actor_session_id, action, resource_type, resource_id,
       resource_version, changed_fields_json, occurred_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), actor.user_id, actor.session_id, action, resourceType,
    resourceId, resourceVersion, JSON.stringify(changedFields), now,
  )
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

async function sealIdempotentResponse(
  env: Env,
  value: ControlIdempotency,
  response: unknown,
): Promise<Record<string, unknown>> {
  const encrypted = await encryptCredential(
    { api_key: JSON.stringify(response) },
    requireMasterKey(env),
    idempotencyResponseAad(value.scope, value.key_hash),
  )
  return {
    schema_version: 1,
    nonce_b64: encrypted.nonce_b64,
    ciphertext_b64: encrypted.ciphertext_b64,
  }
}

async function parseSealedIdempotentResponse(
  env: Env,
  row: ControlIdempotencyRow,
  resourceType: string,
): Promise<Record<string, unknown>> {
  const envelope = parseIdempotentResponse<{
    schema_version?: unknown
    nonce_b64?: unknown
    ciphertext_b64?: unknown
  }>(row, resourceType)
  if (
    envelope.schema_version !== 1 ||
    typeof envelope.nonce_b64 !== 'string' ||
    typeof envelope.ciphertext_b64 !== 'string'
  ) throw unavailable()
  const credential = await decryptCredential(
    envelope.nonce_b64,
    envelope.ciphertext_b64,
    requireMasterKey(env),
    idempotencyResponseAad(row.scope, row.key_hash),
  )
  try {
    const value: unknown = JSON.parse(credential.api_key)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    return value as Record<string, unknown>
  } catch {
    throw unavailable()
  }
}

function idempotencyResponseAad(scope: string, keyHash: string): string {
  return `commercial-code-idempotency:v1:${scope}:${keyHash}`
}

function publicCommercialConfig(row: Record<string, number>): Record<string, unknown> {
  return {
    control_version: row.control_version,
    affiliate_rebate_rate: row.affiliate_rebate_rate_ppm / 10_000,
    affiliate_rebate_rate_ppm: row.affiliate_rebate_rate_ppm,
    affiliate_rebate_freeze_hours: row.affiliate_rebate_freeze_hours,
    affiliate_rebate_duration_days: row.affiliate_rebate_duration_days,
    affiliate_rebate_per_invitee_cap: row.affiliate_rebate_per_invitee_cap_micros / 1_000_000,
    affiliate_rebate_per_invitee_cap_micros: row.affiliate_rebate_per_invitee_cap_micros,
    affiliate_admin_recharge_enabled: row.affiliate_admin_recharge_enabled === 1,
    updated_at_ms: row.updated_at_ms,
  }
}

function commercialConfigResponse(config: Record<string, unknown>): Response {
  if (!Number.isSafeInteger(config.control_version) || (config.control_version as number) < 0) {
    throw unavailable()
  }
  const response = controlSuccess(config)
  response.headers.set('etag', `"${config.control_version}"`)
  return response
}

function codeResponse(code: Record<string, unknown>, status = 200): Response {
  if (!Number.isSafeInteger(code.control_version) || (code.control_version as number) < 0) {
    throw unavailable()
  }
  const response = controlSuccess(code, status)
  response.headers.set('etag', `"${code.control_version}"`)
  return response
}

function generatedCode(kind: CodeKind): string {
  const token = randomToken(kind === 'promotion' ? 12 : 9)
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
  return `${kind === 'promotion' ? 'PROMO' : 'INV'}-${token}`
}

function requireStoredBonus(row: StoredCodeRow): number {
  if (!Number.isSafeInteger(row.bonus_micros) || (row.bonus_micros as number) <= 0) throw unavailable()
  return row.bonus_micros as number
}

function requirePepper(env: Env): string {
  if (!env.API_KEY_PEPPER || new TextEncoder().encode(env.API_KEY_PEPPER).byteLength < 32) {
    throw new GatewayError(503, 'commercial_not_configured', 'Commercial code hashing is not configured', 'server_error')
  }
  return env.API_KEY_PEPPER
}

function requireMasterKey(env: Env): string {
  if (!env.CREDENTIALS_MASTER_KEY || new TextEncoder().encode(env.CREDENTIALS_MASTER_KEY).byteLength < 32) {
    throw new GatewayError(503, 'commercial_not_configured', 'Commercial code encryption is not configured', 'server_error')
  }
  return env.CREDENTIALS_MASTER_KEY
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function iso(value: number): string {
  return new Date(value).toISOString()
}

function microsToUsd(value: number): number {
  return value / 1_000_000
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function title(kind: CodeKind): string {
  return kind === 'promotion' ? 'Promo' : 'Invitation'
}

function notFound(kind: CodeKind): GatewayError {
  return new GatewayError(404, `${kind}_code_not_found`, `${title(kind)} code was not found`)
}

function versionConflict(): GatewayError {
  return new GatewayError(412, 'control_version_conflict', 'Resource changed concurrently')
}

function unavailable(): GatewayError {
  return new GatewayError(503, 'commercial_unavailable', 'Commercial data is unavailable', 'server_error')
}
