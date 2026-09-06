import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import {
  accountStatsGraphRows,
  accountStatsStatements,
  emptyAccountStatsRelated,
  loadAccountStatsRelated,
  materializeAccountStatsGraph,
  parseAccountStatsRules,
  parsedAccountStatsRules,
  publicAccountStatsRules,
  relatedAccountStatsFromGraph,
  validateAccountStatsScopes,
  type AccountStatsRelated,
  type MaterializedAccountStatsGraph,
  type ParsedAccountStatsRule,
} from './account-stats-pricing'
import { authenticateAdminSession, type AdminActor } from './admin-auth'
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
  queryInteger,
  readJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
  requireResourceId,
} from './http'

type ControlBindings = { Bindings: Env }
type ChannelStatus = 'active' | 'inactive'
type PublicChannelStatus = 'active' | 'disabled'
type BillingMode = 'token' | 'per_request' | 'image' | 'video'
type BillingModelSource = 'requested' | 'upstream' | 'channel_mapped' | 'response_model'

const MAX_BODY_BYTES = 512 * 1024
const MAX_SAFE = Number.MAX_SAFE_INTEGER
// Leave room in D1's per-invocation query budget for the parent CAS, cleanup,
// audit, idempotency, and one post-conflict idempotency recovery read.
const MAX_GRAPH_ROWS = 31
const CHANNEL_COLUMNS = `id, name, description, status, billing_model_source,
  restrict_models, features_config_json, apply_pricing_to_account_stats,
  control_version, created_at_ms, updated_at_ms`

interface ChannelRow {
  id: string
  name: string
  description: string
  status: ChannelStatus
  billing_model_source: BillingModelSource
  restrict_models: number
  features_config_json: string
  apply_pricing_to_account_stats: number
  control_version: number
  created_at_ms: number
  updated_at_ms: number
}

interface GroupRow { channel_id: string; group_id: string }
interface MappingRow {
  channel_id: string
  platform: string
  source_pattern: string
  target_pattern: string
  source_is_wildcard: number
  target_is_wildcard: number
  sort_order: number
}
interface PricingRow {
  id: string
  channel_id: string
  platform: string
  billing_mode: BillingMode
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_write_micros_per_million: number | null
  cache_write_1h_micros_per_million: number | null
  cache_read_micros_per_million: number | null
  image_input_micros_per_million: number | null
  image_output_micros_per_million: number | null
  per_request_micros: number | null
  fast_multiplier_ppm: number | null
  flex_multiplier_ppm: number | null
  time_pricing_json: string | null
  control_version: number
  created_at_ms: number
  updated_at_ms: number
}
interface PricingModelRow {
  pricing_id: string
  model_pattern: string
  is_wildcard: number
  sort_order: number
}
interface IntervalRow {
  id: string
  pricing_id: string
  min_tokens: number
  max_tokens: number | null
  tier_label: string
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_write_micros_per_million: number | null
  cache_write_1h_micros_per_million: number | null
  cache_read_micros_per_million: number | null
  input_multiplier_ppm: number | null
  output_multiplier_ppm: number | null
  cache_write_multiplier_ppm: number | null
  cache_read_multiplier_ppm: number | null
  per_request_micros: number | null
  sort_order: number
}

interface ParsedMapping {
  platform: string
  source_pattern: string
  target_pattern: string
  source_is_wildcard: number
  target_is_wildcard: number
  sort_order: number
}
interface ParsedInterval extends Omit<IntervalRow, 'id' | 'pricing_id'> { id?: string }
interface ParsedPricing extends Omit<PricingRow, 'id' | 'channel_id' | 'control_version' | 'created_at_ms' | 'updated_at_ms' | 'time_pricing_json'> {
  id?: string
  models: Array<{ model_pattern: string; is_wildcard: number; sort_order: number }>
  intervals: ParsedInterval[]
  time_pricing: Record<string, unknown> | null
}
interface ParsedChannel {
  name: string
  description: string
  status: ChannelStatus
  billing_model_source: BillingModelSource
  restrict_models: boolean
  features_config: Record<string, unknown>
  apply_pricing_to_account_stats: boolean
  group_ids: string[]
  mappings: ParsedMapping[]
  pricing: ParsedPricing[]
  account_stats_pricing_rules: ParsedAccountStatsRule[]
}

interface RelatedRows {
  groups: GroupRow[]
  mappings: MappingRow[]
  pricing: PricingRow[]
  models: PricingModelRow[]
  intervals: IntervalRow[]
  accountStats: AccountStatsRelated
}

interface RelatedLoadOptions {
  groups?: boolean
  mappings?: boolean
  pricing?: boolean
  accountStats?: boolean
}

export async function listAdminChannels(context: Context<ControlBindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const conditions: string[] = []
    const values: unknown[] = []
    const status = context.req.query('status')
    if (status !== undefined) {
      conditions.push('status = ?')
      values.push(parseStatus(status, 'status'))
    }
    const search = context.req.query('search')?.trim()
    if (search) {
      if (search.length > 100) throw invalid('search', 'search must not exceed 100 characters')
      const pattern = `%${escapeLike(search)}%`
      conditions.push(`(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`)
      values.push(pattern, pattern)
    }
    const sortBy = context.req.query('sort_by') ?? 'created_at'
    const sortColumn = ({ name: 'name', status: 'status', created_at: 'created_at_ms', updated_at: 'updated_at_ms' } as const)[sortBy]
    if (sortColumn === undefined) throw invalid('sort_by', 'sort_by is invalid')
    const sortOrder = (context.req.query('sort_order') ?? 'desc').toLowerCase()
    if (sortOrder !== 'asc' && sortOrder !== 'desc') throw invalid('sort_order', 'sort_order must be asc or desc')
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const [countResult, rowsResult] = await context.env.DB.batch([
      context.env.DB.prepare(`SELECT COUNT(*) AS total FROM channels ${where}`).bind(...values),
      context.env.DB.prepare(
        `SELECT ${CHANNEL_COLUMNS} FROM channels ${where}
         ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}, id ${sortOrder.toUpperCase()}
         LIMIT ? OFFSET ?`,
      ).bind(...values, pageSize, (page - 1) * pageSize),
    ])
    const total = validCount(countResult.results[0])
    const rows = rowsResult.results as unknown as ChannelRow[]
    const related = await loadRelated(context.env, rows.map((row) => row.id))
    return controlSuccess({
      items: rows.map((row) => publicChannel(row, related)),
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminChannel(context: Context<ControlBindings>): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const row = await requireChannel(context.env, context.req.param('id'))
    const value = publicChannel(row, await loadRelated(context.env, [row.id]))
    return versioned(value)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function createAdminChannel(context: Context<ControlBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const key = requireIdempotencyKey(context.req.raw)
    const input = parseCreate(await readJsonObject(context.req.raw, MAX_BODY_BYTES))
    const idempotency = await controlIdempotency('admin.channels.create.v1', key, input)
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) return versioned(parseIdempotentResponse(replay, 'channel'))
    await validateGroups(context.env, input.group_ids)
    await validateAccountStatsScopes(context.env, input.group_ids, input.account_stats_pricing_rules)
    const now = Date.now()
    const id = await deterministicUuid('admin.channels.create.v1', key)
    const graph = await materializeGraph(input, key, now)
    const row: ChannelRow = {
      id,
      name: input.name,
      description: input.description,
      status: input.status,
      billing_model_source: input.billing_model_source,
      restrict_models: input.restrict_models ? 1 : 0,
      features_config_json: JSON.stringify(input.features_config),
      apply_pricing_to_account_stats: input.apply_pricing_to_account_stats ? 1 : 0,
      control_version: 0,
      created_at_ms: now,
      updated_at_ms: now,
    }
    const response = publicChannel(row, relatedFromGraph(id, input, graph))
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `INSERT INTO channels (${CHANNEL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ).bind(
        id, row.name, row.description, row.status, row.billing_model_source,
        row.restrict_models, row.features_config_json, row.apply_pricing_to_account_stats,
        now, now,
      ),
      ...graphStatements(context.env, id, input, graph, now),
      auditInsert(context.env, actor, 'channel.create', id, 0, idempotency.key_hash, ['create'], now),
      controlIdempotencyInsert(context.env, idempotency, 'channel', id, response, now),
    ]
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) return versioned(parseIdempotentResponse(recovered, 'channel'))
      throw mapWriteError(error)
    }
    return versioned(response, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updateAdminChannel(context: Context<ControlBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const id = requireResourceId(context.req.param('id'), 'channel')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw, MAX_BODY_BYTES)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const patch = parsePatch(body)
    const idempotency = await controlIdempotency('admin.channels.update.v1', key, { id, expected, patch })
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) return versioned(parseIdempotentResponse(replay, 'channel'))
    const current = await requireChannel(context.env, id)
    assertVersion(current.control_version, expected)
    const currentRelated = await loadRelated(context.env, [id], {
      groups: patch.group_ids === undefined,
      mappings: patch.mappings === undefined,
      pricing: patch.pricing === undefined,
      accountStats: patch.account_stats_pricing_rules === undefined,
    })
    const base = parsedFromStored(current, currentRelated)
    const next: ParsedChannel = { ...base, ...patch }
    validateGraphBudget(next)
    if (patch.group_ids !== undefined) await validateGroups(context.env, next.group_ids, id)
    if (patch.group_ids !== undefined || patch.account_stats_pricing_rules !== undefined) {
      await validateAccountStatsScopes(context.env, next.group_ids, next.account_stats_pricing_rules)
    }
    const now = Date.now()
    const graph = await materializeGraph(next, key, now)
    const nextRow: ChannelRow = {
      ...current,
      name: next.name,
      description: next.description,
      status: next.status,
      billing_model_source: next.billing_model_source,
      restrict_models: next.restrict_models ? 1 : 0,
      features_config_json: JSON.stringify(next.features_config),
      apply_pricing_to_account_stats: next.apply_pricing_to_account_stats ? 1 : 0,
      control_version: expected + 1,
      updated_at_ms: now,
    }
    const response = publicChannel(nextRow, relatedFromGraph(id, next, graph))
    const changedFields = Object.keys(body).filter((field) => field !== 'expected_control_version').sort()
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `UPDATE channels SET
           name = ?, description = ?, status = ?, billing_model_source = ?,
           restrict_models = ?, features_config_json = ?, apply_pricing_to_account_stats = ?,
           control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
           updated_at_ms = ? WHERE id = ?`,
      ).bind(
        nextRow.name, nextRow.description, nextRow.status, nextRow.billing_model_source,
        nextRow.restrict_models, nextRow.features_config_json,
        nextRow.apply_pricing_to_account_stats, expected, expected + 1, now, id,
      ),
      ...(patch.group_ids === undefined ? [] : [
        context.env.DB.prepare('DELETE FROM channel_groups WHERE channel_id = ?').bind(id),
      ]),
      ...(patch.account_stats_pricing_rules === undefined ? [] : [
        context.env.DB.prepare('DELETE FROM channel_account_stats_pricing_rules WHERE channel_id = ?').bind(id),
      ]),
      ...(patch.pricing === undefined ? [] : [
        context.env.DB.prepare('DELETE FROM channel_model_pricing WHERE channel_id = ?').bind(id),
      ]),
      ...(patch.mappings === undefined ? [] : [
        context.env.DB.prepare('DELETE FROM channel_model_mappings WHERE channel_id = ?').bind(id),
      ]),
      ...graphStatements(context.env, id, next, graph, now, {
        groups: patch.group_ids !== undefined,
        mappings: patch.mappings !== undefined,
        pricing: patch.pricing !== undefined,
        accountStats: patch.account_stats_pricing_rules !== undefined,
      }),
      guardedAuditInsert(context.env, actor, 'channel.update', id, expected + 1, idempotency.key_hash, changedFields, now),
      guardedIdempotencyInsert(context.env, idempotency, id, response, expected + 1, now),
    ]
    try {
      await context.env.DB.batch(statements)
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) return versioned(parseIdempotentResponse(recovered, 'channel'))
      throw mapWriteError(error)
    }
    return versioned(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function deleteAdminChannel(context: Context<ControlBindings>): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(context.req.raw, context.env)
    const id = requireResourceId(context.req.param('id'), 'channel')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readOptionalBody(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const idempotency = await controlIdempotency('admin.channels.delete.v1', key, { id, expected })
    const replay = await findControlIdempotency(context.env, idempotency)
    if (replay !== null) return controlSuccess(parseIdempotentResponse(replay, 'channel_delete'))
    const current = await requireChannel(context.env, id)
    assertVersion(current.control_version, expected)
    const now = Date.now()
    const response = { message: 'Channel deleted successfully' }
    try {
      await context.env.DB.batch([
        guardedAuditInsert(context.env, actor, 'channel.delete', id, expected, idempotency.key_hash, ['delete'], now),
        context.env.DB.prepare('DELETE FROM channels WHERE id = ? AND control_version = ?').bind(id, expected),
        controlIdempotencyInsert(context.env, idempotency, 'channel_delete', id, response, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'channel_delete'))
      throw mapWriteError(error)
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function parseCreate(body: Record<string, unknown>): ParsedChannel {
  rejectCredentialFields(body)
  const input: ParsedChannel = {
    name: requiredText(body.name, 'name', 128),
    description: optionalText(body.description, 'description', 4096) ?? '',
    status: parseStatus(body.status ?? 'active', 'status'),
    billing_model_source: parseBillingSource(body.billing_model_source ?? 'channel_mapped'),
    restrict_models: optionalBoolean(body.restrict_models, 'restrict_models') ?? false,
    features_config: parseObject(body.features_config ?? {}, 'features_config', 65_536),
    apply_pricing_to_account_stats: parseApplyPricingToAccountStats(body.apply_pricing_to_account_stats),
    group_ids: parseStringList(body.group_ids ?? [], 'group_ids', 100, 128),
    mappings: parseMappings(body.model_mapping ?? {}),
    pricing: parsePricing(body.model_pricing ?? []),
    account_stats_pricing_rules: parseAccountStatsRules(body.account_stats_pricing_rules ?? []),
  }
  validateGraphBudget(input)
  return input
}

function parsePatch(body: Record<string, unknown>): Partial<ParsedChannel> {
  rejectCredentialFields(body)
  const patch: Partial<ParsedChannel> = {}
  if (body.name !== undefined) patch.name = requiredText(body.name, 'name', 128)
  if (body.description !== undefined) patch.description = optionalText(body.description, 'description', 4096) ?? ''
  if (body.status !== undefined) patch.status = parseStatus(body.status, 'status')
  if (body.billing_model_source !== undefined) patch.billing_model_source = parseBillingSource(body.billing_model_source)
  if (body.restrict_models !== undefined) patch.restrict_models = requiredBoolean(body.restrict_models, 'restrict_models')
  if (body.features_config !== undefined) patch.features_config = parseObject(body.features_config, 'features_config', 65_536)
  if (body.apply_pricing_to_account_stats !== undefined) {
    patch.apply_pricing_to_account_stats = parseApplyPricingToAccountStats(body.apply_pricing_to_account_stats)
  }
  if (body.group_ids !== undefined) patch.group_ids = parseStringList(body.group_ids, 'group_ids', 100, 128)
  if (body.model_mapping !== undefined) patch.mappings = parseMappings(body.model_mapping)
  if (body.model_pricing !== undefined) patch.pricing = parsePricing(body.model_pricing)
  if (body.account_stats_pricing_rules !== undefined) {
    patch.account_stats_pricing_rules = parseAccountStatsRules(body.account_stats_pricing_rules)
  }
  return patch
}

function parsePricing(value: unknown): ParsedPricing[] {
  if (!Array.isArray(value) || value.length > 100) throw invalid('model_pricing', 'model_pricing must contain at most 100 entries')
  const pricing = value.map((raw, index) => {
    const row = parseObject(raw, `model_pricing[${index}]`, 100_000)
    const models = parseStringList(row.models, `model_pricing[${index}].models`, 100, 256, 1)
      .map((model_pattern, sort_order) => ({
        model_pattern,
        is_wildcard: wildcard(model_pattern, `model_pricing[${index}].models`) ? 1 : 0,
        sort_order,
      }))
    const billingMode = row.billing_mode ?? 'token'
    if (!['token', 'per_request', 'image', 'video'].includes(String(billingMode))) {
      throw invalid('billing_mode', 'billing_mode is invalid')
    }
    const normalizedBillingMode = billingMode as BillingMode
    const intervalsRaw = row.intervals ?? []
    if (!Array.isArray(intervalsRaw) || intervalsRaw.length > 100) {
      throw invalid('intervals', 'intervals must contain at most 100 entries')
    }
    const intervals = intervalsRaw.map((rawInterval, intervalIndex) => parseInterval(rawInterval, index, intervalIndex))
    validateIntervals(intervals, index, normalizedBillingMode)
    const parsed: ParsedPricing = {
      id: optionalId(row.id, `model_pricing[${index}].id`),
      platform: requiredText(row.platform ?? 'anthropic', `model_pricing[${index}].platform`, 64),
      billing_mode: normalizedBillingMode,
      input_micros_per_million: nullableInteger(row.input_micros_per_million, 'input_micros_per_million'),
      output_micros_per_million: nullableInteger(row.output_micros_per_million, 'output_micros_per_million'),
      cache_write_micros_per_million: nullableInteger(row.cache_write_micros_per_million, 'cache_write_micros_per_million'),
      cache_write_1h_micros_per_million: nullableInteger(row.cache_write_1h_micros_per_million, 'cache_write_1h_micros_per_million'),
      cache_read_micros_per_million: nullableInteger(row.cache_read_micros_per_million, 'cache_read_micros_per_million'),
      image_input_micros_per_million: nullableInteger(row.image_input_micros_per_million, 'image_input_micros_per_million'),
      image_output_micros_per_million: nullableInteger(row.image_output_micros_per_million, 'image_output_micros_per_million'),
      per_request_micros: nullableInteger(row.per_request_micros, 'per_request_micros'),
      fast_multiplier_ppm: nullableInteger(row.fast_multiplier_ppm, 'fast_multiplier_ppm', 1),
      flex_multiplier_ppm: nullableInteger(row.flex_multiplier_ppm, 'flex_multiplier_ppm', 1),
      time_pricing: parseTimePricing(row.time_pricing, index),
      models,
      intervals,
    }
    validateBillingConfiguration(parsed, index)
    return parsed
  })
  validatePatternConflicts(pricing.flatMap((price) => price.models.map((model) => ({
    platform: price.platform,
    pattern: model.model_pattern,
    pricing: true,
  }))), 'model_pricing')
  return pricing
}

function parseInterval(value: unknown, priceIndex: number, index: number): ParsedInterval {
  const row = parseObject(value, `intervals[${index}]`, 20_000)
  const min = integer(row.min_tokens ?? 0, 'min_tokens')
  const max = nullableInteger(row.max_tokens, 'max_tokens')
  if (max !== null && max <= min) throw invalid('max_tokens', 'max_tokens must be greater than min_tokens')
  return {
    id: optionalId(row.id, `model_pricing[${priceIndex}].intervals[${index}].id`),
    min_tokens: min,
    max_tokens: max,
    tier_label: optionalText(row.tier_label, 'tier_label', 128) ?? '',
    input_micros_per_million: nullableInteger(row.input_micros_per_million, 'input_micros_per_million'),
    output_micros_per_million: nullableInteger(row.output_micros_per_million, 'output_micros_per_million'),
    cache_write_micros_per_million: nullableInteger(row.cache_write_micros_per_million, 'cache_write_micros_per_million'),
    cache_write_1h_micros_per_million: nullableInteger(row.cache_write_1h_micros_per_million, 'cache_write_1h_micros_per_million'),
    cache_read_micros_per_million: nullableInteger(row.cache_read_micros_per_million, 'cache_read_micros_per_million'),
    input_multiplier_ppm: nullableInteger(row.input_multiplier_ppm, 'input_multiplier_ppm', 1),
    output_multiplier_ppm: nullableInteger(row.output_multiplier_ppm, 'output_multiplier_ppm', 1),
    cache_write_multiplier_ppm: nullableInteger(row.cache_write_multiplier_ppm, 'cache_write_multiplier_ppm', 1),
    cache_read_multiplier_ppm: nullableInteger(row.cache_read_multiplier_ppm, 'cache_read_multiplier_ppm', 1),
    per_request_micros: nullableInteger(row.per_request_micros, 'per_request_micros'),
    sort_order: integer(row.sort_order ?? index, 'sort_order'),
  }
}

function validateIntervals(intervals: ParsedInterval[], priceIndex: number, mode: BillingMode): void {
  if (mode !== 'token') return
  const sorted = [...intervals].sort((a, b) => a.min_tokens - b.min_tokens)
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]
    if (previous.max_tokens === null || previous.max_tokens > sorted[index].min_tokens) {
      throw invalid('intervals', `model_pricing[${priceIndex}] intervals overlap`)
    }
  }
}

function parseTimePricing(value: unknown, priceIndex: number): Record<string, unknown> | null {
  if (value === undefined || value === null) return null
  const row = parseObject(value, `model_pricing[${priceIndex}].time_pricing`, 65_536)
  const periodsRaw = row.periods ?? []
  if (!Array.isArray(periodsRaw) || periodsRaw.length > 48) throw invalid('time_pricing', 'time_pricing periods are invalid')
  const periods = periodsRaw.map((raw, index) => {
    const period = parseObject(raw, `periods[${index}]`, 1024)
    const start = clock(period.start_time, 'start_time')
    const end = clock(period.end_time, 'end_time')
    if (start === end) throw invalid('time_pricing', 'time pricing period must not be empty')
    return { start_time: start, end_time: end, multiplier_ppm: integer(period.multiplier_ppm, 'multiplier_ppm', 1) }
  })
  return {
    timezone: requiredText(row.timezone, 'timezone', 64),
    weekdays_only: optionalBoolean(row.weekdays_only, 'weekdays_only') ?? false,
    periods,
  }
}

function parseMappings(value: unknown): ParsedMapping[] {
  const object = parseObject(value, 'model_mapping', 65_536)
  const platforms = Object.keys(object).sort()
  if (platforms.length > 32) throw invalid('model_mapping', 'model_mapping has too many platforms')
  const result: ParsedMapping[] = []
  for (const platform of platforms) {
    requiredText(platform, 'model_mapping platform', 64)
    const mappings = parseObject(object[platform], `model_mapping.${platform}`, 65_536)
    for (const source of Object.keys(mappings).sort()) {
      if (result.length >= 500) throw invalid('model_mapping', 'model_mapping has too many entries')
      const target = optionalText(mappings[source], `model_mapping.${platform}.${source}`, 256) ?? ''
      result.push({
        platform,
        source_pattern: requiredPattern(source, 'model_mapping source'),
        target_pattern: target === '' ? '' : requiredPattern(target, 'model_mapping target'),
        source_is_wildcard: wildcard(source, 'model_mapping source') ? 1 : 0,
        target_is_wildcard: target !== '' && wildcard(target, 'model_mapping target') ? 1 : 0,
        sort_order: result.length,
      })
    }
  }
  validatePatternConflicts(result.map((mapping) => ({
    platform: mapping.platform,
    pattern: mapping.source_pattern,
    pricing: false,
  })), 'model_mapping')
  return result
}

function validateBillingConfiguration(price: ParsedPricing, index: number): void {
  if (price.time_pricing !== null && price.billing_mode !== 'token') {
    throw invalid('time_pricing', `model_pricing[${index}] time_pricing only supports token billing`)
  }
  if (
    ['per_request', 'image', 'video'].includes(price.billing_mode)
    && price.per_request_micros === null
    && price.intervals.length === 0
  ) {
    throw invalid('billing_mode', `model_pricing[${index}] requires per_request_micros or intervals`)
  }
  for (const interval of price.intervals) {
    const values = [
      interval.input_micros_per_million, interval.output_micros_per_million,
      interval.cache_write_micros_per_million, interval.cache_write_1h_micros_per_million,
      interval.cache_read_micros_per_million, interval.input_multiplier_ppm,
      interval.output_multiplier_ppm, interval.cache_write_multiplier_ppm,
      interval.cache_read_multiplier_ppm, interval.per_request_micros,
    ]
    if (values.every((value) => value === null)) {
      throw invalid('intervals', `model_pricing[${index}] interval has no price or multiplier`)
    }
  }
}

function validatePatternConflicts(
  values: Array<{ platform: string; pattern: string; pricing: boolean }>,
  field: string,
): void {
  for (let leftIndex = 0; leftIndex < values.length; leftIndex += 1) {
    const left = values[leftIndex]
    for (let rightIndex = leftIndex + 1; rightIndex < values.length; rightIndex += 1) {
      const right = values[rightIndex]
      if (left.platform.toLowerCase() !== right.platform.toLowerCase()) continue
      const normalize = left.pricing && right.pricing ? normalizePricingPattern : normalizeMappingPattern
      const leftPattern = normalize(left.pattern)
      const rightPattern = normalize(right.pattern)
      const leftWildcard = leftPattern.endsWith('*')
      const rightWildcard = rightPattern.endsWith('*')
      const leftPrefix = leftWildcard ? leftPattern.slice(0, -1) : leftPattern
      const rightPrefix = rightWildcard ? rightPattern.slice(0, -1) : rightPattern
      const conflicts = leftWildcard
        ? rightPrefix.startsWith(leftPrefix)
        : rightWildcard
          ? leftPrefix.startsWith(rightPrefix)
          : leftPrefix === rightPrefix
      if (conflicts) throw invalid(field, `${field} contains overlapping patterns for platform ${left.platform}`)
    }
  }
}

function normalizePricingPattern(value: string): string {
  const suffix = value.endsWith('*') ? '*' : ''
  let prefix = (suffix === '' ? value : value.slice(0, -1)).trim().toLowerCase()
  if (prefix.startsWith('claude-')) prefix = prefix.replaceAll('.', '-')
  return prefix + suffix
}

function normalizeMappingPattern(value: string): string {
  return value.toLowerCase()
}

async function validateGroups(env: Env, ids: string[], currentChannelId?: string): Promise<void> {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(', ')
  const rows = await env.DB.prepare(
    `SELECT g.id, cg.channel_id FROM "groups" g
       LEFT JOIN channel_groups cg ON cg.group_id = g.id
      WHERE g.id IN (${placeholders})`,
  ).bind(...ids).all<{ id: string; channel_id: string | null }>()
  if (rows.results.length !== ids.length) throw new GatewayError(409, 'channel_group_not_found', 'One or more groups do not exist')
  if (rows.results.some((row) => row.channel_id !== null && row.channel_id !== currentChannelId)) {
    throw new GatewayError(409, 'channel_group_conflict', 'A group already belongs to another channel')
  }
}

async function requireChannel(env: Env, rawId: string | undefined): Promise<ChannelRow> {
  const id = requireResourceId(rawId, 'channel')
  const row = await env.DB.prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`).bind(id).first<ChannelRow>()
  if (row === null) throw new GatewayError(404, 'channel_not_found', 'Channel was not found')
  return row
}

async function loadRelated(
  env: Env,
  channelIds: string[],
  options: RelatedLoadOptions = {},
): Promise<RelatedRows> {
  if (channelIds.length === 0) {
    return { groups: [], mappings: [], pricing: [], models: [], intervals: [], accountStats: emptyAccountStatsRelated() }
  }
  const includeGroups = options.groups ?? true
  const includeMappings = options.mappings ?? true
  const includePricing = options.pricing ?? true
  const includeAccountStats = options.accountStats ?? true
  const placeholders = channelIds.map(() => '?').join(', ')
  const [groups, mappings, pricing, accountStats] = await Promise.all([
    includeGroups ? env.DB.prepare(`SELECT channel_id, group_id FROM channel_groups WHERE channel_id IN (${placeholders}) ORDER BY group_id`).bind(...channelIds).all() : Promise.resolve({ results: [] }),
    includeMappings ? env.DB.prepare(
      `SELECT channel_id, platform, source_pattern, target_pattern, source_is_wildcard,
              target_is_wildcard, sort_order FROM channel_model_mappings
       WHERE channel_id IN (${placeholders}) ORDER BY channel_id, platform, sort_order, source_pattern`,
    ).bind(...channelIds).all() : Promise.resolve({ results: [] }),
    includePricing ? env.DB.prepare(
      `SELECT id, channel_id, platform, billing_mode, input_micros_per_million,
              output_micros_per_million, cache_write_micros_per_million,
              cache_write_1h_micros_per_million, cache_read_micros_per_million,
              image_input_micros_per_million, image_output_micros_per_million,
              per_request_micros, fast_multiplier_ppm, flex_multiplier_ppm,
              time_pricing_json, control_version, created_at_ms, updated_at_ms
         FROM channel_model_pricing WHERE channel_id IN (${placeholders})
        ORDER BY channel_id, platform, id`,
    ).bind(...channelIds).all() : Promise.resolve({ results: [] }),
    includeAccountStats ? loadAccountStatsRelated(env, channelIds) : Promise.resolve(emptyAccountStatsRelated()),
  ])
  const prices = pricing.results as unknown as PricingRow[]
  if (prices.length === 0) {
    return {
      groups: groups.results as unknown as GroupRow[],
      mappings: mappings.results as unknown as MappingRow[], pricing: [], models: [], intervals: [], accountStats,
    }
  }
  const [models, intervals] = await env.DB.batch([
    env.DB.prepare(
      `SELECT pm.pricing_id, pm.model_pattern, pm.is_wildcard, pm.sort_order
         FROM channel_pricing_models pm
         JOIN channel_model_pricing p ON p.id = pm.pricing_id
        WHERE p.channel_id IN (${placeholders})
        ORDER BY pm.pricing_id, pm.sort_order, pm.model_pattern`,
    ).bind(...channelIds),
    env.DB.prepare(
      `SELECT pi.id, pi.pricing_id, pi.min_tokens, pi.max_tokens, pi.tier_label,
              pi.input_micros_per_million, pi.output_micros_per_million,
              pi.cache_write_micros_per_million, pi.cache_write_1h_micros_per_million,
              pi.cache_read_micros_per_million, pi.input_multiplier_ppm,
              pi.output_multiplier_ppm, pi.cache_write_multiplier_ppm,
              pi.cache_read_multiplier_ppm, pi.per_request_micros, pi.sort_order
         FROM channel_pricing_intervals pi
         JOIN channel_model_pricing p ON p.id = pi.pricing_id
        WHERE p.channel_id IN (${placeholders})
        ORDER BY pi.pricing_id, pi.sort_order, pi.id`,
    ).bind(...channelIds),
  ])
  return {
    groups: groups.results as unknown as GroupRow[],
    mappings: mappings.results as unknown as MappingRow[],
    pricing: prices,
    models: models.results as unknown as PricingModelRow[],
    intervals: intervals.results as unknown as IntervalRow[],
    accountStats,
  }
}

function publicChannel(row: ChannelRow, related: RelatedRows) {
  const mapping: Record<string, Record<string, string>> = {}
  for (const item of related.mappings.filter((item) => item.channel_id === row.id)) {
    ;(mapping[item.platform] ??= {})[item.source_pattern] = item.target_pattern
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: publicStatus(row.status),
    billing_model_source: row.billing_model_source,
    restrict_models: row.restrict_models === 1,
    features_config: parseStoredObject(row.features_config_json, 'features_config'),
    group_ids: related.groups.filter((item) => item.channel_id === row.id).map((item) => item.group_id),
    model_pricing: related.pricing.filter((item) => item.channel_id === row.id).map((price) => ({
      id: price.id,
      platform: price.platform,
      models: related.models.filter((model) => model.pricing_id === price.id).map((model) => model.model_pattern),
      billing_mode: price.billing_mode,
      input_micros_per_million: price.input_micros_per_million,
      output_micros_per_million: price.output_micros_per_million,
      cache_write_micros_per_million: price.cache_write_micros_per_million,
      cache_write_1h_micros_per_million: price.cache_write_1h_micros_per_million,
      cache_read_micros_per_million: price.cache_read_micros_per_million,
      image_input_micros_per_million: price.image_input_micros_per_million,
      image_output_micros_per_million: price.image_output_micros_per_million,
      per_request_micros: price.per_request_micros,
      fast_multiplier_ppm: price.fast_multiplier_ppm,
      flex_multiplier_ppm: price.flex_multiplier_ppm,
      intervals: related.intervals.filter((interval) => interval.pricing_id === price.id).map(publicInterval),
      time_pricing: price.time_pricing_json === null ? null : parseStoredObject(price.time_pricing_json, 'time_pricing'),
    })),
    model_mapping: mapping,
    apply_pricing_to_account_stats: row.apply_pricing_to_account_stats === 1,
    account_stats_pricing_rules: publicAccountStatsRules(row.id, related.accountStats),
    control_version: row.control_version,
    created_at: new Date(row.created_at_ms).toISOString(),
    updated_at: new Date(row.updated_at_ms).toISOString(),
  }
}

function publicInterval(row: IntervalRow) {
  const { pricing_id: _pricingId, ...value } = row
  return value
}

function parsedFromStored(row: ChannelRow, related: RelatedRows): ParsedChannel {
  const mappings = related.mappings.filter((item) => item.channel_id === row.id).map((item) => ({
    platform: item.platform, source_pattern: item.source_pattern, target_pattern: item.target_pattern,
    source_is_wildcard: item.source_is_wildcard, target_is_wildcard: item.target_is_wildcard, sort_order: item.sort_order,
  }))
  return {
    name: row.name, description: row.description, status: row.status,
    billing_model_source: row.billing_model_source, restrict_models: row.restrict_models === 1,
    features_config: parseStoredObject(row.features_config_json, 'features_config'),
    apply_pricing_to_account_stats: row.apply_pricing_to_account_stats === 1,
    group_ids: related.groups.filter((item) => item.channel_id === row.id).map((item) => item.group_id),
    mappings,
    pricing: related.pricing.filter((item) => item.channel_id === row.id).map((price) => ({
      id: price.id,
      platform: price.platform, billing_mode: price.billing_mode,
      input_micros_per_million: price.input_micros_per_million,
      output_micros_per_million: price.output_micros_per_million,
      cache_write_micros_per_million: price.cache_write_micros_per_million,
      cache_write_1h_micros_per_million: price.cache_write_1h_micros_per_million,
      cache_read_micros_per_million: price.cache_read_micros_per_million,
      image_input_micros_per_million: price.image_input_micros_per_million,
      image_output_micros_per_million: price.image_output_micros_per_million,
      per_request_micros: price.per_request_micros,
      fast_multiplier_ppm: price.fast_multiplier_ppm, flex_multiplier_ppm: price.flex_multiplier_ppm,
      time_pricing: price.time_pricing_json === null ? null : parseStoredObject(price.time_pricing_json, 'time_pricing'),
      models: related.models.filter((item) => item.pricing_id === price.id).map((item) => ({
        model_pattern: item.model_pattern, is_wildcard: item.is_wildcard, sort_order: item.sort_order,
      })),
      intervals: related.intervals.filter((item) => item.pricing_id === price.id).map((item) => {
        const { id, pricing_id: _pricingId, ...interval } = item
        return { id, ...interval }
      }),
    })),
    account_stats_pricing_rules: parsedAccountStatsRules(row.id, related.accountStats),
  }
}

interface MaterializedGraph {
  pricing: Array<Omit<ParsedPricing, 'id' | 'intervals'> & {
    id: string
    intervals: Array<Omit<ParsedInterval, 'id'> & { id: string }>
  }>
  accountStats: MaterializedAccountStatsGraph
}

async function materializeGraph(input: ParsedChannel, key: string, _now: number): Promise<MaterializedGraph> {
  return {
    pricing: await Promise.all(input.pricing.map(async (price, index) => {
      const id = price.id ?? await deterministicUuid('admin.channels.pricing.v1', `${key}:pricing:${index}`)
      return {
        ...price,
        id,
        intervals: await Promise.all(price.intervals.map(async (interval, intervalIndex) => ({
          ...interval,
          id: interval.id ?? await deterministicUuid('admin.channels.interval.v1', `${key}:pricing:${index}:interval:${intervalIndex}`),
        }))),
      }
    })),
    accountStats: await materializeAccountStatsGraph(input.account_stats_pricing_rules, key),
  }
}

function relatedFromGraph(channelId: string, input: ParsedChannel, graph: MaterializedGraph): RelatedRows {
  return {
    groups: input.group_ids.map((group_id) => ({ channel_id: channelId, group_id })),
    mappings: input.mappings.map((item) => ({ channel_id: channelId, ...item })),
    pricing: graph.pricing.map((price) => ({
      id: price.id, channel_id: channelId, platform: price.platform, billing_mode: price.billing_mode,
      input_micros_per_million: price.input_micros_per_million,
      output_micros_per_million: price.output_micros_per_million,
      cache_write_micros_per_million: price.cache_write_micros_per_million,
      cache_write_1h_micros_per_million: price.cache_write_1h_micros_per_million,
      cache_read_micros_per_million: price.cache_read_micros_per_million,
      image_input_micros_per_million: price.image_input_micros_per_million,
      image_output_micros_per_million: price.image_output_micros_per_million,
      per_request_micros: price.per_request_micros,
      fast_multiplier_ppm: price.fast_multiplier_ppm, flex_multiplier_ppm: price.flex_multiplier_ppm,
      time_pricing_json: price.time_pricing === null ? null : JSON.stringify(price.time_pricing),
      control_version: 0, created_at_ms: 0, updated_at_ms: 0,
    })),
    models: graph.pricing.flatMap((price) => price.models.map((model) => ({ pricing_id: price.id, ...model }))),
    intervals: graph.pricing.flatMap((price) => price.intervals.map((interval) => ({ pricing_id: price.id, ...interval }))),
    accountStats: relatedAccountStatsFromGraph(channelId, graph.accountStats),
  }
}

function graphStatements(
  env: Env,
  channelId: string,
  input: ParsedChannel,
  graph: MaterializedGraph,
  now: number,
  options: RelatedLoadOptions = {},
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  const includeGroups = options.groups ?? true
  const includeMappings = options.mappings ?? true
  const includePricing = options.pricing ?? true
  const includeAccountStats = options.accountStats ?? true
  for (const groupId of includeGroups ? input.group_ids : []) {
    statements.push(env.DB.prepare('INSERT INTO channel_groups (channel_id, group_id, created_at_ms) VALUES (?, ?, ?)').bind(channelId, groupId, now))
  }
  for (const mapping of includeMappings ? input.mappings : []) {
    statements.push(env.DB.prepare(
      `INSERT INTO channel_model_mappings (
         channel_id, platform, source_pattern, target_pattern, source_is_wildcard,
         target_is_wildcard, sort_order, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      channelId, mapping.platform, mapping.source_pattern, mapping.target_pattern,
      mapping.source_is_wildcard, mapping.target_is_wildcard, mapping.sort_order, now,
    ))
  }
  for (const price of includePricing ? graph.pricing : []) {
    statements.push(env.DB.prepare(
      `INSERT INTO channel_model_pricing (
         id, channel_id, platform, billing_mode, input_micros_per_million,
         output_micros_per_million, cache_write_micros_per_million,
         cache_write_1h_micros_per_million, cache_read_micros_per_million,
         image_input_micros_per_million, image_output_micros_per_million,
         per_request_micros, fast_multiplier_ppm, flex_multiplier_ppm,
         time_pricing_json, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      price.id, channelId, price.platform, price.billing_mode,
      price.input_micros_per_million, price.output_micros_per_million,
      price.cache_write_micros_per_million, price.cache_write_1h_micros_per_million,
      price.cache_read_micros_per_million, price.image_input_micros_per_million,
      price.image_output_micros_per_million, price.per_request_micros,
      price.fast_multiplier_ppm, price.flex_multiplier_ppm,
      price.time_pricing === null ? null : JSON.stringify(price.time_pricing), now, now,
    ))
    for (const model of price.models) {
      statements.push(env.DB.prepare(
        `INSERT INTO channel_pricing_models (
           pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
         ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(price.id, model.model_pattern, model.is_wildcard, model.sort_order, now))
    }
    for (const interval of price.intervals) {
      statements.push(env.DB.prepare(
        `INSERT INTO channel_pricing_intervals (
           id, pricing_id, min_tokens, max_tokens, tier_label,
           input_micros_per_million, output_micros_per_million,
           cache_write_micros_per_million, cache_write_1h_micros_per_million,
           cache_read_micros_per_million, input_multiplier_ppm,
           output_multiplier_ppm, cache_write_multiplier_ppm,
           cache_read_multiplier_ppm, per_request_micros, sort_order,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        interval.id, price.id, interval.min_tokens, interval.max_tokens, interval.tier_label,
        interval.input_micros_per_million, interval.output_micros_per_million,
        interval.cache_write_micros_per_million, interval.cache_write_1h_micros_per_million,
        interval.cache_read_micros_per_million, interval.input_multiplier_ppm,
        interval.output_multiplier_ppm, interval.cache_write_multiplier_ppm,
        interval.cache_read_multiplier_ppm, interval.per_request_micros,
        interval.sort_order, now, now,
      ))
    }
  }
  if (includeAccountStats) {
    statements.push(...accountStatsStatements(env, channelId, graph.accountStats, now))
  }
  return statements
}

function auditInsert(
  env: Env, actor: AdminActor, action: string, channelId: string, version: number,
  keyHash: string, changedFields: string[], now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO admin_channel_audit_events (
       id, actor_user_id, action, actor_session_id, resource_id,
       resource_version, idempotency_key_hash, changed_fields_json, occurred_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), actor.user_id, action, actor.session_id, channelId,
    version, keyHash, JSON.stringify(changedFields), now,
  )
}

function guardedAuditInsert(
  env: Env, actor: AdminActor, action: string, channelId: string, version: number,
  keyHash: string, changedFields: string[], now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO admin_channel_audit_events (
       id, actor_user_id, action, actor_session_id, resource_id,
       resource_version, idempotency_key_hash, changed_fields_json, occurred_at_ms
     ) VALUES (?, ?,
       CASE WHEN EXISTS (
         SELECT 1 FROM channels WHERE id = ? AND control_version = ?
       ) THEN ? ELSE NULL END,
       ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), actor.user_id, channelId, version, action, actor.session_id,
    channelId, version, keyHash, JSON.stringify(changedFields), now,
  )
}

function guardedIdempotencyInsert(
  env: Env,
  value: Awaited<ReturnType<typeof controlIdempotency>>,
  id: string,
  response: unknown,
  expectedVersion: number,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO control_idempotency (
       scope, key_hash, request_hash, resource_type, resource_id,
       response_json, created_at_ms, expires_at_ms
     ) VALUES (?, ?, ?, 'channel',
       CASE WHEN EXISTS (
         SELECT 1 FROM channels WHERE id = ? AND control_version = ?
       ) THEN ? ELSE NULL END,
       ?, ?, ?)`,
  ).bind(
    value.scope, value.key_hash, value.request_hash, id, expectedVersion, id,
    JSON.stringify(response), now, now + 7 * DAY_MS,
  )
}

const DAY_MS = 86_400_000

function versioned(value: unknown, status = 200): Response {
  const response = controlSuccess(value, status)
  const version = (value as { control_version?: unknown })?.control_version
  if (Number.isSafeInteger(version)) response.headers.set('etag', `"${version}"`)
  return response
}

function parseStatus(value: unknown, field: string): ChannelStatus {
  if (value === 'active') return 'active'
  if (value === 'disabled' || value === 'inactive') return 'inactive'
  throw invalid(field, `${field} must be active, disabled, or inactive`)
}

function publicStatus(value: ChannelStatus): PublicChannelStatus {
  return value === 'inactive' ? 'disabled' : 'active'
}

function parseBillingSource(value: unknown): BillingModelSource {
  if (value === 'channel_mapped') return value
  if (['requested', 'upstream', 'response_model'].includes(String(value))) {
    throw new GatewayError(
      409,
      'billing_model_source_not_supported',
      'This billing model source is not implemented by the Worker runtime yet',
    )
  }
  throw invalid('billing_model_source', 'billing_model_source is invalid')
}

function parseApplyPricingToAccountStats(value: unknown): boolean {
  return value === undefined
    ? false
    : requiredBoolean(value, 'apply_pricing_to_account_stats')
}

function parseStringList(value: unknown, field: string, maximumItems: number, maximumLength: number, minimumItems = 0): string[] {
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) {
    throw invalid(field, `${field} must contain between ${minimumItems} and ${maximumItems} entries`)
  }
  const values = value.map((item) => {
    if ((typeof item !== 'string' && !Number.isSafeInteger(item)) || String(item).length > maximumLength) {
      throw invalid(field, `${field} contains an invalid identifier`)
    }
    const text = String(item).trim()
    if (text === '') throw invalid(field, `${field} contains an empty identifier`)
    return text
  })
  if (new Set(values.map((item) => item.toLowerCase())).size !== values.length) {
    throw invalid(field, `${field} contains duplicate entries`)
  }
  return [...values].sort((left, right) => left.localeCompare(right))
}

function parseObject(value: unknown, field: string, maximumBytes: number): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(field, `${field} must be an object`)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes) throw invalid(field, `${field} is too large`)
  return value as Record<string, unknown>
}

function parseStoredObject(value: string, field: string): Record<string, unknown> {
  try {
    return parseObject(JSON.parse(value), field, 65_536)
  } catch (error) {
    if (error instanceof GatewayError) throw new GatewayError(500, `invalid_channel_${field}`, `Stored ${field} is invalid`, 'server_error')
    throw new GatewayError(500, `invalid_channel_${field}`, `Stored ${field} is invalid`, 'server_error')
  }
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(field, `${field} must be a non-empty string of at most ${maximum} characters`)
  }
  return value.trim()
}

function optionalText(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > maximum || /\u0000/.test(value)) throw invalid(field, `${field} is invalid`)
  return value
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  return value === undefined ? undefined : requiredBoolean(value, field)
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalid(field, `${field} must be boolean`)
  return value
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > MAX_SAFE) {
    throw invalid(field, `${field} must be an exact integer between ${minimum} and ${MAX_SAFE}`)
  }
  return value as number
}

function nullableInteger(value: unknown, field: string, minimum = 0): number | null {
  return value === undefined || value === null ? null : integer(value, field, minimum)
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requireResourceId(String(value), field.replace(/[^a-z0-9]+/gi, '_'))
}

function requiredPattern(value: unknown, field: string): string {
  const pattern = requiredText(value, field, 256)
  wildcard(pattern, field)
  return pattern
}

function wildcard(pattern: string, field: string): boolean {
  const first = pattern.indexOf('*')
  if (first === -1) return false
  if (first !== pattern.length - 1 || pattern.indexOf('*', first + 1) !== -1) {
    throw invalid(field, `${field} only supports a single trailing wildcard`)
  }
  return true
}

function clock(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
    throw invalid(field, `${field} must use HH:mm or HH:mm:ss`)
  }
  return value
}

function rejectCredentialFields(body: Record<string, unknown>): void {
  for (const field of ['api_key', 'api_secret', 'secret', 'credentials', 'base_url']) {
    if (body[field] !== undefined) throw invalid(field, `${field} is not part of the channel boundary`)
  }
}

function validateGraphBudget(input: ParsedChannel): void {
  const rows = input.group_ids.length + input.mappings.length + input.pricing.length
    + input.pricing.reduce((total, price) => total + price.models.length + price.intervals.length, 0)
    + accountStatsGraphRows(input.account_stats_pricing_rules)
  if (rows > MAX_GRAPH_ROWS) {
    throw invalid('channel_graph', `channel graph must contain at most ${MAX_GRAPH_ROWS} normalized rows`)
  }
}

async function readOptionalBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > 8192) throw new GatewayError(413, 'request_too_large', 'Request body is too large')
  if (text.trim() === '') return {}
  let value: unknown
  try { value = JSON.parse(text) } catch { throw invalid('body', 'Request body must be valid JSON') }
  return parseObject(value, 'body', 8192)
}

function assertVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new GatewayError(412, 'control_version_conflict', 'Channel changed; reload it and retry')
  if (expected >= MAX_SAFE) throw new GatewayError(409, 'control_version_exhausted', 'Channel control version is exhausted')
}

function validCount(value: unknown): number {
  const count = (value as { total?: unknown } | undefined)?.total
  if (!Number.isSafeInteger(count) || (count as number) < 0) throw new GatewayError(500, 'invalid_channel_count', 'Channel count is invalid', 'server_error')
  return count as number
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function invalid(field: string, message: string): GatewayError {
  return new GatewayError(400, `invalid_${field.replace(/[^a-z0-9]+/gi, '_')}`, message)
}

function mapWriteError(error: unknown): unknown {
  if (error instanceof GatewayError) return error
  const message = error instanceof Error ? error.message : ''
  if (/control_version|NOT NULL constraint failed: admin_channel_audit_events\.action/i.test(message)) {
    return new GatewayError(412, 'control_version_conflict', 'Channel changed; reload it and retry')
  }
  if (/idx_channel_groups_one_channel_per_group|channel_groups\.group_id/i.test(message)) {
    return new GatewayError(409, 'channel_group_conflict', 'A group already belongs to another channel')
  }
  if (/idx_channels_name|channels\.name|UNIQUE constraint failed: channels\.name/i.test(message)) {
    return new GatewayError(409, 'channel_name_exists', 'A channel with this name already exists')
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return new GatewayError(409, 'channel_relation_conflict', 'A referenced channel relation changed; reload and retry')
  }
  if (/CHECK constraint failed|UNIQUE constraint failed/i.test(message)) {
    return new GatewayError(409, 'channel_graph_conflict', 'Channel pricing or mapping conflicts with stored data')
  }
  return error
}
