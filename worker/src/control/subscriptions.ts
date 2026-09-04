import type { Context } from 'hono'

import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { normalizeSubscriptionWindows } from '../subscription-windows'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
} from './idempotency'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  optionalSafeInteger,
  optionalString,
  queryInteger,
  readJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
  requireSafeInteger,
  requireString,
} from './http'

type ControlBindings = { Bindings: Env }
type SubscriptionStatus = 'active' | 'suspended' | 'revoked' | 'expired'
type WindowKind = 'daily' | 'weekly' | 'monthly'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const MONTH_MS = 30 * DAY_MS
const MAX_DATE_MS = 8_640_000_000_000_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_BULK_USERS = 100
const RECOVERY_LIMIT = 4

interface SubscriptionRow {
  id: string
  user_id: string
  group_id: string
  plan_id: string | null
  status: SubscriptionStatus
  starts_at_ms: number
  expires_at_ms: number
  daily_quota_micros: number | null
  weekly_quota_micros: number | null
  monthly_quota_micros: number | null
  daily_used_micros: number
  weekly_used_micros: number
  monthly_used_micros: number
  daily_anchor_ms: number
  daily_window_start_ms: number | null
  weekly_window_start_ms: number | null
  monthly_window_start_ms: number | null
  quota_reset_epoch: number
  quota_reset_generation: number
  source_type: 'admin' | 'registration' | 'redeem' | 'payment'
  source_id: string
  notes: string
  control_version: number
  created_at_ms: number
  updated_at_ms: number
  user_email: string
  user_display_name: string
  user_status: 'active' | 'disabled'
  group_name: string
  group_description: string | null
  group_platform: string
  group_enabled: number
  group_type: 'standard' | 'subscription'
  group_rate_multiplier_ppm: number
  effective_rate_multiplier_ppm: number
}

interface UserRow {
  id: string
  email: string
  display_name: string
  status: 'active' | 'disabled'
}

interface GroupRow {
  id: string
  name: string
  description: string | null
  platform: string
  enabled: number
  group_type: 'standard' | 'subscription'
  rate_multiplier_ppm: number
  daily_quota_micros: number | null
  weekly_quota_micros: number | null
  monthly_quota_micros: number | null
}

interface AssignmentInput {
  user_id: string
  group_id: string
  validity_days: number
  notes: string
}

interface ResetWindows {
  daily: number | null
  weekly: number | null
  monthly: number | null
}

interface StateSyncPayload {
  configuration: Record<string, unknown>
  reset?: {
    schema_version: 1
    mutation_id: string
    subscription_id: string
    control_version: number
    windows: ResetWindows
  }
}

interface StateSyncRow {
  id: string
  request_id: string
  subscription_id: string
  operation: 'configure' | 'reset_quota'
  control_version: number
  payload_json: string
  attempts: number
}

interface BulkAssignResponse {
  success_count: number
  created_count: number
  reused_count: number
  failed_count: number
  subscriptions: Array<Record<string, unknown>>
  errors: string[]
  statuses: Record<string, 'created' | 'reused' | 'failed'>
}

export async function listAdminSubscriptions(context: Context<ControlBindings>): Promise<Response> {
  try {
    await recoverPendingSubscriptionState(context.env)
    return await listSubscriptions(context)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminSubscription(context: Context<ControlBindings>): Promise<Response> {
  try {
    await recoverPendingSubscriptionState(context.env)
    return controlSuccess(publicSubscription(await requireSubscription(context.env, context.req.param('id')), Date.now()))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminSubscriptionProgress(context: Context<ControlBindings>): Promise<Response> {
  try {
    await recoverPendingSubscriptionState(context.env)
    const row = await requireSubscription(context.env, context.req.param('id'))
    return controlSuccess(subscriptionProgress(row, Date.now()))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminGroupSubscriptions(context: Context<ControlBindings>): Promise<Response> {
  try {
    await recoverPendingSubscriptionState(context.env)
    const groupId = requireUuid(context.req.param('id'), 'group_id')
    await requireGroup(context.env, groupId, false)
    return await listSubscriptions(context, { groupId })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminUserSubscriptions(context: Context<ControlBindings>): Promise<Response> {
  try {
    await recoverPendingSubscriptionState(context.env)
    const userId = requireUuid(context.req.param('id'), 'user_id')
    await requireUser(context.env, userId, false)
    return await listSubscriptions(context, { userId })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function assignAdminSubscription(context: Context<ControlBindings>): Promise<Response> {
  try {
    await recoverPendingSubscriptionState(context.env)
    const key = requireIdempotencyKey(context.req.raw)
    const input = parseAssignment(await readJsonObject(context.req.raw))
    const scope = 'admin.subscriptions.assign.v1'
    const requestId = await deterministicUuid(scope, key)
    const idempotency = await controlIdempotency(scope, key, input)
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      const response = parseIdempotentResponse<Record<string, unknown>>(previous, 'subscription')
      await synchronizeRequest(context.env, requestId)
      return controlSuccess(response)
    }

    const [user, group] = await Promise.all([
      requireUser(context.env, input.user_id, true),
      requireGroup(context.env, input.group_id, true),
    ])
    const existing = await findSubscriptionByUserGroup(context.env, user.id, group.id)
    if (existing !== null) await synchronizeSubscriptionState(context.env, existing.id)
    const current = Date.now()
    const duration = checkedDuration(input.validity_days)
    let row: SubscriptionRow
    let created: boolean
    const statements: D1PreparedStatement[] = []
    if (existing === null) {
      created = true
      const subscriptionId = await deterministicUuid(
        'user.subscription.entitlement.v1',
        `${user.id}\0${group.id}`,
      )
      const expiresAt = checkedTimestampAdd(current, duration)
      const dailyAnchor = initialDailyAnchor(current, expiresAt)
      row = joinedFromParts({
        id: subscriptionId,
        user_id: user.id,
        group_id: group.id,
        plan_id: null,
        status: 'active',
        starts_at_ms: current,
        expires_at_ms: expiresAt,
        daily_quota_micros: group.daily_quota_micros,
        weekly_quota_micros: group.weekly_quota_micros,
        monthly_quota_micros: group.monthly_quota_micros,
        daily_used_micros: 0,
        weekly_used_micros: 0,
        monthly_used_micros: 0,
        daily_anchor_ms: dailyAnchor,
        daily_window_start_ms: dailyWindowStart(dailyAnchor, current),
        weekly_window_start_ms: current,
        monthly_window_start_ms: current,
        quota_reset_epoch: 0,
        quota_reset_generation: 0,
        source_type: 'admin',
        source_id: requestId,
        notes: input.notes,
        control_version: 0,
        created_at_ms: current,
        updated_at_ms: current,
      }, user, group, await effectiveRate(context.env, user.id, group))
      statements.push(insertSubscriptionStatement(context.env, row))
    } else {
      if (existing.status === 'suspended' || existing.status === 'revoked') {
        throw new GatewayError(409, 'subscription_not_assignable', 'Suspended or revoked subscriptions cannot be reassigned')
      }
      if (effectiveStatus(existing, current) === 'active') {
        throw new GatewayError(409, 'subscription_already_exists', 'An active subscription already exists for this user and group')
      }
      created = false
      assertVersionAvailable(existing.control_version)
      const expiresAt = checkedTimestampAdd(current, duration)
      const dailyAnchor = initialDailyAnchor(current, expiresAt)
      row = {
        ...existing,
        status: 'active',
        starts_at_ms: current,
        expires_at_ms: expiresAt,
        daily_quota_micros: group.daily_quota_micros,
        weekly_quota_micros: group.weekly_quota_micros,
        monthly_quota_micros: group.monthly_quota_micros,
        daily_used_micros: 0,
        weekly_used_micros: 0,
        monthly_used_micros: 0,
        daily_anchor_ms: dailyAnchor,
        daily_window_start_ms: dailyWindowStart(dailyAnchor, current),
        weekly_window_start_ms: current,
        monthly_window_start_ms: current,
        quota_reset_epoch: existing.quota_reset_epoch + 1,
        source_type: 'admin',
        source_id: requestId,
        notes: input.notes,
        control_version: existing.control_version + 1,
        updated_at_ms: current,
      }
      statements.push(updateSubscriptionStatement(context.env, row, existing.control_version))
    }

    const intentId = await deterministicUuid('subscription.state.sync.v1', `${requestId}\0${row.id}`)
    const response = publicSubscription(row, current)
    statements.push(
      subscriptionEventStatement(context.env, row, intentId, created ? 'assigned' : 'extended', input.validity_days, current),
      stateSyncStatement(context.env, row, requestId, intentId, 'configure', undefined, current),
      controlIdempotencyInsert(context.env, idempotency, 'subscription', row.id, response, current),
    )
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered === null) throw mapSubscriptionWriteError(error)
      const replay = parseIdempotentResponse<Record<string, unknown>>(recovered, 'subscription')
      await synchronizeRequest(context.env, requestId)
      return controlSuccess(replay)
    }
    await synchronizeRequest(context.env, requestId)
    return controlSuccess(response, created ? 201 : 200)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function bulkAssignAdminSubscriptions(context: Context<ControlBindings>): Promise<Response> {
  try {
    await recoverPendingSubscriptionState(context.env)
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const input = parseBulkAssignment(body)
    const scope = 'admin.subscriptions.bulk-assign.v1'
    const requestId = await deterministicUuid(scope, key)
    const idempotency = await controlIdempotency(scope, key, input)
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      const response = parseIdempotentResponse<BulkAssignResponse>(previous, 'subscription_bulk')
      await synchronizeRequest(context.env, requestId)
      return controlSuccess(response)
    }

    const group = await requireGroup(context.env, input.group_id, true)
    const current = Date.now()
    const duration = checkedDuration(input.validity_days)
    const statements: D1PreparedStatement[] = []
    const response: BulkAssignResponse = {
      success_count: 0,
      created_count: 0,
      reused_count: 0,
      failed_count: 0,
      subscriptions: [],
      errors: [],
      statuses: {},
    }
    for (const userId of input.user_ids) {
      const user = await findUser(context.env, userId)
      if (user === null || user.status !== 'active') {
        response.failed_count += 1
        response.statuses[userId] = 'failed'
        response.errors.push(`user ${userId}: user is missing or disabled`)
        continue
      }
      const existing = await findSubscriptionByUserGroup(context.env, userId, group.id)
      if (existing !== null) await synchronizeSubscriptionState(context.env, existing.id)
      if (existing !== null && (existing.status === 'revoked' || existing.status === 'suspended')) {
        response.failed_count += 1
        response.statuses[userId] = 'failed'
        response.errors.push(`user ${userId}: subscription is ${existing.status}`)
        continue
      }
      if (existing !== null && effectiveStatus(existing, current) === 'active') {
        response.success_count += 1
        response.reused_count += 1
        response.statuses[userId] = 'reused'
        response.subscriptions.push(publicSubscription(existing, current))
        continue
      }

      const intentId = await deterministicUuid('subscription.state.sync.v1', `${requestId}\0${userId}`)
      const rate = await effectiveRate(context.env, userId, group)
      const expiresAt = checkedTimestampAdd(current, duration)
      const dailyAnchor = initialDailyAnchor(current, expiresAt)
      let row: SubscriptionRow
      if (existing === null) {
        row = joinedFromParts({
          id: await deterministicUuid('user.subscription.entitlement.v1', `${userId}\0${group.id}`),
          user_id: userId,
          group_id: group.id,
          plan_id: null,
          status: 'active',
          starts_at_ms: current,
          expires_at_ms: expiresAt,
          daily_quota_micros: group.daily_quota_micros,
          weekly_quota_micros: group.weekly_quota_micros,
          monthly_quota_micros: group.monthly_quota_micros,
          daily_used_micros: 0,
          weekly_used_micros: 0,
          monthly_used_micros: 0,
          daily_anchor_ms: dailyAnchor,
          daily_window_start_ms: dailyWindowStart(dailyAnchor, current),
          weekly_window_start_ms: current,
          monthly_window_start_ms: current,
          quota_reset_epoch: 0,
          quota_reset_generation: 0,
          source_type: 'admin',
          source_id: intentId,
          notes: input.notes,
          control_version: 0,
          created_at_ms: current,
          updated_at_ms: current,
        }, user, group, rate)
        statements.push(insertSubscriptionStatement(context.env, row))
        response.created_count += 1
        response.statuses[userId] = 'created'
      } else {
        assertVersionAvailable(existing.control_version)
        row = {
          ...existing,
          status: 'active',
          starts_at_ms: current,
          expires_at_ms: expiresAt,
          daily_quota_micros: group.daily_quota_micros,
          weekly_quota_micros: group.weekly_quota_micros,
          monthly_quota_micros: group.monthly_quota_micros,
          daily_used_micros: 0,
          weekly_used_micros: 0,
          monthly_used_micros: 0,
          daily_anchor_ms: dailyAnchor,
          daily_window_start_ms: dailyWindowStart(dailyAnchor, current),
          weekly_window_start_ms: current,
          monthly_window_start_ms: current,
          quota_reset_epoch: existing.quota_reset_epoch + 1,
          source_type: 'admin',
          source_id: intentId,
          notes: input.notes,
          control_version: existing.control_version + 1,
          updated_at_ms: current,
        }
        statements.push(updateSubscriptionStatement(context.env, row, existing.control_version))
        response.reused_count += 1
        response.statuses[userId] = 'reused'
      }
      response.success_count += 1
      response.subscriptions.push(publicSubscription(row, current))
      statements.push(
        subscriptionEventStatement(
          context.env,
          row,
          intentId,
          existing === null ? 'assigned' : 'extended',
          input.validity_days,
          current,
        ),
        stateSyncStatement(context.env, row, requestId, intentId, 'configure', undefined, current),
      )
    }
    statements.push(controlIdempotencyInsert(
      context.env,
      idempotency,
      'subscription_bulk',
      requestId,
      response,
      current,
    ))
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered === null) throw mapSubscriptionWriteError(error)
      const replay = parseIdempotentResponse<BulkAssignResponse>(recovered, 'subscription_bulk')
      await synchronizeRequest(context.env, requestId)
      return controlSuccess(replay)
    }
    await synchronizeRequest(context.env, requestId)
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function extendAdminSubscription(context: Context<ControlBindings>): Promise<Response> {
  return mutateAdminSubscription(context, 'extend')
}

export async function revokeAdminSubscription(context: Context<ControlBindings>): Promise<Response> {
  return mutateAdminSubscription(context, 'revoke')
}

export async function restoreAdminSubscription(context: Context<ControlBindings>): Promise<Response> {
  return mutateAdminSubscription(context, 'restore')
}

export async function resetAdminSubscriptionQuota(context: Context<ControlBindings>): Promise<Response> {
  return mutateAdminSubscription(context, 'reset_quota')
}

async function mutateAdminSubscription(
  context: Context<ControlBindings>,
  operation: 'extend' | 'revoke' | 'restore' | 'reset_quota',
): Promise<Response> {
  try {
    await recoverPendingSubscriptionState(context.env)
    const subscriptionId = requireUuid(context.req.param('id'), 'subscription_id')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readOptionalJson(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const operationInput = parseMutationInput(operation, body)
    const scope = `admin.subscriptions.${operation}.v1`
    const requestId = await deterministicUuid(scope, key)
    const idempotency = await controlIdempotency(scope, key, {
      subscription_id: subscriptionId,
      expected_control_version: expected,
      ...operationInput,
    })
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      const resourceType = operation === 'revoke' ? 'subscription_revoke' : 'subscription'
      const response = parseIdempotentResponse<Record<string, unknown>>(previous, resourceType)
      await synchronizeRequest(context.env, requestId)
      return controlSuccess(response)
    }

    await synchronizeSubscriptionState(context.env, subscriptionId)
    const current = await requireSubscription(context.env, subscriptionId)
    assertControlVersion(current.control_version, expected)
    const now = Date.now()
    let next: SubscriptionRow
    let eventType: 'extended' | 'revoked' | 'restored' | 'quota_reset'
    let validityDays: number | null = null
    let reset: ResetWindows | undefined
    if (operation === 'extend') {
      if (current.status === 'revoked' || current.status === 'suspended') {
        throw new GatewayError(409, 'subscription_not_extendable', 'Revoked or suspended subscriptions cannot be extended')
      }
      requireAvailableOwnerAndGroup(current)
      const days = operationInput.days as number
      const expired = effectiveStatus(current, now) === 'expired'
      if (expired && days < 0) {
        throw new GatewayError(400, 'cannot_shorten_expired', 'An expired subscription cannot be shortened')
      }
      const delta = checkedSignedDuration(days)
      const startsAt = expired ? now : current.starts_at_ms
      const expiresAt = checkedTimestampAdd(expired ? now : current.expires_at_ms, delta)
      if (expiresAt <= now || expiresAt <= startsAt) {
        throw new GatewayError(409, 'adjust_would_expire', 'The adjustment would expire the subscription')
      }
      next = {
        ...current,
        status: 'active',
        starts_at_ms: startsAt,
        expires_at_ms: expiresAt,
        daily_used_micros: expired ? 0 : current.daily_used_micros,
        weekly_used_micros: expired ? 0 : current.weekly_used_micros,
        monthly_used_micros: expired ? 0 : current.monthly_used_micros,
        daily_anchor_ms: expired ? initialDailyAnchor(startsAt, expiresAt) : current.daily_anchor_ms,
        daily_window_start_ms: expired ? initialDailyStart(startsAt, expiresAt) : current.daily_window_start_ms,
        weekly_window_start_ms: expired ? startsAt : current.weekly_window_start_ms,
        monthly_window_start_ms: expired ? startsAt : current.monthly_window_start_ms,
        quota_reset_epoch: expired ? current.quota_reset_epoch + 1 : current.quota_reset_epoch,
        control_version: expected + 1,
        updated_at_ms: now,
      }
      eventType = 'extended'
      validityDays = days > 0 ? days : null
    } else if (operation === 'revoke') {
      if (current.status === 'revoked') {
        throw new GatewayError(409, 'subscription_already_revoked', 'Subscription is already revoked')
      }
      next = { ...current, status: 'revoked', control_version: expected + 1, updated_at_ms: now }
      eventType = 'revoked'
    } else if (operation === 'restore') {
      if (current.status !== 'revoked') {
        throw new GatewayError(409, 'subscription_not_revoked', 'Only a revoked subscription can be restored')
      }
      const status: SubscriptionStatus = current.expires_at_ms <= now ? 'expired' : 'active'
      if (status === 'active') requireAvailableOwnerAndGroup(current)
      next = { ...current, status, control_version: expected + 1, updated_at_ms: now }
      eventType = 'restored'
    } else {
      if (
        current.status !== 'active' ||
        current.starts_at_ms > now ||
        current.expires_at_ms <= now
      ) {
        throw new GatewayError(409, 'subscription_not_active', 'Only a currently active subscription can be reset')
      }
      requireAvailableOwnerAndGroup(current)
      const selected = operationInput as Record<WindowKind, boolean>
      const normalized = normalizeSubscriptionWindows(current, now)
      reset = {
        daily: selected.daily ? normalized.daily_window_start_ms : null,
        weekly: selected.weekly ? now : null,
        monthly: selected.monthly ? now : null,
      }
      next = {
        ...current,
        daily_used_micros: selected.daily ? 0 : current.daily_used_micros,
        weekly_used_micros: selected.weekly ? 0 : current.weekly_used_micros,
        monthly_used_micros: selected.monthly ? 0 : current.monthly_used_micros,
        daily_window_start_ms: selected.daily ? reset.daily : current.daily_window_start_ms,
        weekly_window_start_ms: selected.weekly ? reset.weekly : current.weekly_window_start_ms,
        monthly_window_start_ms: selected.monthly ? reset.monthly : current.monthly_window_start_ms,
        quota_reset_epoch: selected.daily ? current.quota_reset_epoch + 1 : current.quota_reset_epoch,
        quota_reset_generation: current.quota_reset_generation + 1,
        control_version: expected + 1,
        updated_at_ms: now,
      }
      eventType = 'quota_reset'
    }

    const intentId = await deterministicUuid('subscription.state.sync.v1', `${requestId}\0${subscriptionId}`)
    const response = operation === 'revoke'
      ? { message: 'Subscription revoked successfully' }
      : publicSubscription(next, now)
    const resourceType = operation === 'revoke' ? 'subscription_revoke' : 'subscription'
    const updateStatement = operation === 'reset_quota'
      ? resetSubscriptionQuotaStatement(context.env, next, expected, reset!)
      : current.starts_at_ms !== next.starts_at_ms
        ? updateSubscriptionStatement(context.env, next, expected)
        : updateSubscriptionEntitlementStatement(context.env, next, expected)
    try {
      await context.env.DB.batch([
        updateStatement,
        subscriptionEventStatement(context.env, next, intentId, eventType, validityDays, now),
        stateSyncStatement(
          context.env,
          next,
          requestId,
          intentId,
          operation === 'reset_quota' ? 'reset_quota' : 'configure',
          reset,
          now,
        ),
        controlIdempotencyInsert(context.env, idempotency, resourceType, subscriptionId, response, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered === null) throw mapSubscriptionWriteError(error)
      const replay = parseIdempotentResponse<Record<string, unknown>>(recovered, resourceType)
      await synchronizeRequest(context.env, requestId)
      return controlSuccess(replay)
    }
    await synchronizeRequest(context.env, requestId)
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function listSubscriptions(
  context: Context<ControlBindings>,
  fixed: { userId?: string; groupId?: string } = {},
): Promise<Response> {
  const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
  const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
  const now = Date.now()
  const conditions: string[] = []
  const values: unknown[] = []
  const userId = fixed.userId ?? optionalUuidQuery(context.req.query('user_id'), 'user_id')
  const groupId = fixed.groupId ?? optionalUuidQuery(context.req.query('group_id'), 'group_id')
  if (userId !== undefined) {
    conditions.push('s.user_id = ?')
    values.push(userId)
  }
  if (groupId !== undefined) {
    conditions.push('s.group_id = ?')
    values.push(groupId)
  }
  const status = context.req.query('status')
  if (status !== undefined && status !== '') {
    if (!['active', 'expired', 'revoked', 'suspended'].includes(status)) {
      throw new GatewayError(400, 'invalid_status', 'status is invalid')
    }
    if (status === 'active') {
      conditions.push(`s.status = 'active' AND s.starts_at_ms <= ? AND s.expires_at_ms > ?`)
      values.push(now, now)
    } else if (status === 'expired') {
      conditions.push(`(s.status = 'expired' OR (s.status = 'active' AND s.expires_at_ms <= ?))`)
      values.push(now)
    } else {
      conditions.push('s.status = ?')
      values.push(status)
    }
  }
  const platform = context.req.query('platform')?.trim()
  if (platform) {
    if (platform.length > 32) throw new GatewayError(400, 'invalid_platform', 'platform is invalid')
    conditions.push('g.platform = ?')
    values.push(platform)
  }
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
  const sortBy = context.req.query('sort_by') ?? 'created_at'
  const sortColumn = ({
    created_at: 's.created_at_ms',
    expires_at: 's.expires_at_ms',
    status: 's.status',
    updated_at: 's.updated_at_ms',
  } as Record<string, string>)[sortBy]
  if (sortColumn === undefined) throw new GatewayError(400, 'invalid_sort_by', 'sort_by is invalid')
  const sortOrder = (context.req.query('sort_order') ?? 'desc').toLowerCase()
  if (sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw new GatewayError(400, 'invalid_sort_order', 'sort_order must be asc or desc')
  }
  const [count, rows] = await context.env.DB.batch([
    context.env.DB.prepare(
      `SELECT COUNT(*) AS total
         FROM user_subscriptions s
         JOIN "groups" g ON g.id = s.group_id
         JOIN users u ON u.id = s.user_id
         ${where}`,
    ).bind(...values),
    context.env.DB.prepare(
      `${subscriptionSelect()} ${where}
       ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}, s.id ${sortOrder.toUpperCase()}
       LIMIT ? OFFSET ?`,
    ).bind(...values, pageSize, (page - 1) * pageSize),
  ])
  const totalValue = (count.results[0] as { total?: unknown } | undefined)?.total
  if (!Number.isSafeInteger(totalValue) || (totalValue as number) < 0) {
    throw new GatewayError(500, 'invalid_subscription_count', 'Subscription count is invalid', 'server_error')
  }
  const total = totalValue as number
  return controlSuccess({
    items: (rows.results as unknown as SubscriptionRow[]).map((row) => publicSubscription(row, now)),
    total,
    page,
    page_size: pageSize,
    pages: total === 0 ? 0 : Math.ceil(total / pageSize),
  })
}

function subscriptionSelect(): string {
  return `SELECT s.id, s.user_id, s.group_id, s.plan_id, s.status,
                 s.starts_at_ms, s.expires_at_ms,
                 s.daily_quota_micros, s.weekly_quota_micros, s.monthly_quota_micros,
                 s.daily_used_micros, s.weekly_used_micros, s.monthly_used_micros,
                 s.daily_anchor_ms, s.daily_window_start_ms,
                 s.weekly_window_start_ms, s.monthly_window_start_ms,
                 s.quota_reset_epoch, s.quota_reset_generation,
                 s.source_type, s.source_id, s.notes, s.control_version,
                 s.created_at_ms, s.updated_at_ms,
                 u.email AS user_email, u.display_name AS user_display_name,
                 u.status AS user_status,
                 g.name AS group_name, g.description AS group_description,
                 g.platform AS group_platform, g.enabled AS group_enabled,
                 g.group_type, g.rate_multiplier_ppm AS group_rate_multiplier_ppm,
                 COALESCE(rate.rate_multiplier_ppm, g.rate_multiplier_ppm)
                   AS effective_rate_multiplier_ppm
            FROM user_subscriptions s
            JOIN users u ON u.id = s.user_id
            JOIN "groups" g ON g.id = s.group_id
            LEFT JOIN user_group_rate_overrides rate
              ON rate.user_id = s.user_id AND rate.group_id = s.group_id`
}

async function requireSubscription(env: Env, rawId: string | undefined): Promise<SubscriptionRow> {
  const id = requireUuid(rawId, 'subscription_id')
  const row = await env.DB.prepare(`${subscriptionSelect()} WHERE s.id = ?`)
    .bind(id)
    .first<SubscriptionRow>()
  if (row === null) throw new GatewayError(404, 'subscription_not_found', 'Subscription was not found')
  return row
}

async function findSubscriptionByUserGroup(
  env: Env,
  userId: string,
  groupId: string,
): Promise<SubscriptionRow | null> {
  return env.DB.prepare(`${subscriptionSelect()} WHERE s.user_id = ? AND s.group_id = ? LIMIT 1`)
    .bind(userId, groupId)
    .first<SubscriptionRow>()
}

async function findUser(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare(
    'SELECT id, email, display_name, status FROM users WHERE id = ?',
  ).bind(id).first<UserRow>()
}

async function requireUser(env: Env, id: string, requireActive: boolean): Promise<UserRow> {
  const row = await findUser(env, id)
  if (row === null) throw new GatewayError(404, 'user_not_found', 'User was not found')
  if (requireActive && row.status !== 'active') {
    throw new GatewayError(409, 'user_disabled', 'A disabled user cannot receive an active subscription')
  }
  return row
}

async function requireGroup(env: Env, id: string, requireEnabled: boolean): Promise<GroupRow> {
  const row = await env.DB.prepare(
    `SELECT id, name, description, platform, enabled, group_type, rate_multiplier_ppm,
            daily_quota_micros, weekly_quota_micros, monthly_quota_micros
       FROM "groups" WHERE id = ?`,
  ).bind(id).first<GroupRow>()
  if (row === null) throw new GatewayError(404, 'group_not_found', 'Group was not found')
  if (row.group_type !== 'subscription') {
    throw new GatewayError(409, 'subscription_group_required', 'Subscriptions require a subscription group')
  }
  if (requireEnabled && row.enabled !== 1) {
    throw new GatewayError(409, 'group_disabled', 'A disabled group cannot receive an active subscription')
  }
  return row
}

async function effectiveRate(env: Env, userId: string, group: GroupRow): Promise<number> {
  const override = await env.DB.prepare(
    `SELECT rate_multiplier_ppm FROM user_group_rate_overrides
      WHERE user_id = ? AND group_id = ?`,
  ).bind(userId, group.id).first<{ rate_multiplier_ppm: number }>()
  return override?.rate_multiplier_ppm ?? group.rate_multiplier_ppm
}

function joinedFromParts(
  row: Omit<SubscriptionRow,
    'user_email' | 'user_display_name' | 'user_status' |
    'group_name' | 'group_description' | 'group_platform' | 'group_enabled' |
    'group_type' | 'group_rate_multiplier_ppm' | 'effective_rate_multiplier_ppm'>,
  user: UserRow,
  group: GroupRow,
  rate: number,
): SubscriptionRow {
  return {
    ...row,
    user_email: user.email,
    user_display_name: user.display_name,
    user_status: user.status,
    group_name: group.name,
    group_description: group.description,
    group_platform: group.platform,
    group_enabled: group.enabled,
    group_type: group.group_type,
    group_rate_multiplier_ppm: group.rate_multiplier_ppm,
    effective_rate_multiplier_ppm: rate,
  }
}

function publicSubscription(row: SubscriptionRow, now: number): Record<string, unknown> {
  const normalized = normalizeSubscriptionWindows(row, now)
  return {
    id: row.id,
    user_id: row.user_id,
    group_id: row.group_id,
    plan_id: row.plan_id,
    status: effectiveStatus(row, now),
    starts_at: iso(row.starts_at_ms),
    expires_at: iso(row.expires_at_ms),
    daily_usage_usd: microsToUsd(normalized.daily_used_micros),
    weekly_usage_usd: microsToUsd(normalized.weekly_used_micros),
    monthly_usage_usd: microsToUsd(normalized.monthly_used_micros),
    daily_window_start: nullableIso(normalized.daily_window_start_ms),
    weekly_window_start: nullableIso(normalized.weekly_window_start_ms),
    monthly_window_start: nullableIso(normalized.monthly_window_start_ms),
    source_type: row.source_type,
    notes: row.notes,
    assigned_by: null,
    assigned_at: iso(row.created_at_ms),
    created_at: iso(row.created_at_ms),
    updated_at: iso(row.updated_at_ms),
    control_version: row.control_version,
    user: {
      id: row.user_id,
      email: row.user_email,
      username: row.user_display_name,
      display_name: row.user_display_name,
      status: row.user_status,
    },
    group: {
      id: row.group_id,
      name: row.group_name,
      description: row.group_description,
      platform: row.group_platform,
      status: row.group_enabled === 1 ? 'active' : 'inactive',
      subscription_type: row.group_type,
      rate_multiplier: ppmToMultiplier(row.effective_rate_multiplier_ppm),
      daily_limit_usd: nullableMicrosToUsd(row.daily_quota_micros),
      weekly_limit_usd: nullableMicrosToUsd(row.weekly_quota_micros),
      monthly_limit_usd: nullableMicrosToUsd(row.monthly_quota_micros),
    },
  }
}

function subscriptionProgress(row: SubscriptionRow, now: number): Record<string, unknown> {
  const normalized = normalizeSubscriptionWindows(row, now)
  return {
    subscription_id: row.id,
    id: row.id,
    group_name: row.group_name,
    expires_at: iso(row.expires_at_ms),
    days_remaining: daysRemaining(row.expires_at_ms, now),
    expires_in_days: daysRemaining(row.expires_at_ms, now),
    daily: windowProgress(normalized.daily_used_micros, row.daily_quota_micros, normalized.daily_window_start_ms, DAY_MS, row.expires_at_ms, now),
    weekly: windowProgress(normalized.weekly_used_micros, row.weekly_quota_micros, normalized.weekly_window_start_ms, WEEK_MS, row.expires_at_ms, now),
    monthly: windowProgress(normalized.monthly_used_micros, row.monthly_quota_micros, normalized.monthly_window_start_ms, MONTH_MS, row.expires_at_ms, now),
  }
}

function windowProgress(
  usedMicros: number,
  limitMicros: number | null,
  start: number | null,
  period: number,
  expiresAt: number,
  now: number,
): Record<string, unknown> {
  const resetAt = start === null ? null : Math.min(checkedTimestampAdd(start, period), expiresAt)
  const used = microsToUsd(usedMicros)
  const limit = nullableMicrosToUsd(limitMicros)
  const percentage = limitMicros === null || limitMicros === 0
    ? 0
    : Math.min(100, usedMicros / limitMicros * 100)
  return {
    used,
    used_usd: used,
    limit,
    limit_usd: limit,
    remaining_usd: limit === null ? null : Math.max(0, limit - used),
    percentage,
    window_start: nullableIso(start),
    resets_at: resetAt === null ? null : iso(resetAt),
    reset_in_seconds: resetAt === null ? null : Math.max(0, Math.ceil((resetAt - now) / 1_000)),
    resets_in_seconds: resetAt === null ? null : Math.max(0, Math.ceil((resetAt - now) / 1_000)),
  }
}

function insertSubscriptionStatement(env: Env, row: SubscriptionRow): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO user_subscriptions (
       id, user_id, group_id, plan_id, status, starts_at_ms, expires_at_ms,
       daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
       daily_used_micros, weekly_used_micros, monthly_used_micros,
       daily_anchor_ms, daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
       quota_reset_epoch, quota_reset_generation,
       source_type, source_id, notes, control_version, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id, row.user_id, row.group_id, row.plan_id, row.status,
    row.starts_at_ms, row.expires_at_ms,
    row.daily_quota_micros, row.weekly_quota_micros, row.monthly_quota_micros,
    row.daily_used_micros, row.weekly_used_micros, row.monthly_used_micros,
    row.daily_anchor_ms,
    row.daily_window_start_ms, row.weekly_window_start_ms, row.monthly_window_start_ms,
    row.quota_reset_epoch, row.quota_reset_generation,
    row.source_type, row.source_id, row.notes, row.control_version,
    row.created_at_ms, row.updated_at_ms,
  )
}

function updateSubscriptionStatement(
  env: Env,
  row: SubscriptionRow,
  expected: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE user_subscriptions
        SET status = ?, starts_at_ms = ?, expires_at_ms = ?,
            daily_quota_micros = ?, weekly_quota_micros = ?, monthly_quota_micros = ?,
            daily_used_micros = ?, weekly_used_micros = ?, monthly_used_micros = ?,
            daily_anchor_ms = ?,
            daily_window_start_ms = ?, weekly_window_start_ms = ?, monthly_window_start_ms = ?,
            quota_reset_epoch = ?, quota_reset_generation = ?,
            source_type = ?, source_id = ?, notes = ?,
            control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
            updated_at_ms = ?
      WHERE id = ?`,
  ).bind(
    row.status, row.starts_at_ms, row.expires_at_ms,
    row.daily_quota_micros, row.weekly_quota_micros, row.monthly_quota_micros,
    row.daily_used_micros, row.weekly_used_micros, row.monthly_used_micros,
    row.daily_anchor_ms,
    row.daily_window_start_ms, row.weekly_window_start_ms, row.monthly_window_start_ms,
    row.quota_reset_epoch, row.quota_reset_generation,
    row.source_type, row.source_id, row.notes,
    expected, row.control_version, row.updated_at_ms, row.id,
  )
}

function updateSubscriptionEntitlementStatement(
  env: Env,
  row: SubscriptionRow,
  expected: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE user_subscriptions
        SET status = ?, starts_at_ms = ?, expires_at_ms = ?,
            daily_quota_micros = ?, weekly_quota_micros = ?, monthly_quota_micros = ?,
            source_type = ?, source_id = ?, notes = ?,
            control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
            updated_at_ms = MAX(updated_at_ms, ?)
      WHERE id = ?`,
  ).bind(
    row.status, row.starts_at_ms, row.expires_at_ms,
    row.daily_quota_micros, row.weekly_quota_micros, row.monthly_quota_micros,
    row.source_type, row.source_id, row.notes,
    expected, row.control_version, row.updated_at_ms, row.id,
  )
}

function resetSubscriptionQuotaStatement(
  env: Env,
  row: SubscriptionRow,
  expected: number,
  windows: ResetWindows,
): D1PreparedStatement {
  const resetDaily = windows.daily !== null
  const resetWeekly = windows.weekly !== null
  const resetMonthly = windows.monthly !== null
  return env.DB.prepare(
    `UPDATE user_subscriptions
        SET daily_used_micros = CASE WHEN ? THEN 0 ELSE daily_used_micros END,
            weekly_used_micros = CASE WHEN ? THEN 0 ELSE weekly_used_micros END,
            monthly_used_micros = CASE WHEN ? THEN 0 ELSE monthly_used_micros END,
            daily_window_start_ms = CASE WHEN ? THEN ? ELSE daily_window_start_ms END,
            weekly_window_start_ms = CASE WHEN ? THEN ? ELSE weekly_window_start_ms END,
            monthly_window_start_ms = CASE WHEN ? THEN ? ELSE monthly_window_start_ms END,
            quota_reset_epoch = CASE WHEN ? THEN quota_reset_epoch + 1 ELSE quota_reset_epoch END,
            quota_reset_generation = quota_reset_generation + 1,
            control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
            updated_at_ms = MAX(updated_at_ms, ?)
      WHERE id = ?`,
  ).bind(
    resetDaily ? 1 : 0,
    resetWeekly ? 1 : 0,
    resetMonthly ? 1 : 0,
    resetDaily ? 1 : 0,
    windows.daily,
    resetWeekly ? 1 : 0,
    windows.weekly,
    resetMonthly ? 1 : 0,
    windows.monthly,
    resetDaily ? 1 : 0,
    expected,
    row.control_version,
    row.updated_at_ms,
    row.id,
  )
}

function subscriptionEventStatement(
  env: Env,
  row: SubscriptionRow,
  sourceId: string,
  eventType: 'assigned' | 'extended' | 'revoked' | 'restored' | 'quota_reset',
  validityDays: number | null,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO subscription_events (
       id, subscription_id, user_id, group_id, event_type,
       source_type, source_id, validity_days, occurred_at_ms
     ) VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, ?)`,
  ).bind(
    sourceId,
    row.id,
    row.user_id,
    row.group_id,
    eventType,
    sourceId,
    validityDays,
    now,
  )
}

function stateSyncStatement(
  env: Env,
  row: SubscriptionRow,
  requestId: string,
  intentId: string,
  operation: 'configure' | 'reset_quota',
  resetWindows: ResetWindows | undefined,
  now: number,
): D1PreparedStatement {
  const payload: StateSyncPayload = {
    configuration: subscriptionConfiguration(row, now),
    ...(resetWindows === undefined ? {} : {
      reset: {
        schema_version: 1,
        mutation_id: intentId,
        subscription_id: row.id,
        control_version: row.control_version,
        windows: resetWindows,
      },
    }),
  }
  return env.DB.prepare(
    `INSERT INTO subscription_state_sync (
       id, request_id, subscription_id, operation, control_version,
       payload_json, status, attempts, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  ).bind(
    intentId,
    requestId,
    row.id,
    operation,
    row.control_version,
    JSON.stringify(payload),
    now,
    now,
  )
}

function subscriptionConfiguration(row: SubscriptionRow, now: number): Record<string, unknown> {
  return {
    schema_version: 1,
    subscription_id: row.id,
    user_id: row.user_id,
    group_id: row.group_id,
    starts_at_ms: row.starts_at_ms,
    expires_at_ms: row.expires_at_ms,
    daily_quota_micros: row.daily_quota_micros,
    weekly_quota_micros: row.weekly_quota_micros,
    monthly_quota_micros: row.monthly_quota_micros,
    daily_used_micros: row.daily_used_micros,
    weekly_used_micros: row.weekly_used_micros,
    monthly_used_micros: row.monthly_used_micros,
    daily_anchor_ms: row.daily_anchor_ms,
    daily_window_start_ms: row.daily_window_start_ms,
    weekly_window_start_ms: row.weekly_window_start_ms,
    monthly_window_start_ms: row.monthly_window_start_ms,
    quota_reset_epoch: row.quota_reset_epoch,
    quota_reset_generation: row.quota_reset_generation,
    control_version: row.control_version,
    enabled: row.status === 'active' && row.starts_at_ms <= now && row.expires_at_ms > now,
  }
}

export async function recoverPendingSubscriptionState(
  env: Env,
  limit = RECOVERY_LIMIT,
): Promise<number> {
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, 100)
    : RECOVERY_LIMIT
  const rows = await env.DB.prepare(
    `SELECT id, request_id, subscription_id, operation, control_version, payload_json, attempts
       FROM subscription_state_sync
      WHERE status = 'pending'
      ORDER BY updated_at_ms ASC, id ASC
      LIMIT ?`,
  ).bind(boundedLimit).all<StateSyncRow>()
  let recovered = 0
  for (const row of rows.results) {
    try {
      await synchronizeIntent(env, row)
      recovered += 1
    } catch (error) {
      console.error('subscription state recovery deferred', {
        intent_id: row.id,
        subscription_id: row.subscription_id,
        name: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  return recovered
}

export async function synchronizeSubscriptionState(env: Env, subscriptionId: string): Promise<void> {
  while (true) {
    const rows = await env.DB.prepare(
      `SELECT id, request_id, subscription_id, operation, control_version, payload_json, attempts
         FROM subscription_state_sync
        WHERE status = 'pending' AND subscription_id = ?
        ORDER BY control_version ASC, created_at_ms ASC, id ASC
        LIMIT 100`,
    ).bind(subscriptionId).all<StateSyncRow>()
    if (rows.results.length === 0) return
    for (const row of rows.results) await synchronizeIntent(env, row)
  }
}

async function synchronizeRequest(env: Env, requestId: string): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, request_id, subscription_id, operation, control_version, payload_json, attempts
       FROM subscription_state_sync
      WHERE status = 'pending' AND request_id = ?
      ORDER BY subscription_id ASC, control_version ASC, id ASC
      LIMIT 100`,
  ).bind(requestId).all<StateSyncRow>()
  for (const row of rows.results) await synchronizeIntent(env, row)
  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM subscription_state_sync
      WHERE status = 'pending' AND request_id = ?`,
  ).bind(requestId).first<{ total: number }>()
  if (remaining === null || remaining.total !== 0) {
    throw new GatewayError(503, 'subscription_state_sync_pending', 'Subscription state synchronization is still pending', 'server_error')
  }
}

async function synchronizeIntent(env: Env, row: StateSyncRow): Promise<void> {
  try {
    if (env.SUBSCRIPTION_STATE === undefined) {
      throw new Error('Subscription state namespace is unavailable')
    }
    const parsed = JSON.parse(row.payload_json) as StateSyncPayload
    if (parsed === null || typeof parsed !== 'object' || parsed.configuration === undefined) {
      throw new Error('Subscription state intent is invalid')
    }
    const stub = env.SUBSCRIPTION_STATE.get(env.SUBSCRIPTION_STATE.idFromName(row.subscription_id))
    if (row.operation === 'reset_quota') {
      if (parsed.reset === undefined) throw new Error('Subscription reset intent has no reset command')
      await requireStateResponse(await statePost(stub, '/configure-reset', {
        configuration: parsed.configuration,
        reset: parsed.reset,
      }))
    } else {
      await requireStateResponse(await statePost(stub, '/configure', parsed.configuration))
    }
    const appliedAt = Date.now()
    await env.DB.prepare(
      `UPDATE subscription_state_sync
          SET status = 'applied', last_error = NULL,
              updated_at_ms = ?, applied_at_ms = ?
        WHERE id = ? AND status = 'pending'`,
    ).bind(appliedAt, appliedAt, row.id).run()
  } catch (error) {
    const failedAt = Date.now()
    try {
      await env.DB.prepare(
        `UPDATE subscription_state_sync
            SET attempts = attempts + 1, last_error = ?, updated_at_ms = ?
          WHERE id = ? AND status = 'pending'`,
      ).bind(errorMessage(error).slice(0, 500), failedAt, row.id).run()
    } catch (recordError) {
      console.error('failed to record subscription state synchronization failure', {
        intent_id: row.id,
        name: recordError instanceof Error ? recordError.name : 'unknown',
      })
    }
    throw new GatewayError(
      503,
      'subscription_state_sync_failed',
      'Subscription was changed, but its runtime state is pending synchronization; retry with the same Idempotency-Key',
      'server_error',
    )
  }
}

function statePost(
  stub: DurableObjectStub,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return stub.fetch(new Request(`https://subscription-state.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

async function requireStateResponse(response: Response): Promise<void> {
  if (response.ok) return
  let detail = 'Durable Object rejected the subscription state intent'
  try {
    const body = await response.json() as { error?: { message?: string } }
    detail = body.error?.message ?? detail
  } catch {
    // A malformed state response is retried through the durable D1 intent.
  }
  throw new Error(detail)
}

function parseAssignment(body: Record<string, unknown>): AssignmentInput {
  return {
    user_id: requireUuid(requireString(body, 'user_id', 64), 'user_id'),
    group_id: requireUuid(requireString(body, 'group_id', 64), 'group_id'),
    validity_days: optionalSafeInteger(body, 'validity_days', 1, 36_500) ?? 30,
    notes: optionalString(body, 'notes', 2_000) ?? '',
  }
}

function parseBulkAssignment(body: Record<string, unknown>): AssignmentInput & { user_ids: string[] } {
  const raw = body.user_ids
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BULK_USERS) {
    throw new GatewayError(400, 'invalid_user_ids', `user_ids must contain between 1 and ${MAX_BULK_USERS} UUIDs`)
  }
  const userIds = [...new Set(raw.map((value) => {
    if (typeof value !== 'string') throw new GatewayError(400, 'invalid_user_ids', 'Every user_id must be a UUID')
    return requireUuid(value, 'user_id')
  }))]
  return {
    user_ids: userIds,
    user_id: userIds[0]!,
    group_id: requireUuid(requireString(body, 'group_id', 64), 'group_id'),
    validity_days: optionalSafeInteger(body, 'validity_days', 1, 36_500) ?? 30,
    notes: optionalString(body, 'notes', 2_000) ?? '',
  }
}

function parseMutationInput(
  operation: 'extend' | 'revoke' | 'restore' | 'reset_quota',
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (operation === 'extend') {
    const days = requireSafeInteger(body, 'days', -36_500, 36_500)
    if (days === 0) throw new GatewayError(400, 'invalid_days', 'days must not be zero')
    return { days }
  }
  if (operation === 'reset_quota') {
    const daily = requireBooleanValue(body, 'daily')
    const weekly = requireBooleanValue(body, 'weekly')
    const monthly = requireBooleanValue(body, 'monthly')
    if (!daily && !weekly && !monthly) {
      throw new GatewayError(400, 'empty_quota_reset', 'At least one quota window must be reset')
    }
    return { daily, weekly, monthly }
  }
  return {}
}

function requireBooleanValue(body: Record<string, unknown>, field: string): boolean {
  if (typeof body[field] !== 'boolean') {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a boolean`)
  }
  return body[field] as boolean
}

function requireUuid(value: string | undefined, field: string): string {
  const normalized = requireResourceId(value, field)
  if (!UUID_PATTERN.test(normalized)) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a UUID`)
  }
  return normalized.toLowerCase()
}

function optionalUuidQuery(value: string | undefined, field: string): string | undefined {
  return value === undefined || value === '' ? undefined : requireUuid(value, field)
}

function requireAvailableOwnerAndGroup(row: SubscriptionRow): void {
  if (row.user_status !== 'active') {
    throw new GatewayError(409, 'user_disabled', 'The subscription owner is disabled')
  }
  if (row.group_enabled !== 1) {
    throw new GatewayError(409, 'group_disabled', 'The subscription group is disabled')
  }
}

function assertControlVersion(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new GatewayError(412, 'control_version_conflict', 'Subscription changed; reload it and retry')
  }
  assertVersionAvailable(expected)
}

function assertVersionAvailable(version: number): void {
  if (version >= Number.MAX_SAFE_INTEGER) {
    throw new GatewayError(409, 'control_version_exhausted', 'Subscription control version is exhausted')
  }
}

function checkedDuration(days: number): number {
  return checkedSignedDuration(days)
}

function checkedSignedDuration(days: number): number {
  const result = days * DAY_MS
  if (!Number.isSafeInteger(result)) {
    throw new GatewayError(400, 'invalid_validity_days', 'Subscription duration is invalid')
  }
  return result
}

function checkedTimestampAdd(value: number, delta: number): number {
  const result = value + delta
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_DATE_MS) {
    throw new GatewayError(409, 'subscription_expiry_out_of_range', 'Subscription expiry is outside the supported range')
  }
  return result
}

function initialDailyStart(startsAt: number, expiresAt: number, now = startsAt): number {
  return dailyWindowStart(initialDailyAnchor(startsAt, expiresAt), now)
}

function initialDailyAnchor(startsAt: number, expiresAt: number): number {
  return expiresAt - startsAt <= DAY_MS ? startsAt : 0
}

function dailyWindowStart(anchor: number, now: number): number {
  return anchor + Math.floor((now - anchor) / DAY_MS) * DAY_MS
}

function effectiveStatus(
  row: Pick<SubscriptionRow, 'status' | 'starts_at_ms' | 'expires_at_ms'>,
  now: number,
): SubscriptionStatus {
  return row.status === 'active' && (row.starts_at_ms > now || row.expires_at_ms <= now)
    ? 'expired'
    : row.status
}

function daysRemaining(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / DAY_MS))
}

function microsToUsd(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError(500, 'invalid_subscription_amount', 'Subscription amount is invalid', 'server_error')
  }
  return value / 1_000_000
}

function nullableMicrosToUsd(value: number | null): number | null {
  return value === null ? null : microsToUsd(value)
}

function ppmToMultiplier(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError(500, 'invalid_subscription_rate', 'Subscription rate is invalid', 'server_error')
  }
  return value / 1_000_000
}

function iso(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
    throw new GatewayError(500, 'invalid_subscription_timestamp', 'Subscription timestamp is invalid', 'server_error')
  }
  return new Date(value).toISOString()
}

function nullableIso(value: number | null): string | null {
  return value === null ? null : iso(value)
}

function mapSubscriptionWriteError(error: unknown): unknown {
  if (error instanceof GatewayError) return error
  const message = errorMessage(error)
  if (message.includes('control_version')) {
    return new GatewayError(412, 'control_version_conflict', 'Subscription changed; reload it and retry')
  }
  if (
    message.includes('UNIQUE constraint') ||
    message.includes('FOREIGN KEY') ||
    message.includes('user_subscription_') ||
    message.includes('subscription_event_')
  ) {
    return new GatewayError(409, 'subscription_conflict', 'Subscription relations changed; reload and retry')
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
