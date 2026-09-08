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
  readJsonObject,
  requireIdempotencyKey,
  requireResourceId,
} from './http'

type ControlBindings = { Bindings: Env }

interface RpmOverrideInput {
  user_id: string
  rpm_override: number
}

interface RpmOverrideMutationResult {
  message: string
  updated?: number
  deleted?: number
}

export async function listAdminGroupRpmOverrides(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const groupId = requireResourceId(context.req.param('id'), 'group')
    await requireGroup(context.env, groupId)
    const rows = await context.env.DB.prepare(
      `SELECT rpm.user_id, u.display_name AS user_name, u.email AS user_email,
              '' AS user_notes, u.status AS user_status,
              rpm.rpm_override, rpm.control_version
         FROM user_group_rpm_overrides rpm
         JOIN users u ON u.id = rpm.user_id
        WHERE rpm.group_id = ?
        ORDER BY u.display_name COLLATE NOCASE ASC, u.email ASC, rpm.user_id ASC`,
    ).bind(groupId).all()
    return controlSuccess(rows.results)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function putAdminGroupRpmOverrides(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const groupId = requireResourceId(context.req.param('id'), 'group')
    const key = requireIdempotencyKey(context.req.raw)
    const entries = parseEntries(await readJsonObject(context.req.raw))
    const idempotency = await controlIdempotency(
      'admin.group-rpm-overrides.put.v1',
      key,
      { group_id: groupId, entries },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      if (previous.resource_id !== groupId) throw invalidIdempotencyRecord()
      return controlSuccess(parseIdempotentResponse(previous, 'group_rpm_overrides'))
    }
    await Promise.all([
      requireGroup(context.env, groupId),
      requireUsers(context.env, entries.map((entry) => entry.user_id)),
    ])
    const now = Date.now()
    const response: RpmOverrideMutationResult = {
      message: 'RPM overrides updated',
      updated: entries.length,
    }
    // PUT replaces the complete override set for this group. JSON1 keeps the
    // deletion at two binds even for the maximum 100 retained users, while the
    // following UPSERTs stay below D1's conservative per-statement bind budget.
    // D1 executes the whole batch atomically, so readers cannot observe the
    // deletion without its matching UPSERTs and idempotency record.
    const retainedUserIds = JSON.stringify(entries.map((entry) => entry.user_id))
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `DELETE FROM user_group_rpm_overrides
          WHERE group_id = ?
            AND user_id NOT IN (SELECT value FROM json_each(?))`,
      ).bind(groupId, retainedUserIds),
    ]
    for (let offset = 0; offset < entries.length; offset += 20) {
      const chunk = entries.slice(offset, offset + 20)
      const values = chunk.map(() => '(?, ?, ?, 0, ?, ?)').join(', ')
      const bindings = chunk.flatMap((entry) => [
        entry.user_id,
        groupId,
        entry.rpm_override,
        now,
        now,
      ])
      statements.push(context.env.DB.prepare(
        `INSERT INTO user_group_rpm_overrides (
           user_id, group_id, rpm_override, control_version, created_at_ms, updated_at_ms
         ) VALUES ${values}
         ON CONFLICT(user_id, group_id) DO UPDATE SET
           rpm_override = excluded.rpm_override,
           control_version = user_group_rpm_overrides.control_version + 1,
           updated_at_ms = excluded.updated_at_ms`,
      ).bind(...bindings))
    }
    statements.push(controlIdempotencyInsert(
      context.env,
      idempotency,
      'group_rpm_overrides',
      groupId,
      response,
      now,
    ))
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        if (recovered.resource_id !== groupId) throw invalidIdempotencyRecord()
        return controlSuccess(parseIdempotentResponse(recovered, 'group_rpm_overrides'))
      }
      throw error
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function clearAdminGroupRpmOverrides(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const groupId = requireResourceId(context.req.param('id'), 'group')
    const key = requireIdempotencyKey(context.req.raw)
    const idempotency = await controlIdempotency(
      'admin.group-rpm-overrides.clear.v1',
      key,
      { group_id: groupId },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      if (previous.resource_id !== groupId) throw invalidIdempotencyRecord()
      return controlSuccess(parseIdempotentResponse(previous, 'group_rpm_overrides_clear'))
    }
    await requireGroup(context.env, groupId)
    const count = await context.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM user_group_rpm_overrides WHERE group_id = ?`,
    ).bind(groupId).first<{ total: number }>()
    if (!Number.isSafeInteger(count?.total) || count!.total < 0) {
      throw new GatewayError(500, 'invalid_rpm_override_count', 'RPM override count is invalid', 'server_error')
    }
    const response: RpmOverrideMutationResult = {
      message: 'RPM overrides cleared',
      deleted: count!.total,
    }
    const now = Date.now()
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `DELETE FROM user_group_rpm_overrides WHERE group_id = ?`,
        ).bind(groupId),
        controlIdempotencyInsert(
          context.env,
          idempotency,
          'group_rpm_overrides_clear',
          groupId,
          response,
          now,
        ),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        if (recovered.resource_id !== groupId) throw invalidIdempotencyRecord()
        return controlSuccess(parseIdempotentResponse(recovered, 'group_rpm_overrides_clear'))
      }
      throw error
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function parseEntries(body: Record<string, unknown>): RpmOverrideInput[] {
  if (!Array.isArray(body.entries) || body.entries.length > 100) {
    throw new GatewayError(400, 'invalid_entries', 'entries must contain between 0 and 100 items')
  }
  const seen = new Set<string>()
  return body.entries.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new GatewayError(400, 'invalid_entry', 'Each RPM override entry must be an object')
    }
    const item = value as Record<string, unknown>
    const userId = requireResourceId(
      typeof item.user_id === 'string' ? item.user_id : undefined,
      'user',
    )
    if (seen.has(userId)) {
      throw new GatewayError(400, 'duplicate_user_id', 'Each user may appear only once')
    }
    seen.add(userId)
    if (!Number.isSafeInteger(item.rpm_override) || (item.rpm_override as number) < 0) {
      throw new GatewayError(400, 'invalid_rpm_override', 'rpm_override must be a non-negative safe integer')
    }
    return { user_id: userId, rpm_override: item.rpm_override as number }
  })
}

async function requireGroup(env: Env, groupId: string): Promise<void> {
  const group = await env.DB.prepare(
    `SELECT id FROM "groups" WHERE id = ? AND deleted_at_ms IS NULL`,
  ).bind(groupId).first<{ id: string }>()
  if (group === null) throw new GatewayError(404, 'group_not_found', 'Group was not found')
}

async function requireUsers(env: Env, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return
  const placeholders = userIds.map(() => '?').join(', ')
  const rows = await env.DB.prepare(
    `SELECT id FROM users WHERE id IN (${placeholders})`,
  ).bind(...userIds).all<{ id: string }>()
  const found = new Set(rows.results.map((row) => row.id))
  const missing = userIds.find((id) => !found.has(id))
  if (missing !== undefined) {
    throw new GatewayError(404, 'user_not_found', `User '${missing}' was not found`)
  }
}

function invalidIdempotencyRecord(): GatewayError {
  return new GatewayError(
    503,
    'invalid_idempotency_record',
    'Idempotency record is invalid',
    'server_error',
  )
}
