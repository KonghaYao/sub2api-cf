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
  queryInteger,
  readJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
} from './http'

type ControlBindings = { Bindings: Env }

interface RateMultiplierInput {
  user_id: string
  rate_multiplier_ppm: number
}

interface GroupRow {
  control_version: number
}

interface RateRow {
  user_id: string
  user_name: string
  user_email: string
  user_notes: string
  user_status: string
  rate_multiplier_ppm: number | null
  rpm_override: number | null
  control_version: number | null
}

interface MutationResult {
  message: string
  updated?: number
  deleted?: number
  control_version: number
}

/**
 * Preserves the legacy endpoint's array response. Optional search and paging
 * are useful to direct API clients; the original modal continues to fetch the
 * complete array and paginate locally.
 */
export async function listAdminGroupRateMultipliers(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const groupId = requireResourceId(context.req.param('id'), 'group')
    await requireGroup(context.env, groupId)
    const search = context.req.query('search')?.trim() ?? ''
    if (search.length > 100) {
      throw new GatewayError(400, 'invalid_search', 'search must not exceed 100 characters')
    }
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 100, 1, 100)
    const paged = context.req.query('page') !== undefined || context.req.query('page_size') !== undefined
    const conditions = ['entry.group_id = ?']
    const values: unknown[] = [groupId]
    if (search !== '') {
      const pattern = `%${escapeLike(search)}%`
      conditions.push(`(u.email LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR entry.user_id LIKE ? ESCAPE '\\')`)
      values.push(pattern, pattern, pattern)
    }
    const from = `FROM (
      SELECT group_id, user_id FROM user_group_rate_overrides
      UNION
      SELECT group_id, user_id FROM user_group_rpm_overrides
    ) entry
    JOIN users u ON u.id = entry.user_id
    LEFT JOIN user_group_rate_overrides rate
      ON rate.group_id = entry.group_id AND rate.user_id = entry.user_id
    LEFT JOIN user_group_rpm_overrides rpm
      ON rpm.group_id = entry.group_id AND rpm.user_id = entry.user_id
    WHERE ${conditions.join(' AND ')}`
    const count = paged
      ? await context.env.DB.prepare(`SELECT COUNT(*) AS total ${from}`).bind(...values).first<{ total: number }>()
      : null
    const rows = await context.env.DB.prepare(
      `SELECT entry.user_id, u.display_name AS user_name, u.email AS user_email,
              '' AS user_notes, u.status AS user_status,
              rate.rate_multiplier_ppm, rpm.rpm_override, rate.control_version
         ${from}
        ORDER BY u.display_name COLLATE NOCASE ASC, u.email ASC, entry.user_id ASC
        ${paged ? 'LIMIT ? OFFSET ?' : ''}`,
    ).bind(...values, ...(paged ? [pageSize, (page - 1) * pageSize] : [])).all<RateRow>()
    const items = rows.results.map(publicRateRow)
    if (!paged) return controlSuccess(items)
    if (!Number.isSafeInteger(count?.total) || count!.total < 0) {
      throw new GatewayError(500, 'invalid_rate_multiplier_count', 'Rate multiplier count is invalid', 'server_error')
    }
    return controlSuccess({
      items,
      total: count!.total,
      page,
      page_size: pageSize,
      pages: count!.total === 0 ? 0 : Math.ceil(count!.total / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function putAdminGroupRateMultipliers(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const groupId = requireResourceId(context.req.param('id'), 'group')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const entries = parseEntries(body)
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const idempotency = await controlIdempotency(
      'admin.group-rate-multipliers.put.v1', key, { group_id: groupId, entries, control_version: expectedVersion },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      if (previous.resource_id !== groupId) throw invalidIdempotencyRecord()
      return controlSuccess(parseIdempotentResponse(previous, 'group_rate_multipliers'))
    }
    await requireUsers(context.env, entries.map((entry) => entry.user_id))
    const controlVersion = await claimGroupVersion(context.env, groupId, expectedVersion)
    const now = Date.now()
    const response: MutationResult = {
      message: 'Rate multipliers updated successfully',
      updated: entries.length,
      control_version: controlVersion,
    }
    const retainedUserIds = JSON.stringify(entries.map((entry) => entry.user_id))
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `DELETE FROM user_group_rate_overrides
          WHERE group_id = ?
            AND user_id NOT IN (SELECT value FROM json_each(?))`,
      ).bind(groupId, retainedUserIds),
    ]
    for (let offset = 0; offset < entries.length; offset += 20) {
      const chunk = entries.slice(offset, offset + 20)
      const values = chunk.map(() => '(?, ?, ?, 0, ?, ?)').join(', ')
      const bindings = chunk.flatMap((entry) => [entry.user_id, groupId, entry.rate_multiplier_ppm, now, now])
      statements.push(context.env.DB.prepare(
        `INSERT INTO user_group_rate_overrides (
           user_id, group_id, rate_multiplier_ppm, control_version, created_at_ms, updated_at_ms
         ) VALUES ${values}
         ON CONFLICT(user_id, group_id) DO UPDATE SET
           rate_multiplier_ppm = excluded.rate_multiplier_ppm,
           control_version = user_group_rate_overrides.control_version + 1,
           updated_at_ms = excluded.updated_at_ms`,
      ).bind(...bindings))
    }
    statements.push(controlIdempotencyInsert(
      context.env, idempotency, 'group_rate_multipliers', groupId, response, now,
    ))
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'group_rate_multipliers'))
      throw error
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function clearAdminGroupRateMultipliers(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const groupId = requireResourceId(context.req.param('id'), 'group')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const idempotency = await controlIdempotency(
      'admin.group-rate-multipliers.clear.v1', key, { group_id: groupId, control_version: expectedVersion },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      if (previous.resource_id !== groupId) throw invalidIdempotencyRecord()
      return controlSuccess(parseIdempotentResponse(previous, 'group_rate_multipliers_clear'))
    }
    const controlVersion = await claimGroupVersion(context.env, groupId, expectedVersion)
    const count = await context.env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM user_group_rate_overrides WHERE group_id = ?)
            + (SELECT COUNT(*) FROM user_group_rpm_overrides WHERE group_id = ?) AS total`,
    ).bind(groupId, groupId).first<{ total: number }>()
    if (!Number.isSafeInteger(count?.total) || count!.total < 0) {
      throw new GatewayError(500, 'invalid_rate_multiplier_count', 'Rate multiplier count is invalid', 'server_error')
    }
    const now = Date.now()
    const response: MutationResult = {
      message: 'Rate multipliers cleared successfully', deleted: count!.total, control_version: controlVersion,
    }
    await context.env.DB.batch([
      context.env.DB.prepare('DELETE FROM user_group_rate_overrides WHERE group_id = ?').bind(groupId),
      context.env.DB.prepare('DELETE FROM user_group_rpm_overrides WHERE group_id = ?').bind(groupId),
      controlIdempotencyInsert(context.env, idempotency, 'group_rate_multipliers_clear', groupId, response, now),
    ])
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function publicRateRow(row: RateRow) {
  return {
    user_id: row.user_id,
    user_name: row.user_name,
    user_email: row.user_email,
    user_notes: row.user_notes,
    user_status: row.user_status,
    ...(row.rate_multiplier_ppm === null ? {} : { rate_multiplier: row.rate_multiplier_ppm / 1_000_000 }),
    ...(row.rpm_override === null ? {} : { rpm_override: row.rpm_override }),
    ...(row.control_version === null ? {} : { control_version: row.control_version }),
  }
}

function parseEntries(body: Record<string, unknown>): RateMultiplierInput[] {
  if (!Array.isArray(body.entries) || body.entries.length > 100) {
    throw new GatewayError(400, 'invalid_entries', 'entries must contain between 0 and 100 items')
  }
  const seen = new Set<string>()
  return body.entries.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new GatewayError(400, 'invalid_entry', 'Each rate multiplier entry must be an object')
    }
    const item = value as Record<string, unknown>
    const userId = requireResourceId(typeof item.user_id === 'string' ? item.user_id : undefined, 'user')
    if (seen.has(userId)) throw new GatewayError(400, 'duplicate_user_id', 'Each user may appear only once')
    seen.add(userId)
    if (typeof item.rate_multiplier !== 'number' || !Number.isFinite(item.rate_multiplier) || item.rate_multiplier <= 0) {
      throw new GatewayError(400, 'invalid_rate_multiplier', 'rate_multiplier must be a positive finite number')
    }
    const ppm = Math.round(item.rate_multiplier * 1_000_000)
    if (!Number.isSafeInteger(ppm) || ppm <= 0) {
      throw new GatewayError(400, 'invalid_rate_multiplier', 'rate_multiplier is outside the supported range')
    }
    return { user_id: userId, rate_multiplier_ppm: ppm }
  })
}

async function requireGroup(env: Env, groupId: string): Promise<GroupRow> {
  const group = await env.DB.prepare('SELECT control_version FROM "groups" WHERE id = ? AND deleted_at_ms IS NULL').bind(groupId).first<GroupRow>()
  if (group === null) throw new GatewayError(404, 'group_not_found', 'Group was not found')
  return group
}

async function claimGroupVersion(env: Env, groupId: string, expectedVersion: number): Promise<number> {
  const group = await requireGroup(env, groupId)
  if (group.control_version !== expectedVersion) {
    throw new GatewayError(412, 'control_version_conflict', 'Resource changed; reload it and retry')
  }
  if (expectedVersion >= Number.MAX_SAFE_INTEGER) {
    throw new GatewayError(409, 'control_version_exhausted', 'Resource control version is exhausted')
  }
  const update = await env.DB.prepare(
    `UPDATE "groups" SET control_version = control_version + 1, updated_at_ms = ?
      WHERE id = ? AND control_version = ?`,
  ).bind(Date.now(), groupId, expectedVersion).run()
  if (update.meta.changes !== 1) {
    throw new GatewayError(412, 'control_version_conflict', 'Resource changed; reload it and retry')
  }
  return expectedVersion + 1
}

async function requireUsers(env: Env, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return
  const rows = await env.DB.prepare(`SELECT id FROM users WHERE id IN (${userIds.map(() => '?').join(', ')})`)
    .bind(...userIds).all<{ id: string }>()
  const found = new Set(rows.results.map((row) => row.id))
  const missing = userIds.find((id) => !found.has(id))
  if (missing !== undefined) throw new GatewayError(404, 'user_not_found', `User '${missing}' was not found`)
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function invalidIdempotencyRecord(): GatewayError {
  return new GatewayError(503, 'invalid_idempotency_record', 'Idempotency record is invalid', 'server_error')
}
