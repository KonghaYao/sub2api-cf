/**
 * Admin Channels API endpoints
 * Handles channel management for administrators
 */

import { apiClient } from '../client'
import { isCloudflareWorkerContractActive } from '@/utils/adminCapabilities'
import type { BillingMode, ChannelStatus, BillingModelSource } from '@/constants/channel'

export type { BillingMode } from '@/constants/channel'

export type ChannelId = string | number
export type ChannelGroupId = string | number

export interface PricingInterval {
  id?: ChannelId
  min_tokens: number
  max_tokens: number | null
  tier_label: string
  input_price: number | null
  output_price: number | null
  cache_write_price: number | null
  cache_write_1h_price?: number | null
  cache_read_price: number | null
  input_multiplier: number | null
  output_multiplier: number | null
  cache_write_multiplier: number | null
  cache_read_multiplier: number | null
  per_request_price: number | null
  sort_order: number
}

export interface ChannelTimePricingPeriod {
  start_time: string
  end_time: string
  multiplier: number
}

export interface ChannelTimePricing {
  timezone: string
  weekdays_only?: boolean
  periods: ChannelTimePricingPeriod[]
}

export interface ChannelModelPricing {
  id?: ChannelId
  platform: string
  models: string[]
  billing_mode: BillingMode
  input_price: number | null
  output_price: number | null
  cache_write_price: number | null
  cache_write_1h_price?: number | null
  cache_read_price: number | null
  fast_multiplier?: number | null
  flex_multiplier?: number | null
  image_input_price: number | null
  image_output_price: number | null
  per_request_price: number | null
  intervals: PricingInterval[]
  time_pricing: ChannelTimePricing | null
}

export interface AccountStatsPricingRule {
  id?: ChannelId
  name: string
  group_ids: ChannelGroupId[]
  account_ids: ChannelId[]
  pricing: ChannelModelPricing[]
}

export interface Channel {
  id: ChannelId
  name: string
  description: string
  status: ChannelStatus
  billing_model_source: BillingModelSource
  restrict_models: boolean
  features_config?: Record<string, unknown>
  group_ids: ChannelGroupId[]
  model_pricing: ChannelModelPricing[]
  model_mapping: Record<string, Record<string, string>> // platform → {src→dst}
  apply_pricing_to_account_stats: boolean
  account_stats_pricing_rules: AccountStatsPricingRule[]
  created_at: string
  updated_at: string
  control_version?: number
}

export interface CreateChannelRequest {
  name: string
  description?: string
  group_ids?: ChannelGroupId[]
  model_pricing?: ChannelModelPricing[]
  model_mapping?: Record<string, Record<string, string>>
  billing_model_source?: string
  restrict_models?: boolean
  features_config?: Record<string, unknown>
  apply_pricing_to_account_stats?: boolean
  account_stats_pricing_rules?: AccountStatsPricingRule[]
}

export interface UpdateChannelRequest {
  name?: string
  description?: string
  status?: string
  group_ids?: ChannelGroupId[]
  model_pricing?: ChannelModelPricing[]
  model_mapping?: Record<string, Record<string, string>>
  billing_model_source?: string
  restrict_models?: boolean
  features_config?: Record<string, unknown>
  apply_pricing_to_account_stats?: boolean
  account_stats_pricing_rules?: AccountStatsPricingRule[]
}

interface PaginatedResponse<T> {
  items: T[]
  total: number
  page?: number
  page_size?: number
  pages?: number
}

interface WorkerPricingInterval extends Omit<PricingInterval,
  | 'input_price' | 'output_price' | 'cache_write_price' | 'cache_write_1h_price'
  | 'cache_read_price' | 'input_multiplier' | 'output_multiplier'
  | 'cache_write_multiplier' | 'cache_read_multiplier' | 'per_request_price'> {
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_write_micros_per_million: number | null
  cache_write_1h_micros_per_million?: number | null
  cache_read_micros_per_million: number | null
  input_multiplier_ppm: number | null
  output_multiplier_ppm: number | null
  cache_write_multiplier_ppm: number | null
  cache_read_multiplier_ppm: number | null
  per_request_micros: number | null
}

interface WorkerChannelModelPricing extends Omit<ChannelModelPricing,
  | 'input_price' | 'output_price' | 'cache_write_price' | 'cache_write_1h_price'
  | 'cache_read_price' | 'fast_multiplier' | 'flex_multiplier'
  | 'image_input_price' | 'image_output_price' | 'per_request_price' | 'intervals'
  | 'time_pricing'> {
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_write_micros_per_million: number | null
  cache_write_1h_micros_per_million?: number | null
  cache_read_micros_per_million: number | null
  fast_multiplier_ppm?: number | null
  flex_multiplier_ppm?: number | null
  image_input_micros_per_million: number | null
  image_output_micros_per_million: number | null
  per_request_micros: number | null
  intervals: WorkerPricingInterval[]
  time_pricing: WorkerTimePricing | null
}

interface WorkerTimePricing extends Omit<ChannelTimePricing, 'periods'> {
  periods: Array<Omit<ChannelTimePricingPeriod, 'multiplier'> & { multiplier_ppm: number }>
}

interface WorkerAccountStatsPricingInterval {
  id?: ChannelId
  min_tokens: number
  max_tokens: number | null
  tier_label: string
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_write_micros_per_million: number | null
  cache_write_1h_micros_per_million?: number | null
  cache_read_micros_per_million: number | null
  per_request_micros: number | null
  sort_order: number
}

interface WorkerAccountStatsModelPricing {
  id?: ChannelId
  platform: string
  models: string[]
  billing_mode: BillingMode
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_write_micros_per_million: number | null
  cache_write_1h_micros_per_million?: number | null
  cache_read_micros_per_million: number | null
  image_output_micros_per_million: number | null
  per_request_micros: number | null
  intervals: WorkerAccountStatsPricingInterval[]
}

interface WorkerAccountStatsPricingRule {
  id?: ChannelId
  name: string
  group_ids: ChannelGroupId[]
  account_ids: ChannelId[]
  pricing: WorkerAccountStatsModelPricing[]
}

interface WorkerChannel extends Omit<Channel, 'model_pricing' | 'account_stats_pricing_rules'> {
  model_pricing: WorkerChannelModelPricing[]
  account_stats_pricing_rules: WorkerAccountStatsPricingRule[]
  control_version: number
}

const channelControlVersions = new Map<string, number>()

function operationKey(scope: string): string {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${scope}-${id}`
}

function requireChannelVersion(id: ChannelId): number {
  const version = channelControlVersions.get(String(id))
  if (version === undefined) {
    throw Object.assign(new Error('Reload this channel before changing it'), {
      code: 'channel_version_not_loaded',
    })
  }
  return version
}

function optionalExactInteger(value: number | null | undefined, scale: number, field: string): number | null {
  if (value === null || value === undefined) return null
  const exact = value * scale
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(exact)) {
    throw Object.assign(new Error(`${field} cannot be represented exactly by the Worker contract`), {
      code: 'invalid_channel_price',
    })
  }
  return exact
}

function rejectUnsupportedAccountStatsPrice(field: string, value: unknown): void {
  if (value === null || value === undefined) return
  throw Object.assign(new Error(`${field} is not supported for Worker account-stat pricing yet`), {
    code: 'account_stats_token_type_not_supported',
  })
}

const microsPerMillionToPerToken = (value: number | null | undefined): number | null =>
  value == null ? null : value / 1_000_000_000_000
const microsToUsd = (value: number | null | undefined): number | null =>
  value == null ? null : value / 1_000_000
const ppmToMultiplier = (value: number | null | undefined): number | null =>
  value == null ? null : value / 1_000_000

function adaptWorkerInterval(interval: WorkerPricingInterval): PricingInterval {
  return {
    id: interval.id,
    min_tokens: interval.min_tokens,
    max_tokens: interval.max_tokens,
    tier_label: interval.tier_label,
    input_price: microsPerMillionToPerToken(interval.input_micros_per_million),
    output_price: microsPerMillionToPerToken(interval.output_micros_per_million),
    cache_write_price: microsPerMillionToPerToken(interval.cache_write_micros_per_million),
    cache_write_1h_price: microsPerMillionToPerToken(interval.cache_write_1h_micros_per_million),
    cache_read_price: microsPerMillionToPerToken(interval.cache_read_micros_per_million),
    input_multiplier: ppmToMultiplier(interval.input_multiplier_ppm),
    output_multiplier: ppmToMultiplier(interval.output_multiplier_ppm),
    cache_write_multiplier: ppmToMultiplier(interval.cache_write_multiplier_ppm),
    cache_read_multiplier: ppmToMultiplier(interval.cache_read_multiplier_ppm),
    per_request_price: microsToUsd(interval.per_request_micros),
    sort_order: interval.sort_order,
  }
}

function adaptWorkerPricing(pricing: WorkerChannelModelPricing): ChannelModelPricing {
  return {
    id: pricing.id,
    platform: pricing.platform,
    models: pricing.models,
    billing_mode: pricing.billing_mode,
    input_price: microsPerMillionToPerToken(pricing.input_micros_per_million),
    output_price: microsPerMillionToPerToken(pricing.output_micros_per_million),
    cache_write_price: microsPerMillionToPerToken(pricing.cache_write_micros_per_million),
    cache_write_1h_price: microsPerMillionToPerToken(pricing.cache_write_1h_micros_per_million),
    cache_read_price: microsPerMillionToPerToken(pricing.cache_read_micros_per_million),
    fast_multiplier: ppmToMultiplier(pricing.fast_multiplier_ppm),
    flex_multiplier: ppmToMultiplier(pricing.flex_multiplier_ppm),
    image_input_price: microsPerMillionToPerToken(pricing.image_input_micros_per_million),
    image_output_price: microsPerMillionToPerToken(pricing.image_output_micros_per_million),
    per_request_price: microsToUsd(pricing.per_request_micros),
    intervals: pricing.intervals.map(adaptWorkerInterval),
    time_pricing: pricing.time_pricing === null ? null : {
      timezone: pricing.time_pricing.timezone,
      weekdays_only: pricing.time_pricing.weekdays_only,
      periods: pricing.time_pricing.periods.map((period) => ({
        start_time: period.start_time,
        end_time: period.end_time,
        multiplier: period.multiplier_ppm / 1_000_000,
      })),
    },
  }
}

function adaptWorkerAccountStatsInterval(interval: WorkerAccountStatsPricingInterval): PricingInterval {
  return {
    id: interval.id,
    min_tokens: interval.min_tokens,
    max_tokens: interval.max_tokens,
    tier_label: interval.tier_label,
    input_price: microsPerMillionToPerToken(interval.input_micros_per_million),
    output_price: microsPerMillionToPerToken(interval.output_micros_per_million),
    cache_write_price: microsPerMillionToPerToken(interval.cache_write_micros_per_million),
    cache_write_1h_price: microsPerMillionToPerToken(interval.cache_write_1h_micros_per_million),
    cache_read_price: microsPerMillionToPerToken(interval.cache_read_micros_per_million),
    input_multiplier: null,
    output_multiplier: null,
    cache_write_multiplier: null,
    cache_read_multiplier: null,
    per_request_price: microsToUsd(interval.per_request_micros),
    sort_order: interval.sort_order,
  }
}

function adaptWorkerAccountStatsPricing(pricing: WorkerAccountStatsModelPricing): ChannelModelPricing {
  return {
    id: pricing.id,
    platform: pricing.platform,
    models: pricing.models,
    billing_mode: pricing.billing_mode,
    input_price: microsPerMillionToPerToken(pricing.input_micros_per_million),
    output_price: microsPerMillionToPerToken(pricing.output_micros_per_million),
    cache_write_price: microsPerMillionToPerToken(pricing.cache_write_micros_per_million),
    cache_write_1h_price: microsPerMillionToPerToken(pricing.cache_write_1h_micros_per_million),
    cache_read_price: microsPerMillionToPerToken(pricing.cache_read_micros_per_million),
    fast_multiplier: null,
    flex_multiplier: null,
    image_input_price: null,
    image_output_price: microsPerMillionToPerToken(pricing.image_output_micros_per_million),
    per_request_price: microsToUsd(pricing.per_request_micros),
    intervals: pricing.intervals.map(adaptWorkerAccountStatsInterval),
    time_pricing: null,
  }
}

function adaptWorkerChannel(raw: Channel | WorkerChannel): Channel {
  if (!isCloudflareWorkerContractActive()) return raw as Channel
  const channel = raw as WorkerChannel
  const adapted: Channel = {
    ...channel,
    group_ids: channel.group_ids.map((id) => String(id)),
    model_pricing: channel.model_pricing.map(adaptWorkerPricing),
    account_stats_pricing_rules: (channel.account_stats_pricing_rules ?? []).map((rule) => ({
      id: rule.id,
      name: rule.name,
      group_ids: rule.group_ids.map((id) => String(id)),
      account_ids: rule.account_ids.map((id) => String(id)),
      pricing: rule.pricing.map(adaptWorkerAccountStatsPricing),
    })),
    created_at: channel.created_at,
    updated_at: channel.updated_at,
  }
  channelControlVersions.set(String(channel.id), channel.control_version)
  return adapted
}

function workerInterval(interval: PricingInterval): Record<string, unknown> {
  return {
    ...(interval.id === undefined ? {} : { id: interval.id }),
    min_tokens: interval.min_tokens,
    max_tokens: interval.max_tokens,
    tier_label: interval.tier_label,
    input_micros_per_million: optionalExactInteger(interval.input_price, 1_000_000_000_000, 'input_price'),
    output_micros_per_million: optionalExactInteger(interval.output_price, 1_000_000_000_000, 'output_price'),
    cache_write_micros_per_million: optionalExactInteger(interval.cache_write_price, 1_000_000_000_000, 'cache_write_price'),
    cache_write_1h_micros_per_million: optionalExactInteger(interval.cache_write_1h_price, 1_000_000_000_000, 'cache_write_1h_price'),
    cache_read_micros_per_million: optionalExactInteger(interval.cache_read_price, 1_000_000_000_000, 'cache_read_price'),
    input_multiplier_ppm: optionalExactInteger(interval.input_multiplier, 1_000_000, 'input_multiplier'),
    output_multiplier_ppm: optionalExactInteger(interval.output_multiplier, 1_000_000, 'output_multiplier'),
    cache_write_multiplier_ppm: optionalExactInteger(interval.cache_write_multiplier, 1_000_000, 'cache_write_multiplier'),
    cache_read_multiplier_ppm: optionalExactInteger(interval.cache_read_multiplier, 1_000_000, 'cache_read_multiplier'),
    per_request_micros: optionalExactInteger(interval.per_request_price, 1_000_000, 'per_request_price'),
    sort_order: interval.sort_order,
  }
}

function workerPricing(pricing: ChannelModelPricing): Record<string, unknown> {
  return {
    ...(pricing.id === undefined ? {} : { id: pricing.id }),
    platform: pricing.platform,
    models: pricing.models,
    billing_mode: pricing.billing_mode,
    input_micros_per_million: optionalExactInteger(pricing.input_price, 1_000_000_000_000, 'input_price'),
    output_micros_per_million: optionalExactInteger(pricing.output_price, 1_000_000_000_000, 'output_price'),
    cache_write_micros_per_million: optionalExactInteger(pricing.cache_write_price, 1_000_000_000_000, 'cache_write_price'),
    cache_write_1h_micros_per_million: optionalExactInteger(pricing.cache_write_1h_price, 1_000_000_000_000, 'cache_write_1h_price'),
    cache_read_micros_per_million: optionalExactInteger(pricing.cache_read_price, 1_000_000_000_000, 'cache_read_price'),
    fast_multiplier_ppm: optionalExactInteger(pricing.fast_multiplier, 1_000_000, 'fast_multiplier'),
    flex_multiplier_ppm: optionalExactInteger(pricing.flex_multiplier, 1_000_000, 'flex_multiplier'),
    image_input_micros_per_million: optionalExactInteger(pricing.image_input_price, 1_000_000_000_000, 'image_input_price'),
    image_output_micros_per_million: optionalExactInteger(pricing.image_output_price, 1_000_000_000_000, 'image_output_price'),
    per_request_micros: optionalExactInteger(pricing.per_request_price, 1_000_000, 'per_request_price'),
    intervals: pricing.intervals.map(workerInterval),
    time_pricing: pricing.time_pricing === null ? null : {
      timezone: pricing.time_pricing.timezone,
      weekdays_only: pricing.time_pricing.weekdays_only,
      periods: pricing.time_pricing.periods.map((period) => ({
        start_time: period.start_time,
        end_time: period.end_time,
        multiplier_ppm: optionalExactInteger(period.multiplier, 1_000_000, 'time_pricing.multiplier'),
      })),
    },
  }
}

function workerAccountStatsInterval(interval: PricingInterval): Record<string, unknown> {
  rejectUnsupportedAccountStatsPrice('account_stats.cache_write_1h_price', interval.cache_write_1h_price)
  return {
    ...(interval.id === undefined ? {} : { id: interval.id }),
    min_tokens: interval.min_tokens,
    max_tokens: interval.max_tokens,
    tier_label: interval.tier_label,
    input_micros_per_million: optionalExactInteger(interval.input_price, 1_000_000_000_000, 'account_stats.input_price'),
    output_micros_per_million: optionalExactInteger(interval.output_price, 1_000_000_000_000, 'account_stats.output_price'),
    cache_write_micros_per_million: optionalExactInteger(interval.cache_write_price, 1_000_000_000_000, 'account_stats.cache_write_price'),
    cache_read_micros_per_million: optionalExactInteger(interval.cache_read_price, 1_000_000_000_000, 'account_stats.cache_read_price'),
    per_request_micros: optionalExactInteger(interval.per_request_price, 1_000_000, 'account_stats.per_request_price'),
    sort_order: interval.sort_order,
  }
}

function workerAccountStatsPricing(pricing: ChannelModelPricing): Record<string, unknown> {
  rejectUnsupportedAccountStatsPrice('account_stats.cache_write_1h_price', pricing.cache_write_1h_price)
  rejectUnsupportedAccountStatsPrice('account_stats.image_input_price', pricing.image_input_price)
  rejectUnsupportedAccountStatsPrice('account_stats.image_output_price', pricing.image_output_price)
  if ((pricing.billing_mode === 'per_request' || pricing.billing_mode === 'image')
    && pricing.per_request_price == null) {
    throw Object.assign(new Error('A top-level per-request price is required for Worker account-stat pricing'), {
      code: 'account_stats_per_request_price_required',
    })
  }
  return {
    ...(pricing.id === undefined ? {} : { id: pricing.id }),
    platform: pricing.platform,
    models: pricing.models,
    billing_mode: pricing.billing_mode,
    input_micros_per_million: optionalExactInteger(pricing.input_price, 1_000_000_000_000, 'account_stats.input_price'),
    output_micros_per_million: optionalExactInteger(pricing.output_price, 1_000_000_000_000, 'account_stats.output_price'),
    cache_write_micros_per_million: optionalExactInteger(pricing.cache_write_price, 1_000_000_000_000, 'account_stats.cache_write_price'),
    cache_read_micros_per_million: optionalExactInteger(pricing.cache_read_price, 1_000_000_000_000, 'account_stats.cache_read_price'),
    per_request_micros: optionalExactInteger(pricing.per_request_price, 1_000_000, 'account_stats.per_request_price'),
    intervals: pricing.billing_mode === 'token'
      ? pricing.intervals.map(workerAccountStatsInterval)
      : [],
  }
}

function workerPayload(request: CreateChannelRequest | UpdateChannelRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  const source = request as Record<string, unknown>
  for (const field of [
    'name', 'description', 'status', 'group_ids', 'model_mapping',
    'billing_model_source', 'restrict_models', 'features_config',
  ] as const) {
    if (source[field] !== undefined) payload[field] = source[field]
  }
  if (request.model_pricing !== undefined) {
    payload.model_pricing = request.model_pricing.map(workerPricing)
  }
  if (request.apply_pricing_to_account_stats !== undefined) {
    payload.apply_pricing_to_account_stats = request.apply_pricing_to_account_stats
  }
  if (request.account_stats_pricing_rules !== undefined) {
    payload.account_stats_pricing_rules = request.account_stats_pricing_rules.map((rule) => ({
      ...(rule.id === undefined ? {} : { id: rule.id }),
      name: rule.name,
      group_ids: rule.group_ids,
      account_ids: rule.account_ids,
      pricing: rule.pricing.map(workerAccountStatsPricing),
    }))
  }
  return payload
}

/**
 * List channels with pagination
 */
export async function list(
  page: number = 1,
  pageSize: number = 20,
  filters?: {
    status?: string
    search?: string
    sort_by?: string
    sort_order?: 'asc' | 'desc'
  },
  options?: { signal?: AbortSignal }
): Promise<PaginatedResponse<Channel>> {
  const { data } = await apiClient.get<PaginatedResponse<Channel | WorkerChannel>>('/admin/channels', {
    params: {
      page,
      page_size: pageSize,
      ...filters
    },
    signal: options?.signal
  })
  if (!isCloudflareWorkerContractActive()) return data as PaginatedResponse<Channel>
  return { ...data, items: data.items.map(adaptWorkerChannel) }
}

/**
 * Get channel by ID
 */
export async function getById(id: ChannelId): Promise<Channel> {
  const { data } = await apiClient.get<Channel | WorkerChannel>(`/admin/channels/${id}`)
  return adaptWorkerChannel(data)
}

/**
 * Create a new channel
 */
export async function create(req: CreateChannelRequest): Promise<Channel> {
  if (!isCloudflareWorkerContractActive()) {
    const { data } = await apiClient.post<Channel>('/admin/channels', req)
    return data
  }
  const { data } = await apiClient.post<WorkerChannel>('/admin/channels', workerPayload(req), {
    headers: { 'Idempotency-Key': operationKey('admin-channel-create') },
  })
  return adaptWorkerChannel(data)
}

/**
 * Update a channel
 */
export async function update(id: ChannelId, req: UpdateChannelRequest): Promise<Channel> {
  if (!isCloudflareWorkerContractActive()) {
    const { data } = await apiClient.put<Channel>(`/admin/channels/${id}`, req)
    return data
  }
  const version = requireChannelVersion(id)
  const { data } = await apiClient.put<WorkerChannel>(`/admin/channels/${id}`, workerPayload(req), {
    headers: {
      'Idempotency-Key': operationKey('admin-channel-update'),
      'If-Match': `"${version}"`,
    },
  })
  return adaptWorkerChannel(data)
}

/**
 * Delete a channel
 */
export async function remove(id: ChannelId): Promise<void> {
  if (!isCloudflareWorkerContractActive()) {
    await apiClient.delete(`/admin/channels/${id}`)
    return
  }
  const version = requireChannelVersion(id)
  await apiClient.delete(`/admin/channels/${id}`, {
    headers: {
      'Idempotency-Key': operationKey('admin-channel-delete'),
      'If-Match': `"${version}"`,
    },
  })
  channelControlVersions.delete(String(id))
}

export interface ModelDefaultPricing {
  found: boolean
  input_price?: number    // per-token price
  output_price?: number
  cache_write_price?: number
  cache_write_1h_price?: number | null
  cache_read_price?: number
  image_input_price?: number
  image_output_price?: number
}

export async function getModelDefaultPricing(model: string): Promise<ModelDefaultPricing> {
  const { data } = await apiClient.get<ModelDefaultPricing>('/admin/channels/model-pricing', {
    params: { model }
  })
  return data
}

export interface SyncPricingModelsResult {
  models: string[]
}

/**
 * Fetch the latest model names from the LiteLLM pricing catalog for the given platform
 */
export async function syncPricingModels(platform: string): Promise<SyncPricingModelsResult> {
  const { data } = await apiClient.get<SyncPricingModelsResult>('/admin/channels/pricing/sync-models', {
    params: { platform }
  })
  return data
}

const channelsAPI = { list, getById, create, update, remove, getModelDefaultPricing, syncPricingModels }
export default channelsAPI
