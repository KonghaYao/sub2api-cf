import type { Context } from 'hono'

import { authenticateUserRequest } from '../auth/handler'
import { authenticateAdminSession, type AdminActor } from '../control/admin-auth'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  queryInteger,
  readJsonObject,
  readOptionalJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
  requireString,
} from '../control/http'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
  type ControlIdempotency,
  type ControlIdempotencyRow,
} from '../control/idempotency'
import type { Env } from '../env'
import { apiKeyDigest, decryptCredential, encryptCredential, sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import {
  affiliateCodeAad,
  commercialCodeDigest,
  normalizeCommercialCode,
} from './registration'

type CommercialBindings = { Bindings: Env }
const MAX_PAYMENT_MICROS = 9_000_000_000_000
const CONTROL_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000

interface AffiliateProfileRow {
  user_id: string
  code_hash: string
  code_prefix: string
  code_custom: number
  code_key_version: number
  code_nonce_b64: string
  code_ciphertext_b64: string
  rebate_rate_ppm: number | null
  invited_count: number
  available_micros: number
  frozen_micros: number
  history_micros: number
  control_version: number
  created_at_ms: number
  updated_at_ms: number
}

interface CommercialConfigRow {
  affiliate_rebate_rate_ppm: number
  affiliate_rebate_freeze_hours: number
  affiliate_rebate_duration_days: number
  affiliate_rebate_per_invitee_cap_micros: number
  affiliate_admin_recharge_enabled: number
}

interface AffiliateRebateRow {
  id: string
  source_order_id: string
  out_trade_no: string
  inviter_user_id: string
  invitee_user_id: string
  order_amount_micros: number
  pay_amount_micros: number
  rebate_micros: number
  payment_type: string
  order_status: string
  status: 'frozen' | 'available' | 'void'
  eligible_at_ms: number
  created_at_ms: number
}

interface TransferRow {
  id: string
  user_id: string
  idempotency_key_hash: string
  request_hash: string
  status: 'processing' | 'completed'
  amount_micros: number
  balance_after_micros: number | null
  state_version: number | null
  created_at_ms: number
  completed_at_ms: number | null
}

interface UserBalanceRow {
  id: string
  balance_micros: number
  state_version: number
  status: 'active' | 'disabled'
}

export interface AffiliateRebateInput {
  source_order_id: string
  invitee_user_id: string
  order_amount_micros: number
  pay_amount_micros: number
  out_trade_no?: string
  payment_type?: string
  order_status?: string
  is_admin_recharge?: boolean
}

export interface AffiliateRebateResult {
  applied: boolean
  idempotent: boolean
  rebate_id: string | null
  rebate_micros: number
  rebate_amount: number
  status: 'frozen' | 'available' | 'void' | null
  eligible_at_ms: number | null
}

export interface AffiliateRefundAdjustmentResult {
  applied: boolean
  idempotent: boolean
  adjustment_id: string | null
  adjustment_micros: number
  quota_clawback_micros: number
  balance_clawback_micros: number
  status: 'processing' | 'completed' | null
}

interface AffiliateRefundAdjustmentRow {
  id: string
  rebate_id: string
  refund_id: string
  inviter_user_id: string
  adjustment_kind: 'partial_clawback' | 'full_void'
  adjustment_micros: number
  quota_clawback_micros: number
  balance_clawback_micros: number
  status: 'processing' | 'completed'
  balance_after_micros: number | null
  state_version: number | null
}

interface AffiliateRefundSourceRow {
  rebate_id: string
  inviter_user_id: string
  rebate_status: 'frozen' | 'available' | 'void'
  rebate_micros: number
  order_amount_micros: number
  refund_amount_micros: number
  cumulative_refunded_micros: number
  available_micros: number
  frozen_micros: number
  previously_adjusted_micros: number
}

interface AffiliatePaymentOrderRow {
  id: string
  user_id: string
  out_trade_no: string
  amount_micros: number
  pay_amount_micros: number
  paid_amount_micros: number
  provider_key_snapshot: string
  status: 'COMPLETED'
}

/** Creates a deterministic, encrypted referral code for a user if needed. */
export async function ensureAffiliateProfile(env: Env, userId: string): Promise<AffiliateProfileRow> {
  const current = await findProfile(env, userId)
  if (current !== null) return current
  const user = await env.DB.prepare(
    `SELECT id FROM users WHERE id = ? LIMIT 1`,
  ).bind(userId).first<{ id: string }>()
  if (user === null) throw new GatewayError(404, 'user_not_found', 'User was not found')
  const material = await systemAffiliateCode(env, userId, 1)
  const now = Date.now()
  try {
    await env.DB.prepare(
      `INSERT INTO affiliate_profiles (
         user_id, code_hash, code_prefix, code_custom, code_key_version,
         code_nonce_b64, code_ciphertext_b64, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?)`,
    ).bind(
      userId, material.hash, material.code.slice(0, 8),
      material.nonce, material.ciphertext, now, now,
    ).run()
  } catch (error) {
    const raced = await findProfile(env, userId)
    if (raced !== null) return raced
    throw error
  }
  const created = await findProfile(env, userId)
  if (created === null) throw commercialUnavailable()
  return created
}

export async function getUserAffiliate(context: Context<CommercialBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    await requireAffiliateEnabled(context.env)
    await ensureAffiliateProfile(context.env, user.id)
    await thawMaturedRebates(context.env, user.id, Date.now())
    const profile = await findProfile(context.env, user.id)
    if (profile === null) throw commercialUnavailable()
    const config = await commercialConfig(context.env)
    const referral = await context.env.DB.prepare(
      `SELECT inviter_user_id FROM affiliate_referrals WHERE invitee_user_id = ? LIMIT 1`,
    ).bind(user.id).first<{ inviter_user_id: string }>()
    const invitees = await context.env.DB.prepare(
      `SELECT user.id AS user_id, user.email, user.display_name,
              user.created_at_ms,
              COALESCE(SUM(CASE WHEN rebate.status <> 'void' THEN rebate.rebate_micros ELSE 0 END), 0)
                AS total_rebate_micros
         FROM affiliate_referrals referral
         JOIN users user ON user.id = referral.invitee_user_id
         LEFT JOIN affiliate_rebates rebate
           ON rebate.inviter_user_id = referral.inviter_user_id
          AND rebate.invitee_user_id = referral.invitee_user_id
        WHERE referral.inviter_user_id = ?
        GROUP BY user.id, user.email, user.display_name, user.created_at_ms, referral.attributed_at_ms
        ORDER BY referral.attributed_at_ms DESC, user.id DESC LIMIT 100`,
    ).bind(user.id).all<{
      user_id: string
      email: string
      display_name: string
      created_at_ms: number
      total_rebate_micros: number
    }>()
    const ratePpm = profile.rebate_rate_ppm ?? config.affiliate_rebate_rate_ppm
    return controlSuccess({
      user_id: user.id,
      aff_code: await decryptAffiliateCode(context.env, profile),
      inviter_id: referral?.inviter_user_id ?? null,
      aff_count: profile.invited_count,
      aff_quota: microsToUsd(profile.available_micros),
      aff_quota_micros: profile.available_micros,
      aff_frozen_quota: microsToUsd(profile.frozen_micros),
      aff_frozen_quota_micros: profile.frozen_micros,
      aff_history_quota: microsToUsd(profile.history_micros),
      aff_history_quota_micros: profile.history_micros,
      effective_rebate_rate_percent: ratePpm / 10_000,
      invitees: invitees.results.map((invitee) => ({
        user_id: invitee.user_id,
        email: maskEmail(invitee.email),
        username: invitee.display_name,
        created_at: iso(invitee.created_at_ms),
        total_rebate: microsToUsd(invitee.total_rebate_micros),
        total_rebate_micros: invitee.total_rebate_micros,
      })),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** Transfer-all is a recoverable D1 operation around an idempotent UserStateDO mutation. */
export async function transferUserAffiliateQuota(context: Context<CommercialBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    await requireAffiliateEnabled(context.env)
    await ensureAffiliateProfile(context.env, user.id)
    const now = Date.now()
    await thawMaturedRebates(context.env, user.id, now)
    const suppliedKey = context.req.header('idempotency-key')?.trim()
    if (suppliedKey !== undefined && (suppliedKey.length < 8 || suppliedKey.length > 200)) {
      throw new GatewayError(400, 'invalid_idempotency_key', 'Idempotency-Key must contain between 8 and 200 characters')
    }
    const operationKey = suppliedKey ?? crypto.randomUUID()
    const [idempotencyHash, requestHash] = await Promise.all([
      sha256Hex(`affiliate-transfer-key:v1\0${user.id}\0${operationKey}`),
      sha256Hex(`affiliate-transfer-request:v1\0${user.id}\0all`),
    ])
    let transfer = await findTransferByIdempotency(context.env, user.id, idempotencyHash)
    if (transfer !== null && transfer.request_hash !== requestHash) throw idempotencyConflict()
    if (transfer?.status === 'completed') return controlSuccess(publicTransfer(transfer))
    if (transfer === null) {
      // A response-lost operation owns the reserved quota. Resume it even when a
      // legacy frontend did not retain its generated idempotency key.
      transfer = await context.env.DB.prepare(
        `${transferSelect()} WHERE user_id = ? AND status = 'processing' LIMIT 1`,
      ).bind(user.id).first<TransferRow>()
    }
    if (transfer === null) {
      const profile = await findProfile(context.env, user.id)
      if (profile === null) throw commercialUnavailable()
      if (profile.available_micros <= 0) throw affiliateQuotaEmpty()
      const transferId = await deterministicUuid('affiliate.transfer.v1', `${user.id}\0${operationKey}`)
      try {
        await context.env.DB.prepare(
          `INSERT INTO affiliate_transfer_operations (
             id, user_id, idempotency_key_hash, request_hash, status,
             amount_micros, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`,
        ).bind(
          transferId, user.id, idempotencyHash, requestHash,
          profile.available_micros, now, now,
        ).run()
      } catch (error) {
        transfer = await findTransferByIdempotency(context.env, user.id, idempotencyHash) ??
          await context.env.DB.prepare(
            `${transferSelect()} WHERE user_id = ? AND status = 'processing' LIMIT 1`,
          ).bind(user.id).first<TransferRow>()
        if (transfer === null) {
          if (/affiliate_quota_empty/i.test(errorMessage(error))) throw affiliateQuotaEmpty()
          throw error
        }
      }
      transfer ??= await findTransferByIdempotency(context.env, user.id, idempotencyHash)
    }
    if (transfer === null) throw commercialUnavailable()

    const balanceUser = await context.env.DB.prepare(
      `SELECT id, balance_micros, state_version, status FROM users WHERE id = ? LIMIT 1`,
    ).bind(user.id).first<UserBalanceRow>()
    if (balanceUser === null || balanceUser.status !== 'active') {
      throw new GatewayError(403, 'user_disabled', 'User account is disabled', 'permission_error')
    }
    await ensureUserState(context.env, balanceUser)
    const adjusted = await userStatePost(context.env, user.id, '/balance/adjust', {
      schema_version: 1,
      mutation_id: `affiliate-transfer:${transfer.id}`,
      amount_delta_micros: transfer.amount_micros,
    })
    if (!adjusted.ok) throw await stateError(adjusted)
    const state = await parseBalanceState(adjusted, user.id)
    const completedAt = Date.now()
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE affiliate_transfer_operations
            SET status = 'completed', balance_after_micros = ?, state_version = ?,
                control_version = control_version + 1, completed_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND user_id = ? AND status = 'processing'`,
      ).bind(state.balance_micros, state.state_version, completedAt, completedAt, transfer.id, user.id),
      context.env.DB.prepare(
        `UPDATE users SET balance_micros = ?, state_version = ?, updated_at_ms = ?
          WHERE id = ? AND state_version < ?`,
      ).bind(state.balance_micros, state.state_version, completedAt, user.id, state.state_version),
    ])
    const completed = await context.env.DB.prepare(
      `${transferSelect()} WHERE id = ? AND user_id = ? LIMIT 1`,
    ).bind(transfer.id, user.id).first<TransferRow>()
    if (completed === null || completed.status !== 'completed') throw commercialUnavailable()
    return controlSuccess(publicTransfer(completed))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** Payment/reconciliation seam. A source order can accrue at most once. */
export async function accrueAffiliateRebate(
  env: Env,
  input: AffiliateRebateInput,
  now = Date.now(),
): Promise<AffiliateRebateResult> {
  validateRebateInput(input)
  if (!(await affiliateEnabled(env))) {
    return { applied: false, idempotent: false, rebate_id: null, rebate_micros: 0, rebate_amount: 0, status: null, eligible_at_ms: null }
  }
  const existing = await findRebateBySource(env, input.source_order_id)
  if (existing !== null) return publicRebateResult(existing, true)
  const rebateId = await deterministicUuid('affiliate.rebate.v1', input.source_order_id)
  try {
    await env.DB.prepare(
      `WITH eligible AS (
         SELECT referral.inviter_user_id, referral.invitee_user_id, referral.attributed_at_ms,
                config.affiliate_rebate_freeze_hours AS freeze_hours,
                config.affiliate_rebate_duration_days AS duration_days,
                config.affiliate_rebate_per_invitee_cap_micros AS cap_micros,
                config.affiliate_admin_recharge_enabled AS admin_recharge_enabled,
                COALESCE(inviter.rebate_rate_ppm, config.affiliate_rebate_rate_ppm) AS rate_ppm,
                COALESCE((
                  SELECT SUM(previous.rebate_micros) FROM affiliate_rebates previous
                   WHERE previous.inviter_user_id = referral.inviter_user_id
                     AND previous.invitee_user_id = referral.invitee_user_id
                     AND previous.status <> 'void'
                ), 0) - COALESCE((
                  SELECT SUM(adjustment.adjustment_micros)
                    FROM affiliate_rebate_adjustments adjustment
                    JOIN affiliate_rebates adjusted ON adjusted.id = adjustment.rebate_id
                   WHERE adjusted.inviter_user_id = referral.inviter_user_id
                     AND adjusted.invitee_user_id = referral.invitee_user_id
                ), 0) AS already_accrued_micros
           FROM affiliate_referrals referral
           JOIN affiliate_profiles inviter ON inviter.user_id = referral.inviter_user_id
           JOIN commercial_config config ON config.id = 'global'
          WHERE referral.invitee_user_id = ?
       ), calculated AS (
         SELECT *, CAST((? * rate_ppm + 500000) / 1000000 AS INTEGER) AS raw_rebate_micros
           FROM eligible
          WHERE (duration_days = 0 OR ? <= attributed_at_ms + duration_days * 86400000)
            AND (? = 0 OR admin_recharge_enabled = 1)
       )
       INSERT INTO affiliate_rebates (
         id, source_order_id, out_trade_no, inviter_user_id, invitee_user_id,
         order_amount_micros, pay_amount_micros, rebate_micros,
         payment_type, order_status, status, eligible_at_ms,
         created_at_ms, updated_at_ms
       )
       SELECT ?, ?, ?, inviter_user_id, invitee_user_id, ?, ?,
              CASE WHEN cap_micros > 0
                THEN MIN(raw_rebate_micros, cap_micros - already_accrued_micros)
                ELSE raw_rebate_micros END,
              ?, ?, CASE WHEN freeze_hours > 0 THEN 'frozen' ELSE 'available' END,
              ? + freeze_hours * 3600000, ?, ?
         FROM calculated
        WHERE raw_rebate_micros > 0
          AND (cap_micros = 0 OR already_accrued_micros < cap_micros)`,
    ).bind(
      input.invitee_user_id,
      input.pay_amount_micros,
      now,
      input.is_admin_recharge === true ? 1 : 0,
      rebateId,
      input.source_order_id,
      input.out_trade_no ?? '',
      input.order_amount_micros,
      input.pay_amount_micros,
      input.payment_type ?? '',
      input.order_status ?? 'completed',
      now,
      now,
      now,
    ).run()
  } catch (error) {
    const raced = await findRebateBySource(env, input.source_order_id)
    if (raced !== null) return publicRebateResult(raced, true)
    throw error
  }
  const created = await findRebateBySource(env, input.source_order_id)
  return created === null
    ? { applied: false, idempotent: false, rebate_id: null, rebate_micros: 0, rebate_amount: 0, status: null, eligible_at_ms: null }
    : publicRebateResult(created, false)
}

/** Applies the idempotent commission projection for one completed payment order. */
export async function accrueAffiliateRebateForPaymentOrder(
  env: Env,
  orderId: string,
): Promise<AffiliateRebateResult> {
  const order = await env.DB.prepare(
    `SELECT id, user_id, out_trade_no, amount_micros, pay_amount_micros,
            paid_amount_micros, provider_key_snapshot, status
       FROM payment_orders
      WHERE id = ? AND status = 'COMPLETED' LIMIT 1`,
  ).bind(orderId).first<AffiliatePaymentOrderRow>()
  if (order === null) {
    throw new GatewayError(409, 'payment_order_not_completed', 'Payment order is not completed')
  }
  return accrueAffiliateRebate(env, {
    source_order_id: order.id,
    invitee_user_id: order.user_id,
    order_amount_micros: order.amount_micros,
    pay_amount_micros: order.paid_amount_micros > 0
      ? order.paid_amount_micros
      : order.pay_amount_micros,
    out_trade_no: order.out_trade_no,
    payment_type: order.provider_key_snapshot,
    order_status: 'completed',
  })
}

/** Bounded Cron safety net for a Worker interruption after entitlement commit. */
export async function recoverPendingAffiliateRebates(env: Env, requestedLimit = 25): Promise<number> {
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 100)
    : 25
  const rows = await env.DB.prepare(
    `SELECT payment.id
       FROM payment_orders payment
       JOIN affiliate_referrals referral ON referral.invitee_user_id = payment.user_id
       LEFT JOIN affiliate_rebates rebate ON rebate.source_order_id = payment.id
      WHERE payment.status = 'COMPLETED' AND rebate.id IS NULL
      ORDER BY payment.completed_at_ms ASC, payment.id ASC
      LIMIT ?`,
  ).bind(limit).all<{ id: string }>()
  let applied = 0
  for (const row of rows.results) {
    try {
      const result = await accrueAffiliateRebateForPaymentOrder(env, row.id)
      if (result.applied) applied += 1
    } catch (error) {
      console.error('affiliate rebate recovery deferred', {
        order_id: row.id,
        name: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  return applied
}

/**
 * Applies the compensating affiliate entry for one settled payment refund.
 * The D1 reservation is durable before a transferred commission is reclaimed
 * from UserStateDO, so a Worker interruption can safely replay the same
 * deterministic balance mutation.
 */
export async function clawbackAffiliateRebateForRefund(
  env: Env,
  refundId: string,
): Promise<AffiliateRefundAdjustmentResult> {
  let adjustment = await findRefundAdjustment(env, refundId)
  let created = false
  if (adjustment === null) {
    const source = await findAffiliateRefundSource(env, refundId)
    if (source === null || source.rebate_status === 'void') return emptyRefundAdjustment()
    const target = proportionalMicros(
      source.rebate_micros,
      Math.min(source.cumulative_refunded_micros, source.order_amount_micros),
      source.order_amount_micros,
    )
    const adjustmentMicros = Math.max(0, target - source.previously_adjusted_micros)
    const candidate = source.rebate_status === 'frozen'
      ? source.frozen_micros
      : source.available_micros
    const quotaClawbackMicros = Math.min(adjustmentMicros, candidate)
    const balanceClawbackMicros = adjustmentMicros - quotaClawbackMicros
    const adjustmentId = await deterministicUuid('affiliate.rebate.refund-adjustment.v1', refundId)
    const now = Date.now()
    try {
      await env.DB.prepare(
        `INSERT INTO affiliate_rebate_adjustments (
           id, rebate_id, refund_id, adjustment_kind, quota_bucket,
           refund_amount_micros, cumulative_refunded_micros, adjustment_micros,
           quota_clawback_micros, balance_clawback_micros,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        adjustmentId,
        source.rebate_id,
        refundId,
        source.cumulative_refunded_micros >= source.order_amount_micros
          ? 'full_void'
          : 'partial_clawback',
        quotaClawbackMicros === 0 ? 'none' : source.rebate_status,
        source.refund_amount_micros,
        source.cumulative_refunded_micros,
        adjustmentMicros,
        quotaClawbackMicros,
        balanceClawbackMicros,
        now,
        now,
      ).run()
      created = true
    } catch (error) {
      adjustment = await findRefundAdjustment(env, refundId)
      if (adjustment === null) throw error
    }
    adjustment = await findRefundAdjustment(env, refundId)
    if (adjustment === null) throw commercialUnavailable()
  }
  if (adjustment.status === 'completed') {
    return publicRefundAdjustment(adjustment, !created)
  }

  let state: { balance_micros: number; state_version: number } | null = null
  if (adjustment.balance_clawback_micros > 0) {
    const user = await env.DB.prepare(
      `SELECT id, balance_micros, state_version, status FROM users WHERE id = ? LIMIT 1`,
    ).bind(adjustment.inviter_user_id).first<UserBalanceRow>()
    if (user === null) throw commercialUnavailable()
    await ensureUserState(env, user)
    const adjusted = await userStatePost(env, user.id, '/balance/adjust', {
      schema_version: 1,
      mutation_id: `affiliate-refund-clawback:${adjustment.id}`,
      amount_delta_micros: -adjustment.balance_clawback_micros,
    })
    if (!adjusted.ok) throw await stateError(adjusted)
    state = await parseBalanceState(adjusted, user.id)
  }

  const completedAt = Date.now()
  const eventId = await deterministicUuid(
    'payment-event-affiliate-refund-clawback:v1',
    adjustment.id,
  )
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE affiliate_rebate_adjustments
          SET status = 'completed', balance_after_micros = ?, state_version = ?,
              control_version = control_version + 1, completed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'processing'
          AND EXISTS (
            SELECT 1 FROM payment_refunds
             WHERE id = affiliate_rebate_adjustments.refund_id
               AND status IN ('partially_refunded', 'refunded')
               AND settled_amount_micros > 0
          )`,
    ).bind(state?.balance_micros ?? null, state?.state_version ?? null,
      completedAt, completedAt, adjustment.id),
  ]
  if (state !== null) {
    statements.push(env.DB.prepare(
      `UPDATE users SET balance_micros = ?, state_version = ?, updated_at_ms = ?
        WHERE id = ? AND state_version < ?`,
    ).bind(state.balance_micros, state.state_version, completedAt,
      adjustment.inviter_user_id, state.state_version))
  }
  statements.push(env.DB.prepare(
    `INSERT OR IGNORE INTO payment_events (
       id, order_id, event_type, source_type, source_id,
       payload_json, occurred_at_ms, created_at_ms
     )
     SELECT ?, rebate.source_order_id, 'AFFILIATE_REBATE_CLAWBACK_SUCCEEDED',
            'system', adjustment.id, ?, ?, ?
       FROM affiliate_rebate_adjustments adjustment
       JOIN affiliate_rebates rebate ON rebate.id = adjustment.rebate_id
      WHERE adjustment.id = ? AND adjustment.status = 'completed'`,
  ).bind(eventId, JSON.stringify({
    refund_id: refundId,
    adjustment_micros: adjustment.adjustment_micros,
    quota_clawback_micros: adjustment.quota_clawback_micros,
    balance_clawback_micros: adjustment.balance_clawback_micros,
  }), completedAt, completedAt, adjustment.id))
  await env.DB.batch(statements)
  const completed = await findRefundAdjustment(env, refundId)
  if (completed === null || completed.status !== 'completed') throw commercialUnavailable()
  return publicRefundAdjustment(completed, !created)
}

/** Admin-only manual/reconciliation entry into the same payment accrual seam. */
export async function accrueAdminAffiliateRebate(context: Context<CommercialBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw, 16_384)
    const input: AffiliateRebateInput = {
      source_order_id: requireString(body, 'source_order_id', 128),
      invitee_user_id: requireResourceId(String(body.invitee_user_id ?? ''), 'user'),
      order_amount_micros: safeMicros(body.order_amount_micros, 'order_amount_micros'),
      pay_amount_micros: safeMicros(body.pay_amount_micros, 'pay_amount_micros'),
      out_trade_no: body.out_trade_no === undefined ? '' : requireString(body, 'out_trade_no', 128),
      payment_type: body.payment_type === undefined ? '' : requireString(body, 'payment_type', 64),
      order_status: body.order_status === undefined ? 'completed' : requireString(body, 'order_status', 32),
      is_admin_recharge: optionalBoolean(body.is_admin_recharge, 'is_admin_recharge') ?? false,
    }
    const idempotency = await controlIdempotency(
      'commercial.affiliate-user.manual-accrue.v1',
      requireIdempotencyKey(context.req.raw),
      input,
    )
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) return manualAccrualResponse(parseManualAccrualReplay(replay, input.source_order_id))

    const auditId = await deterministicUuid('commercial.affiliate.admin-accrue.audit.v1', input.source_order_id)
    const audited = await context.env.DB.prepare(
      `SELECT 1 AS present FROM commercial_admin_audit_events WHERE id = ? LIMIT 1`,
    ).bind(auditId).first<{ present: number }>()
    if (audited !== null) throw affiliateSourceConflict()

    const existing = await findRebateBySource(context.env, input.source_order_id)
    if (existing !== null && !rebateMatchesInput(existing, input)) throw affiliateSourceConflict()
    const result = existing === null
      ? await accrueAffiliateRebate(context.env, input)
      : publicRebateResult(existing, false)
    const rebate = await findRebateBySource(context.env, input.source_order_id)
    if (rebate !== null && !rebateMatchesInput(rebate, input)) throw affiliateSourceConflict()
    const resourceId = rebate?.inviter_user_id ?? input.invitee_user_id
    const profile = await ensureAffiliateProfile(context.env, resourceId)
    const now = Date.now()
    try {
      await context.env.DB.batch([
        controlIdempotencyInsert(
          context.env,
          idempotency,
          'affiliate_rebate',
          input.source_order_id,
          result,
          now,
        ),
        affiliateAdminAuditStatement(
          context.env,
          actor,
          'affiliate_user.manual_accrue',
          resourceId,
          profile.control_version,
          idempotency.key_hash,
          [
            'source_order_id', 'invitee_user_id', 'order_amount_micros', 'pay_amount_micros',
            'out_trade_no', 'payment_type', 'order_status', 'is_admin_recharge',
          ],
          now,
          auditId,
        ),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return manualAccrualResponse(parseManualAccrualReplay(recovered, input.source_order_id))
      }
      const winner = await context.env.DB.prepare(
        `SELECT 1 AS present FROM commercial_admin_audit_events WHERE id = ? LIMIT 1`,
      ).bind(auditId).first<{ present: number }>()
      if (winner !== null) throw affiliateSourceConflict()
      throw error
    }
    return manualAccrualResponse(result)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminAffiliateInvites(context: Context<CommercialBindings>): Promise<Response> {
  return listAdminRecords(context, 'invites')
}

export async function listAdminAffiliateRebates(context: Context<CommercialBindings>): Promise<Response> {
  return listAdminRecords(context, 'rebates')
}

export async function listAdminAffiliateTransfers(context: Context<CommercialBindings>): Promise<Response> {
  return listAdminRecords(context, 'transfers')
}

export async function getAdminAffiliateUserOverview(context: Context<CommercialBindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const userId = requireResourceId(context.req.param('user_id'), 'user')
    const profile = await ensureAffiliateProfile(context.env, userId)
    const user = await context.env.DB.prepare(
      `SELECT email, display_name FROM users WHERE id = ? LIMIT 1`,
    ).bind(userId).first<{ email: string; display_name: string }>()
    if (user === null) throw new GatewayError(404, 'user_not_found', 'User was not found')
    const config = await commercialConfig(context.env)
    const rebated = await context.env.DB.prepare(
      `SELECT COUNT(DISTINCT invitee_user_id) AS total
         FROM affiliate_rebates WHERE inviter_user_id = ? AND status <> 'void'`,
    ).bind(userId).first<{ total: number }>()
    return controlSuccess({
      user_id: userId,
      email: user.email,
      username: user.display_name,
      aff_code: await decryptAffiliateCode(context.env, profile),
      rebate_rate_percent: (profile.rebate_rate_ppm ?? config.affiliate_rebate_rate_ppm) / 10_000,
      invited_count: profile.invited_count,
      rebated_invitee_count: rebated?.total ?? 0,
      available_quota: microsToUsd(profile.available_micros),
      available_quota_micros: profile.available_micros,
      history_quota: microsToUsd(profile.history_micros),
      history_quota_micros: profile.history_micros,
      control_version: profile.control_version,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminAffiliateUsers(context: Context<CommercialBindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const { page, pageSize, search, like } = listFilter(context)
    const where = search ? `AND (user.email LIKE ? ESCAPE '\\' OR user.display_name LIKE ? ESCAPE '\\')` : ''
    const params = search ? [like, like] : []
    const count = await context.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM affiliate_profiles profile
       JOIN users user ON user.id = profile.user_id
       WHERE (profile.code_custom = 1 OR profile.rebate_rate_ppm IS NOT NULL) ${where}`,
    ).bind(...params).first<{ total: number }>()
    const rows = await context.env.DB.prepare(
      `SELECT profile.*, user.email, user.display_name FROM affiliate_profiles profile
       JOIN users user ON user.id = profile.user_id
       WHERE (profile.code_custom = 1 OR profile.rebate_rate_ppm IS NOT NULL) ${where}
       ORDER BY profile.updated_at_ms DESC, profile.user_id DESC LIMIT ? OFFSET ?`,
    ).bind(...params, pageSize, (page - 1) * pageSize).all<AffiliateProfileRow & { email: string; display_name: string }>()
    const items = await Promise.all(rows.results.map(async (profile) => ({
      user_id: profile.user_id,
      email: profile.email,
      username: profile.display_name,
      aff_code: await decryptAffiliateCode(context.env, profile),
      aff_code_custom: profile.code_custom === 1,
      aff_rebate_rate_percent: profile.rebate_rate_ppm === null ? null : profile.rebate_rate_ppm / 10_000,
      aff_count: profile.invited_count,
      control_version: profile.control_version,
    })))
    return paginated(items, count?.total ?? 0, page, pageSize)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function lookupAdminAffiliateUsers(context: Context<CommercialBindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const search = context.req.query('q')?.trim() ?? ''
    if (search === '') return controlSuccess([])
    if (search.length > 100) throw new GatewayError(400, 'invalid_search', 'search is too long')
    const like = `%${escapeLike(search)}%`
    const rows = await context.env.DB.prepare(
      `SELECT user.id, user.email, user.display_name,
              COALESCE(profile.control_version, 0) AS control_version
         FROM users user
         LEFT JOIN affiliate_profiles profile ON profile.user_id = user.id
        WHERE user.email LIKE ? ESCAPE '\\' OR user.display_name LIKE ? ESCAPE '\\'
        ORDER BY user.email, user.id LIMIT 20`,
    ).bind(like, like).all<{ id: string; email: string; display_name: string; control_version: number }>()
    return controlSuccess(rows.results.map((user) => ({
      id: user.id, email: user.email, username: user.display_name, control_version: user.control_version,
    })))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updateAdminAffiliateUser(context: Context<CommercialBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const userId = requireResourceId(context.req.param('user_id'), 'user')
    const body = await readJsonObject(context.req.raw, 8_192)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const key = requireIdempotencyKey(context.req.raw)
    let requestedCode: string | undefined
    if (body.aff_code !== undefined) {
      if (typeof body.aff_code !== 'string') throw new GatewayError(400, 'AFFILIATE_CODE_INVALID', 'Invalid affiliate code')
      requestedCode = normalizeCommercialCode(body.aff_code, 'affiliate')
    }
    let requestedRatePpm: number | null | undefined
    if (body.clear_rebate_rate === true || body.aff_rebate_rate_percent === null) requestedRatePpm = null
    else if (body.aff_rebate_rate_percent !== undefined) {
      requestedRatePpm = percentToPpm(body.aff_rebate_rate_percent)
    }
    const request = {
      user_id: userId,
      expected_control_version: expected,
      ...(requestedCode === undefined ? {} : { aff_code: requestedCode }),
      ...(requestedRatePpm === undefined ? {} : { rebate_rate_ppm: requestedRatePpm }),
    }
    const idempotency = await controlIdempotency(
      'commercial.affiliate-user.update.v1',
      key,
      request,
    )
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) {
      return controlSuccess(parseAffiliateMutationReplay(replay, userId))
    }
    const profile = await ensureAffiliateProfile(context.env, userId)
    if (profile.control_version !== expected) throw versionConflict()
    let codeMaterial: Awaited<ReturnType<typeof customAffiliateCode>> | null = null
    if (requestedCode !== undefined) {
      codeMaterial = await customAffiliateCode(context.env, userId, profile.code_key_version + 1, requestedCode)
    }
    const ratePpm = requestedRatePpm === undefined ? profile.rebate_rate_ppm : requestedRatePpm
    const now = Date.now()
    const response = { user_id: userId, control_version: expected + 1 }
    const changedFields = [
      ...(requestedCode === undefined ? [] : ['aff_code']),
      ...(requestedRatePpm === undefined ? [] : ['aff_rebate_rate_percent']),
    ]
    try {
      await context.env.DB.batch([
        guardedControlIdempotencyInsert(
          context.env,
          idempotency,
          'affiliate_user',
          userId,
          response,
          now,
          `EXISTS (SELECT 1 FROM affiliate_profiles WHERE user_id = ? AND control_version = ?)`,
          [userId, expected],
        ),
        context.env.DB.prepare(
          `UPDATE affiliate_profiles
              SET code_hash = ?, code_prefix = ?, code_custom = ?, code_key_version = ?,
                  code_nonce_b64 = ?, code_ciphertext_b64 = ?, rebate_rate_ppm = ?,
                  control_version = control_version + 1, updated_at_ms = ?
            WHERE user_id = ? AND control_version = ?`,
        ).bind(
          codeMaterial?.hash ?? profile.code_hash,
          codeMaterial?.code.slice(0, 8) ?? profile.code_prefix,
          codeMaterial === null ? profile.code_custom : 1,
          codeMaterial === null ? profile.code_key_version : profile.code_key_version + 1,
          codeMaterial?.nonce ?? profile.code_nonce_b64,
          codeMaterial?.ciphertext ?? profile.code_ciphertext_b64,
          ratePpm,
          now,
          userId,
          expected,
        ),
        affiliateAdminAuditStatement(
          context.env,
          actor,
          'affiliate_user.update',
          userId,
          expected + 1,
          idempotency.key_hash,
          changedFields,
          now,
        ),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) return controlSuccess(parseAffiliateMutationReplay(recovered, userId))
      if (/UNIQUE constraint failed: affiliate_profiles\.code_hash/i.test(errorMessage(error))) {
        throw new GatewayError(409, 'AFFILIATE_CODE_TAKEN', 'Affiliate code is already in use')
      }
      const latest = await findProfile(context.env, userId)
      if (latest === null || latest.control_version !== expected) throw versionConflict()
      throw error
    }
    const updated = await findProfile(context.env, userId)
    if (updated === null || updated.control_version !== expected + 1) throw versionConflict()
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function clearAdminAffiliateUser(context: Context<CommercialBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const userId = requireResourceId(context.req.param('user_id'), 'user')
    const body = await readOptionalJsonObject(context.req.raw, 4_096)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const idempotency = await controlIdempotency(
      'commercial.affiliate-user.clear.v1',
      requireIdempotencyKey(context.req.raw),
      { user_id: userId, expected_control_version: expected },
    )
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) return controlSuccess(parseAffiliateMutationReplay(replay, userId))
    const profile = await ensureAffiliateProfile(context.env, userId)
    if (profile.control_version !== expected) throw versionConflict()
    const material = await systemAffiliateCode(context.env, userId, profile.code_key_version + 1)
    const now = Date.now()
    const response = { user_id: userId, control_version: expected + 1 }
    try {
      await context.env.DB.batch([
        guardedControlIdempotencyInsert(
          context.env,
          idempotency,
          'affiliate_user',
          userId,
          response,
          now,
          `EXISTS (SELECT 1 FROM affiliate_profiles WHERE user_id = ? AND control_version = ?)`,
          [userId, expected],
        ),
        context.env.DB.prepare(
          `UPDATE affiliate_profiles
              SET code_hash = ?, code_prefix = ?, code_custom = 0,
                  code_key_version = ?, code_nonce_b64 = ?, code_ciphertext_b64 = ?,
                  rebate_rate_ppm = NULL, control_version = control_version + 1, updated_at_ms = ?
            WHERE user_id = ? AND control_version = ?`,
        ).bind(
          material.hash, material.code.slice(0, 8), profile.code_key_version + 1,
          material.nonce, material.ciphertext, now, userId, expected,
        ),
        affiliateAdminAuditStatement(
          context.env,
          actor,
          'affiliate_user.clear',
          userId,
          expected + 1,
          idempotency.key_hash,
          ['aff_code', 'aff_rebate_rate_percent'],
          now,
        ),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) return controlSuccess(parseAffiliateMutationReplay(recovered, userId))
      const latest = await findProfile(context.env, userId)
      if (latest === null || latest.control_version !== expected) throw versionConflict()
      throw error
    }
    const updated = await findProfile(context.env, userId)
    if (updated === null || updated.control_version !== expected + 1) throw versionConflict()
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function batchUpdateAdminAffiliateRates(context: Context<CommercialBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw, 32_768)
    if (!Array.isArray(body.user_ids) || body.user_ids.length < 1 || body.user_ids.length > 100) {
      throw new GatewayError(400, 'invalid_user_ids', 'user_ids must contain between 1 and 100 users')
    }
    const userIds = [...new Set(body.user_ids.map((value) => requireResourceId(String(value), 'user')))].sort()
    const ratePpm = body.clear === true ? null : percentToPpm(body.aff_rebate_rate_percent)
    const expectedVersions = requireBatchExpectedVersions(context.req.raw, body, userIds)
    const idempotency = await controlIdempotency(
      'commercial.affiliate-user.batch-rate.v1',
      requireIdempotencyKey(context.req.raw),
      {
        users: userIds.map((userId) => ({ user_id: userId, control_version: expectedVersions.get(userId) })),
        rebate_rate_ppm: ratePpm,
      },
    )
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) {
      return controlSuccess(parseIdempotentResponse<Record<string, unknown>>(replay, 'affiliate_user_batch'))
    }
    for (const userId of userIds) await ensureAffiliateProfile(context.env, userId)
    const now = Date.now()
    const controlVersions = Object.fromEntries(
      userIds.map((userId) => [userId, (expectedVersions.get(userId) as number) + 1]),
    )
    const response = { affected: userIds.length, control_versions: controlVersions }
    const guardParts = userIds.map(() => '(user_id = ? AND control_version = ?)').join(' OR ')
    const guardValues = userIds.flatMap((userId) => [userId, expectedVersions.get(userId) as number])
    try {
      await context.env.DB.batch([
        guardedControlIdempotencyInsert(
          context.env,
          idempotency,
          'affiliate_user_batch',
          `batch:${idempotency.request_hash.slice(0, 24)}`,
          response,
          now,
          `? = (SELECT COUNT(*) FROM affiliate_profiles WHERE ${guardParts})`,
          [userIds.length, ...guardValues],
        ),
        ...userIds.map((userId) => context.env.DB.prepare(
          `UPDATE affiliate_profiles SET rebate_rate_ppm = ?,
                  control_version = control_version + 1, updated_at_ms = ?
            WHERE user_id = ? AND control_version = ?`,
        ).bind(ratePpm, now, userId, expectedVersions.get(userId))),
        ...userIds.map((userId) => affiliateAdminAuditStatement(
          context.env,
          actor,
          'affiliate_user.batch_rate.update',
          userId,
          controlVersions[userId],
          idempotency.key_hash,
          ['aff_rebate_rate_percent'],
          now,
        )),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return controlSuccess(parseIdempotentResponse<Record<string, unknown>>(recovered, 'affiliate_user_batch'))
      }
      const latest = await loadProfileVersions(context.env, userIds)
      if (userIds.some((userId) => latest.get(userId) !== expectedVersions.get(userId))) {
        throw versionConflict()
      }
      throw error
    }
    const latest = await loadProfileVersions(context.env, userIds)
    if (userIds.some((userId) => latest.get(userId) !== controlVersions[userId])) throw versionConflict()
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function listAdminRecords(
  context: Context<CommercialBindings>,
  kind: 'invites' | 'rebates' | 'transfers',
): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const { page, pageSize, search, like } = listFilter(context)
    const offset = (page - 1) * pageSize
    if (kind === 'invites') {
      const where = search ? `WHERE inviter.email LIKE ? ESCAPE '\\' OR invitee.email LIKE ? ESCAPE '\\'` : ''
      const params = search ? [like, like] : []
      const count = await context.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM affiliate_referrals referral
         JOIN users inviter ON inviter.id = referral.inviter_user_id
         JOIN users invitee ON invitee.id = referral.invitee_user_id ${where}`,
      ).bind(...params).first<{ total: number }>()
      const rows = await context.env.DB.prepare(
        `SELECT referral.*, inviter.email AS inviter_email, inviter.display_name AS inviter_username,
                invitee.email AS invitee_email, invitee.display_name AS invitee_username,
                COALESCE(SUM(CASE WHEN rebate.status <> 'void' THEN rebate.rebate_micros ELSE 0 END), 0)
                  AS total_rebate_micros
           FROM affiliate_referrals referral
           JOIN users inviter ON inviter.id = referral.inviter_user_id
           JOIN users invitee ON invitee.id = referral.invitee_user_id
           LEFT JOIN affiliate_rebates rebate
             ON rebate.inviter_user_id = referral.inviter_user_id
            AND rebate.invitee_user_id = referral.invitee_user_id
           ${where}
          GROUP BY referral.invitee_user_id
          ORDER BY referral.attributed_at_ms DESC, referral.invitee_user_id DESC LIMIT ? OFFSET ?`,
      ).bind(...params, pageSize, offset).all<Record<string, unknown>>()
      return paginated(rows.results.map((row) => ({
        inviter_id: row.inviter_user_id,
        inviter_email: row.inviter_email,
        inviter_username: row.inviter_username,
        invitee_id: row.invitee_user_id,
        invitee_email: row.invitee_email,
        invitee_username: row.invitee_username,
        aff_code: `${row.affiliate_code_prefix}…`,
        total_rebate: microsToUsd(row.total_rebate_micros as number),
        total_rebate_micros: row.total_rebate_micros,
        created_at: iso(row.attributed_at_ms as number),
      })), count?.total ?? 0, page, pageSize)
    }
    if (kind === 'rebates') {
      const where = search ? `WHERE rebate.out_trade_no LIKE ? ESCAPE '\\' OR inviter.email LIKE ? ESCAPE '\\' OR invitee.email LIKE ? ESCAPE '\\'` : ''
      const params = search ? [like, like, like] : []
      const count = await context.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM affiliate_rebates rebate
         JOIN users inviter ON inviter.id = rebate.inviter_user_id
         JOIN users invitee ON invitee.id = rebate.invitee_user_id ${where}`,
      ).bind(...params).first<{ total: number }>()
      const rows = await context.env.DB.prepare(
        `SELECT rebate.*, inviter.email AS inviter_email, inviter.display_name AS inviter_username,
                invitee.email AS invitee_email, invitee.display_name AS invitee_username
           FROM affiliate_rebates rebate
           JOIN users inviter ON inviter.id = rebate.inviter_user_id
           JOIN users invitee ON invitee.id = rebate.invitee_user_id ${where}
          ORDER BY rebate.created_at_ms DESC, rebate.id DESC LIMIT ? OFFSET ?`,
      ).bind(...params, pageSize, offset).all<Record<string, unknown>>()
      return paginated(rows.results.map((row) => ({
        order_id: row.source_order_id,
        out_trade_no: row.out_trade_no,
        inviter_id: row.inviter_user_id,
        inviter_email: row.inviter_email,
        inviter_username: row.inviter_username,
        invitee_id: row.invitee_user_id,
        invitee_email: row.invitee_email,
        invitee_username: row.invitee_username,
        order_amount: microsToUsd(row.order_amount_micros as number),
        pay_amount: microsToUsd(row.pay_amount_micros as number),
        rebate_amount: microsToUsd(row.rebate_micros as number),
        rebate_micros: row.rebate_micros,
        payment_type: row.payment_type,
        order_status: row.order_status,
        rebate_status: row.status,
        created_at: iso(row.created_at_ms as number),
      })), count?.total ?? 0, page, pageSize)
    }
    const where = search ? `WHERE user.email LIKE ? ESCAPE '\\' OR user.display_name LIKE ? ESCAPE '\\'` : ''
    const params = search ? [like, like] : []
    const count = await context.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM affiliate_transfer_operations transfer
       JOIN users user ON user.id = transfer.user_id ${where}`,
    ).bind(...params).first<{ total: number }>()
    const rows = await context.env.DB.prepare(
      `SELECT transfer.*, user.email AS user_email, user.display_name AS username,
              profile.available_micros, profile.frozen_micros, profile.history_micros,
              user.balance_micros AS current_balance_micros
         FROM affiliate_transfer_operations transfer
         JOIN users user ON user.id = transfer.user_id
         JOIN affiliate_profiles profile ON profile.user_id = transfer.user_id ${where}
        ORDER BY transfer.created_at_ms DESC, transfer.id DESC LIMIT ? OFFSET ?`,
    ).bind(...params, pageSize, offset).all<Record<string, unknown>>()
    return paginated(rows.results.map((row) => ({
      ledger_id: row.id,
      user_id: row.user_id,
      user_email: row.user_email,
      username: row.username,
      amount: microsToUsd(row.amount_micros as number),
      amount_micros: row.amount_micros,
      balance_after: row.balance_after_micros === null ? null : microsToUsd(row.balance_after_micros as number),
      available_quota_after: microsToUsd(row.available_micros as number),
      frozen_quota_after: microsToUsd(row.frozen_micros as number),
      history_quota_after: microsToUsd(row.history_micros as number),
      snapshot_available: row.status === 'completed',
      status: row.status,
      created_at: iso(row.created_at_ms as number),
    })), count?.total ?? 0, page, pageSize)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function thawMaturedRebates(env: Env, userId: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE affiliate_rebates
        SET status = 'available', control_version = control_version + 1, updated_at_ms = ?
      WHERE inviter_user_id = ? AND status = 'frozen' AND eligible_at_ms <= ?`,
  ).bind(now, userId, now).run()
}

async function findProfile(env: Env, userId: string): Promise<AffiliateProfileRow | null> {
  return env.DB.prepare(
    `SELECT user_id, code_hash, code_prefix, code_custom, code_key_version,
            code_nonce_b64, code_ciphertext_b64, rebate_rate_ppm, invited_count,
            available_micros, frozen_micros, history_micros, control_version,
            created_at_ms, updated_at_ms
       FROM affiliate_profiles WHERE user_id = ? LIMIT 1`,
  ).bind(userId).first<AffiliateProfileRow>()
}

async function commercialConfig(env: Env): Promise<CommercialConfigRow> {
  const row = await env.DB.prepare(
    `SELECT affiliate_rebate_rate_ppm, affiliate_rebate_freeze_hours,
            affiliate_rebate_duration_days, affiliate_rebate_per_invitee_cap_micros,
            affiliate_admin_recharge_enabled
       FROM commercial_config WHERE id = 'global' LIMIT 1`,
  ).first<CommercialConfigRow>()
  if (row === null) throw commercialUnavailable()
  return row
}

async function systemAffiliateCode(env: Env, userId: string, keyVersion: number) {
  const pepper = requirePepper(env)
  const seed = await apiKeyDigest(`sub2api/affiliate-profile/v1\0${userId}`, pepper)
  return encryptAffiliateCode(env, userId, keyVersion, `AFF${seed.slice(0, 13).toUpperCase()}`)
}

async function customAffiliateCode(env: Env, userId: string, keyVersion: number, value: string) {
  return encryptAffiliateCode(env, userId, keyVersion, normalizeCommercialCode(value, 'affiliate'))
}

async function encryptAffiliateCode(env: Env, userId: string, keyVersion: number, code: string) {
  const encrypted = await encryptCredential(
    { api_key: code }, requireMasterKey(env), affiliateCodeAad(userId, keyVersion),
  )
  return {
    code,
    hash: await commercialCodeDigest('affiliate', code, requirePepper(env)),
    nonce: encrypted.nonce_b64,
    ciphertext: encrypted.ciphertext_b64,
  }
}

async function decryptAffiliateCode(env: Env, profile: AffiliateProfileRow): Promise<string> {
  const credential = await decryptCredential(
    profile.code_nonce_b64,
    profile.code_ciphertext_b64,
    requireMasterKey(env),
    affiliateCodeAad(profile.user_id, profile.code_key_version),
  )
  return normalizeCommercialCode(credential.api_key, 'affiliate')
}

async function findRebateBySource(env: Env, sourceOrderId: string): Promise<AffiliateRebateRow | null> {
  return env.DB.prepare(
    `SELECT id, source_order_id, out_trade_no, inviter_user_id, invitee_user_id,
            order_amount_micros, pay_amount_micros, rebate_micros, payment_type,
            order_status, status, eligible_at_ms, created_at_ms
       FROM affiliate_rebates WHERE source_order_id = ? LIMIT 1`,
  ).bind(sourceOrderId).first<AffiliateRebateRow>()
}

function publicRebateResult(row: AffiliateRebateRow, idempotent: boolean): AffiliateRebateResult {
  return {
    applied: row.status !== 'void',
    idempotent,
    rebate_id: row.id,
    rebate_micros: row.rebate_micros,
    rebate_amount: microsToUsd(row.rebate_micros),
    status: row.status,
    eligible_at_ms: row.eligible_at_ms,
  }
}

async function findRefundAdjustment(
  env: Env,
  refundId: string,
): Promise<AffiliateRefundAdjustmentRow | null> {
  return env.DB.prepare(
    `SELECT adjustment.id, adjustment.rebate_id, adjustment.refund_id,
            rebate.inviter_user_id, adjustment.adjustment_kind,
            adjustment.adjustment_micros, adjustment.quota_clawback_micros,
            adjustment.balance_clawback_micros, adjustment.status,
            adjustment.balance_after_micros, adjustment.state_version
       FROM affiliate_rebate_adjustments adjustment
       JOIN affiliate_rebates rebate ON rebate.id = adjustment.rebate_id
      WHERE adjustment.refund_id = ? LIMIT 1`,
  ).bind(refundId).first<AffiliateRefundAdjustmentRow>()
}

async function findAffiliateRefundSource(
  env: Env,
  refundId: string,
): Promise<AffiliateRefundSourceRow | null> {
  return env.DB.prepare(
    `SELECT rebate.id AS rebate_id, rebate.inviter_user_id,
            rebate.status AS rebate_status, rebate.rebate_micros,
            rebate.order_amount_micros, refund.settled_amount_micros AS refund_amount_micros,
            payment.refunded_amount_micros AS cumulative_refunded_micros,
            profile.available_micros, profile.frozen_micros,
            COALESCE((
              SELECT SUM(previous.adjustment_micros)
                FROM affiliate_rebate_adjustments previous
               WHERE previous.rebate_id = rebate.id
            ), 0) AS previously_adjusted_micros
       FROM payment_refunds refund
       JOIN payment_orders payment ON payment.id = refund.order_id
       JOIN affiliate_rebates rebate ON rebate.source_order_id = payment.id
       JOIN affiliate_profiles profile ON profile.user_id = rebate.inviter_user_id
      WHERE refund.id = ?
        AND refund.status IN ('partially_refunded', 'refunded')
        AND refund.settled_amount_micros > 0
        AND payment.status IN ('PARTIALLY_REFUNDED', 'REFUNDED')
      LIMIT 1`,
  ).bind(refundId).first<AffiliateRefundSourceRow>()
}

function proportionalMicros(total: number, numerator: number, denominator: number): number {
  if (
    !Number.isSafeInteger(total) || total < 0 ||
    !Number.isSafeInteger(numerator) || numerator < 0 ||
    !Number.isSafeInteger(denominator) || denominator <= 0
  ) throw commercialUnavailable()
  return Number(
    (BigInt(total) * BigInt(numerator) + BigInt(denominator) / 2n) / BigInt(denominator),
  )
}

function publicRefundAdjustment(
  row: AffiliateRefundAdjustmentRow,
  idempotent: boolean,
): AffiliateRefundAdjustmentResult {
  return {
    applied: true,
    idempotent,
    adjustment_id: row.id,
    adjustment_micros: row.adjustment_micros,
    quota_clawback_micros: row.quota_clawback_micros,
    balance_clawback_micros: row.balance_clawback_micros,
    status: row.status,
  }
}

function emptyRefundAdjustment(): AffiliateRefundAdjustmentResult {
  return {
    applied: false,
    idempotent: false,
    adjustment_id: null,
    adjustment_micros: 0,
    quota_clawback_micros: 0,
    balance_clawback_micros: 0,
    status: null,
  }
}

function validateRebateInput(input: AffiliateRebateInput): void {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.source_order_id)) {
    throw new GatewayError(400, 'invalid_source_order_id', 'source_order_id is invalid')
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.invitee_user_id)) {
    throw new GatewayError(400, 'invalid_user_id', 'invitee_user_id is invalid')
  }
  safeMicros(input.order_amount_micros, 'order_amount_micros')
  safeMicros(input.pay_amount_micros, 'pay_amount_micros')
}

function safeMicros(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_PAYMENT_MICROS) {
    throw new GatewayError(400, `invalid_${field}`, `${field} is outside the supported range`)
  }
  return value as number
}

function transferSelect(): string {
  return `SELECT id, user_id, idempotency_key_hash, request_hash, status,
                 amount_micros, balance_after_micros, state_version,
                 created_at_ms, completed_at_ms
            FROM affiliate_transfer_operations`
}

async function findTransferByIdempotency(
  env: Env,
  userId: string,
  hash: string,
): Promise<TransferRow | null> {
  return env.DB.prepare(
    `${transferSelect()} WHERE user_id = ? AND idempotency_key_hash = ? LIMIT 1`,
  ).bind(userId, hash).first<TransferRow>()
}

function publicTransfer(transfer: TransferRow): Record<string, unknown> {
  if (transfer.status !== 'completed' || transfer.balance_after_micros === null) {
    throw commercialUnavailable()
  }
  return {
    transferred_quota: microsToUsd(transfer.amount_micros),
    transferred_micros: transfer.amount_micros,
    balance: microsToUsd(transfer.balance_after_micros),
    balance_micros: transfer.balance_after_micros,
    transfer_id: transfer.id,
    idempotent: true,
  }
}

async function ensureUserState(env: Env, user: UserBalanceRow): Promise<void> {
  const response = await userStatePost(env, user.id, '/configure', {
    schema_version: 1,
    mutation_id: `d1-user:${user.state_version}`,
    user_id: user.id,
    balance_micros: user.balance_micros,
    enabled: user.status === 'active',
    initial_state_version: user.state_version,
  })
  if (response.ok) return
  const code = await responseErrorCode(response)
  if (code !== 'user_already_configured') throw await stateError(response)
}

function userStatePost(env: Env, userId: string, path: string, body: Record<string, unknown>): Promise<Response> {
  const stub = env.USER_STATE.get(env.USER_STATE.idFromName(userId))
  return stub.fetch(new Request(`https://user-state.internal${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
}

async function parseBalanceState(response: Response, userId: string): Promise<{ balance_micros: number; state_version: number }> {
  const body = await response.json() as {
    profile?: { user_id?: unknown; balance_micros?: unknown }
    state_version?: unknown
  }
  if (
    body.profile?.user_id !== userId ||
    !Number.isSafeInteger(body.profile.balance_micros) || (body.profile.balance_micros as number) < 0 ||
    !Number.isSafeInteger(body.state_version) || (body.state_version as number) < 0
  ) throw commercialUnavailable()
  return {
    balance_micros: body.profile.balance_micros as number,
    state_version: body.state_version as number,
  }
}

async function responseErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = await response.clone().json() as { error?: { code?: unknown } }
    return typeof body.error?.code === 'string' ? body.error.code : undefined
  } catch { return undefined }
}

async function stateError(response: Response): Promise<GatewayError> {
  let code = 'state_operation_failed'
  let message = 'User state operation failed'
  try {
    const body = await response.clone().json() as { error?: { code?: unknown; message?: unknown } }
    if (typeof body.error?.code === 'string') code = body.error.code
    if (typeof body.error?.message === 'string') message = body.error.message
  } catch { /* sanitized defaults */ }
  return new GatewayError(response.status >= 400 && response.status < 500 ? response.status : 503, code, message, 'server_error')
}

function listFilter(context: Context<CommercialBindings>) {
  const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
  const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
  const search = context.req.query('search')?.trim() ?? ''
  if (search.length > 100) throw new GatewayError(400, 'invalid_search', 'search is too long')
  return { page, pageSize, search, like: `%${escapeLike(search)}%` }
}

function paginated(items: unknown[], total: number, page: number, pageSize: number): Response {
  return controlSuccess({ items, total, page, page_size: pageSize, pages: Math.ceil(total / pageSize) })
}

function percentToPpm(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new GatewayError(400, 'INVALID_RATE', 'Rebate rate must be between 0 and 100')
  }
  return Math.round(value * 10_000)
}

function requireBatchExpectedVersions(
  request: Request,
  body: Record<string, unknown>,
  userIds: string[],
): Map<string, number> {
  const raw = body.expected_control_versions
  if (raw === undefined) {
    if (userIds.length === 1) {
      return new Map([[userIds[0], requireExpectedControlVersion(request, body)]])
    }
    throw new GatewayError(
      428,
      'control_version_required',
      'expected_control_versions is required for every user in a batch',
    )
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GatewayError(
      400,
      'invalid_expected_control_versions',
      'expected_control_versions must be an object keyed by user id',
    )
  }
  const values = raw as Record<string, unknown>
  const keys = Object.keys(values).sort()
  if (keys.length !== userIds.length || keys.some((key, index) => key !== userIds[index])) {
    throw new GatewayError(
      400,
      'invalid_expected_control_versions',
      'expected_control_versions must contain exactly the requested users',
    )
  }
  const versions = new Map<string, number>()
  for (const userId of userIds) {
    const value = values[userId]
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new GatewayError(
        400,
        'invalid_expected_control_versions',
        'Every expected control version must be a non-negative safe integer',
      )
    }
    versions.set(userId, value as number)
  }
  if (userIds.length === 1) {
    const header = request.headers.get('if-match')?.trim()
    const bodyVersion = body.expected_control_version
    if ((header !== undefined && header !== '') || bodyVersion !== undefined) {
      const singular = requireExpectedControlVersion(request, body)
      if (singular !== versions.get(userIds[0])) {
        throw new GatewayError(
          400,
          'control_version_mismatch',
          'If-Match and expected_control_versions disagree',
        )
      }
    }
  } else if (body.expected_control_version !== undefined || request.headers.has('if-match')) {
    throw new GatewayError(
      400,
      'control_version_mismatch',
      'Batch requests with multiple users require expected_control_versions',
    )
  }
  return versions
}

async function loadProfileVersions(env: Env, userIds: string[]): Promise<Map<string, number>> {
  const placeholders = userIds.map(() => '?').join(', ')
  const rows = await env.DB.prepare(
    `SELECT user_id, control_version FROM affiliate_profiles WHERE user_id IN (${placeholders})`,
  ).bind(...userIds).all<{ user_id: string; control_version: number }>()
  return new Map(rows.results.map((row) => [row.user_id, row.control_version]))
}

function guardedControlIdempotencyInsert(
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
    now + CONTROL_IDEMPOTENCY_TTL_MS,
  )
}

function affiliateAdminAuditStatement(
  env: Env,
  actor: AdminActor,
  action: string,
  resourceId: string,
  resourceVersion: number,
  idempotencyKeyHash: string,
  changedFields: string[],
  now: number,
  eventId: string = crypto.randomUUID(),
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO commercial_admin_audit_events (
       id, actor_user_id, actor_session_id, action, resource_type, resource_id,
       resource_version, idempotency_key_hash, changed_fields_json, occurred_at_ms
     ) VALUES (?, ?, ?, ?, 'affiliate_user', ?, ?, ?, ?, ?)`,
  ).bind(
    eventId,
    actor.user_id,
    actor.session_id,
    action,
    resourceId,
    resourceVersion,
    idempotencyKeyHash,
    JSON.stringify(changedFields),
    now,
  )
}

function manualAccrualResponse(result: AffiliateRebateResult): Response {
  return controlSuccess(result, result.applied && !result.idempotent ? 201 : 200)
}

function parseManualAccrualReplay(
  row: ControlIdempotencyRow,
  sourceOrderId: string,
): AffiliateRebateResult {
  const response = parseIdempotentResponse<AffiliateRebateResult>(row, 'affiliate_rebate')
  if (
    row.resource_id !== sourceOrderId ||
    typeof response.applied !== 'boolean' ||
    typeof response.idempotent !== 'boolean' ||
    !Number.isSafeInteger(response.rebate_micros) ||
    typeof response.rebate_amount !== 'number'
  ) {
    throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
  }
  return response
}

function rebateMatchesInput(row: AffiliateRebateRow, input: AffiliateRebateInput): boolean {
  return row.source_order_id === input.source_order_id &&
    row.invitee_user_id === input.invitee_user_id &&
    row.order_amount_micros === input.order_amount_micros &&
    row.pay_amount_micros === input.pay_amount_micros &&
    row.out_trade_no === (input.out_trade_no ?? '') &&
    row.payment_type === (input.payment_type ?? '') &&
    row.order_status === (input.order_status ?? 'completed')
}

function parseAffiliateMutationReplay(
  row: ControlIdempotencyRow,
  userId: string,
): { user_id: string; control_version: number } {
  const response = parseIdempotentResponse<{ user_id?: unknown; control_version?: unknown }>(
    row,
    'affiliate_user',
  )
  if (
    row.resource_id !== userId ||
    response.user_id !== userId ||
    !Number.isSafeInteger(response.control_version) ||
    (response.control_version as number) < 0
  ) {
    throw new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
  }
  return { user_id: userId, control_version: response.control_version as number }
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new GatewayError(400, `invalid_${field}`, `${field} must be boolean`)
  return value
}

async function affiliateEnabled(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `SELECT public_json FROM system_settings WHERE id = 'global' LIMIT 1`,
    ).first<{ public_json: string }>()
    if (row !== null) {
      const parsed: unknown = JSON.parse(row.public_json)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new GatewayError(503, 'settings_unavailable', 'Affiliate settings are invalid', 'server_error')
      }
      const authoritative = (parsed as { affiliate_enabled?: unknown }).affiliate_enabled
      if (authoritative !== undefined) {
        if (typeof authoritative !== 'boolean') {
          throw new GatewayError(503, 'settings_unavailable', 'Affiliate settings are invalid', 'server_error')
        }
        return authoritative
      }
    }
    if (typeof env.CONFIG_KV.get !== 'function') return false
    const settings = await env.CONFIG_KV.get<{ affiliate_enabled?: unknown }>(
      `${env.ENVIRONMENT}:public-settings:v1`,
      'json',
    )
    if (settings === null || settings.affiliate_enabled === undefined) return false
    if (typeof settings.affiliate_enabled !== 'boolean') {
      throw new GatewayError(503, 'settings_unavailable', 'Affiliate settings are invalid', 'server_error')
    }
    return settings.affiliate_enabled
  } catch (error) {
    if (error instanceof GatewayError) throw error
    throw new GatewayError(503, 'settings_unavailable', 'Affiliate settings are unavailable', 'server_error')
  }
}

async function requireAffiliateEnabled(env: Env): Promise<void> {
  if (!(await affiliateEnabled(env))) {
    throw new GatewayError(403, 'AFFILIATE_DISABLED', 'Affiliate rewards are disabled', 'permission_error')
  }
}

function requirePepper(env: Env): string {
  if (!env.API_KEY_PEPPER || new TextEncoder().encode(env.API_KEY_PEPPER).byteLength < 32) {
    throw new GatewayError(503, 'commercial_not_configured', 'Affiliate code hashing is not configured', 'server_error')
  }
  return env.API_KEY_PEPPER
}

function requireMasterKey(env: Env): string {
  if (!env.CREDENTIALS_MASTER_KEY || new TextEncoder().encode(env.CREDENTIALS_MASTER_KEY).byteLength < 32) {
    throw new GatewayError(503, 'commercial_not_configured', 'Affiliate code encryption is not configured', 'server_error')
  }
  return env.CREDENTIALS_MASTER_KEY
}

function maskEmail(email: string): string {
  const separator = email.indexOf('@')
  if (separator < 1) return '***'
  return `${email.slice(0, 1)}***@${email.slice(separator + 1, separator + 2)}***${email.slice(email.lastIndexOf('.'))}`
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

function affiliateQuotaEmpty(): GatewayError {
  return new GatewayError(400, 'AFFILIATE_QUOTA_EMPTY', 'No affiliate quota is available to transfer')
}

function idempotencyConflict(): GatewayError {
  return new GatewayError(409, 'idempotency_conflict', 'Idempotency-Key was already used for another request')
}

function versionConflict(): GatewayError {
  return new GatewayError(412, 'control_version_conflict', 'Affiliate user changed concurrently')
}

function affiliateSourceConflict(): GatewayError {
  return new GatewayError(409, 'affiliate_source_conflict', 'Affiliate source order was already processed')
}

function commercialUnavailable(): GatewayError {
  return new GatewayError(503, 'commercial_unavailable', 'Commercial state is unavailable', 'server_error')
}
