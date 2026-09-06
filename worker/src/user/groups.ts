import type { Context } from 'hono'
import { authenticateUserRequest } from '../auth/handler'
import { controlError, controlSuccess } from '../control/http'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { groupAccessPredicate } from './group-access'

type UserBindings = { Bindings: Env }

interface AvailableGroupRow {
  id: string
  name: string
  description: string | null
  platform: string
  rate_multiplier_ppm: number
  group_type: 'standard' | 'subscription'
  is_exclusive: number
  allow_image_generation: number
  allow_batch_image_generation: number
}

interface UserGroupRateRow {
  group_id: string
  rate_multiplier_ppm: number
}

interface UserGroupAccessRow {
  enabled: number
  accessible: number
}

/**
 * Lists the enabled groups the authenticated user may bind to an API key.
 *
 * Access is deliberately resolved in D1 rather than inferred by the client:
 * public standard groups are available to everyone, explicit permissions can
 * grant a private group, and subscription groups require a currently active
 * subscription unless they were explicitly granted.
 */
export async function listAvailableUserGroups(
  context: Context<UserBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const now = Date.now()
    const rows = await context.env.DB.prepare(
      `SELECT g.id, g.name, g.description, g.platform,
              g.rate_multiplier_ppm, g.group_type, g.is_exclusive,
              g.allow_image_generation, g.allow_batch_image_generation
         FROM "groups" g
        WHERE g.enabled = 1
          AND ${groupAccessPredicate('g')}
        ORDER BY g.sort_order ASC, g.name COLLATE NOCASE ASC, g.id ASC`,
    ).bind(user.id, user.id, user.id, now, now).all<AvailableGroupRow>()

    const response = controlSuccess(rows.results.map(publicAvailableGroup))
    response.headers.set(
      'x-sub2api-group-access-policy',
      'public-permission-or-active-subscription',
    )
    return response
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** Return per-user rate overrides only for groups the user may currently use. */
export async function getUserGroupRates(context: Context<UserBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const now = Date.now()
    const rows = await context.env.DB.prepare(
      `SELECT r.group_id, r.rate_multiplier_ppm
         FROM user_group_rate_overrides r
         JOIN "groups" g ON g.id = r.group_id
        WHERE r.user_id = ?
          AND g.enabled = 1
          AND ${groupAccessPredicate('g')}
        ORDER BY r.group_id ASC`,
    ).bind(user.id, user.id, user.id, user.id, now, now).all<UserGroupRateRow>()

    const rates: Record<string, number> = Object.create(null) as Record<string, number>
    for (const row of rows.results) {
      rates[row.group_id] = ppmToMultiplier(row.rate_multiplier_ppm)
    }
    const response = controlSuccess(rates)
    response.headers.set('x-sub2api-group-rates-policy', 'accessible-overrides-only')
    return response
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/**
 * Authoritatively checks whether a user may bind an API key to a group.
 *
 * Keep this check server-side and shared with the group-list predicate so a
 * client cannot bypass a private/subscription group by posting its UUID
 * directly instead of selecting it from the advertised list.
 */
export async function requireUserGroupAccess(
  env: Env,
  userId: string,
  groupId: string,
  action: 'create' | 'bind',
): Promise<void> {
  const now = Date.now()
  const group = await env.DB.prepare(
    `SELECT g.enabled,
            CASE WHEN ${groupAccessPredicate('g')} THEN 1 ELSE 0 END AS accessible
       FROM "groups" g
      WHERE g.id = ?`,
  ).bind(userId, userId, userId, now, now, groupId).first<UserGroupAccessRow>()

  if (group === null) throw new GatewayError(404, 'group_not_found', 'Group was not found')
  if (group.enabled !== 1) {
    const message = action === 'create'
      ? 'Cannot create an API key for a disabled group'
      : 'Cannot bind an API key to a disabled group'
    throw new GatewayError(409, 'group_disabled', message)
  }
  if (group.accessible !== 1) {
    const message = action === 'create'
      ? 'Cannot create an API key for a group you cannot access'
      : 'Cannot bind an API key to a group you cannot access'
    throw new GatewayError(403, 'group_access_denied', message)
  }
}

function publicAvailableGroup(row: AvailableGroupRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    platform: row.platform,
    rate_multiplier: ppmToMultiplier(row.rate_multiplier_ppm),
    is_exclusive: row.is_exclusive === 1,
    status: 'active',
    subscription_type: row.group_type,
    allow_image_generation: row.allow_image_generation === 1,
    allow_batch_image_generation: row.allow_batch_image_generation === 1,
  }
}

function ppmToMultiplier(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError(
      500,
      'invalid_group_rate_multiplier',
      'Group rate multiplier is invalid',
      'server_error',
    )
  }
  return value / 1_000_000
}
