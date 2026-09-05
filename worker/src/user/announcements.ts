import type { Context } from 'hono'
import { authenticateUserRequest } from '../auth/handler'
import { authenticateAdminSession, type AdminActor } from '../control/admin-auth'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
} from '../control/idempotency'
import {
  controlError,
  controlSuccess,
  queryInteger,
  readJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
} from '../control/http'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'

type Bindings = { Bindings: Env }
type AnnouncementStatus = 'draft' | 'active' | 'archived'
type NotifyMode = 'silent' | 'popup'
type Operator = 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'eq'

interface AnnouncementCondition {
  type: 'subscription' | 'balance'
  operator: Operator
  group_ids?: string[]
  value_micros?: number
}

interface AnnouncementTargeting {
  any_of: Array<{ all_of: AnnouncementCondition[] }>
}

interface AnnouncementRow {
  id: string
  title: string
  content: string
  status: AnnouncementStatus
  notify_mode: NotifyMode
  targeting_json: string
  starts_at_ms: number | null
  ends_at_ms: number | null
  created_by_user_id: string | null
  updated_by_user_id: string | null
  control_version: number
  created_at_ms: number
  updated_at_ms: number
}

interface AnnouncementView {
  id: string
  title: string
  content: string
  status: AnnouncementStatus
  notify_mode: NotifyMode
  targeting: Record<string, unknown>
  starts_at: string | null
  ends_at: string | null
  created_by: string | null
  updated_by: string | null
  control_version: number
  created_at: string
  updated_at: string
}

const CREATE_SCOPE = 'admin.announcement.create.v1'
const UPDATE_SCOPE = 'admin.announcement.update.v1'
const DELETE_SCOPE = 'admin.announcement.delete.v1'
const RESOURCE_TYPE = 'announcement'
const ACTIVE_LIMIT = 500
const ADMIN_PAGE_LIMIT = 100
const TARGETING_CONDITION_LIMIT = 100
const TARGETING_GROUP_ID_LIMIT = 90
const SUBSCRIPTION_LOOKUP_CHUNK = 98

export async function createAdminAnnouncement(context: Context<Bindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw, 80 * 1024)
    rejectUnknownFields(body, [
      'title', 'content', 'status', 'notify_mode', 'targeting', 'starts_at', 'ends_at',
    ])
    const input = await parseAnnouncementInput(context.env, body)
    const idempotency = await controlIdempotency(
      CREATE_SCOPE,
      requireIdempotencyKey(context.req.raw),
      input,
    )
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) {
      return announcementResponse(parseIdempotentResponse(replay, RESOURCE_TYPE), 201)
    }

    const now = Date.now()
    const id = crypto.randomUUID()
    const row: AnnouncementRow = {
      id,
      title: input.title,
      content: input.content,
      status: input.status,
      notify_mode: input.notify_mode,
      targeting_json: JSON.stringify(input.targeting),
      starts_at_ms: input.starts_at_ms,
      ends_at_ms: input.ends_at_ms,
      created_by_user_id: actor.user_id,
      updated_by_user_id: actor.user_id,
      control_version: 1,
      created_at_ms: now,
      updated_at_ms: now,
    }
    const view = announcementView(row)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO announcements (
             id, title, content, status, notify_mode, targeting_json,
             starts_at_ms, ends_at_ms, created_by_user_id, updated_by_user_id,
             control_version, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).bind(
          id, row.title, row.content, row.status, row.notify_mode, row.targeting_json,
          row.starts_at_ms, row.ends_at_ms, actor.user_id, actor.user_id, now, now,
        ),
        context.env.DB.prepare(
          `INSERT INTO announcement_admin_audit_events (
             id, actor_user_id, actor_session_id, action, announcement_id,
             resource_version, details_json, occurred_at_ms
           ) VALUES (?, ?, ?, 'announcement.create', ?, 1, ?, ?)`,
        ).bind(
          crypto.randomUUID(), actor.user_id, actor.session_id, id,
          JSON.stringify({ status: row.status, notify_mode: row.notify_mode }), now,
        ),
        controlIdempotencyInsert(context.env, idempotency, RESOURCE_TYPE, id, view, now),
      ])
    } catch (error) {
      if (isIdempotencyRace(error)) {
        const winner = await findControlIdempotency(context.env, idempotency)
        if (winner !== null) {
          return announcementResponse(parseIdempotentResponse(winner, RESOURCE_TYPE), 201)
        }
      }
      throw error
    }
    return announcementResponse(view, 201)
  } catch (error) {
    return controlError(normalizeAnnouncementError(error))
  }
}

export async function listAdminAnnouncements(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, ADMIN_PAGE_LIMIT)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const status = context.req.query('status')?.trim() ?? ''
    if (status !== '' && !['draft', 'active', 'archived'].includes(status)) {
      throw new GatewayError(400, 'invalid_status', 'status is invalid')
    }
    const search = (context.req.query('search') ?? '').trim().slice(0, 200)
    const sortBy = context.req.query('sort_by') ?? 'created_at'
    const sortOrder = (context.req.query('sort_order') ?? 'desc').toLowerCase()
    const sortColumns: Record<string, string> = {
      id: 'id', title: 'title COLLATE NOCASE', status: 'status',
      notify_mode: 'notify_mode', starts_at: 'starts_at_ms', ends_at: 'ends_at_ms',
      created_at: 'created_at_ms', updated_at: 'updated_at_ms',
    }
    const sortColumn = sortColumns[sortBy]
    if (sortColumn === undefined || !['asc', 'desc'].includes(sortOrder)) {
      throw new GatewayError(400, 'invalid_sort', 'sort_by or sort_order is invalid')
    }
    const clauses: string[] = []
    const values: unknown[] = []
    if (status !== '') {
      clauses.push('status = ?')
      values.push(status)
    }
    if (search !== '') {
      clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')")
      const pattern = `${escapeLike(search)}%`
      values.push(pattern, pattern)
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    const offset = (page - 1) * pageSize
    const [rowsResult, countResult] = await context.env.DB.batch([
      context.env.DB.prepare(
        `SELECT id, title, content, status, notify_mode, targeting_json,
                starts_at_ms, ends_at_ms, created_by_user_id, updated_by_user_id,
                control_version, created_at_ms, updated_at_ms
           FROM announcements ${where}
          ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}, id ${sortOrder.toUpperCase()}
          LIMIT ? OFFSET ?`,
      ).bind(...values, pageSize, offset),
      context.env.DB.prepare(`SELECT COUNT(*) AS total FROM announcements ${where}`).bind(...values),
    ])
    const total = Number((countResult.results[0] as { total: number } | undefined)?.total ?? 0)
    return controlSuccess({
      items: (rowsResult.results as unknown as AnnouncementRow[]).map(announcementView),
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(normalizeAnnouncementError(error))
  }
}

export async function getAdminAnnouncement(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const row = await requireAnnouncement(context.env, context.req.param('id'))
    return announcementResponse(announcementView(row), 200)
  } catch (error) {
    return controlError(normalizeAnnouncementError(error))
  }
}

export async function updateAdminAnnouncement(context: Context<Bindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const id = requireResourceId(context.req.param('id'), 'announcement')
    const body = await readJsonObject(context.req.raw, 80 * 1024)
    rejectUnknownFields(body, [
      'title', 'content', 'status', 'notify_mode', 'targeting', 'starts_at', 'ends_at',
      'expected_control_version',
    ])
    const expectedVersion = requireExpectedControlVersion(context.req.raw, body)
    const idempotency = await controlIdempotency(
      UPDATE_SCOPE,
      requireIdempotencyKey(context.req.raw),
      { id, expected_control_version: expectedVersion, body },
    )
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) return announcementResponse(parseIdempotentResponse(replay, RESOURCE_TYPE), 200)
    const current = await requireAnnouncement(context.env, id)
    if (current.control_version !== expectedVersion) throw controlVersionConflict()
    const input = await parseAnnouncementPatch(context.env, current, body)

    const now = Date.now()
    const next: AnnouncementRow = {
      ...current,
      ...input,
      targeting_json: JSON.stringify(input.targeting),
      updated_by_user_id: actor.user_id,
      control_version: expectedVersion + 1,
      updated_at_ms: now,
    }
    const view = announcementView(next)
    try {
      await context.env.DB.batch([
        guardedAuditInsert(
          context.env, actor, 'announcement.update', id,
          expectedVersion, next.control_version,
          { from_status: current.status, to_status: next.status }, now,
        ),
        context.env.DB.prepare(
          `UPDATE announcements
              SET title = ?, content = ?, status = ?, notify_mode = ?, targeting_json = ?,
                  starts_at_ms = ?, ends_at_ms = ?, updated_by_user_id = ?,
                  control_version = ?, updated_at_ms = ?
            WHERE id = ? AND control_version = ?`,
        ).bind(
          next.title, next.content, next.status, next.notify_mode, next.targeting_json,
          next.starts_at_ms, next.ends_at_ms, actor.user_id,
          next.control_version, now, id, expectedVersion,
        ),
        controlIdempotencyInsert(context.env, idempotency, RESOURCE_TYPE, id, view, now),
      ])
    } catch (error) {
      const recovered = await recoverIdempotencyRace(context.env, idempotency)
      if (recovered !== null) return announcementResponse(recovered, 200)
      throw error
    }
    return announcementResponse(view, 200)
  } catch (error) {
    return controlError(normalizeAnnouncementError(error))
  }
}

export async function deleteAdminAnnouncement(context: Context<Bindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const id = requireResourceId(context.req.param('id'), 'announcement')
    const expectedVersion = requireExpectedControlVersion(context.req.raw, {})
    const idempotency = await controlIdempotency(
      DELETE_SCOPE,
      requireIdempotencyKey(context.req.raw),
      { id, expected_control_version: expectedVersion },
    )
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) return controlSuccess(parseIdempotentResponse(replay, RESOURCE_TYPE))
    const current = await requireAnnouncement(context.env, id)
    if (current.control_version !== expectedVersion) throw controlVersionConflict()
    const now = Date.now()
    const response = { message: 'Announcement deleted successfully' }
    try {
      await context.env.DB.batch([
        guardedAuditInsert(
          context.env, actor, 'announcement.delete', id,
          expectedVersion, expectedVersion + 1,
          { status: current.status }, now,
        ),
        context.env.DB.prepare(
          `DELETE FROM announcements WHERE id = ? AND control_version = ?`,
        ).bind(id, expectedVersion),
        controlIdempotencyInsert(context.env, idempotency, RESOURCE_TYPE, id, response, now),
      ])
    } catch (error) {
      const recovered = await recoverIdempotencyRace(context.env, idempotency)
      if (recovered !== null) return controlSuccess(recovered)
      throw error
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(normalizeAnnouncementError(error))
  }
}

export async function listAdminAnnouncementReadStatus(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const announcement = await requireAnnouncement(context.env, context.req.param('id'))
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, ADMIN_PAGE_LIMIT)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const search = (context.req.query('search') ?? '').trim().slice(0, 200)
    const sortBy = context.req.query('sort_by') ?? 'email'
    const sortOrder = (context.req.query('sort_order') ?? 'asc').toLowerCase()
    const sortColumns: Record<string, string> = {
      email: 'u.email COLLATE NOCASE', username: 'u.display_name COLLATE NOCASE',
      balance: 'u.balance_micros', created_at: 'u.created_at_ms', user_id: 'u.id',
    }
    const sortColumn = sortColumns[sortBy]
    if (sortColumn === undefined || !['asc', 'desc'].includes(sortOrder)) {
      throw new GatewayError(400, 'invalid_sort', 'sort_by or sort_order is invalid')
    }
    const where = search === ''
      ? ''
      : "WHERE u.email LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\'"
    const values = search === '' ? [] : [`${escapeLike(search)}%`, `${escapeLike(search)}%`]
    const offset = (page - 1) * pageSize
    const [usersResult, countResult] = await context.env.DB.batch([
      context.env.DB.prepare(
        `SELECT u.id, u.email, u.display_name, u.balance_micros, r.read_at_ms
           FROM users AS u
           LEFT JOIN announcement_reads AS r
             ON r.user_id = u.id AND r.announcement_id = ?
          ${where}
          ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}, u.id ${sortOrder.toUpperCase()}
          LIMIT ? OFFSET ?`,
      ).bind(announcement.id, ...values, pageSize, offset),
      context.env.DB.prepare(`SELECT COUNT(*) AS total FROM users AS u ${where}`).bind(...values),
    ])
    const users = usersResult.results as unknown as Array<{
      id: string
      email: string
      display_name: string
      balance_micros: number
      read_at_ms: number | null
    }>
    const subscriptionsByUser = new Map<string, Set<string>>()
    if (users.length > 0) {
      const now = Date.now()
      const userIds = users.map((user) => user.id)
      const statements: D1PreparedStatement[] = []
      for (let offset = 0; offset < userIds.length; offset += SUBSCRIPTION_LOOKUP_CHUNK) {
        const chunk = userIds.slice(offset, offset + SUBSCRIPTION_LOOKUP_CHUNK)
        const placeholders = chunk.map(() => '?').join(', ')
        statements.push(context.env.DB.prepare(
          `SELECT user_id, group_id FROM user_subscriptions
            WHERE user_id IN (${placeholders}) AND status = 'active'
              AND starts_at_ms <= ? AND expires_at_ms > ?`,
        ).bind(...chunk, now, now))
      }
      const subscriptionResults = await context.env.DB.batch(statements)
      for (const result of subscriptionResults) {
        for (const row of result.results as unknown as Array<{ user_id: string; group_id: string }>) {
          const groups = subscriptionsByUser.get(row.user_id) ?? new Set<string>()
          groups.add(row.group_id)
          subscriptionsByUser.set(row.user_id, groups)
        }
      }
    }
    const targeting = parseStoredTargeting(announcement.targeting_json)
    const items = users.map((user) => ({
      user_id: user.id,
      email: user.email,
      username: user.display_name || user.email.slice(0, user.email.indexOf('@')),
      balance: user.balance_micros / 1_000_000,
      eligible: targetingMatches(
        targeting,
        user.balance_micros,
        subscriptionsByUser.get(user.id) ?? new Set(),
      ),
      read_at: toIso(user.read_at_ms),
    }))
    const total = Number((countResult.results[0] as { total: number } | undefined)?.total ?? 0)
    return controlSuccess({
      items,
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(normalizeAnnouncementError(error))
  }
}

export async function listMyAnnouncements(context: Context<Bindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const unreadOnly = parseBooleanQuery(context.req.query('unread_only'))
    const now = Date.now()
    const [announcementResult, subscriptionResult, readResult] = await context.env.DB.batch([
      context.env.DB.prepare(
        `SELECT id, title, content, status, notify_mode, targeting_json,
                starts_at_ms, ends_at_ms, created_by_user_id, updated_by_user_id,
                control_version, created_at_ms, updated_at_ms
           FROM announcements
          WHERE status = 'active'
            AND (starts_at_ms IS NULL OR starts_at_ms <= ?)
            AND (ends_at_ms IS NULL OR ends_at_ms > ?)
          ORDER BY created_at_ms DESC, id DESC
          LIMIT ?`,
      ).bind(now, now, ACTIVE_LIMIT + 1),
      context.env.DB.prepare(
        `SELECT group_id FROM user_subscriptions
          WHERE user_id = ? AND status = 'active'
            AND starts_at_ms <= ? AND expires_at_ms > ?`,
      ).bind(user.id, now, now),
      context.env.DB.prepare(
        `SELECT r.announcement_id, r.read_at_ms
           FROM announcement_reads AS r
           JOIN announcements AS a ON a.id = r.announcement_id
          WHERE r.user_id = ? AND a.status = 'active'
            AND (a.starts_at_ms IS NULL OR a.starts_at_ms <= ?)
            AND (a.ends_at_ms IS NULL OR a.ends_at_ms > ?)`,
      ).bind(user.id, now, now),
    ])
    const rows = announcementResult.results as unknown as AnnouncementRow[]
    if (rows.length > ACTIVE_LIMIT) {
      throw new GatewayError(503, 'announcement_feed_limit_exceeded', 'Announcement feed is temporarily unavailable', 'server_error')
    }
    const groups = new Set((subscriptionResult.results as unknown as Array<{ group_id: string }>).map((row) => row.group_id))
    const reads = new Map((readResult.results as unknown as Array<{ announcement_id: string; read_at_ms: number }>).map((row) => [row.announcement_id, row.read_at_ms]))
    const items = rows
      .filter((row) => targetingMatches(parseStoredTargeting(row.targeting_json), user.balance_micros, groups))
      .map((row) => ({ ...userAnnouncementView(row), read_at: toIso(reads.get(row.id) ?? null) }))
      .filter((row) => !unreadOnly || row.read_at === null)
      .sort((left, right) => {
        if ((left.read_at === null) !== (right.read_at === null)) return left.read_at === null ? -1 : 1
        return right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id)
      })
    return controlSuccess(items)
  } catch (error) {
    return controlError(normalizeAnnouncementError(error))
  }
}

export async function markMyAnnouncementRead(context: Context<Bindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const id = requireResourceId(context.req.param('id'), 'announcement')
    const now = Date.now()
    const row = await context.env.DB.prepare(
      `SELECT id, title, content, status, notify_mode, targeting_json,
              starts_at_ms, ends_at_ms, created_by_user_id, updated_by_user_id,
              control_version, created_at_ms, updated_at_ms
         FROM announcements WHERE id = ?`,
    ).bind(id).first<AnnouncementRow>()
    if (row === null || !isActiveAt(row, now)) throw announcementNotFound()
    const subscriptions = await context.env.DB.prepare(
      `SELECT group_id FROM user_subscriptions
        WHERE user_id = ? AND status = 'active'
          AND starts_at_ms <= ? AND expires_at_ms > ?`,
    ).bind(user.id, now, now).all<{ group_id: string }>()
    const groups = new Set(subscriptions.results.map((item) => item.group_id))
    if (!targetingMatches(parseStoredTargeting(row.targeting_json), user.balance_micros, groups)) {
      throw announcementNotFound()
    }
    await context.env.DB.prepare(
      `INSERT INTO announcement_reads (announcement_id, user_id, read_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(announcement_id, user_id) DO NOTHING`,
    ).bind(id, user.id, now).run()
    return controlSuccess({ message: 'ok' })
  } catch (error) {
    return controlError(normalizeAnnouncementError(error))
  }
}

interface ParsedInput {
  title: string
  content: string
  status: AnnouncementStatus
  notify_mode: NotifyMode
  targeting: AnnouncementTargeting
  starts_at_ms: number | null
  ends_at_ms: number | null
}

async function parseAnnouncementPatch(
  env: Env,
  current: AnnouncementRow,
  body: Record<string, unknown>,
): Promise<ParsedInput> {
  const currentTargeting = parseStoredTargeting(current.targeting_json)
  const title = body.title === undefined
    ? current.title
    : requireTrimmedString(body.title, 'title', 200)
  const content = body.content === undefined
    ? current.content
    : requireTrimmedString(body.content, 'content', 65_536)
  const status = body.status === undefined
    ? current.status
    : parseEnum(body.status, 'status', ['draft', 'active', 'archived'] as const)
  const notifyMode = body.notify_mode === undefined
    ? current.notify_mode
    : parseEnum(body.notify_mode, 'notify_mode', ['silent', 'popup'] as const)
  const targeting = body.targeting === undefined ? currentTargeting : parseTargeting(body.targeting)
  if (body.targeting !== undefined) await requireTargetGroups(env, targeting)
  const startsAt = body.starts_at === undefined
    ? current.starts_at_ms
    : parseUnixSeconds(body.starts_at, 'starts_at')
  const endsAt = body.ends_at === undefined
    ? current.ends_at_ms
    : parseUnixSeconds(body.ends_at, 'ends_at')
  if (startsAt !== null && endsAt !== null && startsAt >= endsAt) {
    throw new GatewayError(400, 'announcement_invalid_schedule', 'starts_at must be before ends_at')
  }
  if (Object.keys(body).every((field) => field === 'expected_control_version')) {
    throw new GatewayError(400, 'empty_announcement_update', 'At least one announcement field is required')
  }
  return {
    title,
    content,
    status,
    notify_mode: notifyMode,
    targeting,
    starts_at_ms: startsAt,
    ends_at_ms: endsAt,
  }
}

async function requireAnnouncement(env: Env, rawId: string | undefined): Promise<AnnouncementRow> {
  const id = requireResourceId(rawId, 'announcement')
  const row = await env.DB.prepare(
    `SELECT id, title, content, status, notify_mode, targeting_json,
            starts_at_ms, ends_at_ms, created_by_user_id, updated_by_user_id,
            control_version, created_at_ms, updated_at_ms
       FROM announcements WHERE id = ?`,
  ).bind(id).first<AnnouncementRow>()
  if (row === null) throw announcementNotFound()
  return row
}

function guardedAuditInsert(
  env: Env,
  actor: AdminActor,
  action: 'announcement.update' | 'announcement.delete',
  announcementId: string,
  expectedVersion: number,
  resourceVersion: number,
  details: Record<string, unknown>,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO announcement_admin_audit_events (
       id, actor_user_id, actor_session_id, action, announcement_id,
       resource_version, details_json, occurred_at_ms
     ) VALUES (
       ?, ?, ?, ?,
       CASE WHEN EXISTS (
         SELECT 1 FROM announcements WHERE id = ? AND control_version = ?
       ) THEN ? ELSE NULL END,
       ?, ?, ?
     )`,
  ).bind(
    crypto.randomUUID(), actor.user_id, actor.session_id, action,
    announcementId, expectedVersion, announcementId,
    resourceVersion, JSON.stringify(details), now,
  )
}

async function recoverIdempotencyRace(
  env: Env,
  idempotency: Awaited<ReturnType<typeof controlIdempotency>>,
): Promise<unknown | null> {
  const winner = await findControlIdempotency(env, idempotency)
  return winner === null ? null : parseIdempotentResponse(winner, RESOURCE_TYPE)
}

async function parseAnnouncementInput(
  env: Env,
  body: Record<string, unknown>,
): Promise<ParsedInput> {
  const title = requireTrimmedString(body.title, 'title', 200)
  const content = requireTrimmedString(body.content, 'content', 65_536)
  const status = parseEnum(body.status ?? 'draft', 'status', ['draft', 'active', 'archived'] as const)
  const notifyMode = parseEnum(body.notify_mode ?? 'silent', 'notify_mode', ['silent', 'popup'] as const)
  const targeting = parseTargeting(body.targeting ?? { any_of: [] })
  await requireTargetGroups(env, targeting)
  const startsAt = parseUnixSeconds(body.starts_at, 'starts_at')
  const endsAt = parseUnixSeconds(body.ends_at, 'ends_at')
  if (startsAt !== null && endsAt !== null && startsAt >= endsAt) {
    throw new GatewayError(400, 'announcement_invalid_schedule', 'starts_at must be before ends_at')
  }
  return {
    title,
    content,
    status,
    notify_mode: notifyMode,
    targeting,
    starts_at_ms: startsAt,
    ends_at_ms: endsAt,
  }
}

function parseTargeting(value: unknown): AnnouncementTargeting {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidTargeting()
  const object = value as Record<string, unknown>
  rejectUnknownFields(object, ['any_of'])
  const anyOf = object.any_of ?? []
  if (!Array.isArray(anyOf) || anyOf.length > 50) throw invalidTargeting()
  const groups = anyOf.map((groupValue) => {
    if (groupValue === null || typeof groupValue !== 'object' || Array.isArray(groupValue)) throw invalidTargeting()
    const group = groupValue as Record<string, unknown>
    rejectUnknownFields(group, ['all_of'])
    if (!Array.isArray(group.all_of) || group.all_of.length === 0 || group.all_of.length > 50) throw invalidTargeting()
    return { all_of: group.all_of.map(parseCondition) }
  })
  const conditionCount = groups.reduce((total, group) => total + group.all_of.length, 0)
  if (conditionCount > TARGETING_CONDITION_LIMIT) throw invalidTargeting()
  return { any_of: groups }
}

function parseCondition(value: unknown): AnnouncementCondition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidTargeting()
  const condition = value as Record<string, unknown>
  rejectUnknownFields(condition, ['type', 'operator', 'group_ids', 'value'])
  if (condition.type === 'subscription') {
    if (condition.operator !== 'in' || !Array.isArray(condition.group_ids) || condition.group_ids.length === 0 || condition.group_ids.length > 50) {
      throw invalidTargeting()
    }
    const ids = [...new Set(condition.group_ids.map((id) => {
      const normalized = Number.isSafeInteger(id) && (id as number) > 0 ? String(id) : id
      if (typeof normalized !== 'string' || normalized.length === 0 || normalized.length > 128 || !/^[A-Za-z0-9_-]+$/.test(normalized)) throw invalidTargeting()
      return normalized
    }))]
    return { type: 'subscription', operator: 'in', group_ids: ids }
  }
  if (condition.type === 'balance') {
    const allowed = new Set(['gt', 'gte', 'lt', 'lte', 'eq'])
    if (typeof condition.operator !== 'string' || !allowed.has(condition.operator)) throw invalidTargeting()
    const valueMicros = dollarsToMicros(condition.value)
    return { type: 'balance', operator: condition.operator as Operator, value_micros: valueMicros }
  }
  throw invalidTargeting()
}

async function requireTargetGroups(env: Env, targeting: AnnouncementTargeting): Promise<void> {
  const ids = [...new Set(targeting.any_of.flatMap((group) => group.all_of.flatMap((condition) => condition.group_ids ?? [])))]
  if (ids.length === 0) return
  if (ids.length > TARGETING_GROUP_ID_LIMIT) throw invalidTargeting()
  const placeholders = ids.map(() => '?').join(', ')
  const result = await env.DB.prepare(`SELECT id FROM "groups" WHERE id IN (${placeholders})`).bind(...ids).all<{ id: string }>()
  if (result.results.length !== ids.length) throw invalidTargeting()
}

function targetingMatches(targeting: AnnouncementTargeting, balanceMicros: number, groups: Set<string>): boolean {
  if (targeting.any_of.length === 0) return true
  return targeting.any_of.some((group) => group.all_of.length > 0 && group.all_of.every((condition) => {
    if (condition.type === 'subscription') return condition.group_ids?.some((id) => groups.has(id)) === true
    const threshold = condition.value_micros as number
    if (condition.operator === 'gt') return balanceMicros > threshold
    if (condition.operator === 'gte') return balanceMicros >= threshold
    if (condition.operator === 'lt') return balanceMicros < threshold
    if (condition.operator === 'lte') return balanceMicros <= threshold
    return balanceMicros === threshold
  }))
}

function announcementView(row: AnnouncementRow): AnnouncementView {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    status: row.status,
    notify_mode: row.notify_mode,
    targeting: publicTargeting(parseStoredTargeting(row.targeting_json)),
    starts_at: toIso(row.starts_at_ms),
    ends_at: toIso(row.ends_at_ms),
    created_by: row.created_by_user_id,
    updated_by: row.updated_by_user_id,
    control_version: row.control_version,
    created_at: new Date(row.created_at_ms).toISOString(),
    updated_at: new Date(row.updated_at_ms).toISOString(),
  }
}

function userAnnouncementView(row: AnnouncementRow) {
  const admin = announcementView(row)
  return {
    id: admin.id,
    title: admin.title,
    content: admin.content,
    notify_mode: admin.notify_mode,
    starts_at: admin.starts_at,
    ends_at: admin.ends_at,
    created_at: admin.created_at,
    updated_at: admin.updated_at,
  }
}

function publicTargeting(targeting: AnnouncementTargeting): Record<string, unknown> {
  return {
    any_of: targeting.any_of.map((group) => ({
      all_of: group.all_of.map((condition) => condition.type === 'balance'
        ? { type: condition.type, operator: condition.operator, value: (condition.value_micros as number) / 1_000_000 }
        : { type: condition.type, operator: condition.operator, group_ids: condition.group_ids }),
    })),
  }
}

function parseStoredTargeting(value: string): AnnouncementTargeting {
  try { return JSON.parse(value) as AnnouncementTargeting } catch {
    throw new GatewayError(503, 'invalid_announcement_targeting', 'Announcement targeting data is invalid', 'server_error')
  }
}

function isActiveAt(row: AnnouncementRow, now: number): boolean {
  return row.status === 'active' &&
    (row.starts_at_ms === null || row.starts_at_ms <= now) &&
    (row.ends_at_ms === null || row.ends_at_ms > now)
}

function announcementResponse(value: unknown, status: number): Response {
  const response = controlSuccess(value, status)
  const version = (value as { control_version?: unknown }).control_version
  if (Number.isSafeInteger(version)) response.headers.set('etag', `"${version}"`)
  return response
}

function requireTrimmedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw new GatewayError(400, `invalid_${field}`, `${field} is invalid`)
  const result = value.trim()
  if (result.length === 0 || result.length > maximum) throw new GatewayError(400, `invalid_${field}`, `${field} is invalid`)
  return result
}

function parseEnum<const T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new GatewayError(400, `invalid_${field}`, `${field} is invalid`)
  return value as T[number]
}

function parseUnixSeconds(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === 0) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 8_640_000_000_000) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be Unix seconds`)
  }
  return (value as number) * 1_000
}

function dollarsToMicros(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 1_000_000) throw invalidTargeting()
  const scaled = value * 1_000_000
  if (!Number.isSafeInteger(scaled)) throw invalidTargeting()
  return scaled
}

function parseBooleanQuery(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase())
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(body).some((field) => !allowedSet.has(field))) {
    throw new GatewayError(400, 'unsupported_field', 'Request contains unsupported fields')
  }
}

function invalidTargeting(): GatewayError {
  return new GatewayError(400, 'announcement_invalid_target', 'Announcement targeting rules are invalid')
}

function announcementNotFound(): GatewayError {
  return new GatewayError(404, 'announcement_not_found', 'Announcement was not found')
}

function normalizeAnnouncementError(error: unknown): GatewayError {
  const normalized = asGatewayError(error)
  const message = error instanceof Error ? error.message : String(error)
  if (/active_announcement_limit/i.test(message)) {
    return new GatewayError(409, 'active_announcement_limit', 'At most 500 announcements may be active')
  }
  if (/total_announcement_limit/i.test(message)) {
    return new GatewayError(409, 'announcement_limit', 'At most 10000 announcements may be retained')
  }
  if (/announcement_admin_audit_events\.announcement_id|announcement_control_version_conflict/i.test(message)) {
    return controlVersionConflict()
  }
  return normalized
}

function isIdempotencyRace(error: unknown): boolean {
  return /UNIQUE constraint failed: control_idempotency/i.test(error instanceof Error ? error.message : String(error))
}

function controlVersionConflict(): GatewayError {
  return new GatewayError(412, 'control_version_conflict', 'Announcement changed; reload it and retry')
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}
