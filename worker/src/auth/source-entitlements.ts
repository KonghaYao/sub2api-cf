import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'
import type { AuthSource, AuthSourceQuotaPlatform } from '../control/settings'

export type AuthSourceGrantReason = 'signup' | 'first_bind'

export type AuthSourceGrantGuard =
  | { kind: 'user'; value: string }
  | { kind: 'identity'; value: string }
  | { kind: 'email_binding'; value: string }

interface DefaultRow {
  balance_micros: number
  concurrency: number
  grant_on_signup: number
  grant_on_first_bind: number
}

interface SubscriptionRow {
  group_id: string
  validity_days: number
}

interface QuotaRow {
  platform: AuthSourceQuotaPlatform
  daily_limit_micros: number | null
  weekly_limit_micros: number | null
  monthly_limit_micros: number | null
}

interface PendingBalanceEffectRow {
  grant_id: string
  user_id: string
  balance_micros: number
  status: 'pending' | 'applied'
  user_balance_micros: number
  user_state_version: number
  user_status: 'active' | 'disabled'
}

export interface PreparedAuthSourceGrant {
  enabled: boolean
  grantId: string | null
  balanceMicros: number
  concurrency: number
  subscriptionIds: string[]
  statements: D1PreparedStatement[]
}

const DAY_MS = 86_400_000

/**
 * Produces statements for the caller's authentication batch. Every mutation is
 * gated by both the auth write guard and this attempt's winning ledger nonce.
 */
export async function prepareAuthSourceGrant(
  env: Env,
  userId: string,
  source: AuthSource,
  reason: AuthSourceGrantReason,
  guard: AuthSourceGrantGuard,
  now: number,
): Promise<PreparedAuthSourceGrant> {
  let defaults = await env.DB.prepare(
    `SELECT balance_micros, concurrency, grant_on_signup, grant_on_first_bind
       FROM auth_source_defaults WHERE source = ? LIMIT 1`,
  ).bind(source).first<DefaultRow>()
  if (defaults === null) throw unavailable()
  validateDefault(defaults)
  const enabled = reason === 'signup'
    ? defaults.grant_on_signup === 1
    : defaults.grant_on_first_bind === 1
  let globalFallback = false
  if (!enabled) {
    if (reason !== 'signup') return emptyGrant()
    const global = await env.DB.prepare("SELECT public_json FROM system_settings WHERE id='global'").first<{ public_json: string }>()
    const settings = global ? JSON.parse(global.public_json) as Record<string, unknown> : {}
    if (settings.default_balance === undefined && settings.default_concurrency === undefined) return emptyGrant()
    defaults = { ...defaults, balance_micros: Math.round(Number(settings.default_balance ?? 0) * 1e6), concurrency: Number(settings.default_concurrency ?? 5) }
    validateDefault(defaults)
    globalFallback = true
  }

  const subscriptions = globalFallback ? [] : (await env.DB.prepare(
    `SELECT group_id, validity_days FROM auth_source_default_subscriptions
      WHERE source = ? ORDER BY group_id`,
  ).bind(source).all<SubscriptionRow>()).results
  const quotas = globalFallback ? [] : (await env.DB.prepare(
    `SELECT platform, daily_limit_micros, weekly_limit_micros, monthly_limit_micros
       FROM auth_source_default_platform_quotas WHERE source = ? ORDER BY platform`,
  ).bind(source).all<QuotaRow>()).results
  validateGrantConfiguration(subscriptions, quotas)

  const grantId = crypto.randomUUID()
  const attemptNonce = crypto.randomUUID()
  const guardCondition = grantGuardCondition(guard)
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO auth_source_entitlement_grants (
         id, user_id, source, reason, attempt_nonce, balance_micros,
         concurrency, subscriptions_json, platform_quotas_json, created_at_ms
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${guardCondition.sql}
       ON CONFLICT(user_id, source, reason) DO NOTHING`,
    ).bind(
      grantId, userId, source, reason, attemptNonce, defaults.balance_micros,
      defaults.concurrency, JSON.stringify(subscriptions), JSON.stringify(quotas), now,
      ...guardCondition.bindings,
    ),
  ]

  if (reason === 'signup') {
    statements.push(env.DB.prepare(
      `UPDATE users
          SET balance_micros = balance_micros + ?, concurrency = ?, updated_at_ms = ?
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM auth_source_entitlement_grants
           WHERE user_id = ? AND source = ? AND reason = ? AND attempt_nonce = ?
        )`,
    ).bind(
      defaults.balance_micros, defaults.concurrency, now,
      userId, userId, source, reason, attemptNonce,
    ))
  } else {
    statements.push(
      env.DB.prepare(
        `UPDATE users
            SET concurrency = concurrency + ?, updated_at_ms = ?
          WHERE id = ? AND EXISTS (
            SELECT 1 FROM auth_source_entitlement_grants
             WHERE user_id = ? AND source = ? AND reason = ? AND attempt_nonce = ?
          )`,
      ).bind(defaults.concurrency, now, userId, userId, source, reason, attemptNonce),
    )
    if (defaults.balance_micros > 0) statements.push(env.DB.prepare(
        `INSERT INTO auth_source_entitlement_balance_effects (grant_id, status, updated_at_ms)
         SELECT id, 'pending', ? FROM auth_source_entitlement_grants
          WHERE user_id = ? AND source = ? AND reason = ? AND attempt_nonce = ?`,
      ).bind(now, userId, source, reason, attemptNonce))
  }

  statements.push(...platformQuotaStatements(env, userId, source, reason, attemptNonce, quotas, now))
  const subscriptionIds: string[] = []
  for (const subscription of subscriptions) {
    const subscriptionId = crypto.randomUUID()
    subscriptionIds.push(subscriptionId)
    statements.push(...subscriptionStatements(
      env, userId, source, reason, attemptNonce, grantId,
      subscriptionId, subscription, now,
    ))
  }
  return {
    enabled: true,
    grantId,
    balanceMicros: defaults.balance_micros,
    concurrency: defaults.concurrency,
    subscriptionIds,
    statements,
  }
}

/** Replays first-bind DO side effects by immutable grant id. */
export async function settleAuthSourceGrant(env: Env, grantId: string | null): Promise<void> {
  if (grantId === null) return
  const effect = await env.DB.prepare(
    `SELECT grant.id AS grant_id, grant.user_id, grant.balance_micros, effect.status,
            user.balance_micros AS user_balance_micros, user.state_version AS user_state_version,
            user.status AS user_status
       FROM auth_source_entitlement_grants grant
       JOIN auth_source_entitlement_balance_effects effect ON effect.grant_id = grant.id
       JOIN users user ON user.id = grant.user_id
      WHERE grant.id = ? AND grant.reason = 'first_bind' LIMIT 1`,
  ).bind(grantId).first<PendingBalanceEffectRow>()
  if (effect !== null && effect.status === 'pending') await settleBalanceEffect(env, effect)

  // Entitlements and their durable subscription_state_sync intents were committed
  // together. The dedicated bounded recovery task applies them; gateway first use
  // also configures the selected subscription. Never fan out across every grant
  // subscription in an authentication request.

}

export async function findAuthSourceGrantId(
  env: Env,
  userId: string,
  source: AuthSource,
  reason: AuthSourceGrantReason,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM auth_source_entitlement_grants
      WHERE user_id = ? AND source = ? AND reason = ? LIMIT 1`,
  ).bind(userId, source, reason).first<{ id: string }>()
  return row?.id ?? null
}

/** Bounded recovery seam used by sign-in and safe to call repeatedly. */
export async function recoverPendingAuthSourceGrants(
  env: Env,
  userId: string,
  limit = 1,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT grant.id
       FROM auth_source_entitlement_grants grant
       LEFT JOIN auth_source_entitlement_balance_effects effect ON effect.grant_id = grant.id
      WHERE grant.user_id = ? AND grant.reason = 'first_bind'
        AND effect.status = 'pending'
      ORDER BY grant.created_at_ms, grant.id LIMIT ?`,
  ).bind(userId, Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1) : 1).all<{ id: string }>()
  for (const row of rows.results) await settleAuthSourceGrant(env, row.id)
}

/** Cron recovery for users who continue through API keys or passkeys after a partial bind. */
export async function recoverPendingAuthSourceGrantEffects(
  env: Env,
  limit = 1,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('auth source grant recovery limit must be between 1 and 100')
  }
  const rows = await env.DB.prepare(
    `SELECT grant.id
       FROM auth_source_entitlement_grants grant
       LEFT JOIN auth_source_entitlement_balance_effects effect ON effect.grant_id = grant.id
      WHERE grant.reason = 'first_bind'
        AND effect.status = 'pending'
      ORDER BY grant.created_at_ms, grant.id LIMIT ?`,
  ).bind(limit).all<{ id: string }>()
  let recovered = 0
  for (const row of rows.results) {
    try {
      await settleAuthSourceGrant(env, row.id)
      recovered += 1
    } catch (error) {
      console.error('auth source grant recovery failed', {
        grant_id: row.id,
        name: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  return recovered
}

function platformQuotaStatements(
  env: Env,
  userId: string,
  source: AuthSource,
  reason: AuthSourceGrantReason,
  attemptNonce: string,
  quotas: QuotaRow[],
  now: number,
): D1PreparedStatement[] {
  if (quotas.length === 0) return []
  const ledger = `EXISTS (
    SELECT 1 FROM auth_source_entitlement_grants
     WHERE user_id = ? AND source = ? AND reason = ? AND attempt_nonce = ?
  )`
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO user_platform_quota_sets (user_id, control_version, last_mutation_id, updated_at_ms)
     SELECT ?, 0, ?, ? WHERE ${ledger}
     ON CONFLICT(user_id) DO UPDATE SET
       control_version = user_platform_quota_sets.control_version + 1,
       last_mutation_id = excluded.last_mutation_id,
       updated_at_ms = excluded.updated_at_ms`,
  ).bind(userId, attemptNonce, now, userId, source, reason, attemptNonce)]
  for (const quota of quotas) {
    statements.push(env.DB.prepare(
      `INSERT INTO user_platform_quotas (
         user_id, platform, enabled, daily_limit_micros, weekly_limit_micros,
         monthly_limit_micros, control_version, created_at_ms, updated_at_ms
       )
       SELECT ?, ?, 1, ?, ?, ?, 0, ?, ? WHERE ${ledger}
       ON CONFLICT(user_id, platform) DO UPDATE SET
         enabled = 1,
         daily_limit_micros = excluded.daily_limit_micros,
         weekly_limit_micros = excluded.weekly_limit_micros,
         monthly_limit_micros = excluded.monthly_limit_micros,
         control_version = user_platform_quotas.control_version + 1,
         updated_at_ms = excluded.updated_at_ms`,
    ).bind(
      userId, quota.platform, quota.daily_limit_micros, quota.weekly_limit_micros,
      quota.monthly_limit_micros, now, now,
      userId, source, reason, attemptNonce,
    ))
  }
  return statements
}

function subscriptionStatements(
  env: Env,
  userId: string,
  source: AuthSource,
  reason: AuthSourceGrantReason,
  attemptNonce: string,
  grantId: string,
  subscriptionId: string,
  item: SubscriptionRow,
  now: number,
): D1PreparedStatement[] {
  const durationMs = item.validity_days * DAY_MS
  const expiresAt = now + durationMs
  const dailyAnchor = durationMs <= DAY_MS ? now : 0
  const dailyWindowStart = dailyAnchor + Math.floor((now - dailyAnchor) / DAY_MS) * DAY_MS
  const requestId = `${grantId}:${item.group_id}`
  const intentId = crypto.randomUUID()
  const eventId = crypto.randomUUID()
  const ledger = `EXISTS (
    SELECT 1 FROM auth_source_entitlement_grants
     WHERE user_id = ? AND source = ? AND reason = ? AND attempt_nonce = ?
  )`
  return [
    env.DB.prepare(
      `INSERT INTO user_subscriptions (
         id, user_id, group_id, status, starts_at_ms, expires_at_ms,
         daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
         daily_used_micros, weekly_used_micros, monthly_used_micros,
         daily_anchor_ms, daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
         quota_reset_epoch, quota_reset_generation,
         source_type, source_id, notes, control_version, created_at_ms, updated_at_ms
       )
       SELECT ?, ?, g.id, 'active', ?, ?,
              g.daily_quota_micros, g.weekly_quota_micros, g.monthly_quota_micros,
              0, 0, 0, ?, ?, ?, ?, 0, 0,
              'registration', ?, ?, 0, ?, ?
         FROM "groups" g
        WHERE g.id = ? AND g.group_type = 'subscription' AND ${ledger}
       ON CONFLICT(user_id, group_id) DO UPDATE SET
         status = 'active',
         starts_at_ms = CASE WHEN user_subscriptions.expires_at_ms > ?
           THEN user_subscriptions.starts_at_ms ELSE excluded.starts_at_ms END,
         expires_at_ms = CASE WHEN user_subscriptions.expires_at_ms > ?
           THEN user_subscriptions.expires_at_ms + ? ELSE excluded.expires_at_ms END,
         daily_used_micros = CASE WHEN user_subscriptions.expires_at_ms > ? THEN user_subscriptions.daily_used_micros ELSE 0 END,
         weekly_used_micros = CASE WHEN user_subscriptions.expires_at_ms > ? THEN user_subscriptions.weekly_used_micros ELSE 0 END,
         monthly_used_micros = CASE WHEN user_subscriptions.expires_at_ms > ? THEN user_subscriptions.monthly_used_micros ELSE 0 END,
         daily_anchor_ms = CASE WHEN user_subscriptions.expires_at_ms > ? THEN user_subscriptions.daily_anchor_ms ELSE excluded.daily_anchor_ms END,
         daily_window_start_ms = CASE WHEN user_subscriptions.expires_at_ms > ? THEN user_subscriptions.daily_window_start_ms ELSE excluded.daily_window_start_ms END,
         weekly_window_start_ms = CASE WHEN user_subscriptions.expires_at_ms > ? THEN user_subscriptions.weekly_window_start_ms ELSE excluded.weekly_window_start_ms END,
         monthly_window_start_ms = CASE WHEN user_subscriptions.expires_at_ms > ? THEN user_subscriptions.monthly_window_start_ms ELSE excluded.monthly_window_start_ms END,
         quota_reset_epoch = CASE WHEN user_subscriptions.expires_at_ms > ? THEN user_subscriptions.quota_reset_epoch ELSE user_subscriptions.quota_reset_epoch + 1 END,
         quota_reset_generation = CASE WHEN user_subscriptions.expires_at_ms > ? THEN user_subscriptions.quota_reset_generation ELSE user_subscriptions.quota_reset_generation + 1 END,
         source_type = 'registration', source_id = excluded.source_id,
         notes = CASE WHEN user_subscriptions.notes = '' THEN excluded.notes ELSE user_subscriptions.notes || char(10) || excluded.notes END,
         control_version = user_subscriptions.control_version + 1,
         updated_at_ms = excluded.updated_at_ms`,
    ).bind(
      subscriptionId, userId, now, expiresAt,
      dailyAnchor, dailyWindowStart, now, now,
      grantId, `auto assigned by ${reason} defaults`, now, now,
      item.group_id, userId, source, reason, attemptNonce,
      now, now, durationMs, now, now, now, now, now, now, now, now, now,
    ),
    subscriptionStateSyncStatement(env, requestId, intentId, userId, item.group_id, now, ledger, [
      userId, source, reason, attemptNonce,
    ]),
    env.DB.prepare(
      `INSERT INTO subscription_events (
         id, subscription_id, user_id, group_id, event_type,
         source_type, source_id, validity_days, occurred_at_ms
       )
       SELECT ?, subscription.id, ?, ?,
              CASE WHEN subscription.id = ? THEN 'assigned' ELSE 'extended' END,
              'registration', ?, ?, ?
         FROM user_subscriptions subscription
        WHERE subscription.user_id = ? AND subscription.group_id = ? AND ${ledger}`,
    ).bind(
      eventId, userId, item.group_id, subscriptionId,
      requestId, item.validity_days, now, userId, item.group_id,
      userId, source, reason, attemptNonce,
    ),
  ]
}

function subscriptionStateSyncStatement(
  env: Env,
  requestId: string,
  intentId: string,
  userId: string,
  groupId: string,
  now: number,
  ledger: string,
  ledgerBindings: unknown[],
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO subscription_state_sync (
       id, request_id, subscription_id, operation, control_version,
       payload_json, status, attempts, created_at_ms, updated_at_ms
     )
     SELECT ?, ?, subscription.id, 'configure', subscription.control_version,
            json_object('configuration', json_object(
              'schema_version', 1, 'subscription_id', subscription.id,
              'user_id', subscription.user_id, 'group_id', subscription.group_id,
              'starts_at_ms', subscription.starts_at_ms, 'expires_at_ms', subscription.expires_at_ms,
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
              'enabled', json(CASE WHEN subscription.status = 'active'
                AND subscription.starts_at_ms <= ? AND subscription.expires_at_ms > ?
                THEN 'true' ELSE 'false' END)
            )), 'pending', 0, ?, ?
       FROM user_subscriptions subscription
      WHERE subscription.user_id = ? AND subscription.group_id = ? AND ${ledger}`,
  ).bind(intentId, requestId, now, now, now, now, userId, groupId, ...ledgerBindings)
}

async function settleBalanceEffect(env: Env, effect: PendingBalanceEffectRow): Promise<void> {
  const configured = await userStatePost(env, effect.user_id, '/configure', {
    schema_version: 1,
    mutation_id: `d1-user:${effect.user_state_version}`,
    user_id: effect.user_id,
    balance_micros: effect.user_balance_micros,
    enabled: effect.user_status === 'active',
    initial_state_version: effect.user_state_version,
  })
  if (!configured.ok && await responseErrorCode(configured) !== 'user_already_configured') {
    await recordBalanceFailure(env, effect.grant_id, configured.statusText)
    throw unavailable()
  }
  const adjusted = await userStatePost(env, effect.user_id, '/balance/adjust', {
    schema_version: 1,
    mutation_id: `auth-source-grant:${effect.grant_id}`,
    amount_delta_micros: effect.balance_micros,
  })
  if (!adjusted.ok) {
    await recordBalanceFailure(env, effect.grant_id, adjusted.statusText)
    throw unavailable()
  }
  const body = await adjusted.json() as {
    profile?: { user_id?: unknown; balance_micros?: unknown }
    state_version?: unknown
  }
  if (
    body.profile?.user_id !== effect.user_id ||
    !Number.isSafeInteger(body.profile.balance_micros) || (body.profile.balance_micros as number) < 0 ||
    !Number.isSafeInteger(body.state_version) || (body.state_version as number) < 0
  ) {
    await recordBalanceFailure(env, effect.grant_id, 'invalid user state response')
    throw unavailable()
  }
  const appliedAt = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET balance_micros = ?, state_version = ?, updated_at_ms = ?
        WHERE id = ? AND state_version < ?`,
    ).bind(body.profile.balance_micros, body.state_version, appliedAt, effect.user_id, body.state_version),
    env.DB.prepare(
      `UPDATE auth_source_entitlement_balance_effects
          SET status = 'applied', attempts = attempts + 1, balance_after_micros = ?,
              state_version = ?, last_error = NULL, updated_at_ms = ?, applied_at_ms = ?
        WHERE grant_id = ? AND status = 'pending'`,
    ).bind(body.profile.balance_micros, body.state_version, appliedAt, appliedAt, effect.grant_id),
  ])
}

async function recordBalanceFailure(env: Env, grantId: string, message: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE auth_source_entitlement_balance_effects
        SET attempts = attempts + 1, last_error = ?, updated_at_ms = ?
      WHERE grant_id = ? AND status = 'pending'`,
  ).bind(message.slice(0, 500), Date.now(), grantId).run()
}

function userStatePost(env: Env, userId: string, path: string, body: Record<string, unknown>): Promise<Response> {
  const stub = env.USER_STATE.get(env.USER_STATE.idFromName(userId))
  return stub.fetch(new Request(`https://user-state.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

async function responseErrorCode(response: Response): Promise<string> {
  try {
    return String((await response.clone().json() as { error?: { code?: unknown } }).error?.code ?? '')
  } catch {
    return ''
  }
}

function grantGuardCondition(guard: AuthSourceGrantGuard): { sql: string; bindings: unknown[] } {
  if (guard.kind === 'user') {
    return { sql: 'EXISTS (SELECT 1 FROM users WHERE id = ?)', bindings: [guard.value] }
  }
  if (guard.kind === 'identity') {
    return { sql: 'EXISTS (SELECT 1 FROM auth_identities WHERE id = ?)', bindings: [guard.value] }
  }
  return {
    sql: `EXISTS (SELECT 1 FROM email_binding_challenges
      WHERE consume_nonce = ? AND status = 'consumed')`,
    bindings: [guard.value],
  }
}

function validateDefault(row: DefaultRow): void {
  if (
    !Number.isSafeInteger(row.balance_micros) || row.balance_micros < 0 ||
    !Number.isSafeInteger(row.concurrency) || row.concurrency <= 0 ||
    ![0, 1].includes(row.grant_on_signup) || ![0, 1].includes(row.grant_on_first_bind)
  ) throw unavailable()
}

function validateGrantConfiguration(subscriptions: SubscriptionRow[], quotas: QuotaRow[]): void {
  if (subscriptions.some((item) => !Number.isSafeInteger(item.validity_days) || item.validity_days < 1 || item.validity_days > 36_500)) {
    throw unavailable()
  }
  for (const quota of quotas) {
    for (const value of [quota.daily_limit_micros, quota.weekly_limit_micros, quota.monthly_limit_micros]) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw unavailable()
    }
  }
}

function emptyGrant(): PreparedAuthSourceGrant {
  return { enabled: false, grantId: null, balanceMicros: 0, concurrency: 0, subscriptionIds: [], statements: [] }
}

function unavailable(): GatewayError {
  return new GatewayError(503, 'auth_source_entitlement_unavailable', 'Authentication source entitlement is unavailable', 'server_error')
}
