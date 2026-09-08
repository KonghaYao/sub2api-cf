import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
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
  optionalBoolean,
  optionalSafeInteger,
  optionalString,
  readJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
  requireSafeInteger,
  requireString,
} from './http'

type ControlBindings = { Bindings: Env }

interface SubscriptionPlanRow {
  id: string
  group_id: string
  name: string
  description: string
  validity_days: number
  price_micros: number
  currency: string
  daily_quota_micros: number | null
  weekly_quota_micros: number | null
  monthly_quota_micros: number | null
  enabled: number
  sort_order: number
  control_version: number
  created_at_ms: number
  updated_at_ms: number
  group_name?: string
  group_platform?: string
  group_rate_multiplier_ppm?: number
}

interface PlanGroupRow {
  id: string
  name: string
  platform: string
  enabled: number
  group_type: 'standard' | 'subscription'
  rate_multiplier_ppm: number
}

const PLAN_COLUMNS = `id, group_id, name, description, validity_days, price_micros, currency,
  daily_quota_micros, weekly_quota_micros, monthly_quota_micros, enabled, sort_order,
  control_version, created_at_ms, updated_at_ms`
const PLAN_COLUMNS_QUALIFIED = PLAN_COLUMNS.split(',').map((column) => `p.${column.trim()}`).join(', ')
const MAX_MICROS = Number.MAX_SAFE_INTEGER

/** Public plans deliberately contain no admin control metadata. */
export async function listPublicSubscriptionPlans(context: Context<ControlBindings>): Promise<Response> {
  try {
    const rows = await context.env.DB.prepare(
      `SELECT ${PLAN_COLUMNS_QUALIFIED}, g.name AS group_name,
              g.platform AS group_platform,
              g.rate_multiplier_ppm AS group_rate_multiplier_ppm
         FROM subscription_plans p
         JOIN "groups" g ON g.id = p.group_id
        WHERE p.enabled = 1 AND g.enabled = 1
        ORDER BY p.sort_order ASC, p.id ASC`,
    ).all<SubscriptionPlanRow>()
    return controlSuccess(rows.results.map((row) => publicPlan(row, false)))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getPublicSubscriptionPlan(context: Context<ControlBindings>): Promise<Response> {
  try {
    const id = requireResourceId(context.req.param('id'), 'plan')
    const row = await context.env.DB.prepare(
      `SELECT ${PLAN_COLUMNS_QUALIFIED}, g.name AS group_name,
              g.platform AS group_platform,
              g.rate_multiplier_ppm AS group_rate_multiplier_ppm
         FROM subscription_plans p
         JOIN "groups" g ON g.id = p.group_id
        WHERE p.id = ? AND p.enabled = 1 AND g.enabled = 1`,
    ).bind(id).first<SubscriptionPlanRow>()
    if (row === null) throw new GatewayError(404, 'subscription_plan_not_found', 'Subscription plan was not found')
    return controlSuccess(publicPlan(row, false))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminSubscriptionPlans(context: Context<ControlBindings>): Promise<Response> {
  try {
    const rows = await context.env.DB.prepare(
      `SELECT ${PLAN_COLUMNS} FROM subscription_plans ORDER BY sort_order ASC, id ASC`,
    ).all<SubscriptionPlanRow>()
    return controlSuccess(rows.results.map((row) => publicPlan(row, true)))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminSubscriptionPlan(context: Context<ControlBindings>): Promise<Response> {
  try {
    return controlSuccess(publicPlan(await requirePlan(context.env, context.req.param('id')), true))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function createAdminSubscriptionPlan(context: Context<ControlBindings>): Promise<Response> {
  try {
    const key = requireIdempotencyKey(context.req.raw)
    const input = parseCreatePlan(await readJsonObject(context.req.raw))
    const idem = await controlIdempotency('admin.subscription-plans.create.v1', key, input)
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) return controlSuccess(parseIdempotentResponse(previous, 'subscription_plan'))

    await requireSubscriptionGroup(context.env, input.group_id)
    const now = Date.now()
    const row: SubscriptionPlanRow = {
      id: await deterministicUuid('admin.subscription-plans.create.v1', key),
      ...input,
      enabled: input.enabled ? 1 : 0,
      control_version: 0,
      created_at_ms: now,
      updated_at_ms: now,
    }
    const response = publicPlan(row, true)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO subscription_plans (
             id, group_id, name, description, validity_days, price_micros, currency,
             daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
             enabled, sort_order, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          row.id, row.group_id, row.name, row.description, row.validity_days, row.price_micros,
          row.currency, row.daily_quota_micros, row.weekly_quota_micros, row.monthly_quota_micros,
          row.enabled, row.sort_order, now, now,
        ),
        controlIdempotencyInsert(context.env, idem, 'subscription_plan', row.id, response, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'subscription_plan'))
      throw mapPlanWriteError(error)
    }
    return controlSuccess(response, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updateAdminSubscriptionPlan(context: Context<ControlBindings>): Promise<Response> {
  try {
    const id = requireResourceId(context.req.param('id'), 'plan')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const patch = parsePlanPatch(body)
    const idem = await controlIdempotency('admin.subscription-plans.update.v1', key, { id, expected, patch })
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) return controlSuccess(parseIdempotentResponse(previous, 'subscription_plan'))

    const current = await requirePlan(context.env, id)
    assertControlVersion(current.control_version, expected)
    const next = { ...current, ...patch, enabled: patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0 }
    if (next.group_id !== current.group_id) await requireSubscriptionGroup(context.env, next.group_id)
    const updatedAt = Date.now()
    const response = publicPlan({ ...next, control_version: expected + 1, updated_at_ms: updatedAt }, true)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE subscription_plans
              SET group_id = ?, name = ?, description = ?, validity_days = ?, price_micros = ?, currency = ?,
                  daily_quota_micros = ?, weekly_quota_micros = ?, monthly_quota_micros = ?, enabled = ?, sort_order = ?,
                  control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END, updated_at_ms = ?
            WHERE id = ?`,
        ).bind(
          next.group_id, next.name, next.description, next.validity_days, next.price_micros, next.currency,
          next.daily_quota_micros, next.weekly_quota_micros, next.monthly_quota_micros, next.enabled, next.sort_order,
          expected, expected + 1, updatedAt, id,
        ),
        controlIdempotencyInsert(context.env, idem, 'subscription_plan', id, response, updatedAt),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'subscription_plan'))
      throw mapPlanWriteError(error)
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/**
 * Plans are never physically deleted: a historical subscription can retain its
 * plan identity, and disabling removes the plan from every public listing.
 */
export async function disableAdminSubscriptionPlan(context: Context<ControlBindings>): Promise<Response> {
  try {
    const id = requireResourceId(context.req.param('id'), 'plan')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readOptionalJson(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const idem = await controlIdempotency('admin.subscription-plans.disable.v1', key, { id, expected })
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) return controlSuccess(parseIdempotentResponse(previous, 'subscription_plan'))

    const current = await requirePlan(context.env, id)
    assertControlVersion(current.control_version, expected)
    const updatedAt = Date.now()
    const response = publicPlan({ ...current, enabled: 0, control_version: expected + 1, updated_at_ms: updatedAt }, true)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE subscription_plans SET enabled = 0,
             control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
             updated_at_ms = ? WHERE id = ?`,
        ).bind(expected, expected + 1, updatedAt, id),
        controlIdempotencyInsert(context.env, idem, 'subscription_plan', id, response, updatedAt),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'subscription_plan'))
      throw mapPlanWriteError(error)
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function parseCreatePlan(body: Record<string, unknown>) {
  return {
    group_id: requirePlanGroupId(body),
    name: requireString(body, 'name', 128),
    description: optionalText(body, 'description', 1_024) ?? '',
    validity_days: parseValidityDays(body),
    price_micros: parsePriceMicros(body, true) ?? 0,
    currency: parseCurrency(body) ?? 'USD',
    daily_quota_micros: optionalNullableMicros(body, 'daily_quota_micros', 'daily_limit_usd') ?? null,
    weekly_quota_micros: optionalNullableMicros(body, 'weekly_quota_micros', 'weekly_limit_usd') ?? null,
    monthly_quota_micros: optionalNullableMicros(body, 'monthly_quota_micros', 'monthly_limit_usd') ?? null,
    enabled: parseEnabled(body, true) ?? true,
    sort_order: optionalSafeInteger(body, 'sort_order', 0, 1_000_000) ?? 0,
  }
}

function parsePlanPatch(body: Record<string, unknown>) {
  const result: Partial<Omit<SubscriptionPlanRow, 'id' | 'control_version' | 'created_at_ms' | 'updated_at_ms' | 'enabled'>> & { enabled?: boolean } = {}
  if (body.group_id !== undefined) result.group_id = requirePlanGroupId(body)
  const name = optionalString(body, 'name', 128)
  if (name !== undefined) result.name = name
  const description = optionalText(body, 'description', 1_024)
  if (description !== undefined) result.description = description
  if (hasValidityInput(body)) result.validity_days = parseValidityDays(body)
  const price = parsePriceMicros(body, false)
  if (price !== undefined) result.price_micros = price
  const currency = parseCurrency(body)
  if (currency !== undefined) result.currency = currency
  for (const [micros, legacy] of [
    ['daily_quota_micros', 'daily_limit_usd'],
    ['weekly_quota_micros', 'weekly_limit_usd'],
    ['monthly_quota_micros', 'monthly_limit_usd'],
  ] as const) {
    const value = optionalNullableMicros(body, micros, legacy)
    if (value !== undefined) result[micros] = value
  }
  const enabled = parseEnabled(body)
  if (enabled !== undefined) result.enabled = enabled
  const sortOrder = optionalSafeInteger(body, 'sort_order', 0, 1_000_000)
  if (sortOrder !== undefined) result.sort_order = sortOrder
  if (Object.keys(result).length === 0) throw new GatewayError(400, 'empty_update', 'At least one field is required')
  return result
}

function requirePlanGroupId(body: Record<string, unknown>): string {
  const value = body.group_id
  if (typeof value !== 'string') {
    throw new GatewayError(400, 'invalid_group_id', 'group_id must be a Worker group id string')
  }
  return requireResourceId(value, 'group')
}

function parseValidityDays(body: Record<string, unknown>): number {
  const days = requireSafeInteger(body, 'validity_days', 1, 36_500)
  const unit = optionalString(body, 'validity_unit', 16) ?? 'days'
  const multiplier = unit === 'days' ? 1 : unit === 'weeks' ? 7 : unit === 'months' ? 30 : null
  if (multiplier === null) throw new GatewayError(400, 'invalid_validity_unit', 'validity_unit must be days, weeks, or months')
  const resolved = days * multiplier
  if (!Number.isSafeInteger(resolved) || resolved > 36_500) {
    throw new GatewayError(400, 'invalid_validity_days', 'validity period must not exceed 36500 days')
  }
  return resolved
}

function hasValidityInput(body: Record<string, unknown>): boolean {
  return body.validity_days !== undefined || body.validity_unit !== undefined
}

function parsePriceMicros(body: Record<string, unknown>, required: boolean): number | undefined {
  const direct = body.price_micros
  if (direct !== undefined) {
    if (body.price !== undefined) throw new GatewayError(400, 'ambiguous_price', 'Specify price or price_micros, not both')
    return requireSafeInteger(body, 'price_micros', 0, MAX_MICROS)
  }
  if (body.price === undefined) {
    if (required) throw new GatewayError(400, 'invalid_price', 'price or price_micros is required')
    return undefined
  }
  const price = body.price
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
    throw new GatewayError(400, 'invalid_price', 'price must be a non-negative finite number')
  }
  const micros = Math.round(price * 1_000_000)
  if (!Number.isSafeInteger(micros) || micros < 0 || micros > MAX_MICROS) {
    throw new GatewayError(400, 'invalid_price', 'price is outside the supported micro-unit range')
  }
  return micros
}

function parseCurrency(body: Record<string, unknown>): string | undefined {
  if (body.currency === undefined) return undefined
  if (typeof body.currency !== 'string') throw new GatewayError(400, 'invalid_currency', 'currency must be a three-letter code')
  const value = body.currency.trim().toUpperCase()
  // The existing plan editor sends an empty label to mean the default currency.
  if (value === '') return undefined
  if (!/^[A-Z]{3}$/.test(value)) throw new GatewayError(400, 'invalid_currency', 'currency must be a three-letter code')
  return value
}

function optionalNullableMicros(
  body: Record<string, unknown>,
  field: 'daily_quota_micros' | 'weekly_quota_micros' | 'monthly_quota_micros',
  legacyField: 'daily_limit_usd' | 'weekly_limit_usd' | 'monthly_limit_usd',
): number | null | undefined {
  if (body[field] !== undefined && body[legacyField] !== undefined) {
    throw new GatewayError(400, `ambiguous_${field}`, `Specify ${field} or ${legacyField}, not both`)
  }
  if (body[field] !== undefined) {
    if (body[field] === null) return null
    return requireSafeInteger(body, field, 0, MAX_MICROS)
  }
  if (body[legacyField] === undefined) return undefined
  if (body[legacyField] === null) return null
  const amount = body[legacyField]
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new GatewayError(400, `invalid_${legacyField}`, `${legacyField} must be a non-negative finite number`)
  }
  const micros = Math.round(amount * 1_000_000)
  if (!Number.isSafeInteger(micros) || micros > MAX_MICROS) {
    throw new GatewayError(400, `invalid_${legacyField}`, `${legacyField} is outside the supported micro-unit range`)
  }
  return micros
}

function optionalText(body: Record<string, unknown>, field: string, maximum: number): string | undefined {
  if (body[field] === undefined) return undefined
  if (typeof body[field] !== 'string' || (body[field] as string).length > maximum) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a string no longer than ${maximum} characters`)
  }
  return (body[field] as string).trim()
}

function parseEnabled(body: Record<string, unknown>, fallback?: boolean): boolean | undefined {
  const enabled = optionalBoolean(body, 'enabled')
  const forSale = optionalBoolean(body, 'for_sale')
  if (enabled !== undefined && forSale !== undefined && enabled !== forSale) {
    throw new GatewayError(400, 'enabled_mismatch', 'enabled and for_sale disagree')
  }
  if (enabled !== undefined || forSale !== undefined) return enabled ?? forSale
  if (body.status === undefined) return fallback
  const status = optionalString(body, 'status', 16)
  if (status !== 'active' && status !== 'inactive') throw new GatewayError(400, 'invalid_status', 'status must be active or inactive')
  return status === 'active'
}

async function requirePlan(env: Env, idValue: string | undefined): Promise<SubscriptionPlanRow> {
  const id = requireResourceId(idValue, 'plan')
  const row = await env.DB.prepare(`SELECT ${PLAN_COLUMNS} FROM subscription_plans WHERE id = ?`).bind(id).first<SubscriptionPlanRow>()
  if (row === null) throw new GatewayError(404, 'subscription_plan_not_found', 'Subscription plan was not found')
  return row
}

async function requireSubscriptionGroup(env: Env, id: string): Promise<PlanGroupRow> {
  const group = await env.DB.prepare(
    `SELECT id, name, platform, enabled, group_type, rate_multiplier_ppm FROM "groups" WHERE id = ? AND deleted_at_ms IS NULL`,
  ).bind(id).first<PlanGroupRow>()
  if (group === null) throw new GatewayError(404, 'group_not_found', 'Group was not found')
  if (group.group_type !== 'subscription') {
    throw new GatewayError(409, 'subscription_plan_requires_subscription_group', 'Subscription plans require a subscription group')
  }
  return group
}

function publicPlan(row: SubscriptionPlanRow, admin: boolean) {
  const result = {
    id: row.id,
    group_id: row.group_id,
    ...(row.group_name === undefined ? {} : { group_name: row.group_name }),
    ...(row.group_platform === undefined ? {} : { group_platform: row.group_platform }),
    ...(row.group_rate_multiplier_ppm === undefined
      ? {}
      : { rate_multiplier: row.group_rate_multiplier_ppm / 1_000_000 }),
    name: row.name,
    description: row.description,
    price: row.price_micros / 1_000_000,
    price_micros: row.price_micros,
    currency: row.currency,
    validity_days: row.validity_days,
    validity_unit: 'days',
    daily_limit_usd: microsToUsd(row.daily_quota_micros),
    weekly_limit_usd: microsToUsd(row.weekly_quota_micros),
    monthly_limit_usd: microsToUsd(row.monthly_quota_micros),
    daily_quota_micros: row.daily_quota_micros,
    weekly_quota_micros: row.weekly_quota_micros,
    monthly_quota_micros: row.monthly_quota_micros,
    features: [] as string[],
    for_sale: row.enabled === 1,
    enabled: row.enabled === 1,
    status: row.enabled === 1 ? 'active' as const : 'inactive' as const,
    sort_order: row.sort_order,
    ...(admin ? {
      control_version: row.control_version,
      created_at_ms: row.created_at_ms,
      updated_at_ms: row.updated_at_ms,
    } : {}),
  }
  return result
}

function microsToUsd(value: number | null): number | null {
  return value === null ? null : value / 1_000_000
}

function assertControlVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new GatewayError(412, 'control_version_conflict', 'Resource changed; reload it and retry')
  if (expected >= Number.MAX_SAFE_INTEGER) throw new GatewayError(409, 'control_version_exhausted', 'Resource control version is exhausted')
}

function mapPlanWriteError(error: unknown): unknown {
  if (error instanceof GatewayError) return error
  const message = error instanceof Error ? error.message : ''
  if (message.includes('UNIQUE constraint')) return new GatewayError(409, 'subscription_plan_conflict', 'A subscription plan with this name already exists in the group')
  if (message.includes('control_version')) return new GatewayError(412, 'control_version_conflict', 'Resource changed; reload it and retry')
  if (message.includes('subscription_plan_') || message.includes('FOREIGN KEY')) {
    return new GatewayError(409, 'subscription_plan_conflict', 'Subscription plan relation changed; reload and retry')
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
