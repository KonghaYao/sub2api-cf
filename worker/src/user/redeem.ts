import type { Context } from 'hono'
import { authenticateUserRequest } from '../auth/handler'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  queryInteger,
  readJsonObject,
  requireIdempotencyKey,
  requireString,
} from '../control/http'
import { synchronizeSubscriptionState } from '../control/subscriptions'
import type { Env } from '../env'
import { apiKeyDigest, sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'

type UserBindings = { Bindings: Env }

const DAY_MS = 86_400_000
const MAX_DATE_MS = 8_640_000_000_000_000

interface RedeemCodeRow {
  id: string
  code_hash: string
  code_prefix: string
  type: 'balance' | 'subscription'
  value_micros: number
  group_id: string | null
  validity_days: number | null
  status: 'unused' | 'processing' | 'used' | 'expired'
  expires_at_ms: number | null
  used_by_user_id: string | null
  claimed_by_redemption_id: string | null
  daily_quota_micros: number | null
  weekly_quota_micros: number | null
  monthly_quota_micros: number | null
}

interface RedemptionRow {
  id: string
  code_id: string
  user_id: string
  idempotency_key_hash: string
  status: 'processing' | 'completed'
  type: 'balance' | 'subscription'
  value_micros: number
  subscription_id: string | null
  result_json: string | null
  created_at_ms: number
  completed_at_ms: number | null
  code_hash: string
  code_prefix: string
  code_expires_at_ms: number | null
}

interface SubscriptionEntitlementRow {
  id: string
  status: 'active' | 'suspended' | 'revoked' | 'expired'
  starts_at_ms: number
  expires_at_ms: number
}

export async function redeemCode(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const normalizedCode = normalizeRedeemCode(requireString(body, 'code', 128))
    const [codeHash, idempotencyHash, redemptionId] = await Promise.all([
      redeemCodeDigest(normalizedCode, requirePepper(context.env)),
      sha256Hex(`sub2api/redeem/idempotency/v1\0${user.id}\0${idempotencyKey}`),
      deterministicUuid('user.redeem.v1', `${user.id}\0${idempotencyKey}`),
    ])

    let redemption = await findRedemptionByIdempotency(context.env, user.id, idempotencyHash)
    let code: RedeemCodeRow
    if (redemption !== null) {
      if (redemption.id !== redemptionId || redemption.code_hash !== codeHash) {
        throw new GatewayError(
          409,
          'idempotency_conflict',
          'Idempotency-Key was already used for a different redeem code',
        )
      }
      if (redemption.status === 'completed') {
        await synchronizeCompletedSubscriptionRedemption(context.env, redemption)
        return controlSuccess(parseStoredResult(redemption))
      }
      const resumedCode = await findRedeemCodeById(context.env, redemption.code_id)
      if (resumedCode === null) throw redeemUnavailable()
      code = resumedCode
    } else {
      const availableCode = await findRedeemCodeByHash(context.env, codeHash)
      if (availableCode === null) throw redeemUnavailable()
      code = availableCode
      validateRedeemAvailability(code, Date.now())
      if (code.type === 'subscription' && code.group_id !== null) {
        await requireRedeemableSubscriptionEntitlement(context.env, user.id, code.group_id)
      }
      const current = Date.now()
      try {
        await context.env.DB.batch([
          context.env.DB.prepare(
            `UPDATE redeem_codes
                SET status = 'processing', used_by_user_id = ?,
                    claimed_by_redemption_id = ?, used_at_ms = ?,
                    control_version = control_version + 1, updated_at_ms = ?
              WHERE id = ? AND status = 'unused'
                AND (expires_at_ms IS NULL OR expires_at_ms > ?)`,
          ).bind(user.id, redemptionId, current, current, code.id, current),
          context.env.DB.prepare(
            `INSERT INTO redemptions (
               id, code_id, user_id, idempotency_key_hash, status,
               type, value_micros, created_at_ms
             ) VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`,
          ).bind(
            redemptionId,
            code.id,
            user.id,
            idempotencyHash,
            code.type,
            code.value_micros,
            current,
          ),
        ])
      } catch (error) {
        redemption = await findRedemptionByIdempotency(context.env, user.id, idempotencyHash)
        if (
          redemption === null ||
          redemption.id !== redemptionId ||
          redemption.code_hash !== codeHash
        ) {
          throw mapClaimError(error)
        }
        if (redemption.status === 'completed') {
          await synchronizeCompletedSubscriptionRedemption(context.env, redemption)
          return controlSuccess(parseStoredResult(redemption))
        }
      }
    }

    try {
      validateRedeemPayload(code)
      if (code.type === 'balance') {
        return controlSuccess(await fulfillBalanceRedemption(context.env, user, redemptionId, code))
      }
      return controlSuccess(
        await fulfillSubscriptionRedemption(context.env, user.id, redemptionId, code),
      )
    } catch (error) {
      if (isDeterministicPreflightError(error)) {
        await releaseRedemptionClaim(context.env, redemptionId, code.id, user.id)
      }
      throw error
    }
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listUserRedemptions(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 50, 1, 100)
    const rows = await context.env.DB.prepare(
      `SELECT r.id, r.code_id, r.user_id, r.idempotency_key_hash, r.status,
              r.type, r.value_micros, r.subscription_id, r.result_json,
              r.created_at_ms, r.completed_at_ms,
              rc.code_hash, rc.code_prefix, rc.expires_at_ms AS code_expires_at_ms
         FROM redemptions r
         JOIN redeem_codes rc ON rc.id = r.code_id
        WHERE r.user_id = ?
        ORDER BY r.created_at_ms DESC, r.id DESC
        LIMIT ? OFFSET ?`,
    ).bind(user.id, pageSize, (page - 1) * pageSize).all<RedemptionRow>()
    return controlSuccess(rows.results.map((row) => ({
      id: row.id,
      code: `${row.code_prefix}…`,
      type: row.type,
      value: row.type === 'balance' ? microsToUsd(row.value_micros) : storedValidityDays(row),
      status: row.status === 'completed' ? 'used' : 'processing',
      used_at: nullableIso(row.completed_at_ms),
      created_at: iso(row.created_at_ms),
      subscription_id: row.subscription_id,
    })))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** HMAC digest used by both generation/admin code and the public redemption path. */
export function redeemCodeDigest(code: string, pepper: string): Promise<string> {
  return apiKeyDigest(`sub2api/redeem-code/v1\0${normalizeRedeemCode(code)}`, pepper)
}

async function fulfillBalanceRedemption(
  env: Env,
  user: { id: string; balance_micros: number; state_version: number; status: string },
  redemptionId: string,
  code: RedeemCodeRow,
): Promise<Record<string, unknown>> {
  await beginBalanceRedemptionEffect(env, redemptionId, code.id, user.id)
  await ensureUserState(env, user)
  const response = await userStatePost(env, user.id, '/balance/adjust', {
    schema_version: 1,
    mutation_id: `redeem:${redemptionId}`,
    amount_delta_micros: code.value_micros,
  })
  if (!response.ok) throw await stateError(response)
  const state = await parseBalanceState(response, user.id)
  const result = {
    message: 'Redeem code applied successfully',
    type: 'balance',
    value: microsToUsd(code.value_micros),
    value_micros: code.value_micros,
    new_balance: microsToUsd(state.balance_micros),
    new_balance_micros: state.balance_micros,
  }
  await finalizeRedemption(env, redemptionId, code.id, user.id, result, null)
  return result
}

async function fulfillSubscriptionRedemption(
  env: Env,
  userId: string,
  redemptionId: string,
  code: RedeemCodeRow,
): Promise<Record<string, unknown>> {
  if (code.group_id === null || code.validity_days === null) {
    throw new GatewayError(500, 'invalid_redeem_code', 'Redeem code is invalid', 'server_error')
  }
  const existing = await env.DB.prepare(
    `SELECT id, status, starts_at_ms, expires_at_ms
       FROM user_subscriptions WHERE user_id = ? AND group_id = ? LIMIT 1`,
  ).bind(userId, code.group_id).first<SubscriptionEntitlementRow>()
  const current = Date.now()
  const durationMs = checkedDuration(code.validity_days)
  if (existing !== null) {
    validateSubscriptionTimestamp(existing.starts_at_ms)
    validateSubscriptionTimestamp(existing.expires_at_ms)
  }
  if (existing?.status === 'suspended' || existing?.status === 'revoked') {
    throw subscriptionEntitlementNotRedeemable()
  }
  if (existing !== null) await synchronizeSubscriptionState(env, existing.id)
  const isExtending = existing !== null && existing.status === 'active' && existing.expires_at_ms > current
  if (isExtending) checkedTimestampAdd(existing.expires_at_ms, durationMs)
  const subscriptionId = existing?.id ?? await deterministicUuid(
    'user.subscription.entitlement.v1',
    `${userId}\0${code.group_id}`,
  )
  const startsAtMs = isExtending ? existing!.starts_at_ms : current
  const expiresAtMs = checkedTimestampAdd(current, durationMs)
  const dailyAnchorMs = expiresAtMs - startsAtMs <= DAY_MS ? startsAtMs : 0
  const dailyWindowStartMs = dailyAnchorMs +
    Math.floor((current - dailyAnchorMs) / DAY_MS) * DAY_MS
  const eventId = await deterministicUuid('user.subscription.event.v1', redemptionId)
  const intentId = await deterministicUuid(
    'subscription.state.sync.v1',
    `${redemptionId}\0${subscriptionId}`,
  )
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user_subscriptions (
           id, user_id, group_id, status, starts_at_ms, expires_at_ms,
           daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
           daily_used_micros, weekly_used_micros, monthly_used_micros,
           daily_anchor_ms, daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
           quota_reset_epoch, quota_reset_generation,
           source_type, source_id, control_version, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, 0, 0, 'redeem', ?, 0, ?, ?)
         ON CONFLICT(user_id, group_id) DO UPDATE SET
           status = 'active',
           starts_at_ms = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.starts_at_ms
             ELSE excluded.starts_at_ms
           END,
           expires_at_ms = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.expires_at_ms + ?
             ELSE excluded.expires_at_ms
           END,
           daily_quota_micros = excluded.daily_quota_micros,
           weekly_quota_micros = excluded.weekly_quota_micros,
           monthly_quota_micros = excluded.monthly_quota_micros,
           daily_used_micros = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.daily_used_micros
             ELSE 0
           END,
           weekly_used_micros = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.weekly_used_micros
             ELSE 0
           END,
           monthly_used_micros = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.monthly_used_micros
             ELSE 0
           END,
           daily_anchor_ms = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.daily_anchor_ms
             ELSE excluded.daily_anchor_ms
           END,
           daily_window_start_ms = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.daily_window_start_ms
             ELSE excluded.daily_window_start_ms
           END,
           weekly_window_start_ms = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.weekly_window_start_ms
             ELSE excluded.weekly_window_start_ms
           END,
           monthly_window_start_ms = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.monthly_window_start_ms
             ELSE excluded.monthly_window_start_ms
           END,
           quota_reset_epoch = CASE
             WHEN user_subscriptions.status = 'active' AND user_subscriptions.expires_at_ms > ?
               THEN user_subscriptions.quota_reset_epoch
             ELSE user_subscriptions.quota_reset_epoch + 1
           END,
           source_type = 'redeem', source_id = excluded.source_id,
           control_version = CASE
             WHEN user_subscriptions.status IN ('suspended', 'revoked') THEN -1
             ELSE user_subscriptions.control_version + 1
           END,
           updated_at_ms = excluded.updated_at_ms`,
      ).bind(
        subscriptionId,
        userId,
        code.group_id,
        startsAtMs,
        expiresAtMs,
        code.daily_quota_micros,
        code.weekly_quota_micros,
        code.monthly_quota_micros,
        dailyAnchorMs,
        dailyWindowStartMs,
        current,
        current,
        redemptionId,
        current,
        current,
        current,
        current,
        durationMs,
        current,
        current,
        current,
        current,
        current,
        current,
        current,
        current,
      ),
      subscriptionStateSyncStatement(env, redemptionId, intentId, subscriptionId, current),
      env.DB.prepare(
        `INSERT INTO subscription_events (
           id, subscription_id, user_id, group_id, event_type,
           source_type, source_id, validity_days, occurred_at_ms
         ) VALUES (
           ?, ?, ?, ?,
           CASE
             WHEN (SELECT expires_at_ms FROM user_subscriptions WHERE id = ?) > ?
               THEN 'extended'
             ELSE 'assigned'
           END,
           'redeem', ?, ?, ?
         )`,
      ).bind(
        eventId,
        subscriptionId,
        userId,
        code.group_id,
        subscriptionId,
        expiresAtMs,
        redemptionId,
        code.validity_days,
        current,
      ),
      env.DB.prepare(
        `UPDATE redeem_codes
            SET status = 'used', control_version = control_version + 1, updated_at_ms = ?
          WHERE id = ? AND status = 'processing'
            AND used_by_user_id = ? AND claimed_by_redemption_id = ?`,
      ).bind(current, code.id, userId, redemptionId),
      env.DB.prepare(
        `UPDATE redemptions
            SET status = 'completed', subscription_id = ?,
                result_json = (
                  SELECT json_object(
                    'message', 'Redeem code applied successfully',
                    'type', 'subscription',
                    'value', ?,
                    'group_id', subscription.group_id,
                    'subscription_id', subscription.id,
                    'expires_at_ms', subscription.expires_at_ms
                  )
                    FROM user_subscriptions subscription
                   WHERE subscription.id = ?
                ),
                completed_at_ms = ?
          WHERE id = ? AND status = 'processing' AND user_id = ?`,
      ).bind(
        subscriptionId,
        code.validity_days,
        subscriptionId,
        current,
        redemptionId,
        userId,
      ),
    ])
  } catch (error) {
    const recovered = await findRedemptionById(env, redemptionId)
    if (recovered?.status === 'completed') {
      await synchronizeCompletedSubscriptionRedemption(env, recovered)
      return parseStoredResult(recovered)
    }
    if (/redeem_code_unavailable/i.test(errorMessage(error))) {
      throw redeemUnavailable()
    }
    if (/invalid_subscription_timestamp/i.test(errorMessage(error))) {
      throw invalidSubscriptionExpiry()
    }
    if (/CHECK constraint failed:.*control_version/i.test(errorMessage(error))) {
      throw subscriptionEntitlementNotRedeemable()
    }
    throw error
  }
  const completed = await findRedemptionById(env, redemptionId)
  if (completed?.status !== 'completed') {
    throw new GatewayError(
      503,
      'redeem_result_unavailable',
      'Redeem result is unavailable',
      'server_error',
    )
  }
  await synchronizeSubscriptionState(env, subscriptionId)
  return parseStoredResult(completed)
}

function subscriptionStateSyncStatement(
  env: Env,
  requestId: string,
  intentId: string,
  subscriptionId: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO subscription_state_sync (
       id, request_id, subscription_id, operation, control_version,
       payload_json, status, attempts, created_at_ms, updated_at_ms
     )
     SELECT ?, ?, subscription.id, 'configure', subscription.control_version,
            json_object(
              'configuration', json_object(
                'schema_version', 1,
                'subscription_id', subscription.id,
                'user_id', subscription.user_id,
                'group_id', subscription.group_id,
                'starts_at_ms', subscription.starts_at_ms,
                'expires_at_ms', subscription.expires_at_ms,
                'daily_quota_micros', subscription.daily_quota_micros,
                'weekly_quota_micros', subscription.weekly_quota_micros,
                'monthly_quota_micros', subscription.monthly_quota_micros,
                'daily_used_micros', subscription.daily_used_micros,
                'weekly_used_micros', subscription.weekly_used_micros,
                'monthly_used_micros', subscription.monthly_used_micros,
                'daily_anchor_ms', subscription.daily_anchor_ms,
                'daily_window_start_ms', subscription.daily_window_start_ms,
                'weekly_window_start_ms', subscription.weekly_window_start_ms,
                'monthly_window_start_ms', subscription.monthly_window_start_ms,
                'quota_reset_epoch', subscription.quota_reset_epoch,
                'quota_reset_generation', subscription.quota_reset_generation,
                'control_version', subscription.control_version,
                'enabled', json(CASE
                  WHEN subscription.status = 'active'
                   AND subscription.starts_at_ms <= ?
                   AND subscription.expires_at_ms > ?
                  THEN 'true' ELSE 'false' END)
              )
            ),
            'pending', 0, ?, ?
       FROM user_subscriptions subscription
      WHERE subscription.id = ?`,
  ).bind(intentId, requestId, now, now, now, now, subscriptionId)
}

async function synchronizeCompletedSubscriptionRedemption(
  env: Env,
  redemption: Pick<RedemptionRow, 'type' | 'subscription_id'>,
): Promise<void> {
  if (redemption.type !== 'subscription') return
  if (redemption.subscription_id === null) {
    throw new GatewayError(
      503,
      'redeem_result_unavailable',
      'Subscription redemption result is unavailable',
      'server_error',
    )
  }
  await synchronizeSubscriptionState(env, redemption.subscription_id)
}

async function finalizeRedemption(
  env: Env,
  redemptionId: string,
  codeId: string,
  userId: string,
  result: Record<string, unknown>,
  subscriptionId: string | null,
): Promise<void> {
  const current = Date.now()
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE redeem_codes
            SET status = 'used', control_version = control_version + 1, updated_at_ms = ?
          WHERE id = ? AND status = 'processing'
            AND used_by_user_id = ? AND claimed_by_redemption_id = ?`,
      ).bind(current, codeId, userId, redemptionId),
      env.DB.prepare(
        `UPDATE redemptions
            SET status = 'completed', subscription_id = ?, result_json = ?, completed_at_ms = ?
          WHERE id = ? AND status = 'processing' AND user_id = ?`,
      ).bind(subscriptionId, JSON.stringify(result), current, redemptionId, userId),
    ])
  } catch (error) {
    const recovered = await findRedemptionById(env, redemptionId)
    if (recovered?.status !== 'completed') throw error
  }
  const completed = await findRedemptionById(env, redemptionId)
  if (completed?.status !== 'completed') {
    throw new GatewayError(
      503,
      'redeem_result_unavailable',
      'Redeem result is unavailable',
      'server_error',
    )
  }
}

async function beginBalanceRedemptionEffect(
  env: Env,
  redemptionId: string,
  codeId: string,
  userId: string,
): Promise<void> {
  const current = Date.now()
  try {
    const result = await env.DB.prepare(
      `UPDATE redemptions
          SET effect_started_at_ms = COALESCE(effect_started_at_ms, ?)
        WHERE id = ? AND code_id = ? AND user_id = ? AND status = 'processing'
          AND EXISTS (
            SELECT 1 FROM redeem_codes code
             WHERE code.id = redemptions.code_id
               AND code.status = 'processing'
               AND code.used_by_user_id = redemptions.user_id
               AND code.claimed_by_redemption_id = redemptions.id
          )`,
    ).bind(current, redemptionId, codeId, userId).run()
    if (result.meta.changes === 1) return
  } catch (error) {
    if (!/redeem_code_unavailable/i.test(errorMessage(error))) throw error
  }
  throw redeemUnavailable()
}

async function ensureUserState(
  env: Env,
  user: { id: string; balance_micros: number; state_version: number; status: string },
): Promise<void> {
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

function userStatePost(
  env: Env,
  userId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const stub = env.USER_STATE.get(env.USER_STATE.idFromName(userId))
  return stub.fetch(new Request(`https://user-state.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

async function parseBalanceState(response: Response, userId: string): Promise<{ balance_micros: number }> {
  const body = await response.json() as {
    profile?: { user_id?: unknown; balance_micros?: unknown }
  }
  if (
    body.profile?.user_id !== userId ||
    !Number.isSafeInteger(body.profile.balance_micros) ||
    (body.profile.balance_micros as number) < 0
  ) {
    throw new GatewayError(503, 'invalid_user_state', 'User state returned invalid data', 'server_error')
  }
  return { balance_micros: body.profile.balance_micros as number }
}

async function stateError(response: Response): Promise<GatewayError> {
  let code = 'state_operation_failed'
  let message = 'User state operation failed'
  try {
    const body = await response.clone().json() as { error?: { code?: unknown; message?: unknown } }
    if (typeof body.error?.code === 'string') code = body.error.code
    if (typeof body.error?.message === 'string') message = body.error.message
  } catch {
    // Preserve sanitized defaults for malformed internal responses.
  }
  return new GatewayError(response.status >= 400 && response.status < 500 ? response.status : 503, code, message)
}

async function responseErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = await response.clone().json() as { error?: { code?: unknown } }
    return typeof body.error?.code === 'string' ? body.error.code : undefined
  } catch {
    return undefined
  }
}

async function findRedeemCodeByHash(env: Env, digest: string): Promise<RedeemCodeRow | null> {
  return env.DB.prepare(`${redeemCodeSelect()} WHERE rc.code_hash = ? LIMIT 1`).bind(digest).first<RedeemCodeRow>()
}

async function findRedeemCodeById(env: Env, id: string): Promise<RedeemCodeRow | null> {
  return env.DB.prepare(`${redeemCodeSelect()} WHERE rc.id = ? LIMIT 1`).bind(id).first<RedeemCodeRow>()
}

function redeemCodeSelect(): string {
  return `SELECT rc.id, rc.code_hash, rc.code_prefix, rc.type, rc.value_micros,
                 rc.group_id, rc.validity_days, rc.status, rc.expires_at_ms,
                 rc.used_by_user_id, rc.claimed_by_redemption_id,
                 g.daily_quota_micros, g.weekly_quota_micros, g.monthly_quota_micros
            FROM redeem_codes rc
            LEFT JOIN "groups" g ON g.id = rc.group_id`
}

async function findRedemptionByIdempotency(
  env: Env,
  userId: string,
  idempotencyHash: string,
): Promise<RedemptionRow | null> {
  return env.DB.prepare(
    `${redemptionSelect()} WHERE r.user_id = ? AND r.idempotency_key_hash = ? LIMIT 1`,
  ).bind(userId, idempotencyHash).first<RedemptionRow>()
}

async function findRedemptionById(env: Env, id: string): Promise<RedemptionRow | null> {
  return env.DB.prepare(`${redemptionSelect()} WHERE r.id = ? LIMIT 1`).bind(id).first<RedemptionRow>()
}

function redemptionSelect(): string {
  return `SELECT r.id, r.code_id, r.user_id, r.idempotency_key_hash, r.status,
                 r.type, r.value_micros, r.subscription_id, r.result_json,
                 r.created_at_ms, r.completed_at_ms,
                 rc.code_hash, rc.code_prefix, rc.expires_at_ms AS code_expires_at_ms
            FROM redemptions r
            JOIN redeem_codes rc ON rc.id = r.code_id`
}

function validateRedeemAvailability(code: RedeemCodeRow, current: number): void {
  validateRedeemPayload(code)
  if (code.status !== 'unused') throw redeemUnavailable()
  if (code.expires_at_ms !== null && code.expires_at_ms <= current) throw redeemUnavailable()
  if (code.type === 'balance' && code.value_micros <= 0) throw redeemUnavailable()
  if (code.type === 'subscription' && (code.group_id === null || code.validity_days === null)) {
    throw redeemUnavailable()
  }
}

function validateRedeemPayload(code: RedeemCodeRow): void {
  if (!Number.isSafeInteger(code.value_micros) || code.value_micros < 0) {
    throw new GatewayError(500, 'invalid_redeem_amount', 'Redeem amount is invalid', 'server_error')
  }
  if (code.expires_at_ms !== null) validateDateTimestamp(code.expires_at_ms, 'invalid_redeem_timestamp')
  for (const quota of [
    code.daily_quota_micros,
    code.weekly_quota_micros,
    code.monthly_quota_micros,
  ]) {
    if (quota !== null && (!Number.isSafeInteger(quota) || quota < 0)) {
      throw new GatewayError(
        500,
        'invalid_subscription_amount',
        'Subscription amount is invalid',
        'server_error',
      )
    }
  }
  if (code.type === 'balance') {
    if (code.value_micros <= 0 || code.group_id !== null || code.validity_days !== null) {
      throw new GatewayError(500, 'invalid_redeem_code', 'Redeem code is invalid', 'server_error')
    }
    return
  }
  if (
    code.value_micros !== 0 || code.group_id === null ||
    !Number.isSafeInteger(code.validity_days) ||
    (code.validity_days as number) <= 0 || (code.validity_days as number) > 36_500
  ) {
    throw new GatewayError(500, 'invalid_redeem_code', 'Redeem code is invalid', 'server_error')
  }
}

function parseStoredResult(row: RedemptionRow): Record<string, unknown> {
  if (row.result_json === null) {
    throw new GatewayError(503, 'redeem_result_unavailable', 'Redeem result is unavailable', 'server_error')
  }
  try {
    const value: unknown = JSON.parse(row.result_json)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid result')
    const result = value as Record<string, unknown>
    if (result.type === 'subscription' && Object.hasOwn(result, 'expires_at_ms')) {
      const expiresAtMs = result.expires_at_ms
      if (
        !Number.isSafeInteger(expiresAtMs) ||
        (expiresAtMs as number) < 0 ||
        (expiresAtMs as number) > MAX_DATE_MS
      ) {
        throw new Error('invalid subscription expiry')
      }
      const { expires_at_ms: _storedExpiresAtMs, ...publicResult } = result
      return { ...publicResult, expires_at: iso(expiresAtMs as number) }
    }
    return result
  } catch {
    throw new GatewayError(503, 'redeem_result_unavailable', 'Redeem result is unavailable', 'server_error')
  }
}

function storedValidityDays(row: RedemptionRow): number {
  if (row.result_json === null) return 0
  try {
    const parsed = JSON.parse(row.result_json) as { value?: unknown }
    return typeof parsed.value === 'number' &&
      Number.isSafeInteger(parsed.value) && parsed.value > 0
      ? parsed.value
      : 0
  } catch {
    return 0
  }
}

function normalizeRedeemCode(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (normalized.length < 6 || normalized.length > 128 || !/^[A-Z0-9_-]+$/.test(normalized)) {
    throw new GatewayError(400, 'invalid_redeem_code', 'Redeem code format is invalid')
  }
  return normalized
}

function requirePepper(env: Env): string {
  if (typeof env.API_KEY_PEPPER !== 'string' || new TextEncoder().encode(env.API_KEY_PEPPER).byteLength < 32) {
    throw new GatewayError(503, 'redeem_not_configured', 'Redeem service is not configured', 'server_error')
  }
  return env.API_KEY_PEPPER
}

function redeemUnavailable(): GatewayError {
  return new GatewayError(409, 'redeem_code_unavailable', 'Redeem code is invalid, expired, or already used')
}

async function requireRedeemableSubscriptionEntitlement(
  env: Env,
  userId: string,
  groupId: string,
): Promise<void> {
  const existing = await env.DB.prepare(
    `SELECT status FROM user_subscriptions WHERE user_id = ? AND group_id = ? LIMIT 1`,
  ).bind(userId, groupId).first<Pick<SubscriptionEntitlementRow, 'status'>>()
  if (existing?.status === 'suspended' || existing?.status === 'revoked') {
    throw subscriptionEntitlementNotRedeemable()
  }
}

async function releaseRedemptionClaim(
  env: Env,
  redemptionId: string,
  codeId: string,
  userId: string,
): Promise<void> {
  const current = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM redemptions
        WHERE id = ? AND code_id = ? AND user_id = ? AND status = 'processing'
          AND effect_started_at_ms IS NULL`,
    ).bind(redemptionId, codeId, userId),
    env.DB.prepare(
      `UPDATE redeem_codes
          SET status = 'unused', used_by_user_id = NULL,
              claimed_by_redemption_id = NULL, used_at_ms = NULL,
              control_version = control_version + 1, updated_at_ms = ?
        WHERE id = ? AND status = 'processing'
          AND used_by_user_id = ? AND claimed_by_redemption_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM redemptions redemption
             WHERE redemption.id = redeem_codes.claimed_by_redemption_id
               AND redemption.effect_started_at_ms IS NOT NULL
          )`,
    ).bind(current, codeId, userId, redemptionId),
  ])
}

function subscriptionEntitlementNotRedeemable(): GatewayError {
  return new GatewayError(
    409,
    'subscription_entitlement_not_redeemable',
    'A suspended or revoked subscription cannot be extended with a redeem code',
  )
}

function invalidSubscriptionExpiry(): GatewayError {
  return new GatewayError(
    500,
    'invalid_subscription_expiry',
    'Subscription expiry is invalid',
    'server_error',
  )
}

function isDeterministicPreflightError(error: unknown): boolean {
  return error instanceof GatewayError && [
    'subscription_entitlement_not_redeemable',
    'redeem_code_unavailable',
    'invalid_redeem_amount',
    'invalid_redeem_code',
    'invalid_redeem_timestamp',
    'invalid_subscription_amount',
    'invalid_subscription_duration',
    'invalid_subscription_expiry',
  ].includes(error.code)
}

function mapClaimError(error: unknown): GatewayError {
  const message = error instanceof Error ? error.message : String(error)
  if (/redeem_code_unavailable|UNIQUE constraint failed: redemptions\.code_id/i.test(message)) {
    return redeemUnavailable()
  }
  return asGatewayError(error)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function checkedDuration(days: number): number {
  if (!Number.isSafeInteger(days) || days <= 0 || days > 36_500) {
    throw new GatewayError(500, 'invalid_subscription_duration', 'Subscription duration is invalid', 'server_error')
  }
  const value = days * DAY_MS
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GatewayError(500, 'invalid_subscription_duration', 'Subscription duration is invalid', 'server_error')
  }
  return value
}

function checkedTimestampAdd(value: number, delta: number): number {
  if (
    !Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS ||
    !Number.isSafeInteger(delta) || delta <= 0 ||
    value > MAX_DATE_MS - delta
  ) {
    throw invalidSubscriptionExpiry()
  }
  return value + delta
}

function validateSubscriptionTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
    throw invalidSubscriptionExpiry()
  }
}

function microsToUsd(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError(500, 'invalid_redeem_amount', 'Redeem amount is invalid', 'server_error')
  }
  return value / 1_000_000
}

function iso(value: number): string {
  validateDateTimestamp(value, 'invalid_redeem_timestamp')
  return new Date(value).toISOString()
}

function nullableIso(value: number | null): string | null {
  return value === null ? null : iso(value)
}

function validateDateTimestamp(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
    throw new GatewayError(500, code, 'Redeem timestamp is invalid', 'server_error')
  }
}
