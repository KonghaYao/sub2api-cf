import type { Context } from 'hono'
import { authenticateUserRequest } from '../auth/handler'
import { controlError, controlSuccess } from '../control/http'
import { publicSettingsKey } from '../control/settings'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { groupAccessPredicate } from './group-access'

type UserBindings = { Bindings: Env }
const MAX_CATALOG_ROWS = 5_000

interface AvailableChannelsSettings { available_channels_enabled?: boolean }

interface ChannelGroupRow {
  channel_id: string
  channel_name: string
  channel_description: string
  group_id: string
  group_name: string
  group_platform: string
  group_type: 'standard' | 'subscription'
  group_rate_multiplier_ppm: number
  group_is_exclusive: number
}

interface PriceModelRow {
  channel_id: string
  pricing_id: string
  platform: string
  billing_mode: 'token' | 'per_request' | 'image' | 'video'
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_write_micros_per_million: number | null
  cache_write_1h_micros_per_million: number | null
  cache_read_micros_per_million: number | null
  image_input_micros_per_million: number | null
  image_output_micros_per_million: number | null
  per_request_micros: number | null
  model_pattern: string | null
  is_wildcard: number | null
  model_sort_order: number | null
}

interface PricingIntervalRow {
  pricing_id: string
  min_tokens: number
  max_tokens: number | null
  tier_label: string
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_write_micros_per_million: number | null
  cache_write_1h_micros_per_million: number | null
  cache_read_micros_per_million: number | null
  per_request_micros: number | null
}

interface ModelMappingRow {
  channel_id: string
  platform: string
  source_pattern: string
  target_pattern: string
  source_is_wildcard: number
  target_is_wildcard: number
}

interface PublicGroup {
  id: string
  name: string
  platform: string
  subscription_type: string
  rate_multiplier: number
  peak_rate_enabled: false
  peak_start: ''
  peak_end: ''
  peak_rate_multiplier: 1
  is_exclusive: boolean
}

interface PublicPricingInterval {
  min_tokens: number
  max_tokens: number | null
  tier_label?: string
  input_price: number | null
  output_price: number | null
  cache_write_price: number | null
  cache_write_1h_price: number | null
  cache_read_price: number | null
  per_request_price: number | null
}

interface PublicPricing {
  billing_mode: PriceModelRow['billing_mode']
  input_price: number | null
  output_price: number | null
  cache_write_price: number | null
  cache_write_1h_price: number | null
  cache_read_price: number | null
  image_input_price: number | null
  image_output_price: number | null
  per_request_price: number | null
  intervals: PublicPricingInterval[]
}

interface PricingEntry {
  id: string
  platform: string
  pricing: PublicPricing
  concrete: string[]
  wildcards: string[]
}

interface PublicModel { name: string; platform: string; pricing: PublicPricing | null }

interface ChannelProjection {
  name: string
  description: string
  ordinaryGroups: Map<string, PublicGroup[]>
  compositeGroups: PublicGroup[]
  pricings: Map<string, PricingEntry>
  mappings: ModelMappingRow[]
}

export async function listAvailableUserChannels(
  context: Context<UserBindings>,
): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    if (!await availableChannelsEnabled(context.env)) return controlSuccess([])
    return controlSuccess(await readAvailableChannels(context.env, user.id, Date.now()))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function availableChannelsEnabled(env: Env): Promise<boolean> {
  try {
    const settings = await env.CONFIG_KV.get<AvailableChannelsSettings>(
      publicSettingsKey(env.ENVIRONMENT),
      'json',
    )
    return settings?.available_channels_enabled === true
  } catch {
    return false
  }
}

async function readAvailableChannels(env: Env, userId: string, now: number): Promise<Record<string, unknown>[]> {
  const visibleChannels = `WITH visible_channels AS (
    SELECT DISTINCT channel.id
      FROM channels channel
      JOIN channel_groups link ON link.channel_id = channel.id
      JOIN "groups" g ON g.id = link.group_id
     WHERE channel.status = 'active' AND g.enabled = 1
       AND ${groupAccessPredicate('g')}
  )`
  const bindings = [userId, userId, userId, now, now]
  const results = await env.DB.batch([
    env.DB.prepare(
      `${visibleChannels}
       SELECT channel.id AS channel_id, channel.name AS channel_name,
              channel.description AS channel_description,
              g.id AS group_id, g.name AS group_name, g.platform AS group_platform,
              g.group_type, g.rate_multiplier_ppm AS group_rate_multiplier_ppm,
              g.is_exclusive AS group_is_exclusive
         FROM visible_channels visible
         JOIN channels channel ON channel.id = visible.id
         JOIN channel_groups link ON link.channel_id = channel.id
         JOIN "groups" g ON g.id = link.group_id
        WHERE g.enabled = 1 AND ${groupAccessPredicate('g')}
          AND length(trim(g.platform)) > 0
        ORDER BY channel.name COLLATE NOCASE, channel.id,
                 g.name COLLATE NOCASE, g.id
        LIMIT ${MAX_CATALOG_ROWS + 1}`,
    ).bind(...bindings, ...bindings),
    env.DB.prepare(
      `${visibleChannels}
       SELECT pricing.channel_id, pricing.id AS pricing_id, pricing.platform,
              pricing.billing_mode, pricing.input_micros_per_million,
              pricing.output_micros_per_million, pricing.cache_write_micros_per_million,
              pricing.cache_write_1h_micros_per_million, pricing.cache_read_micros_per_million,
              pricing.image_input_micros_per_million, pricing.image_output_micros_per_million,
              pricing.per_request_micros, model.model_pattern, model.is_wildcard,
              model.sort_order AS model_sort_order
         FROM visible_channels visible
         JOIN channel_model_pricing pricing ON pricing.channel_id = visible.id
         LEFT JOIN channel_pricing_models model ON model.pricing_id = pricing.id
        ORDER BY pricing.channel_id, pricing.platform, pricing.created_at_ms, pricing.id,
                 model.sort_order, model.model_pattern COLLATE NOCASE
        LIMIT ${MAX_CATALOG_ROWS + 1}`,
    ).bind(...bindings),
    env.DB.prepare(
      `${visibleChannels}
       SELECT interval.pricing_id, interval.min_tokens, interval.max_tokens,
              interval.tier_label, interval.input_micros_per_million,
              interval.output_micros_per_million, interval.cache_write_micros_per_million,
              interval.cache_write_1h_micros_per_million,
              interval.cache_read_micros_per_million, interval.per_request_micros
         FROM visible_channels visible
         JOIN channel_model_pricing pricing ON pricing.channel_id = visible.id
         JOIN channel_pricing_intervals interval ON interval.pricing_id = pricing.id
        ORDER BY interval.pricing_id, interval.sort_order, interval.id
        LIMIT ${MAX_CATALOG_ROWS + 1}`,
    ).bind(...bindings),
    env.DB.prepare(
      `${visibleChannels}
       SELECT mapping.channel_id, mapping.platform, mapping.source_pattern,
              mapping.target_pattern, mapping.source_is_wildcard, mapping.target_is_wildcard
         FROM visible_channels visible
         JOIN channel_model_mappings mapping ON mapping.channel_id = visible.id
        ORDER BY mapping.channel_id, mapping.platform, mapping.sort_order,
                 mapping.source_pattern COLLATE NOCASE
        LIMIT ${MAX_CATALOG_ROWS + 1}`,
    ).bind(...bindings),
  ])
  for (const result of results) {
    if (result.results.length > MAX_CATALOG_ROWS) {
      throw new GatewayError(503, 'available_channels_too_large', 'Available channel catalog is too large', 'server_error')
    }
  }
  return projectChannels(
    results[0].results as unknown as ChannelGroupRow[],
    results[1].results as unknown as PriceModelRow[],
    results[2].results as unknown as PricingIntervalRow[],
    results[3].results as unknown as ModelMappingRow[],
  )
}

function projectChannels(
  groupRows: ChannelGroupRow[],
  priceRows: PriceModelRow[],
  intervalRows: PricingIntervalRow[],
  mappingRows: ModelMappingRow[],
): Record<string, unknown>[] {
  const channels = new Map<string, ChannelProjection>()
  for (const row of groupRows) {
    let channel = channels.get(row.channel_id)
    if (channel === undefined) {
      channel = {
        name: row.channel_name,
        description: row.channel_description,
        ordinaryGroups: new Map(),
        compositeGroups: [],
        pricings: new Map(),
        mappings: [],
      }
      channels.set(row.channel_id, channel)
    }
    const group = publicGroup(row)
    if (row.group_platform === 'composite') channel.compositeGroups.push(group)
    else {
      const groups = channel.ordinaryGroups.get(row.group_platform) ?? []
      groups.push(group)
      channel.ordinaryGroups.set(row.group_platform, groups)
    }
  }

  const intervalsByPricing = new Map<string, PublicPricingInterval[]>()
  for (const row of intervalRows) {
    const intervals = intervalsByPricing.get(row.pricing_id) ?? []
    intervals.push(publicInterval(row))
    intervalsByPricing.set(row.pricing_id, intervals)
  }
  for (const row of priceRows) {
    const channel = channels.get(row.channel_id)
    if (channel === undefined) continue
    let entry = channel.pricings.get(row.pricing_id)
    if (entry === undefined) {
      entry = {
        id: row.pricing_id,
        platform: row.platform,
        pricing: publicPricing(row, intervalsByPricing.get(row.pricing_id) ?? []),
        concrete: [],
        wildcards: [],
      }
      channel.pricings.set(row.pricing_id, entry)
    }
    if (row.model_pattern === null) continue
    if (row.is_wildcard === 1) entry.wildcards.push(row.model_pattern.slice(0, -1))
    else entry.concrete.push(row.model_pattern)
  }
  for (const row of mappingRows) channels.get(row.channel_id)?.mappings.push(row)

  const output: Record<string, unknown>[] = []
  for (const channel of channels.values()) {
    const models = supportedModels(channel)
    const groupsByPlatform = new Map(channel.ordinaryGroups)
    if (channel.compositeGroups.length > 0) {
      const modelPlatforms = new Set(models.map((model) => model.platform).filter(Boolean))
      if (modelPlatforms.size === 0) modelPlatforms.add('composite')
      for (const platform of modelPlatforms) {
        groupsByPlatform.set(platform, [
          ...(groupsByPlatform.get(platform) ?? []),
          ...channel.compositeGroups,
        ])
      }
    }
    const platforms = [...groupsByPlatform.keys()].sort()
    if (platforms.length === 0) continue
    output.push({
      name: channel.name,
      description: channel.description,
      platforms: platforms.map((platform) => ({
        platform,
        groups: groupsByPlatform.get(platform) ?? [],
        supported_models: models.filter((model) => model.platform === platform),
      })),
    })
  }
  return output
}

function supportedModels(channel: ChannelProjection): PublicModel[] {
  const exactPricing = new Map<string, { name: string; entry: PricingEntry }>()
  const concrete: Array<{ name: string; entry: PricingEntry }> = []
  for (const entry of channel.pricings.values()) {
    for (const name of entry.concrete) {
      const key = modelKey(entry.platform, name)
      if (!exactPricing.has(key)) {
        exactPricing.set(key, { name, entry })
        concrete.push({ name, entry })
      }
    }
  }
  const models = new Map<string, PublicModel>()
  const add = (name: string, platform: string, pricing: PublicPricing | null) => {
    const key = modelKey(platform, name)
    if (!models.has(key)) models.set(key, { name, platform, pricing })
  }
  for (const mapping of channel.mappings) {
    if (mapping.source_is_wildcard === 1) {
      const sourcePrefix = mapping.source_pattern.slice(0, -1)
      const targetPrefix = mapping.target_is_wildcard === 1
        ? mapping.target_pattern.slice(0, -1)
        : sourcePrefix
      for (const candidate of concrete) {
        if (
          candidate.entry.platform === mapping.platform &&
          candidate.name.toLowerCase().startsWith(targetPrefix.toLowerCase())
        ) {
          const suffix = candidate.name.slice(targetPrefix.length)
          add(`${sourcePrefix}${suffix}`, mapping.platform, candidate.entry.pricing)
        }
      }
      continue
    }
    const target = mapping.target_pattern !== '' && mapping.target_is_wildcard !== 1
      ? mapping.target_pattern
      : mapping.source_pattern
    const sourcePrice = exactPricing.get(modelKey(mapping.platform, mapping.source_pattern))
    const targetPrice = exactPricing.get(modelKey(mapping.platform, target))
    add(sourcePrice?.name ?? mapping.source_pattern, mapping.platform, targetPrice?.entry.pricing ?? null)
  }
  for (const candidate of concrete) add(candidate.name, candidate.entry.platform, candidate.entry.pricing)
  return [...models.values()].sort((left, right) =>
    left.platform.localeCompare(right.platform) || left.name.localeCompare(right.name))
}

function publicGroup(row: ChannelGroupRow): PublicGroup {
  return {
    id: row.group_id,
    name: row.group_name,
    platform: row.group_platform,
    subscription_type: row.group_type,
    rate_multiplier: ppm(row.group_rate_multiplier_ppm),
    peak_rate_enabled: false,
    peak_start: '',
    peak_end: '',
    peak_rate_multiplier: 1,
    is_exclusive: row.group_is_exclusive === 1,
  }
}

function publicPricing(row: PriceModelRow, intervals: PublicPricingInterval[]): PublicPricing {
  return {
    billing_mode: row.billing_mode,
    input_price: perToken(row.input_micros_per_million),
    output_price: perToken(row.output_micros_per_million),
    cache_write_price: perToken(row.cache_write_micros_per_million),
    cache_write_1h_price: perToken(row.cache_write_1h_micros_per_million),
    cache_read_price: perToken(row.cache_read_micros_per_million),
    image_input_price: perToken(row.image_input_micros_per_million),
    image_output_price: perToken(row.image_output_micros_per_million),
    per_request_price: perRequest(row.per_request_micros),
    intervals,
  }
}

function publicInterval(row: PricingIntervalRow): PublicPricingInterval {
  return {
    min_tokens: safeInteger(row.min_tokens),
    max_tokens: row.max_tokens === null ? null : safeInteger(row.max_tokens),
    ...(row.tier_label === '' ? {} : { tier_label: row.tier_label }),
    input_price: perToken(row.input_micros_per_million),
    output_price: perToken(row.output_micros_per_million),
    cache_write_price: perToken(row.cache_write_micros_per_million),
    cache_write_1h_price: perToken(row.cache_write_1h_micros_per_million),
    cache_read_price: perToken(row.cache_read_micros_per_million),
    per_request_price: perRequest(row.per_request_micros),
  }
}

function modelKey(platform: string, name: string): string {
  return `${platform}\0${name.toLowerCase()}`
}

function perToken(value: number | null): number | null {
  return value === null ? null : safeInteger(value) / 1_000_000_000_000
}

function perRequest(value: number | null): number | null {
  return value === null ? null : safeInteger(value) / 1_000_000
}

function ppm(value: number): number { return safeInteger(value) / 1_000_000 }

function safeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError(503, 'invalid_available_channel_record', 'Available channel record is invalid', 'server_error')
  }
  return value
}
