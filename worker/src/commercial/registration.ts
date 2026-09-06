import type { Context } from 'hono'

import { controlError, controlSuccess, readJsonObject } from '../control/http'
import type { Env } from '../env'
import { apiKeyDigest, encryptCredential } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'

type CommercialBindings = { Bindings: Env }

type CommercialCodeKind = 'promotion' | 'invitation' | 'affiliate'

interface PublicCommercialSettings {
  promo_code_enabled?: boolean
  invitation_code_enabled?: boolean
  affiliate_enabled?: boolean
}

interface PromotionRow {
  id: string
  status: 'active' | 'disabled'
  bonus_micros: number
  max_uses: number
  used_count: number
  expires_at_ms: number | null
}

interface InvitationRow {
  id: string
  status: 'active' | 'disabled'
  max_uses: number
  used_count: number
  expires_at_ms: number | null
}

interface AffiliateRow {
  user_id: string
  code_prefix: string
}

interface PreparedAffiliateProfile {
  codeHash: string
  codePrefix: string
  nonceB64: string
  ciphertextB64: string
}

export interface PreparedCommercialRegistration {
  active: boolean
  bonusMicros: number
  claimStatement?: D1PreparedStatement
  afterUserStatements: D1PreparedStatement[]
}

export async function commercialCodeDigest(
  kind: CommercialCodeKind,
  code: string,
  pepper: string,
): Promise<string> {
  return apiKeyDigest(`sub2api/${kind}-code/v1\0${normalizeCommercialCode(code, kind)}`, pepper)
}

export function normalizeCommercialCode(value: string, kind: CommercialCodeKind): string {
  const code = value.trim().toUpperCase()
  const maximum = kind === 'affiliate' ? 32 : 64
  if (code.length < 4 || code.length > maximum || !/^[A-Z0-9_-]+$/.test(code)) {
    throw new GatewayError(
      400,
      kind === 'promotion'
        ? 'PROMO_CODE_INVALID'
        : kind === 'invitation'
          ? 'INVITATION_CODE_INVALID'
          : 'AFFILIATE_CODE_INVALID',
      `Invalid ${kind} code`,
    )
  }
  return code
}

/** Public legacy-compatible validation response. Invalid codes are data, not HTTP failures. */
export async function validatePromotionCode(context: Context<CommercialBindings>): Promise<Response> {
  try {
    const settings = await publicCommercialSettings(context.env)
    if (settings.promo_code_enabled !== true) {
      return controlSuccess({ valid: false, error_code: 'PROMO_CODE_DISABLED' })
    }
    const body = await readJsonObject(context.req.raw, 2_048)
    const code = optionalCode(body.code, 'promotion')
    if (code === null) return controlSuccess({ valid: false, error_code: 'PROMO_CODE_INVALID' })
    const row = await findPromotion(context.env, code)
    const errorCode = promotionAvailabilityError(row, Date.now())
    if (errorCode !== null) return controlSuccess({ valid: false, error_code: errorCode })
    return controlSuccess({
      valid: true,
      bonus_amount: microsToUsd(row!.bonus_micros),
      bonus_micros: row!.bonus_micros,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** Public legacy-compatible invitation validation response. */
export async function validateInvitationCode(context: Context<CommercialBindings>): Promise<Response> {
  try {
    const settings = await publicCommercialSettings(context.env)
    if (settings.invitation_code_enabled !== true) {
      return controlSuccess({ valid: false, error_code: 'INVITATION_CODE_DISABLED' })
    }
    const body = await readJsonObject(context.req.raw, 2_048)
    const code = optionalCode(body.code, 'invitation')
    if (code === null) return controlSuccess({ valid: false, error_code: 'INVITATION_CODE_INVALID' })
    const row = await findInvitation(context.env, code)
    const errorCode = invitationAvailabilityError(row, Date.now())
    return controlSuccess(errorCode === null
      ? { valid: true }
      : { valid: false, error_code: errorCode })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/**
 * Resolves optional commercial inputs before password work and prepares writes
 * that must be appended to the same D1 batch as the user INSERT.
 */
export async function prepareCommercialRegistration(
  env: Env,
  body: Record<string, unknown>,
  userId: string,
  now: number,
): Promise<PreparedCommercialRegistration> {
  const settings = await publicCommercialSettings(env)
  const hasCommercialProjection = [
    settings.promo_code_enabled,
    settings.invitation_code_enabled,
    settings.affiliate_enabled,
  ].some((value) => typeof value === 'boolean')
  if (!hasCommercialProjection) {
    // Compatibility for databases/tests predating migration 0032.
    return { active: false, bonusMicros: 0, afterUserStatements: [] }
  }

  const pepper = requirePepper(env)
  let promotion: PromotionRow | null = null
  const promotionCode = rawOptionalCode(body.promo_code)
  if (settings.promo_code_enabled === true && promotionCode !== null) {
    const normalized = normalizeCommercialCode(promotionCode, 'promotion')
    promotion = await findPromotion(env, normalized, pepper)
    const availability = promotionAvailabilityError(promotion, now)
    if (availability !== null) throw registrationCodeError(availability)
  }

  let invitation: InvitationRow | null = null
  const invitationCode = rawOptionalCode(body.invitation_code)
  if (settings.invitation_code_enabled === true) {
    if (invitationCode === null) {
      throw new GatewayError(400, 'INVITATION_CODE_REQUIRED', 'Invitation code is required')
    }
    const normalized = normalizeCommercialCode(invitationCode, 'invitation')
    invitation = await findInvitation(env, normalized, pepper)
    const availability = invitationAvailabilityError(invitation, now)
    if (availability !== null) throw registrationCodeError(availability)
  }

  let inviter: AffiliateRow | null = null
  const affiliateCode = rawOptionalCode(body.aff_code)
  if (settings.affiliate_enabled === true && affiliateCode !== null) {
    const normalized = normalizeCommercialCode(affiliateCode, 'affiliate')
    inviter = await findAffiliate(env, normalized, pepper)
    if (inviter === null || inviter.user_id === userId) {
      throw new GatewayError(400, 'AFFILIATE_CODE_INVALID', 'Invalid affiliate code')
    }
  }

  const profile = settings.affiliate_enabled === true
    ? await prepareAffiliateProfile(env, userId, pepper)
    : null
  const bonusMicros = promotion?.bonus_micros ?? 0
  const claim = env.DB.prepare(
    `INSERT INTO commercial_registration_claims (
       user_id, promotion_code_id, promotion_bonus_micros,
       invitation_code_id, inviter_user_id, affiliate_code_prefix, claimed_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    userId,
    promotion?.id ?? null,
    bonusMicros,
    invitation?.id ?? null,
    inviter?.user_id ?? null,
    inviter?.code_prefix ?? null,
    now,
  )
  const afterUserStatements: D1PreparedStatement[] = []
  if (promotion !== null) {
    afterUserStatements.push(env.DB.prepare(
      `INSERT INTO promotion_code_usages (
         id, promotion_code_id, user_id, bonus_micros, used_at_ms
       ) SELECT ?, promotion_code_id, user_id, promotion_bonus_micros, claimed_at_ms
           FROM commercial_registration_claims
          WHERE user_id = ? AND promotion_code_id = ?`,
    ).bind(crypto.randomUUID(), userId, promotion.id))
  }
  if (invitation !== null) {
    afterUserStatements.push(env.DB.prepare(
      `INSERT INTO invitation_code_usages (id, invitation_code_id, user_id, used_at_ms)
       SELECT ?, invitation_code_id, user_id, claimed_at_ms
         FROM commercial_registration_claims
        WHERE user_id = ? AND invitation_code_id = ?`,
    ).bind(crypto.randomUUID(), userId, invitation.id))
  }
  if (profile !== null) {
    afterUserStatements.push(env.DB.prepare(
      `INSERT INTO affiliate_profiles (
         user_id, code_hash, code_prefix, code_custom, code_key_version,
         code_nonce_b64, code_ciphertext_b64, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?)`,
    ).bind(
      userId,
      profile.codeHash,
      profile.codePrefix,
      profile.nonceB64,
      profile.ciphertextB64,
      now,
      now,
    ))
  }
  if (inviter !== null) {
    afterUserStatements.push(env.DB.prepare(
      `INSERT INTO affiliate_referrals (
         invitee_user_id, inviter_user_id, affiliate_code_prefix, attributed_at_ms
       ) SELECT user_id, inviter_user_id, affiliate_code_prefix, claimed_at_ms
           FROM commercial_registration_claims
          WHERE user_id = ? AND inviter_user_id = ?`,
    ).bind(userId, inviter.user_id))
  }
  return { active: true, bonusMicros, claimStatement: claim, afterUserStatements }
}

export function commercialRegistrationInsertSql(active: boolean): string {
  const columns = `(id, email, display_name, role, status, balance_micros,
    state_version, created_at_ms, updated_at_ms, password_credential,
    auth_version, password_changed_at_ms, last_login_at_ms, email_verified_at_ms,
    financial_history_complete)`
  if (!active) {
    return `INSERT INTO users ${columns}
      VALUES (?, ?, ?, 'user', 'active', 0, 0, ?, ?, ?, 1, ?, ?, ?, 1)`
  }
  return `INSERT INTO users ${columns}
    SELECT ?, ?, ?, 'user', 'active', ?, 0, ?, ?, ?, 1, ?, ?, ?, 1
      FROM commercial_registration_claims WHERE user_id = ?`
}

export function mapCommercialRegistrationWriteError(error: unknown): GatewayError | null {
  const message = error instanceof Error ? error.message : String(error)
  if (/promotion_code_unavailable/i.test(message)) {
    return new GatewayError(409, 'PROMO_CODE_MAX_USED', 'Promo code is no longer available')
  }
  if (/invitation_code_unavailable/i.test(message)) {
    return new GatewayError(409, 'INVITATION_CODE_INVALID', 'Invitation code is no longer available')
  }
  if (/affiliate_(?:inviter_missing|attribution_immutable)/i.test(message)) {
    return new GatewayError(409, 'AFFILIATE_CODE_INVALID', 'Affiliate attribution is no longer available')
  }
  return null
}

async function publicCommercialSettings(env: Env): Promise<PublicCommercialSettings> {
  try {
    const row = await env.DB.prepare(
      `SELECT public_json FROM system_settings WHERE id = 'global' LIMIT 1`,
    ).first<{ public_json: string }>()
    if (row === null) return {}
    const parsed: unknown = JSON.parse(row.public_json)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new GatewayError(503, 'settings_unavailable', 'Commercial settings are invalid', 'server_error')
    }
    const authoritative = parsed as PublicCommercialSettings
    const keys = ['promo_code_enabled', 'invitation_code_enabled', 'affiliate_enabled'] as const
    for (const key of keys) {
      if (authoritative[key] !== undefined && typeof authoritative[key] !== 'boolean') {
        throw new GatewayError(503, 'settings_unavailable', 'Commercial settings are invalid', 'server_error')
      }
    }
    if (keys.some((key) => typeof authoritative[key] === 'boolean')) return authoritative

    // Compatibility for pre-0032 fixtures and a rolling deployment where the
    // D1 row has not yet been rewritten with the newly allow-listed fields.
    if (typeof env.CONFIG_KV.get !== 'function') return {}
    const value = await env.CONFIG_KV.get<PublicCommercialSettings>(
      `${env.ENVIRONMENT}:public-settings:v1`,
      'json',
    )
    if (value === null || typeof value !== 'object') return {}
    for (const key of ['promo_code_enabled', 'invitation_code_enabled', 'affiliate_enabled'] as const) {
      if (value[key] !== undefined && typeof value[key] !== 'boolean') {
        throw new GatewayError(503, 'settings_unavailable', 'Commercial settings are invalid', 'server_error')
      }
    }
    return value
  } catch (error) {
    if (error instanceof GatewayError) throw error
    throw new GatewayError(503, 'settings_unavailable', 'Commercial settings are unavailable', 'server_error')
  }
}

function optionalCode(value: unknown, kind: CommercialCodeKind): string | null {
  if (typeof value !== 'string') return null
  try { return normalizeCommercialCode(value, kind) } catch { return null }
}

function rawOptionalCode(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return ''
  return value.trim() === '' ? null : value
}

async function findPromotion(env: Env, code: string, pepper = requirePepper(env)): Promise<PromotionRow | null> {
  return env.DB.prepare(
    `SELECT id, status, bonus_micros, max_uses, used_count, expires_at_ms
       FROM promotion_codes WHERE code_hash = ? LIMIT 1`,
  ).bind(await commercialCodeDigest('promotion', code, pepper)).first<PromotionRow>()
}

async function findInvitation(env: Env, code: string, pepper = requirePepper(env)): Promise<InvitationRow | null> {
  return env.DB.prepare(
    `SELECT id, status, max_uses, used_count, expires_at_ms
       FROM invitation_codes WHERE code_hash = ? LIMIT 1`,
  ).bind(await commercialCodeDigest('invitation', code, pepper)).first<InvitationRow>()
}

async function findAffiliate(env: Env, code: string, pepper: string): Promise<AffiliateRow | null> {
  return env.DB.prepare(
    `SELECT user_id, code_prefix FROM affiliate_profiles WHERE code_hash = ? LIMIT 1`,
  ).bind(await commercialCodeDigest('affiliate', code, pepper)).first<AffiliateRow>()
}

function promotionAvailabilityError(row: PromotionRow | null, now: number): string | null {
  if (row === null) return 'PROMO_CODE_NOT_FOUND'
  if (row.status !== 'active') return 'PROMO_CODE_DISABLED'
  if (row.expires_at_ms !== null && row.expires_at_ms <= now) return 'PROMO_CODE_EXPIRED'
  if (row.max_uses > 0 && row.used_count >= row.max_uses) return 'PROMO_CODE_MAX_USED'
  return null
}

function invitationAvailabilityError(row: InvitationRow | null, now: number): string | null {
  if (row === null) return 'INVITATION_CODE_NOT_FOUND'
  if (row.status !== 'active') return 'INVITATION_CODE_DISABLED'
  if (row.expires_at_ms !== null && row.expires_at_ms <= now) return 'INVITATION_CODE_EXPIRED'
  if (row.used_count >= row.max_uses) return 'INVITATION_CODE_USED'
  return null
}

function registrationCodeError(code: string): GatewayError {
  const status = code === 'PROMO_CODE_MAX_USED' || code === 'INVITATION_CODE_USED' ? 409 : 400
  return new GatewayError(status, code, code.startsWith('PROMO') ? 'Promo code is unavailable' : 'Invitation code is unavailable')
}

async function prepareAffiliateProfile(
  env: Env,
  userId: string,
  pepper: string,
): Promise<PreparedAffiliateProfile> {
  const masterKey = env.CREDENTIALS_MASTER_KEY
  if (!masterKey || new TextEncoder().encode(masterKey).byteLength < 32) {
    throw new GatewayError(503, 'affiliate_not_configured', 'Affiliate code encryption is not configured', 'server_error')
  }
  const seed = await apiKeyDigest(`sub2api/affiliate-profile/v1\0${userId}`, pepper)
  const code = `AFF${seed.slice(0, 13).toUpperCase()}`
  const encrypted = await encryptCredential(
    { api_key: code },
    masterKey,
    affiliateCodeAad(userId, 1),
  )
  return {
    codeHash: await commercialCodeDigest('affiliate', code, pepper),
    codePrefix: code.slice(0, 8),
    nonceB64: encrypted.nonce_b64,
    ciphertextB64: encrypted.ciphertext_b64,
  }
}

export function affiliateCodeAad(userId: string, keyVersion: number): string {
  return `affiliate-code:v1:${userId}:${keyVersion}`
}

function requirePepper(env: Env): string {
  if (!env.API_KEY_PEPPER || new TextEncoder().encode(env.API_KEY_PEPPER).byteLength < 32) {
    throw new GatewayError(503, 'commercial_not_configured', 'Commercial code hashing is not configured', 'server_error')
  }
  return env.API_KEY_PEPPER
}

function microsToUsd(value: number): number {
  return value / 1_000_000
}
