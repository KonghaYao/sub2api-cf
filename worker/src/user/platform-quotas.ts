import type { Context } from 'hono'
import { authenticateUserRequest } from '../auth/handler'
import { authenticateAdminSession } from '../control/admin-auth'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
} from '../control/idempotency'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  readJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
} from '../control/http'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'

type Bindings = { Bindings: Env }
type Platform = 'anthropic' | 'openai' | 'gemini' | 'antigravity' | 'grok'
type WindowKind = 'daily' | 'weekly' | 'monthly'

const PLATFORMS: readonly Platform[] = ['anthropic', 'openai', 'gemini', 'antigravity', 'grok']
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const MONTH_MS = 30 * DAY_MS

interface QuotaRow {
  user_id: string
  platform: Platform
  enabled: number
  daily_limit_micros: number | null
  weekly_limit_micros: number | null
  monthly_limit_micros: number | null
  daily_used_micros: number
  weekly_used_micros: number
  monthly_used_micros: number
  daily_window_start_ms: number | null
  weekly_window_start_ms: number | null
  monthly_window_start_ms: number | null
  daily_reset_epoch: number
  weekly_reset_epoch: number
  monthly_reset_epoch: number
  control_version: number
  created_at_ms: number
  updated_at_ms: number
}

interface QuotaResponse {
  schema_version: 1
  control_version: number
  platform_quotas: Record<string, unknown>[]
  updated_at_ms: number
}

interface QuotaInput {
  platform: Platform
  daily_limit_micros: number | null
  weekly_limit_micros: number | null
  monthly_limit_micros: number | null
}

export async function getMyPlatformQuotas(context: Context<Bindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    return quotaResponse(await readQuotaSet(context.env, user.id), false)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminUserPlatformQuotas(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const userId = requireResourceId(context.req.param('id'), 'user')
    await requireUser(context.env, userId)
    return quotaResponse(await readQuotaSet(context.env, userId), true)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function replaceAdminUserPlatformQuotas(
  context: Context<Bindings>,
): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const userId = requireResourceId(context.req.param('id'), 'user')
    const body = await readJsonObject(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const key = requireIdempotencyKey(context.req.raw)
    const inputs = parseQuotaInputs(body.quotas)
    const idem = await controlIdempotency('admin.user-platform-quotas.replace.v1', key, {
      user_id: userId,
      expected_control_version: expected,
      quotas: inputs,
    })
    const replay = await findControlIdempotency(context.env, idem)
    if (replay !== null) {
      const data = parseIdempotentResponse<QuotaResponse>(replay, 'user_platform_quotas')
      await syncQuotaSet(context.env, userId)
      return versionedSuccess(data)
    }

    await requireUser(context.env, userId)
    const before = await readQuotaSet(context.env, userId)
    if (before.control_version !== expected) throw versionConflict()
    const nextVersion = checkedNextVersion(expected)
    const now = Date.now()
    const mutationId = await deterministicUuid(`platform-quotas:${userId}`, key)
    const byPlatform = new Map(inputs.map((item) => [item.platform, item]))
    const nextRows = PLATFORMS.map((platform) => {
      const current = before.rows.find((row) => row.platform === platform)
      const input = byPlatform.get(platform)
      return quotaMutationRow(userId, platform, input, current, nextVersion, now)
    })
    const after = quotaData(nextVersion, nextRows, true, now)
    const statements: D1PreparedStatement[] = [
      quotaSetCas(context.env, userId, expected, nextVersion, mutationId, now),
      ...nextRows.map((row) => upsertQuota(context.env, row)),
      context.env.DB.prepare(
        `INSERT INTO admin_platform_quota_audit_events (
           id, actor_user_id, actor_session_id, target_user_id, action,
           resource_version, idempotency_key_hash, request_hash,
           before_json, after_json, occurred_at_ms
         ) VALUES (?, ?, ?, ?, 'platform_quotas.replace', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), actor.user_id, actor.session_id, userId, nextVersion,
        idem.key_hash, idem.request_hash,
        JSON.stringify(quotaData(before.control_version, before.rows, true, before.updated_at_ms)),
        JSON.stringify(after), now,
      ),
      controlIdempotencyInsert(
        context.env, idem, 'user_platform_quotas', userId, after, now,
      ),
    ]
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) {
        const data = parseIdempotentResponse<QuotaResponse>(recovered, 'user_platform_quotas')
        await syncQuotaSet(context.env, userId)
        return versionedSuccess(data)
      }
      if ((await readQuotaSet(context.env, userId)).control_version !== expected) throw versionConflict()
      throw error
    }
    await syncQuotaSet(context.env, userId)
    return versionedSuccess(after)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function resetAdminUserPlatformQuotaWindow(
  context: Context<Bindings>,
): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const userId = requireResourceId(context.req.param('id'), 'user')
    const body = await readJsonObject(context.req.raw)
    const platform = parsePlatform(body.platform)
    const window = parseWindow(body.window)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const key = requireIdempotencyKey(context.req.raw)
    const idem = await controlIdempotency('admin.user-platform-quota.reset.v1', key, {
      user_id: userId, platform, window, expected_control_version: expected,
    })
    const replay = await findControlIdempotency(context.env, idem)
    if (replay !== null) {
      const data = parseIdempotentResponse<QuotaResponse>(replay, 'user_platform_quotas')
      await syncQuotaSet(context.env, userId)
      return versionedSuccess(data)
    }
    await requireUser(context.env, userId)
    const before = await readQuotaSet(context.env, userId)
    if (before.control_version !== expected) throw versionConflict()
    const current = before.rows.find((row) => row.platform === platform)
    if (current === undefined || current.enabled !== 1) {
      throw new GatewayError(404, 'platform_quota_not_found', 'Platform quota was not found')
    }
    const nextVersion = checkedNextVersion(expected)
    const now = Date.now()
    const mutationId = await deterministicUuid(`platform-quota-reset:${userId}`, key)
    const resetRow: QuotaRow = {
      ...current,
      [`${window}_used_micros`]: 0,
      [`${window}_window_start_ms`]: windowStart(window, now, current.monthly_window_start_ms),
      [`${window}_reset_epoch`]: checkedNextVersion(current[`${window}_reset_epoch`]),
      control_version: nextVersion,
      updated_at_ms: now,
    }
    const nextRows = before.rows.map((row) => row.platform === platform
      ? resetRow
      : { ...row, control_version: nextVersion, updated_at_ms: now })
    const after = quotaData(nextVersion, nextRows, true, now)
    await context.env.DB.batch([
      quotaSetCas(context.env, userId, expected, nextVersion, mutationId, now),
      ...nextRows.map((row) => upsertQuota(context.env, row)),
      context.env.DB.prepare(
        `INSERT INTO admin_platform_quota_audit_events (
           id, actor_user_id, actor_session_id, target_user_id, action,
           resource_version, idempotency_key_hash, request_hash,
           before_json, after_json, occurred_at_ms
         ) VALUES (?, ?, ?, ?, 'platform_quota.reset', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), actor.user_id, actor.session_id, userId, nextVersion,
        idem.key_hash, idem.request_hash,
        JSON.stringify(quotaData(before.control_version, before.rows, true, before.updated_at_ms)),
        JSON.stringify(after), now,
      ),
      controlIdempotencyInsert(context.env, idem, 'user_platform_quotas', userId, after, now),
    ])
    await syncQuotaSet(context.env, userId)
    return versionedSuccess(after)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminPlatformQuotaDefaults(context: Context<Bindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    return versionedSuccess(await readDefaults(context.env))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function replaceAdminPlatformQuotaDefaults(
  context: Context<Bindings>,
): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const key = requireIdempotencyKey(context.req.raw)
    const inputs = parseQuotaMap(body.platform_quotas)
    const idem = await controlIdempotency('admin.platform-quota-defaults.replace.v1', key, {
      expected_control_version: expected, platform_quotas: inputs,
    })
    const replay = await findControlIdempotency(context.env, idem)
    if (replay !== null) {
      return versionedSuccess(parseIdempotentResponse(replay, 'platform_quota_defaults'))
    }
    const before = await readDefaults(context.env)
    if (before.control_version !== expected) throw versionConflict()
    const nextVersion = checkedNextVersion(expected)
    const now = Date.now()
    const mutationId = await deterministicUuid('platform-quota-defaults', key)
    const byPlatform = new Map(inputs.map((input) => [input.platform, input]))
    const after = defaultData(nextVersion, PLATFORMS.map((platform) => (
      byPlatform.get(platform) ?? { platform, daily_limit_micros: null, weekly_limit_micros: null, monthly_limit_micros: null }
    )), now)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE platform_quota_defaults_control
              SET control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                  last_mutation_id = ?, updated_at_ms = ?
            WHERE singleton = 1`,
        ).bind(expected, nextVersion, mutationId, now),
        ...PLATFORMS.map((platform) => {
          const input = byPlatform.get(platform)
          return context.env.DB.prepare(
            `INSERT INTO platform_quota_defaults (
               platform, daily_limit_micros, weekly_limit_micros,
               monthly_limit_micros, control_version, updated_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(platform) DO UPDATE SET
               daily_limit_micros = excluded.daily_limit_micros,
               weekly_limit_micros = excluded.weekly_limit_micros,
               monthly_limit_micros = excluded.monthly_limit_micros,
               control_version = excluded.control_version,
               updated_at_ms = excluded.updated_at_ms`,
          ).bind(
            platform, input?.daily_limit_micros ?? null, input?.weekly_limit_micros ?? null,
            input?.monthly_limit_micros ?? null, nextVersion, now,
          )
        }),
        context.env.DB.prepare(
          `INSERT INTO admin_platform_quota_default_audit_events (
             id, actor_user_id, actor_session_id, action, resource_version,
             idempotency_key_hash, request_hash, before_json, after_json, occurred_at_ms
           ) VALUES (?, ?, ?, 'platform_quota_defaults.replace', ?, ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(), actor.user_id, actor.session_id, nextVersion,
          idem.key_hash, idem.request_hash, JSON.stringify(before), JSON.stringify(after), now,
        ),
        controlIdempotencyInsert(context.env, idem, 'platform_quota_defaults', 'global', after, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) {
        return versionedSuccess(parseIdempotentResponse(recovered, 'platform_quota_defaults'))
      }
      if ((await readDefaults(context.env)).control_version !== expected) throw versionConflict()
      throw error
    }
    return versionedSuccess(after)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** Statements to append to the same D1 batch that creates a password/OAuth user. */
export function initialPlatformQuotaStatements(
  env: Env,
  userId: string,
  now = Date.now(),
): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `INSERT INTO user_platform_quota_sets (
         user_id, control_version, last_mutation_id, updated_at_ms
       ) SELECT ?, control_version, 'registration-defaults', ?
           FROM platform_quota_defaults_control WHERE singleton = 1`,
    ).bind(userId, now),
    env.DB.prepare(
      `INSERT INTO user_platform_quotas (
         user_id, platform, enabled,
         daily_limit_micros, weekly_limit_micros, monthly_limit_micros,
         daily_used_micros, weekly_used_micros, monthly_used_micros,
         daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
         daily_reset_epoch, weekly_reset_epoch, monthly_reset_epoch,
         control_version, created_at_ms, updated_at_ms
       ) SELECT ?, platform, 1,
                daily_limit_micros, weekly_limit_micros, monthly_limit_micros,
                0, 0, 0, NULL, NULL, NULL, 0, 0, 0,
                control_version, ?, ?
           FROM platform_quota_defaults`,
    ).bind(userId, now, now),
  ]
}

function quotaResponse(set: Awaited<ReturnType<typeof readQuotaSet>>, admin: boolean): Response {
  return versionedSuccess(quotaData(set.control_version, set.rows, admin, set.updated_at_ms))
}

function versionedSuccess(data: unknown): Response {
  const response = controlSuccess(data)
  if (isVersioned(data)) response.headers.set('etag', `"${data.control_version}"`)
  return response
}

function isVersioned(value: unknown): value is { control_version: number } {
  return value !== null && typeof value === 'object' &&
    Number.isSafeInteger((value as { control_version?: unknown }).control_version)
}

async function readQuotaSet(env: Env, userId: string): Promise<{
  control_version: number
  updated_at_ms: number
  rows: QuotaRow[]
}> {
  const [control, rows] = await Promise.all([
    env.DB.prepare(
      `SELECT control_version, updated_at_ms FROM user_platform_quota_sets WHERE user_id = ?`,
    ).bind(userId).first<{ control_version: number; updated_at_ms: number }>(),
    env.DB.prepare(
      `SELECT user_id, platform, enabled,
              daily_limit_micros, weekly_limit_micros, monthly_limit_micros,
              daily_used_micros, weekly_used_micros, monthly_used_micros,
              daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
              daily_reset_epoch, weekly_reset_epoch, monthly_reset_epoch,
              control_version, created_at_ms, updated_at_ms
         FROM user_platform_quotas WHERE user_id = ? ORDER BY platform`,
    ).bind(userId).all<QuotaRow>(),
  ])
  return {
    control_version: control?.control_version ?? 0,
    updated_at_ms: control?.updated_at_ms ?? 0,
    rows: rows.results,
  }
}

async function readDefaults(env: Env): Promise<Record<string, unknown> & { control_version: number }> {
  const control = await env.DB.prepare(
    `SELECT control_version, updated_at_ms
       FROM platform_quota_defaults_control WHERE singleton = 1`,
  ).first<{ control_version: number; updated_at_ms: number }>()
  if (control === null) throw new GatewayError(503, 'platform_quota_defaults_unavailable', 'Platform quota defaults are unavailable', 'server_error')
  const rows = await env.DB.prepare(
    `SELECT platform, daily_limit_micros, weekly_limit_micros, monthly_limit_micros
       FROM platform_quota_defaults ORDER BY platform`,
  ).all<QuotaInput>()
  return defaultData(control.control_version, rows.results, control.updated_at_ms)
}

function defaultData(version: number, rows: QuotaInput[], updatedAt: number): Record<string, unknown> & { control_version: number } {
  const byPlatform = new Map(rows.map((row) => [row.platform, row]))
  return {
    schema_version: 1,
    control_version: version,
    platform_quotas: Object.fromEntries(PLATFORMS.map((platform) => {
      const row = byPlatform.get(platform)
      return [platform, {
        daily_limit_usd: nullableUsd(row?.daily_limit_micros ?? null),
        weekly_limit_usd: nullableUsd(row?.weekly_limit_micros ?? null),
        monthly_limit_usd: nullableUsd(row?.monthly_limit_micros ?? null),
      }]
    })),
    updated_at_ms: updatedAt,
  }
}

function quotaData(version: number, rows: QuotaRow[], admin: boolean, updatedAt: number): QuotaResponse {
  const now = Date.now()
  return {
    schema_version: 1,
    control_version: version,
    platform_quotas: rows.filter((row) => row.enabled === 1).map((row) => publicQuota(row, admin, now)),
    updated_at_ms: updatedAt,
  }
}

function publicQuota(row: QuotaRow, admin: boolean, now: number): Record<string, unknown> {
  const result: Record<string, unknown> = {
    platform: row.platform,
    daily_limit_usd: nullableUsd(row.daily_limit_micros),
    weekly_limit_usd: nullableUsd(row.weekly_limit_micros),
    monthly_limit_usd: nullableUsd(row.monthly_limit_micros),
  }
  for (const kind of ['daily', 'weekly', 'monthly'] as const) {
    const start = row[`${kind}_window_start_ms`]
    const expired = start !== null && now >= start + windowDuration(kind)
    result[`${kind}_usage_usd`] = microsToUsd(expired ? 0 : row[`${kind}_used_micros`])
    result[`${kind}_window_resets_at`] = start === null ? null : iso(start + windowDuration(kind))
    if (admin) result[`${kind}_window_start`] = start === null ? null : iso(start)
  }
  return result
}

function quotaMutationRow(
  userId: string,
  platform: Platform,
  input: QuotaInput | undefined,
  current: QuotaRow | undefined,
  version: number,
  now: number,
): QuotaRow {
  return {
    user_id: userId,
    platform,
    enabled: input === undefined ? 0 : 1,
    daily_limit_micros: input?.daily_limit_micros ?? null,
    weekly_limit_micros: input?.weekly_limit_micros ?? null,
    monthly_limit_micros: input?.monthly_limit_micros ?? null,
    daily_used_micros: current?.daily_used_micros ?? 0,
    weekly_used_micros: current?.weekly_used_micros ?? 0,
    monthly_used_micros: current?.monthly_used_micros ?? 0,
    daily_window_start_ms: current?.daily_window_start_ms ?? null,
    weekly_window_start_ms: current?.weekly_window_start_ms ?? null,
    monthly_window_start_ms: current?.monthly_window_start_ms ?? null,
    daily_reset_epoch: current?.daily_reset_epoch ?? 0,
    weekly_reset_epoch: current?.weekly_reset_epoch ?? 0,
    monthly_reset_epoch: current?.monthly_reset_epoch ?? 0,
    control_version: version,
    created_at_ms: current?.created_at_ms ?? now,
    updated_at_ms: now,
  }
}

function quotaSetCas(env: Env, userId: string, expected: number, next: number, mutation: string, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO user_platform_quota_sets (
       user_id, control_version, last_mutation_id, updated_at_ms
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       control_version = CASE WHEN control_version = ? THEN excluded.control_version ELSE -1 END,
       last_mutation_id = excluded.last_mutation_id,
       updated_at_ms = excluded.updated_at_ms`,
  ).bind(userId, next, mutation, now, expected)
}

function upsertQuota(env: Env, row: QuotaRow): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO user_platform_quotas (
       user_id, platform, enabled,
       daily_limit_micros, weekly_limit_micros, monthly_limit_micros,
       daily_used_micros, weekly_used_micros, monthly_used_micros,
       daily_window_start_ms, weekly_window_start_ms, monthly_window_start_ms,
       daily_reset_epoch, weekly_reset_epoch, monthly_reset_epoch,
       control_version, created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, platform) DO UPDATE SET
       enabled = excluded.enabled,
       daily_limit_micros = excluded.daily_limit_micros,
       weekly_limit_micros = excluded.weekly_limit_micros,
       monthly_limit_micros = excluded.monthly_limit_micros,
       daily_used_micros = excluded.daily_used_micros,
       weekly_used_micros = excluded.weekly_used_micros,
       monthly_used_micros = excluded.monthly_used_micros,
       daily_window_start_ms = excluded.daily_window_start_ms,
       weekly_window_start_ms = excluded.weekly_window_start_ms,
       monthly_window_start_ms = excluded.monthly_window_start_ms,
       daily_reset_epoch = excluded.daily_reset_epoch,
       weekly_reset_epoch = excluded.weekly_reset_epoch,
       monthly_reset_epoch = excluded.monthly_reset_epoch,
       control_version = excluded.control_version,
       updated_at_ms = excluded.updated_at_ms`,
  ).bind(
    row.user_id, row.platform, row.enabled,
    row.daily_limit_micros, row.weekly_limit_micros, row.monthly_limit_micros,
    row.daily_used_micros, row.weekly_used_micros, row.monthly_used_micros,
    row.daily_window_start_ms, row.weekly_window_start_ms, row.monthly_window_start_ms,
    row.daily_reset_epoch, row.weekly_reset_epoch, row.monthly_reset_epoch,
    row.control_version, row.created_at_ms, row.updated_at_ms,
  )
}

async function syncQuotaSet(env: Env, userId: string): Promise<void> {
  if (env.API_KEY_LIMIT_STATE === undefined) {
    throw new GatewayError(503, 'platform_quota_state_unavailable', 'Platform quota state is unavailable', 'server_error')
  }
  const rows = (await readQuotaSet(env, userId)).rows
  const stub = env.API_KEY_LIMIT_STATE.get(env.API_KEY_LIMIT_STATE.idFromName(`user:${userId}`))
  for (const row of rows) {
    const response = await stub.fetch(new Request('https://state.internal/platform-quota/configure', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema_version: 1, user_id: userId, platform: row.platform,
        enabled: row.enabled === 1, control_version: row.control_version,
        daily_limit_micros: row.daily_limit_micros,
        weekly_limit_micros: row.weekly_limit_micros,
        monthly_limit_micros: row.monthly_limit_micros,
        daily_used_micros: row.daily_used_micros,
        weekly_used_micros: row.weekly_used_micros,
        monthly_used_micros: row.monthly_used_micros,
        daily_window_start_ms: row.daily_window_start_ms,
        weekly_window_start_ms: row.weekly_window_start_ms,
        monthly_window_start_ms: row.monthly_window_start_ms,
        daily_reset_epoch: row.daily_reset_epoch,
        weekly_reset_epoch: row.weekly_reset_epoch,
        monthly_reset_epoch: row.monthly_reset_epoch,
      }),
    }))
    if (!response.ok) throw new GatewayError(503, 'platform_quota_state_unavailable', 'Platform quota state could not be synchronized', 'server_error')
  }
}

async function requireUser(env: Env, userId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT 1 AS found FROM users WHERE id = ?').bind(userId).first()
  if (row === null) throw new GatewayError(404, 'user_not_found', 'User was not found')
}

function parseQuotaInputs(value: unknown): QuotaInput[] {
  if (!Array.isArray(value) || value.length > PLATFORMS.length) {
    throw new GatewayError(400, 'invalid_quotas', 'quotas must be a platform quota array')
  }
  const seen = new Set<Platform>()
  return value.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new GatewayError(400, 'invalid_quota', 'Each quota must be an object')
    }
    const body = raw as Record<string, unknown>
    const platform = parsePlatform(body.platform)
    if (seen.has(platform)) throw new GatewayError(400, 'duplicate_platform_quota', 'Each platform may appear once')
    seen.add(platform)
    return {
      platform,
      daily_limit_micros: usdToMicros(body.daily_limit_usd, 'daily_limit_usd'),
      weekly_limit_micros: usdToMicros(body.weekly_limit_usd, 'weekly_limit_usd'),
      monthly_limit_micros: usdToMicros(body.monthly_limit_usd, 'monthly_limit_usd'),
    }
  })
}

function parseQuotaMap(value: unknown): QuotaInput[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, 'invalid_platform_quotas', 'platform_quotas must be an object')
  }
  return Object.entries(value).map(([key, raw]) => {
    const platform = parsePlatform(key)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new GatewayError(400, 'invalid_platform_quota', 'Each platform quota must be an object')
    }
    const body = raw as Record<string, unknown>
    return {
      platform,
      daily_limit_micros: usdToMicros(body.daily_limit_usd, 'daily_limit_usd'),
      weekly_limit_micros: usdToMicros(body.weekly_limit_usd, 'weekly_limit_usd'),
      monthly_limit_micros: usdToMicros(body.monthly_limit_usd, 'monthly_limit_usd'),
    }
  })
}

function parsePlatform(value: unknown): Platform {
  if (typeof value !== 'string' || !PLATFORMS.includes(value as Platform)) {
    throw new GatewayError(400, 'invalid_platform', 'platform is not supported')
  }
  return value as Platform
}

function parseWindow(value: unknown): WindowKind {
  if (value !== 'daily' && value !== 'weekly' && value !== 'monthly') {
    throw new GatewayError(400, 'invalid_window', 'window must be daily, weekly, or monthly')
  }
  return value
}

function usdToMicros(value: unknown, field: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be null or a non-negative number`)
  }
  const scaled = value * 1_000_000
  const rounded = Math.round(scaled)
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-6) {
    throw new GatewayError(400, `invalid_${field}`, `${field} supports at most six decimal places`)
  }
  return rounded
}

function checkedNextVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new GatewayError(409, 'control_version_exhausted', 'Control version is exhausted')
  }
  return value + 1
}

function versionConflict(): GatewayError {
  return new GatewayError(409, 'control_version_conflict', 'The resource changed; reload and retry')
}

function nullableUsd(value: number | null): number | null {
  return value === null ? null : microsToUsd(value)
}

function microsToUsd(value: number): number { return value / 1_000_000 }
function iso(value: number): string { return new Date(value).toISOString() }
function windowDuration(kind: WindowKind): number { return kind === 'daily' ? DAY_MS : kind === 'weekly' ? WEEK_MS : MONTH_MS }
function windowStart(kind: WindowKind, now: number, monthly: number | null): number {
  if (kind === 'daily') return Math.floor(now / DAY_MS) * DAY_MS
  if (kind === 'weekly') {
    const date = new Date(now)
    const day = (date.getUTCDay() + 6) % 7
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - day * DAY_MS
  }
  return monthly !== null && now < monthly + MONTH_MS ? monthly : now
}
