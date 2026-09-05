import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlError, controlSuccess, queryInteger } from './http'

type ControlBindings = { Bindings: Env }

const AUDIT_CATEGORIES = ['settings', 'rbac', 'channel', 'auth', 'payment'] as const
const AUDIT_OUTCOMES = ['succeeded', 'failed', 'blocked', 'recorded'] as const
const MAX_CURSOR_BYTES = 2_048

type AuditCategory = typeof AUDIT_CATEGORIES[number]
type AuditOutcome = typeof AUDIT_OUTCOMES[number]

interface AuditCursor {
  v: 1
  occurred_at_ms: number
  category: AuditCategory
  event_id: string
}

interface AuditRow {
  category: AuditCategory
  event_id: string
  action: string
  outcome: AuditOutcome
  actor_user_id: string | null
  actor_session_id: string | null
  origin: string
  resource_type: string
  resource_id: string
  resource_version: number | null
  metadata_json: string
  occurred_at_ms: number
}

interface AuditFilters {
  category?: AuditCategory
  action?: string
  outcome?: AuditOutcome
  actorUserId?: string
  resourceType?: string
  resourceId?: string
  startAtMs?: number
  endAtMs?: number
  cursor?: AuditCursor
}

/**
 * Read-only, cross-domain audit event stream for the Worker control plane.
 * It deliberately does not expose raw payloads, request hashes, identity hashes,
 * provider identifiers, or unmasked session identifiers.
 */
export async function listAdminAuditEvents(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const limit = queryInteger(context.req.query('limit'), 'limit', 50, 1, 100)
    const filters = parseFilters(context)
    const { sql, values } = buildListQuery(filters, limit + 1)
    const result = await context.env.DB.prepare(sql).bind(...values).all<AuditRow>()
    const rows = result.results.map(requireAuditRow)
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return controlSuccess({
      items: page.map(publicAuditSummary),
      has_more: hasMore,
      next_cursor: hasMore && last !== undefined ? encodeCursor(last) : null,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** Return a single event with source-specific, allowlisted metadata. */
export async function getAdminAuditEvent(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    const category = parseCategory(context.req.param('category'), true)
    const eventId = requiredFilter(context.req.param('id'), 'event_id', 512)
    const row = await context.env.DB.prepare(
      `SELECT category, event_id, action, outcome, actor_user_id,
              actor_session_id, origin, resource_type, resource_id,
              resource_version, metadata_json, occurred_at_ms
         FROM (${auditSelect(category)}) AS audit_event
        WHERE event_id = ?
        LIMIT 1`,
    ).bind(eventId).first<AuditRow>()
    if (row === null) {
      throw new GatewayError(
        404,
        'admin_audit_event_not_found',
        'Administrative audit event was not found',
      )
    }
    const event = requireAuditRow(row)
    return controlSuccess({
      ...publicAuditSummary(event),
      metadata: sanitizeMetadata(event.category, event.metadata_json),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function parseFilters(context: Context<ControlBindings>): AuditFilters {
  const categoryRaw = context.req.query('category')?.trim()
  const outcomeRaw = context.req.query('outcome')?.trim()
  const startAtMs = parseTime(context.req.query('start_time'), 'start_time')
  const endAtMs = parseTime(context.req.query('end_time'), 'end_time')
  if (startAtMs !== undefined && endAtMs !== undefined && startAtMs > endAtMs) {
    throw new GatewayError(
      400,
      'invalid_audit_time_range',
      'start_time must not be later than end_time',
    )
  }
  return {
    ...(categoryRaw ? { category: parseCategory(categoryRaw, true) } : {}),
    ...(outcomeRaw ? { outcome: parseOutcome(outcomeRaw) } : {}),
    ...optionalFilter(context.req.query('action'), 'action', 100),
    ...optionalFilter(context.req.query('actor_user_id'), 'actorUserId', 128),
    ...optionalFilter(context.req.query('resource_type'), 'resourceType', 64),
    ...optionalFilter(context.req.query('resource_id'), 'resourceId', 512),
    ...(startAtMs === undefined ? {} : { startAtMs }),
    ...(endAtMs === undefined ? {} : { endAtMs }),
    ...(context.req.query('cursor') === undefined
      ? {}
      : { cursor: decodeCursor(context.req.query('cursor') ?? '') }),
  }
}

function optionalFilter<Key extends keyof AuditFilters>(
  raw: string | undefined,
  key: Key,
  maximum: number,
): Pick<AuditFilters, Key> | Record<string, never> {
  if (raw === undefined || raw.trim() === '') return {}
  const value = raw.trim()
  if (value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GatewayError(400, `invalid_${snakeCase(key)}`, `${snakeCase(key)} is invalid`)
  }
  return { [key]: value } as Pick<AuditFilters, Key>
}

function requiredFilter(raw: string | undefined, name: string, maximum: number): string {
  const value = raw?.trim() ?? ''
  if (value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GatewayError(400, `invalid_${name}`, `${name} is invalid`)
  }
  return value
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

function parseCategory(raw: string | undefined, required: true): AuditCategory
function parseCategory(raw: string | undefined, required: false): AuditCategory | undefined
function parseCategory(raw: string | undefined, required: boolean): AuditCategory | undefined {
  if (raw !== undefined && AUDIT_CATEGORIES.includes(raw as AuditCategory)) {
    return raw as AuditCategory
  }
  if (!required && (raw === undefined || raw === '')) return undefined
  throw new GatewayError(
    400,
    'invalid_audit_category',
    `category must be one of: ${AUDIT_CATEGORIES.join(', ')}`,
  )
}

function parseOutcome(raw: string): AuditOutcome {
  if (!AUDIT_OUTCOMES.includes(raw as AuditOutcome)) {
    throw new GatewayError(
      400,
      'invalid_audit_outcome',
      `outcome must be one of: ${AUDIT_OUTCOMES.join(', ')}`,
    )
  }
  return raw as AuditOutcome
}

function parseTime(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = raw.trim()
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new GatewayError(400, `invalid_${name}`, `${name} must be an RFC3339 timestamp`)
  }
  const timestamp = Date.parse(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new GatewayError(400, `invalid_${name}`, `${name} must be an RFC3339 timestamp`)
  }
  return timestamp
}

function buildListQuery(filters: AuditFilters, limit: number): { sql: string; values: unknown[] } {
  const conditions: string[] = []
  const values: unknown[] = []
  const condition = (sql: string, ...bound: unknown[]): void => {
    conditions.push(sql)
    values.push(...bound)
  }
  if (filters.action !== undefined) condition('action = ?', filters.action)
  if (filters.outcome !== undefined) condition('outcome = ?', filters.outcome)
  if (filters.actorUserId !== undefined) condition('actor_user_id = ?', filters.actorUserId)
  if (filters.resourceType !== undefined) condition('resource_type = ?', filters.resourceType)
  if (filters.resourceId !== undefined) condition('resource_id = ?', filters.resourceId)
  if (filters.startAtMs !== undefined) condition('occurred_at_ms >= ?', filters.startAtMs)
  if (filters.endAtMs !== undefined) condition('occurred_at_ms <= ?', filters.endAtMs)
  if (filters.cursor !== undefined) {
    condition(
      `(occurred_at_ms < ?
        OR (occurred_at_ms = ? AND category < ?)
        OR (occurred_at_ms = ? AND category = ? AND event_id < ?))`,
      filters.cursor.occurred_at_ms,
      filters.cursor.occurred_at_ms,
      filters.cursor.category,
      filters.cursor.occurred_at_ms,
      filters.cursor.category,
      filters.cursor.event_id,
    )
  }
  values.push(limit)
  return {
    sql: `SELECT category, event_id, action, outcome, actor_user_id,
                 actor_session_id, origin, resource_type, resource_id,
                 resource_version, metadata_json, occurred_at_ms
            FROM (${auditSelect(filters.category)}) AS audit_event
            ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
           ORDER BY occurred_at_ms DESC, category DESC, event_id DESC
           LIMIT ?`,
    values,
  }
}

function auditSelect(category?: AuditCategory): string {
  const selects: Record<AuditCategory, string> = {
    settings: `
      SELECT 'settings' AS category, id AS event_id, action,
             'succeeded' AS outcome, actor_user_id, actor_session_id,
             'admin' AS origin, 'system_settings' AS resource_type,
             resource_id, resource_version, changed_fields_json AS metadata_json,
             occurred_at_ms
        FROM admin_settings_audit_events`,
    rbac: `
      SELECT 'rbac' AS category, id AS event_id, action,
             'succeeded' AS outcome, actor_user_id, actor_session_id,
             'admin' AS origin, resource_type, resource_id, resource_version,
             details_json AS metadata_json, occurred_at_ms
        FROM admin_rbac_audit_events`,
    channel: `
      SELECT 'channel' AS category, id AS event_id, action,
             'succeeded' AS outcome, actor_user_id, actor_session_id,
             'admin' AS origin, 'channel' AS resource_type,
             resource_id, resource_version, changed_fields_json AS metadata_json,
             occurred_at_ms
        FROM admin_channel_audit_events`,
    auth: `
      SELECT 'auth' AS category, id AS event_id, event_type AS action,
             outcome, user_id AS actor_user_id, session_id AS actor_session_id,
             'auth' AS origin, 'user' AS resource_type,
             COALESCE(user_id, '') AS resource_id, NULL AS resource_version,
             metadata_json, occurred_at_ms
        FROM auth_audit_events`,
    payment: `
      SELECT 'payment' AS category, id AS event_id, event_type AS action,
             CASE
               WHEN lower(event_type) LIKE '%failed%' THEN 'failed'
               WHEN lower(event_type) LIKE '%succeeded%'
                 OR lower(event_type) LIKE '%completed%'
                 OR event_type = 'order.paid' THEN 'succeeded'
               ELSE 'recorded'
             END AS outcome, NULL AS actor_user_id,
             NULL AS actor_session_id, source_type AS origin,
             'payment_order' AS resource_type, order_id AS resource_id,
             NULL AS resource_version, payload_json AS metadata_json,
             occurred_at_ms
        FROM payment_events`,
  }
  return category === undefined
    ? AUDIT_CATEGORIES.map((value) => selects[value]).join('\nUNION ALL\n')
    : selects[category]
}

function requireAuditRow(value: AuditRow): AuditRow {
  if (
    !AUDIT_CATEGORIES.includes(value.category) ||
    !AUDIT_OUTCOMES.includes(value.outcome) ||
    typeof value.event_id !== 'string' ||
    typeof value.action !== 'string' ||
    typeof value.origin !== 'string' ||
    typeof value.resource_type !== 'string' ||
    typeof value.resource_id !== 'string' ||
    typeof value.metadata_json !== 'string' ||
    !Number.isSafeInteger(value.occurred_at_ms) ||
    value.occurred_at_ms < 0
  ) {
    throw new GatewayError(500, 'invalid_admin_audit_event', 'Administrative audit event is invalid')
  }
  return value
}

function publicAuditSummary(row: AuditRow): Record<string, unknown> {
  return {
    category: row.category,
    event_id: row.event_id,
    action: row.action,
    outcome: row.outcome,
    actor_user_id: row.actor_user_id,
    actor_session_id_masked: maskIdentifier(row.actor_session_id),
    origin: row.origin,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    resource_version: row.resource_version,
    occurred_at_ms: row.occurred_at_ms,
    occurred_at: new Date(row.occurred_at_ms).toISOString(),
  }
}

function maskIdentifier(value: string | null): string | null {
  if (value === null || value === '') return null
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

function encodeCursor(row: AuditRow): string {
  const value: AuditCursor = {
    v: 1,
    occurred_at_ms: row.occurred_at_ms,
    category: row.category,
    event_id: row.event_id,
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeCursor(raw: string): AuditCursor {
  if (raw.length === 0 || raw.length > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw invalidCursor()
  }
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - raw.length % 4) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    if (
      value === null || typeof value !== 'object' || Array.isArray(value) ||
      (value as Record<string, unknown>).v !== 1 ||
      !Number.isSafeInteger((value as Record<string, unknown>).occurred_at_ms) ||
      ((value as Record<string, unknown>).occurred_at_ms as number) < 0 ||
      !AUDIT_CATEGORIES.includes((value as Record<string, unknown>).category as AuditCategory) ||
      typeof (value as Record<string, unknown>).event_id !== 'string' ||
      ((value as Record<string, unknown>).event_id as string).length === 0 ||
      ((value as Record<string, unknown>).event_id as string).length > 512
    ) {
      throw invalidCursor()
    }
    return value as AuditCursor
  } catch {
    throw invalidCursor()
  }
}

function invalidCursor(): GatewayError {
  return new GatewayError(400, 'invalid_audit_cursor', 'Audit cursor is invalid')
}

function sanitizeMetadata(category: AuditCategory, raw: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {}
  }
  switch (category) {
    case 'settings':
      return { changed_fields: sanitizeChangedFields(value) }
    case 'rbac':
      return sanitizeRbacMetadata(value)
    case 'channel':
      return { changed_fields: sanitizeChannelChangedFields(value) }
    case 'auth':
      return sanitizeAuthMetadata(value)
    case 'payment':
      return sanitizePaymentMetadata(value)
  }
}

function sanitizeChannelChangedFields(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const allowed = new Set([
    'create', 'delete', 'name', 'description', 'status', 'billing_model_source',
    'restrict_models', 'features_config', 'group_ids', 'model_mapping',
    'model_pricing', 'apply_pricing_to_account_stats',
  ])
  return value.filter((field): field is string => typeof field === 'string' && allowed.has(field)).slice(0, 100)
}

function sanitizeChangedFields(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((field): field is string =>
    typeof field === 'string' && (
      /^public\.(?:site_name|registration_enabled|email_verification_enabled|turnstile_enabled|turnstile_site_key)$/.test(field) ||
      /^secrets\.turnstile_secret_key:(?:set|clear)$/.test(field)
    ),
  ).slice(0, 100)
}

function sanitizeRbacMetadata(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {}
  const result: Record<string, unknown> = {}
  for (const direction of ['before', 'after'] as const) {
    const snapshot = sanitizeRbacSnapshot(value[direction])
    if (Object.keys(snapshot).length > 0) result[direction] = snapshot
  }
  return result
}

function sanitizeRbacSnapshot(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {}
  const result: Record<string, unknown> = {}
  const identifierKeys = [
    'id', 'system_key', 'user_id', 'role_id', 'role_system_key',
    'assigned_by_user_id', 'revoked_by_user_id',
  ] as const
  const booleanKeys = ['system', 'active', 'role_active'] as const
  const integerKeys = [
    'control_version', 'created_at_ms', 'updated_at_ms', 'assigned_at_ms', 'revoked_at_ms',
  ] as const
  for (const key of identifierKeys) {
    if (value[key] === null) result[key] = null
    else if (safeIdentifier(value[key])) result[key] = value[key]
  }
  for (const key of booleanKeys) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  for (const key of integerKeys) {
    if (value[key] === null) result[key] = null
    else if (safeInteger(value[key])) result[key] = value[key]
  }
  if (Array.isArray(value.permissions)) {
    result.permissions = value.permissions.filter((permission): permission is string =>
      typeof permission === 'string' && /^admin\.[a-z_]+\.(?:read|write)$/.test(permission),
    ).slice(0, 100)
  }
  return result
}

function sanitizeAuthMetadata(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {}
  const result: Record<string, unknown> = {}
  for (const key of ['display_name_changed', 'avatar_changed', 'included_current_session']) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  for (const key of ['api_key_id', 'group_id']) {
    if (safeIdentifier(value[key])) result[key] = value[key]
  }
  if (typeof value.reason === 'string' && /^[a-z0-9_.-]{1,100}$/.test(value.reason)) {
    result.reason = value.reason
  }
  return result
}

function sanitizePaymentMetadata(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {}
  const result: Record<string, unknown> = {}
  const identifierKeys = [
    'refund_id', 'subscription_id', 'clawback_resource_id', 'currency',
    'previous_status', 'status', 'restored_status', 'clawback_kind', 'clawback_status',
  ] as const
  const integerKeys = [
    'amount_micros', 'days', 'clawback_days', 'expires_at_ms',
    'previous_expires_at_ms', 'restored_expires_at_ms', 'control_version',
  ] as const
  const booleanKeys = ['deduct_balance', 'courtesy_refund_without_clawback', 'force'] as const
  for (const key of identifierKeys) {
    if (safeIdentifier(value[key])) result[key] = value[key]
  }
  for (const key of integerKeys) {
    if (safeInteger(value[key])) result[key] = value[key]
  }
  for (const key of booleanKeys) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  if (typeof value.reason === 'string' && /^[a-z0-9_.-]{1,100}$/.test(value.reason)) {
    result.reason = value.reason
  }
  return result
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    /^[A-Za-z0-9_.:@-]+$/.test(value)
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
