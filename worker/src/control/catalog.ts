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
  optionalNullableString,
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

interface GroupRow {
  ui_config_json: string
  id: string
  name: string
  description: string | null
  platform: string
  enabled: number
  sort_order: number
  rate_multiplier_ppm: number
  rpm_limit: number
  catalog_mode: 'all_routable' | 'allowlist'
  group_type: 'standard' | 'subscription'
  is_exclusive: number
  daily_quota_micros: number | null
  weekly_quota_micros: number | null
  monthly_quota_micros: number | null
  allow_image_generation: number
  allow_batch_image_generation: number
  image_rate_independent: number
  image_rate_multiplier_ppm: number
  batch_image_discount_multiplier_ppm: number
  batch_image_hold_multiplier_ppm: number
  image_price_1k_micros: number | null
  image_price_2k_micros: number | null
  image_price_4k_micros: number | null
  control_version: number
  created_at_ms: number
  updated_at_ms: number
}

interface ModelRow {
  id: string
  platform: string
  public_name: string
  upstream_name: string
  endpoint: 'chat_completions' | 'responses' | 'both'
  embeddings: number
  image_generation: number
  enabled: number
  control_version: number
  created_at_ms: number
  updated_at_ms: number
}

interface GroupModelRow {
  group_id: string
  model_id: string
  public_name: string
  upstream_name: string
  endpoint: ModelRow['endpoint']
  embeddings: number
  image_generation: number
  upstream_name_override: string | null
  enabled: number
  catalog_visible: number
  sort_order: number
  max_output_tokens: number
  default_max_output_tokens: number
  control_version: number
  created_at_ms: number
  updated_at_ms: number
  price_id: string | null
  price_version: number | null
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_read_micros_per_million: number | null
  per_request_micros: number | null
  minimum_reservation_micros: number | null
}

interface PriceRow {
  id: string
  group_id: string
  model_id: string
  version: number
  active: number
  input_micros_per_million: number
  output_micros_per_million: number
  cache_read_micros_per_million: number
  per_request_micros: number
  minimum_reservation_micros: number
  effective_at_ms: number
  retired_at_ms: number | null
  created_at_ms: number
}

const GROUP_COLUMNS = `ui_config_json, id, name, description, platform, enabled, sort_order,
  rate_multiplier_ppm, rpm_limit, catalog_mode, group_type, is_exclusive,
  daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
  allow_image_generation, allow_batch_image_generation, image_rate_independent,
  image_rate_multiplier_ppm, batch_image_discount_multiplier_ppm,
  batch_image_hold_multiplier_ppm, image_price_1k_micros,
  image_price_2k_micros, image_price_4k_micros,
  control_version, created_at_ms, updated_at_ms`
const MODEL_COLUMNS = `id, platform, public_name, upstream_name, endpoint, embeddings,
  image_generation, enabled,
  control_version, created_at_ms, updated_at_ms`

export async function listAdminGroups(context: Context<ControlBindings>): Promise<Response> {
  try {
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const conditions: string[] = []
    const values: unknown[] = []
    const platform = context.req.query('platform')
    if (platform !== undefined) {
      conditions.push('platform = ?')
      values.push(platform)
    }
    const status = context.req.query('status')
    if (status !== undefined) {
      if (status !== 'active' && status !== 'inactive') {
        throw new GatewayError(400, 'invalid_status', 'status must be active or inactive')
      }
      conditions.push('enabled = ?')
      values.push(status === 'active' ? 1 : 0)
    }
    const exclusive = context.req.query('is_exclusive')
    if (exclusive !== undefined) {
      if (exclusive !== 'true' && exclusive !== 'false') {
        throw new GatewayError(400, 'invalid_is_exclusive', 'is_exclusive must be true or false')
      }
      conditions.push('is_exclusive = ?')
      values.push(exclusive === 'true' ? 1 : 0)
    }
    const search = context.req.query('search')?.trim()
    if (search) {
      if (search.length > 100) throw new GatewayError(400, 'invalid_search', 'search must not exceed 100 characters')
      conditions.push(`(name LIKE ? ESCAPE '\\' OR COALESCE(description, '') LIKE ? ESCAPE '\\')`)
      const pattern = `%${escapeLike(search)}%`
      values.push(pattern, pattern)
    }
    const sortBy = context.req.query('sort_by') ?? 'sort_order'
    const sortColumns: Record<string, string> = {
      id: 'id',
      name: 'name',
      platform: 'platform',
      billing_type: 'group_type',
      subscription_type: 'group_type',
      rate_multiplier: 'rate_multiplier_ppm',
      rate_multiplier_ppm: 'rate_multiplier_ppm',
      is_exclusive: 'is_exclusive',
      account_count: '(SELECT COUNT(*) FROM account_groups ag WHERE ag.group_id = "groups".id)',
      status: 'enabled',
      sort_order: 'sort_order',
      created_at: 'created_at_ms',
      updated_at: 'updated_at_ms',
    }
    const sortColumn = sortColumns[sortBy]
    if (sortColumn === undefined) {
      throw new GatewayError(400, 'invalid_sort_by', 'sort_by is invalid')
    }
    const sortOrder = context.req.query('sort_order') ?? 'asc'
    if (sortOrder !== 'asc' && sortOrder !== 'desc') {
      throw new GatewayError(400, 'invalid_sort_order', 'sort_order must be asc or desc')
    }
    const direction = sortOrder.toUpperCase()
    const orderBy = sortBy === 'id'
      ? `${sortColumn} ${direction}`
      : `${sortColumn} ${direction}, id ${direction}`
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const [count, rows] = await context.env.DB.batch([
      context.env.DB.prepare(`SELECT COUNT(*) AS total FROM "groups" ${where}`).bind(...values),
      context.env.DB.prepare(
        `SELECT ${GROUP_COLUMNS} FROM "groups" ${where}
         ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      ).bind(...values, pageSize, (page - 1) * pageSize),
    ])
    const total = validCount(count.results[0], 'group')
    return controlSuccess({
      items: (rows.results as unknown as GroupRow[]).map(publicGroup),
      total,
      page,
      page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function allAdminGroups(context: Context<ControlBindings>): Promise<Response> {
  try {
    const includeInactive = context.req.query('include_inactive') === 'true'
    const platform = context.req.query('platform')
    const conditions: string[] = includeInactive ? [] : ['enabled = 1']
    const values: unknown[] = []
    if (platform !== undefined) {
      conditions.push('platform = ?')
      values.push(platform)
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const rows = await context.env.DB.prepare(
      `SELECT ${GROUP_COLUMNS} FROM "groups" ${where} ORDER BY sort_order ASC, id ASC`,
    ).bind(...values).all<GroupRow>()
    return controlSuccess(rows.results.map(publicGroup))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function createAdminGroup(context: Context<ControlBindings>): Promise<Response> {
  try {
    const key = requireIdempotencyKey(context.req.raw)
    const input = parseCreateGroup(await readJsonObject(context.req.raw))
    const idem = await controlIdempotency('admin.groups.create.v1', key, input)
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) return controlSuccess(parseIdempotentResponse(previous, 'group'))
    if (await findGroupByName(context.env, input.name)) {
      throw new GatewayError(409, 'group_name_exists', 'A group with this name already exists')
    }
    const now = Date.now()
    const row: GroupRow = {
      id: await deterministicUuid('admin.groups.create.v1', key),
      ...input,
      enabled: input.enabled ? 1 : 0,
      control_version: 0,
      created_at_ms: now,
      updated_at_ms: now,
    }
    const response = publicGroup(row)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO "groups" (
             id, name, description, platform, enabled, sort_order,
             rate_multiplier_ppm, rpm_limit, catalog_mode, group_type, is_exclusive,
             daily_quota_micros, weekly_quota_micros, monthly_quota_micros,
             allow_image_generation, allow_batch_image_generation, image_rate_independent,
             image_rate_multiplier_ppm, batch_image_discount_multiplier_ppm,
             batch_image_hold_multiplier_ppm, image_price_1k_micros,
             image_price_2k_micros, image_price_4k_micros,
             created_at_ms, updated_at_ms, ui_config_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          row.id,
          row.name,
          row.description,
          row.platform,
          row.enabled,
          row.sort_order,
          row.rate_multiplier_ppm,
          row.rpm_limit,
          row.catalog_mode,
          row.group_type,
          row.is_exclusive,
          row.daily_quota_micros,
          row.weekly_quota_micros,
          row.monthly_quota_micros,
          row.allow_image_generation,
          row.allow_batch_image_generation,
          row.image_rate_independent,
          row.image_rate_multiplier_ppm,
          row.batch_image_discount_multiplier_ppm,
          row.batch_image_hold_multiplier_ppm,
          row.image_price_1k_micros,
          row.image_price_2k_micros,
          row.image_price_4k_micros,
          now,
          now,
          row.ui_config_json,
        ),
        controlIdempotencyInsert(context.env, idem, 'group', row.id, response, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'group'))
      throw mapCatalogWriteError(error)
    }
    return controlSuccess(response, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminGroup(context: Context<ControlBindings>): Promise<Response> {
  try {
    return controlSuccess(publicGroup(await requireGroup(context.env, context.req.param('id'))))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updateAdminGroup(context: Context<ControlBindings>): Promise<Response> {
  try {
    const id = requireResourceId(context.req.param('id'), 'group')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const patch = parseGroupPatch(body)
    const idem = await controlIdempotency('admin.groups.update.v1', key, { id, expected, patch })
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) return controlSuccess(parseIdempotentResponse(previous, 'group'))
    const current = await requireGroup(context.env, id)
    assertControlVersion(current.control_version, expected)
    const next = { ...current, ...patch, ui_config_json: JSON.stringify({
      ...JSON.parse(current.ui_config_json ?? '{}'), ...JSON.parse(patch.ui_config_json ?? '{}'),
    }), enabled: patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0 }
    ensureSupportedPlatform(next.platform, next.enabled === 1)
    validateGroupCommerceFields(next)
    const response = publicGroup({
      ...next,
      control_version: current.control_version + 1,
      updated_at_ms: Date.now(),
    })
    if (next.name !== current.name && await findGroupByName(context.env, next.name)) {
      throw new GatewayError(409, 'group_name_exists', 'A group with this name already exists')
    }
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE "groups"
              SET name = ?, description = ?, platform = ?, enabled = ?, sort_order = ?,
                  rate_multiplier_ppm = ?, rpm_limit = ?, catalog_mode = ?, group_type = ?, is_exclusive = ?,
                  daily_quota_micros = ?, weekly_quota_micros = ?, monthly_quota_micros = ?,
                  allow_image_generation = ?, allow_batch_image_generation = ?, image_rate_independent = ?,
                  image_rate_multiplier_ppm = ?, batch_image_discount_multiplier_ppm = ?,
                  batch_image_hold_multiplier_ppm = ?, image_price_1k_micros = ?,
                  image_price_2k_micros = ?, image_price_4k_micros = ?,
                  ui_config_json = ?,
                  control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
                  updated_at_ms = ?
            WHERE id = ?`,
        ).bind(
          next.name,
          next.description,
          next.platform,
          next.enabled,
          next.sort_order,
          next.rate_multiplier_ppm,
          next.rpm_limit,
          next.catalog_mode,
          next.group_type,
          next.is_exclusive,
          next.daily_quota_micros,
          next.weekly_quota_micros,
          next.monthly_quota_micros,
          next.allow_image_generation,
          next.allow_batch_image_generation,
          next.image_rate_independent,
          next.image_rate_multiplier_ppm,
          next.batch_image_discount_multiplier_ppm,
          next.batch_image_hold_multiplier_ppm,
          next.image_price_1k_micros,
          next.image_price_2k_micros,
          next.image_price_4k_micros,
          next.ui_config_json,
          expected,
          expected + 1,
          response.updated_at_ms,
          id,
        ),
        controlIdempotencyInsert(context.env, idem, 'group', id, response, response.updated_at_ms),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'group'))
      throw mapCatalogWriteError(error)
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function deleteAdminGroup(context: Context<ControlBindings>): Promise<Response> {
  return softDisable(context, 'group')
}

export async function listAdminModels(context: Context<ControlBindings>): Promise<Response> {
  try {
    const page = queryInteger(context.req.query('page'), 'page', 1, 1, 1_000_000)
    const pageSize = queryInteger(context.req.query('page_size'), 'page_size', 20, 1, 100)
    const rows = await context.env.DB.prepare(
      `SELECT ${MODEL_COLUMNS} FROM models ORDER BY public_name ASC, id ASC LIMIT ? OFFSET ?`,
    ).bind(pageSize, (page - 1) * pageSize).all<ModelRow>()
    const count = await context.env.DB.prepare('SELECT COUNT(*) AS total FROM models').first<{ total: number }>()
    const total = validCount(count, 'model')
    return controlSuccess({
      items: rows.results.map(publicModel), total, page, page_size: pageSize,
      pages: total === 0 ? 0 : Math.ceil(total / pageSize),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function createAdminModel(context: Context<ControlBindings>): Promise<Response> {
  try {
    const key = requireIdempotencyKey(context.req.raw)
    const input = parseCreateModel(await readJsonObject(context.req.raw))
    const idem = await controlIdempotency('admin.models.create.v1', key, input)
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) return controlSuccess(parseIdempotentResponse(previous, 'model'))
    const now = Date.now()
    const row: ModelRow = {
      id: await deterministicUuid('admin.models.create.v1', key),
      ...input,
      embeddings: input.embeddings ? 1 : 0,
      image_generation: input.image_generation ? 1 : 0,
      enabled: input.enabled ? 1 : 0,
      control_version: 0,
      created_at_ms: now,
      updated_at_ms: now,
    }
    const response = publicModel(row)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO models (
             id, platform, public_name, upstream_name, endpoint, embeddings,
             image_generation, enabled,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          row.id, row.platform, row.public_name, row.upstream_name,
          row.endpoint, row.embeddings, row.image_generation, row.enabled, now, now,
        ),
        controlIdempotencyInsert(context.env, idem, 'model', row.id, response, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'model'))
      throw mapCatalogWriteError(error)
    }
    return controlSuccess(response, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminModel(context: Context<ControlBindings>): Promise<Response> {
  try {
    return controlSuccess(publicModel(await requireModel(context.env, context.req.param('id'))))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updateAdminModel(context: Context<ControlBindings>): Promise<Response> {
  try {
    const id = requireResourceId(context.req.param('id'), 'model')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const patch = parseModelPatch(body)
    const idem = await controlIdempotency('admin.models.update.v1', key, { id, expected, patch })
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) return controlSuccess(parseIdempotentResponse(previous, 'model'))
    const current = await requireModel(context.env, id)
    assertControlVersion(current.control_version, expected)
    const next = {
      ...current,
      ...patch,
      embeddings: patch.embeddings === undefined ? current.embeddings : patch.embeddings ? 1 : 0,
      image_generation: patch.image_generation === undefined
        ? current.image_generation
        : patch.image_generation ? 1 : 0,
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
    }
    ensureSupportedPlatform(next.platform, next.enabled === 1)
    const updatedAt = Date.now()
    const response = publicModel({ ...next, control_version: expected + 1, updated_at_ms: updatedAt })
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE models SET platform = ?, public_name = ?, upstream_name = ?, endpoint = ?,
             embeddings = ?, image_generation = ?, enabled = ?,
             control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END, updated_at_ms = ?
           WHERE id = ?`,
        ).bind(
          next.platform, next.public_name, next.upstream_name, next.endpoint,
          next.embeddings, next.image_generation, next.enabled,
          expected, expected + 1, updatedAt, id,
        ),
        controlIdempotencyInsert(context.env, idem, 'model', id, response, updatedAt),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'model'))
      throw mapCatalogWriteError(error)
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function deleteAdminModel(context: Context<ControlBindings>): Promise<Response> {
  return softDisable(context, 'model')
}

export async function listAdminGroupModels(context: Context<ControlBindings>): Promise<Response> {
  try {
    const groupId = requireResourceId(context.req.param('id') || context.req.param('group_id'), 'group')
    await requireGroup(context.env, groupId)
    const result = await context.env.DB.prepare(
      `${groupModelSelect()} WHERE gm.group_id = ? ORDER BY gm.sort_order ASC, m.public_name ASC`,
    ).bind(groupId).all<GroupModelRow>()
    return controlSuccess(result.results.map(publicGroupModel))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function putAdminGroupModel(context: Context<ControlBindings>): Promise<Response> {
  try {
    const groupId = requireResourceId(context.req.param('id') || context.req.param('group_id'), 'group')
    const modelId = requireResourceId(context.req.param('model_id'), 'model')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const idem = await controlIdempotency('admin.group-models.put.v1', key, {
      group_id: groupId, model_id: modelId, expected, body,
    })
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) return controlSuccess(parseIdempotentResponse(previous, 'group_model'))
    const group = await requireGroup(context.env, groupId)
    const model = await requireModel(context.env, modelId)
    if (group.platform !== model.platform) {
      throw new GatewayError(409, 'platform_mismatch', 'Group and model platforms must match')
    }
    const current = await findGroupModel(context.env, groupId, modelId)
    assertControlVersion(current?.control_version ?? 0, expected)
    const patch = parseGroupModel(body, current)
    const now = Date.now()
    const nextVersion = current === null ? 0 : expected + 1
    const response = {
      group_id: groupId,
      model_id: modelId,
      public_name: model.public_name,
      upstream_name: model.upstream_name,
      endpoint: model.endpoint,
      embeddings: model.embeddings === 1,
      image_generation: model.image_generation === 1,
      ...patch,
      control_version: nextVersion,
      created_at_ms: current?.created_at_ms ?? now,
      updated_at_ms: now,
    }
    const statement = current === null
      ? context.env.DB.prepare(
        `INSERT INTO group_models (
           group_id, model_id, upstream_name_override, enabled, catalog_visible,
           sort_order, max_output_tokens, default_max_output_tokens, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        groupId, modelId, patch.upstream_name_override, patch.enabled ? 1 : 0,
        patch.catalog_visible ? 1 : 0, patch.sort_order, patch.max_output_tokens,
        patch.default_max_output_tokens, now, now,
      )
      : context.env.DB.prepare(
        `UPDATE group_models SET upstream_name_override = ?, enabled = ?, catalog_visible = ?,
           sort_order = ?, max_output_tokens = ?, default_max_output_tokens = ?,
           control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
           updated_at_ms = ? WHERE group_id = ? AND model_id = ?`,
      ).bind(
        patch.upstream_name_override, patch.enabled ? 1 : 0, patch.catalog_visible ? 1 : 0,
        patch.sort_order, patch.max_output_tokens, patch.default_max_output_tokens,
        expected, expected + 1, now, groupId, modelId,
      )
    try {
      await context.env.DB.batch([
        statement,
        controlIdempotencyInsert(context.env, idem, 'group_model', `${groupId}:${modelId}`, response, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'group_model'))
      throw mapCatalogWriteError(error)
    }
    return controlSuccess(response, current === null ? 201 : 200)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function deleteAdminGroupModel(context: Context<ControlBindings>): Promise<Response> {
  try {
    const groupId = requireResourceId(context.req.param('id') || context.req.param('group_id'), 'group')
    const modelId = requireResourceId(context.req.param('model_id'), 'model')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readOptionalJson(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const idem = await controlIdempotency('admin.group-models.disable.v1', key, { groupId, modelId, expected })
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) return controlSuccess(parseIdempotentResponse(previous, 'group_model'))
    const current = await findGroupModel(context.env, groupId, modelId)
    if (current === null) throw new GatewayError(404, 'group_model_not_found', 'Group model was not found')
    assertControlVersion(current.control_version, expected)
    const now = Date.now()
    const response = publicGroupModel({
      ...current, enabled: 0, control_version: expected + 1, updated_at_ms: now,
    })
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE group_models SET enabled = 0,
             control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
             updated_at_ms = ? WHERE group_id = ? AND model_id = ?`,
        ).bind(expected, expected + 1, now, groupId, modelId),
        controlIdempotencyInsert(context.env, idem, 'group_model', `${groupId}:${modelId}`, response, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'group_model'))
      throw mapCatalogWriteError(error)
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminModelPrices(context: Context<ControlBindings>): Promise<Response> {
  try {
    const groupId = requireResourceId(context.req.param('id') || context.req.param('group_id'), 'group')
    const modelId = requireResourceId(context.req.param('model_id'), 'model')
    const rows = await context.env.DB.prepare(
      `SELECT id, group_id, model_id, version, active,
              input_micros_per_million, output_micros_per_million,
              cache_read_micros_per_million, per_request_micros,
              minimum_reservation_micros, effective_at_ms, retired_at_ms, created_at_ms
         FROM model_prices WHERE group_id = ? AND model_id = ?
        ORDER BY version DESC`,
    ).bind(groupId, modelId).all<PriceRow>()
    return controlSuccess(rows.results.map(publicPrice))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function publishAdminModelPrice(context: Context<ControlBindings>): Promise<Response> {
  try {
    const groupId = requireResourceId(context.req.param('id') || context.req.param('group_id'), 'group')
    const modelId = requireResourceId(context.req.param('model_id'), 'model')
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const input = parsePrice(body)
    const idem = await controlIdempotency('admin.model-prices.publish.v1', key, {
      group_id: groupId, model_id: modelId, expected, ...input,
    })
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) return controlSuccess(parseIdempotentResponse(previous, 'model_price'))
    const link = await findGroupModel(context.env, groupId, modelId)
    if (link === null) throw new GatewayError(404, 'group_model_not_found', 'Group model was not found')
    assertControlVersion(link.control_version, expected)
    const latest = await context.env.DB.prepare(
      'SELECT MAX(version) AS version FROM model_prices WHERE group_id = ? AND model_id = ?',
    ).bind(groupId, modelId).first<{ version: number | null }>()
    const version = (latest?.version ?? 0) + 1
    if (!Number.isSafeInteger(version)) throw new GatewayError(409, 'price_version_exhausted', 'Price version is exhausted')
    const now = Date.now()
    const row: PriceRow = {
      id: await deterministicUuid('admin.model-prices.publish.v1', key),
      group_id: groupId,
      model_id: modelId,
      version,
      active: 1,
      ...input,
      effective_at_ms: now,
      retired_at_ms: null,
      created_at_ms: now,
    }
    const response = publicPrice(row)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE model_prices SET active = 0, retired_at_ms = ?
            WHERE group_id = ? AND model_id = ? AND active = 1`,
        ).bind(now, groupId, modelId),
        context.env.DB.prepare(
          `INSERT INTO model_prices (
             id, group_id, model_id, version, active,
             input_micros_per_million, output_micros_per_million,
             cache_read_micros_per_million, per_request_micros,
             minimum_reservation_micros, effective_at_ms, created_at_ms
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          row.id, groupId, modelId, version, row.input_micros_per_million,
          row.output_micros_per_million, row.cache_read_micros_per_million,
          row.per_request_micros, row.minimum_reservation_micros, now, now,
        ),
        context.env.DB.prepare(
          `UPDATE group_models SET
             control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
             updated_at_ms = ? WHERE group_id = ? AND model_id = ?`,
        ).bind(expected, expected + 1, now, groupId, modelId),
        controlIdempotencyInsert(context.env, idem, 'model_price', row.id, response, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, 'model_price'))
      throw mapCatalogWriteError(error)
    }
    return controlSuccess(response, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminModelCandidates(context: Context<ControlBindings>): Promise<Response> {
  try {
    const groupId = context.req.param('id')
    const platform = context.req.query('platform') ?? (groupId === '0'
      ? 'openai'
      : (await requireGroup(context.env, groupId)).platform)
    const rows = await context.env.DB.prepare(
      `SELECT public_name FROM models WHERE platform = ? AND enabled = 1 ORDER BY public_name ASC`,
    ).bind(platform).all<{ public_name: string }>()
    return controlSuccess({ models: rows.results.map((row) => row.public_name) })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function softDisable(context: Context<ControlBindings>, type: 'group' | 'model'): Promise<Response> {
  try {
    const id = requireResourceId(context.req.param('id'), type)
    const key = requireIdempotencyKey(context.req.raw)
    const body = await readOptionalJson(context.req.raw)
    const expected = requireExpectedControlVersion(context.req.raw, body)
    const scope = `admin.${type}s.disable.v1`
    const idem = await controlIdempotency(scope, key, { id, expected })
    const previous = await findControlIdempotency(context.env, idem)
    if (previous !== null) return controlSuccess(parseIdempotentResponse(previous, type))
    const current = type === 'group'
      ? await requireGroup(context.env, id)
      : await requireModel(context.env, id)
    assertControlVersion(current.control_version, expected)
    const now = Date.now()
    const next = { ...current, enabled: 0, control_version: expected + 1, updated_at_ms: now }
    const response = type === 'group'
      ? publicGroup(next as GroupRow)
      : publicModel(next as ModelRow)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE ${type === 'group' ? '"groups"' : 'models'} SET enabled = 0,
             control_version = CASE WHEN control_version = ? THEN ? ELSE -1 END,
             updated_at_ms = ? WHERE id = ?`,
        ).bind(expected, expected + 1, now, id),
        controlIdempotencyInsert(context.env, idem, type, id, response, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idem)
      if (recovered !== null) return controlSuccess(parseIdempotentResponse(recovered, type))
      throw mapCatalogWriteError(error)
    }
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

// UI configuration is preserved, but does not claim an implemented runtime policy.
const GROUP_UI_FIELDS = new Set(["long_context_pricing_enabled", "force_openai_fast", "free_openai_fast", "model_pricing", "video_rate_independent", "video_rate_multiplier", "video_price_480p", "video_price_720p", "video_price_1080p", "video_model_prices", "web_search_price_per_call", "search_price_per_1k", "audio_realtime_price_per_min", "audio_tts_price_per_million_chars", "audio_stt_price_per_hour", "peak_rate_enabled", "peak_start", "peak_end", "peak_rate_multiplier", "profit_control_enabled", "profit_min_margin", "profit_safety_buffer", "claude_code_only", "fallback_group_id", "fallback_group_id_on_invalid_request", "mcp_xml_inject", "supported_model_scopes", "models_list_config", "allow_messages_dispatch", "allow_live", "default_mapped_model", "messages_dispatch_model_config", "model_routing", "model_routing_enabled", "max_reasoning_effort", "max_reasoning_effort_over_limit", "reasoning_effort_mappings", "require_oauth_only", "require_privacy_set"])
const GROUP_CORE_FIELDS = new Set(["expected_control_version", "name", "description", "platform", "is_exclusive", "rpm_limit", "allow_image_generation", "allow_batch_image_generation", "image_rate_independent", "control_version", "enabled", "status", "sort_order", "catalog_mode", "group_type", "rate_multiplier_ppm", "daily_quota_micros", "weekly_quota_micros", "monthly_quota_micros", "image_rate_multiplier_ppm", "batch_image_discount_multiplier_ppm", "batch_image_hold_multiplier_ppm", "image_price_1k_micros", "image_price_2k_micros", "image_price_4k_micros"])
function parseGroupUiConfig(body: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(body)) {
    if (field === 'copy_accounts_from_group_ids') {
      if (!Array.isArray(value) || value.length > 0) {
        throw new GatewayError(409, 'group_account_copy_not_supported', 'Copying group accounts is not implemented')
      }
    } else if (GROUP_UI_FIELDS.has(field)) config[field] = value
    else if (!GROUP_CORE_FIELDS.has(field)) {
      throw new GatewayError(400, 'unsupported_group_field', `Field '${field}' is not supported`)
    }
  }
  if (JSON.stringify(config).length > 65536) {
    throw new GatewayError(400, 'group_config_too_large', 'Group configuration must not exceed 65536 characters')
  }
  return config
}

function parseCreateGroup(body: Record<string, unknown>) {
  const uiConfig = parseGroupUiConfig(body)
  const platform = optionalString(body, 'platform', 32) ?? 'openai'
  const enabled = parseEnabled(body, true) ?? true
  ensureSupportedPlatform(platform, enabled)
  const catalogMode = optionalString(body, 'catalog_mode', 32) ?? 'all_routable'
  if (catalogMode !== 'all_routable' && catalogMode !== 'allowlist') {
    throw new GatewayError(400, 'invalid_catalog_mode', 'catalog_mode is invalid')
  }
  const groupType = parseGroupType(body) ?? 'standard'
  const result = {
    ui_config_json: JSON.stringify(uiConfig),
    name: requireString(body, 'name', 128),
    description: optionalNullableString(body, 'description', 1_024) ?? null,
    platform,
    enabled,
    sort_order: optionalSafeInteger(body, 'sort_order', 0, 1_000_000) ?? 0,
    rate_multiplier_ppm: optionalSafeInteger(body, 'rate_multiplier_ppm', 0) ?? 1_000_000,
    rpm_limit: optionalSafeInteger(body, 'rpm_limit', 0) ?? 0,
    catalog_mode: catalogMode as GroupRow['catalog_mode'],
    group_type: groupType,
    is_exclusive: optionalBoolean(body, 'is_exclusive') === false ? 0 : 1,
    daily_quota_micros: optionalNullableMicros(body, 'daily_quota_micros') ?? null,
    weekly_quota_micros: optionalNullableMicros(body, 'weekly_quota_micros') ?? null,
    monthly_quota_micros: optionalNullableMicros(body, 'monthly_quota_micros') ?? null,
    allow_image_generation: optionalBoolean(body, 'allow_image_generation') ? 1 : 0,
    allow_batch_image_generation: optionalBoolean(body, 'allow_batch_image_generation') ? 1 : 0,
    image_rate_independent: optionalBoolean(body, 'image_rate_independent') ? 1 : 0,
    image_rate_multiplier_ppm: optionalSafeInteger(body, 'image_rate_multiplier_ppm', 0, 10_000_000) ?? 1_000_000,
    batch_image_discount_multiplier_ppm: optionalSafeInteger(body, 'batch_image_discount_multiplier_ppm', 0, 10_000_000) ?? 500_000,
    batch_image_hold_multiplier_ppm: optionalSafeInteger(body, 'batch_image_hold_multiplier_ppm', 0, 10_000_000) ?? 600_000,
    image_price_1k_micros: optionalNullableImagePrice(body, 'image_price_1k_micros') ?? null,
    image_price_2k_micros: optionalNullableImagePrice(body, 'image_price_2k_micros') ?? null,
    image_price_4k_micros: optionalNullableImagePrice(body, 'image_price_4k_micros') ?? null,
  }
  validateGroupCommerceFields(result)
  return result
}

function parseGroupPatch(body: Record<string, unknown>) {
  const result: Partial<{
    ui_config_json: string;
    name: string; description: string | null; platform: string; enabled: boolean;
    sort_order: number; rate_multiplier_ppm: number; rpm_limit: number;
    catalog_mode: GroupRow['catalog_mode'];
    group_type: GroupRow['group_type']; is_exclusive: number;
    daily_quota_micros: number | null; weekly_quota_micros: number | null;
    monthly_quota_micros: number | null;
    allow_image_generation: number; allow_batch_image_generation: number;
    image_rate_independent: number; image_rate_multiplier_ppm: number;
    batch_image_discount_multiplier_ppm: number; batch_image_hold_multiplier_ppm: number;
    image_price_1k_micros: number | null; image_price_2k_micros: number | null;
    image_price_4k_micros: number | null
  }> = {}
  const uiConfig = parseGroupUiConfig(body)
  if (Object.keys(uiConfig).length) result.ui_config_json = JSON.stringify(uiConfig)
  const name = optionalString(body, 'name', 128)
  if (name !== undefined) result.name = name
  const description = optionalNullableString(body, 'description', 1_024)
  if (description !== undefined) result.description = description
  const platform = optionalString(body, 'platform', 32)
  if (platform !== undefined) result.platform = platform
  const enabled = parseEnabled(body)
  if (enabled !== undefined) result.enabled = enabled
  const sortOrder = optionalSafeInteger(body, 'sort_order', 0, 1_000_000)
  if (sortOrder !== undefined) result.sort_order = sortOrder
  const multiplier = optionalSafeInteger(body, 'rate_multiplier_ppm', 0)
  if (multiplier !== undefined) result.rate_multiplier_ppm = multiplier
  const rpmLimit = optionalSafeInteger(body, 'rpm_limit', 0)
  if (rpmLimit !== undefined) result.rpm_limit = rpmLimit
  const catalogMode = optionalString(body, 'catalog_mode', 32)
  if (catalogMode !== undefined) {
    if (catalogMode !== 'all_routable' && catalogMode !== 'allowlist') {
      throw new GatewayError(400, 'invalid_catalog_mode', 'catalog_mode is invalid')
    }
    result.catalog_mode = catalogMode
  }
  const groupType = parseGroupType(body)
  if (groupType !== undefined) result.group_type = groupType
  const exclusive = optionalBoolean(body, 'is_exclusive')
  if (exclusive !== undefined) result.is_exclusive = exclusive ? 1 : 0
  for (const field of [
    'allow_image_generation',
    'allow_batch_image_generation',
    'image_rate_independent',
  ] as const) {
    const value = optionalBoolean(body, field)
    if (value !== undefined) result[field] = value ? 1 : 0
  }
  for (const field of [
    'image_rate_multiplier_ppm',
    'batch_image_discount_multiplier_ppm',
    'batch_image_hold_multiplier_ppm',
  ] as const) {
    const value = optionalSafeInteger(body, field, 0, 10_000_000)
    if (value !== undefined) result[field] = value
  }
  for (const field of [
    'image_price_1k_micros',
    'image_price_2k_micros',
    'image_price_4k_micros',
  ] as const) {
    const value = optionalNullableImagePrice(body, field)
    if (value !== undefined) result[field] = value
  }
  for (const field of [
    'daily_quota_micros',
    'weekly_quota_micros',
    'monthly_quota_micros',
  ] as const) {
    const value = optionalNullableMicros(body, field)
    if (value !== undefined) result[field] = value
  }
  if (Object.keys(result).length === 0) throw new GatewayError(400, 'empty_update', 'At least one field is required')
  return result
}

function parseGroupType(body: Record<string, unknown>): GroupRow['group_type'] | undefined {
  const value = optionalString(body, 'group_type', 32)
  if (value === undefined) return undefined
  if (value !== 'standard' && value !== 'subscription') {
    throw new GatewayError(400, 'invalid_group_type', 'group_type must be standard or subscription')
  }
  return value
}

function optionalNullableMicros(
  body: Record<string, unknown>,
  field: 'daily_quota_micros' | 'weekly_quota_micros' | 'monthly_quota_micros',
): number | null | undefined {
  if (body[field] === undefined) return undefined
  if (body[field] === null) return null
  return requireSafeInteger(body, field)
}

function optionalNullableImagePrice(
  body: Record<string, unknown>,
  field: 'image_price_1k_micros' | 'image_price_2k_micros' | 'image_price_4k_micros',
): number | null | undefined {
  if (body[field] === undefined) return undefined
  if (body[field] === null) return null
  return requireSafeInteger(body, field)
}

function validateGroupCommerceFields(
  group: Pick<GroupRow,
    'platform' | 'group_type' | 'daily_quota_micros' | 'weekly_quota_micros' |
    'monthly_quota_micros' | 'allow_image_generation' | 'allow_batch_image_generation' |
    'batch_image_discount_multiplier_ppm' | 'batch_image_hold_multiplier_ppm'>,
): void {
  if (
    group.group_type === 'standard' &&
    [group.daily_quota_micros, group.weekly_quota_micros, group.monthly_quota_micros]
      .some((value) => value !== null)
  ) {
    throw new GatewayError(
      400,
      'standard_group_subscription_quota',
      'Subscription quota fields require group_type subscription',
    )
  }
  if (group.allow_batch_image_generation === 1 && group.allow_image_generation !== 1) {
    throw new GatewayError(
      400,
      'batch_image_requires_image_generation',
      'Batch image generation requires image generation to be enabled',
    )
  }
  if (group.allow_batch_image_generation === 1 && group.platform !== 'gemini') {
    throw new GatewayError(
      400,
      'batch_image_platform_not_supported',
      'Batch image generation is currently supported only for Gemini groups',
    )
  }
  if (group.batch_image_hold_multiplier_ppm < group.batch_image_discount_multiplier_ppm) {
    throw new GatewayError(
      400,
      'invalid_batch_image_hold_multiplier',
      'Batch image hold multiplier must cover the discount multiplier',
    )
  }
}

function parseCreateModel(body: Record<string, unknown>) {
  const platform = optionalString(body, 'platform', 32) ?? 'openai'
  const enabled = parseEnabled(body, true) ?? true
  ensureSupportedPlatform(platform, enabled)
  const endpoint = optionalString(body, 'endpoint', 32) ?? 'both'
  if (!['chat_completions', 'responses', 'both'].includes(endpoint)) {
    throw new GatewayError(400, 'invalid_endpoint', 'endpoint is invalid')
  }
  const publicName = requireString(body, 'public_name', 256)
  const embeddings = optionalBoolean(body, 'embeddings')
  const imageGeneration = optionalBoolean(body, 'image_generation')
  return {
    platform,
    public_name: publicName,
    upstream_name: optionalString(body, 'upstream_name', 256) ?? publicName,
    endpoint: endpoint as ModelRow['endpoint'],
    ...(embeddings === undefined ? {} : { embeddings }),
    ...(imageGeneration === undefined ? {} : { image_generation: imageGeneration }),
    enabled,
  }
}

function parseModelPatch(body: Record<string, unknown>) {
  const result: Partial<{
    platform: string; public_name: string; upstream_name: string;
    endpoint: ModelRow['endpoint']; embeddings: boolean; image_generation: boolean; enabled: boolean
  }> = {}
  const platform = optionalString(body, 'platform', 32)
  if (platform !== undefined) result.platform = platform
  const publicName = optionalString(body, 'public_name', 256)
  if (publicName !== undefined) result.public_name = publicName
  const upstreamName = optionalString(body, 'upstream_name', 256)
  if (upstreamName !== undefined) result.upstream_name = upstreamName
  const endpoint = optionalString(body, 'endpoint', 32)
  if (endpoint !== undefined) {
    if (!['chat_completions', 'responses', 'both'].includes(endpoint)) {
      throw new GatewayError(400, 'invalid_endpoint', 'endpoint is invalid')
    }
    result.endpoint = endpoint as ModelRow['endpoint']
  }
  const embeddings = optionalBoolean(body, 'embeddings')
  if (embeddings !== undefined) result.embeddings = embeddings
  const imageGeneration = optionalBoolean(body, 'image_generation')
  if (imageGeneration !== undefined) result.image_generation = imageGeneration
  const enabled = parseEnabled(body)
  if (enabled !== undefined) result.enabled = enabled
  if (Object.keys(result).length === 0) throw new GatewayError(400, 'empty_update', 'At least one field is required')
  return result
}

function parseGroupModel(body: Record<string, unknown>, current: GroupModelRow | null) {
  const max = optionalSafeInteger(body, 'max_output_tokens', 1, 1_000_000)
    ?? current?.max_output_tokens ?? 16_384
  const defaultMax = optionalSafeInteger(body, 'default_max_output_tokens', 1, max)
    ?? current?.default_max_output_tokens ?? Math.min(4_096, max)
  if (defaultMax > max) throw new GatewayError(400, 'invalid_output_tokens', 'default_max_output_tokens must not exceed max_output_tokens')
  return {
    upstream_name_override: optionalNullableString(body, 'upstream_name_override', 256)
      ?? current?.upstream_name_override ?? null,
    enabled: optionalBoolean(body, 'enabled') ?? (current?.enabled === 1 || current === null),
    catalog_visible: optionalBoolean(body, 'catalog_visible') ?? (current?.catalog_visible === 1 || current === null),
    sort_order: optionalSafeInteger(body, 'sort_order', 0, 1_000_000) ?? current?.sort_order ?? 0,
    max_output_tokens: max,
    default_max_output_tokens: defaultMax,
  }
}

function parsePrice(body: Record<string, unknown>) {
  return {
    input_micros_per_million: requireSafeInteger(body, 'input_micros_per_million'),
    output_micros_per_million: requireSafeInteger(body, 'output_micros_per_million'),
    cache_read_micros_per_million: optionalSafeInteger(body, 'cache_read_micros_per_million') ?? 0,
    per_request_micros: optionalSafeInteger(body, 'per_request_micros') ?? 0,
    minimum_reservation_micros: optionalSafeInteger(body, 'minimum_reservation_micros', 1) ?? 1,
  }
}

function parseEnabled(body: Record<string, unknown>, fallback?: boolean): boolean | undefined {
  const direct = optionalBoolean(body, 'enabled')
  if (direct !== undefined) return direct
  const status = optionalString(body, 'status', 16)
  if (status === undefined) return fallback
  if (status !== 'active' && status !== 'inactive') {
    throw new GatewayError(400, 'invalid_status', 'status must be active or inactive')
  }
  return status === 'active'
}

async function requireGroup(env: Env, idValue: string | undefined): Promise<GroupRow> {
  const id = requireResourceId(idValue, 'group')
  const row = await env.DB.prepare(
    `SELECT ${GROUP_COLUMNS} FROM "groups" WHERE id = ?`,
  ).bind(id).first<GroupRow>()
  if (row === null) throw new GatewayError(404, 'group_not_found', 'Group was not found')
  return row
}

async function findGroupByName(env: Env, name: string): Promise<GroupRow | null> {
  return env.DB.prepare(
    `SELECT ${GROUP_COLUMNS} FROM "groups" WHERE name = ?`,
  ).bind(name).first<GroupRow>()
}

async function requireModel(env: Env, idValue: string | undefined): Promise<ModelRow> {
  const id = requireResourceId(idValue, 'model')
  const row = await env.DB.prepare(
    `SELECT ${MODEL_COLUMNS} FROM models WHERE id = ?`,
  ).bind(id).first<ModelRow>()
  if (row === null) throw new GatewayError(404, 'model_not_found', 'Model was not found')
  return row
}

async function findGroupModel(env: Env, groupId: string, modelId: string): Promise<GroupModelRow | null> {
  return env.DB.prepare(
    `${groupModelSelect()} WHERE gm.group_id = ? AND gm.model_id = ?`,
  ).bind(groupId, modelId).first<GroupModelRow>()
}

function groupModelSelect(): string {
  return `SELECT gm.group_id, gm.model_id, m.public_name, m.upstream_name, m.endpoint,
    m.embeddings, m.image_generation,
    gm.upstream_name_override, gm.enabled, gm.catalog_visible, gm.sort_order,
    gm.max_output_tokens, gm.default_max_output_tokens, gm.control_version,
    gm.created_at_ms, gm.updated_at_ms,
    p.id AS price_id, p.version AS price_version,
    p.input_micros_per_million, p.output_micros_per_million,
    p.cache_read_micros_per_million, p.per_request_micros,
    p.minimum_reservation_micros
    FROM group_models gm JOIN models m ON m.id = gm.model_id
    LEFT JOIN model_prices p ON p.group_id = gm.group_id AND p.model_id = gm.model_id AND p.active = 1`
}

function publicGroup(row: GroupRow) {
  const { ui_config_json, ...normalized } = row
  const uiConfig = JSON.parse(ui_config_json ?? '{}') as Record<string, unknown>
  return {
    ...uiConfig,
    ...normalized,
    compatibility: { stored_only_fields: Object.keys(uiConfig) },
    enabled: row.enabled === 1,
    is_exclusive: row.is_exclusive === 1,
    allow_image_generation: row.allow_image_generation === 1,
    allow_batch_image_generation: row.allow_batch_image_generation === 1,
    image_rate_independent: row.image_rate_independent === 1,
    status: row.enabled === 1 ? 'active' as const : 'inactive' as const,
  }
}

function publicModel(row: ModelRow) {
  return {
    ...row,
    embeddings: row.embeddings === 1,
    image_generation: row.image_generation === 1,
    enabled: row.enabled === 1,
    status: row.enabled === 1 ? 'active' as const : 'inactive' as const,
  }
}

function publicGroupModel(row: GroupModelRow) {
  return {
    ...row,
    embeddings: row.embeddings === 1,
    image_generation: row.image_generation === 1,
    enabled: row.enabled === 1,
    catalog_visible: row.catalog_visible === 1,
    price: row.price_id === null ? null : {
      id: row.price_id,
      version: row.price_version,
      input_micros_per_million: row.input_micros_per_million,
      output_micros_per_million: row.output_micros_per_million,
      cache_read_micros_per_million: row.cache_read_micros_per_million,
      per_request_micros: row.per_request_micros,
      minimum_reservation_micros: row.minimum_reservation_micros,
    },
  }
}

function publicPrice(row: PriceRow) {
  return { ...row, active: row.active === 1 }
}

function ensureSupportedPlatform(platform: string, enabled: boolean): void {
  if (enabled && !['openai', 'anthropic', 'gemini', 'codex'].includes(platform)) {
    throw new GatewayError(
      409,
      'platform_not_supported',
      'Only OpenAI, Anthropic, Gemini, and Codex groups and models can be enabled',
    )
  }
}

function assertControlVersion(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new GatewayError(412, 'control_version_conflict', 'Resource changed; reload it and retry')
  }
  if (expected >= Number.MAX_SAFE_INTEGER) {
    throw new GatewayError(409, 'control_version_exhausted', 'Resource control version is exhausted')
  }
}

function validCount(value: unknown, resource: string): number {
  const count = (value as { total?: unknown } | null)?.total
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new GatewayError(500, `invalid_${resource}_count`, `${resource} count is invalid`, 'server_error')
  }
  return count as number
}

function mapCatalogWriteError(error: unknown): unknown {
  if (error instanceof GatewayError) return error
  const message = error instanceof Error ? error.message : ''
  if (message.includes('UNIQUE constraint')) {
    return new GatewayError(409, 'catalog_conflict', 'Catalog resource already exists')
  }
  if (message.includes('control_version')) {
    return new GatewayError(412, 'control_version_conflict', 'Catalog changed; reload it and retry')
  }
  if (
    message.includes('invalid_group_') ||
    message.includes('invalid_model_') ||
    message.includes('immutable_model_price')
  ) {
    return new GatewayError(409, 'catalog_conflict', 'Catalog relation or price changed; reload it and retry')
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

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}
