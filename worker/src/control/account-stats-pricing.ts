import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'
import { deterministicUuid, requireResourceId } from './http'

const MAX_SAFE = Number.MAX_SAFE_INTEGER

type StatsBillingMode = 'token' | 'per_request' | 'image'

export interface ParsedStatsInterval {
  id?: string
  min_tokens: number
  max_tokens: number | null
  tier_label: string
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_write_micros_per_million: number | null
  cache_write_1h_micros_per_million: number | null
  cache_read_micros_per_million: number | null
  per_request_micros: number | null
  sort_order: number
}

export interface ParsedStatsPricing {
  id?: string
  sort_order: number
  platform: string
  billing_mode: StatsBillingMode
  input_micros_per_million: number | null
  output_micros_per_million: number | null
  cache_write_micros_per_million: number | null
  cache_write_1h_micros_per_million: number | null
  cache_read_micros_per_million: number | null
  image_output_micros_per_million: number | null
  per_request_micros: number | null
  models: Array<{ model_pattern: string; is_wildcard: number; sort_order: number }>
  intervals: ParsedStatsInterval[]
}

export interface ParsedAccountStatsRule {
  id?: string
  name: string
  group_ids: string[]
  account_ids: string[]
  sort_order: number
  pricing: ParsedStatsPricing[]
}

interface RuleRow {
  id: string
  channel_id: string
  name: string
  sort_order: number
}

interface RuleGroupRow { rule_id: string; group_id: string }
interface RuleAccountRow { rule_id: string; account_id: string }
interface StatsPricingRow extends Omit<ParsedStatsPricing, 'id' | 'models' | 'intervals'> {
  id: string
  rule_id: string
  sort_order: number
}
interface StatsModelRow {
  pricing_id: string
  model_pattern: string
  is_wildcard: number
  sort_order: number
}
interface StatsIntervalRow extends Omit<ParsedStatsInterval, 'id'> {
  id: string
  pricing_id: string
}

export interface AccountStatsRelated {
  rules: RuleRow[]
  groups: RuleGroupRow[]
  accounts: RuleAccountRow[]
  pricing: StatsPricingRow[]
  models: StatsModelRow[]
  intervals: StatsIntervalRow[]
}

export interface MaterializedAccountStatsGraph {
  rules: Array<Omit<ParsedAccountStatsRule, 'id' | 'pricing'> & {
    id: string
    pricing: Array<Omit<ParsedStatsPricing, 'id' | 'intervals'> & {
      id: string
      intervals: Array<Omit<ParsedStatsInterval, 'id'> & { id: string }>
    }>
  }>
}

export function emptyAccountStatsRelated(): AccountStatsRelated {
  return { rules: [], groups: [], accounts: [], pricing: [], models: [], intervals: [] }
}

export function parseAccountStatsRules(value: unknown): ParsedAccountStatsRule[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw invalid('account_stats_pricing_rules', 'account_stats_pricing_rules must contain at most 8 entries')
  }
  return value.map((raw, ruleIndex) => {
    const row = object(raw, `account_stats_pricing_rules[${ruleIndex}]`)
    const groupIds = ids(row.group_ids ?? [], `account_stats_pricing_rules[${ruleIndex}].group_ids`, 16)
    const accountIds = ids(row.account_ids ?? [], `account_stats_pricing_rules[${ruleIndex}].account_ids`, 16)
    if (groupIds.length + accountIds.length === 0) {
      throw invalid('account_stats_pricing_rules', `account statistics rule #${ruleIndex + 1} must have a group or account scope`)
    }
    const pricing = parseStatsPricing(row.pricing ?? [], ruleIndex)
    if (pricing.length === 0) {
      throw invalid('account_stats_pricing_rules', `account statistics rule #${ruleIndex + 1} must have pricing`)
    }
    return {
      id: optionalId(row.id, `account_stats_pricing_rules[${ruleIndex}].id`),
      name: text(row.name ?? '', `account_stats_pricing_rules[${ruleIndex}].name`, 100, true),
      group_ids: groupIds,
      account_ids: accountIds,
      sort_order: ruleIndex,
      pricing,
    }
  })
}

function parseStatsPricing(value: unknown, ruleIndex: number): ParsedStatsPricing[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw invalid('account_stats_pricing_rules', `account statistics rule #${ruleIndex + 1} pricing must contain at most 8 entries`)
  }
  const prices = value.map((raw, priceIndex) => {
    const prefix = `account_stats_pricing_rules[${ruleIndex}].pricing[${priceIndex}]`
    const row = object(raw, prefix)
    const modelValues = ids(row.models, `${prefix}.models`, 16, 256, 1)
    const billingMode = row.billing_mode ?? 'token'
    if (billingMode !== 'token' && billingMode !== 'per_request' && billingMode !== 'image') {
      throw invalid('billing_mode', `${prefix}.billing_mode is invalid`)
    }
    if (row.time_pricing !== undefined && row.time_pricing !== null) {
      throw new GatewayError(409, 'account_stats_time_pricing_not_supported', 'Account statistics pricing does not support time pricing')
    }
    for (const field of [
      'cache_write_1h_micros_per_million',
      'image_input_micros_per_million', 'image_output_micros_per_million',
      'fast_multiplier_ppm', 'flex_multiplier_ppm',
    ]) {
      if (row[field] !== undefined && row[field] !== null) {
        throw new GatewayError(
          409,
          'account_stats_price_field_not_supported',
          `${prefix}.${field} is not calculated by the Worker runtime yet`,
        )
      }
    }
    const intervalsRaw = row.intervals ?? []
    if (!Array.isArray(intervalsRaw) || intervalsRaw.length > 8) {
      throw invalid('intervals', `${prefix}.intervals must contain at most 8 entries`)
    }
    const intervals = intervalsRaw.map((item, intervalIndex) => parseStatsInterval(item, prefix, intervalIndex))
    validateIntervals(intervals, prefix, billingMode)
    const parsed: ParsedStatsPricing = {
      id: optionalId(row.id, `${prefix}.id`),
      sort_order: priceIndex,
      platform: text(row.platform ?? '', `${prefix}.platform`, 64, true),
      billing_mode: billingMode,
      input_micros_per_million: nullableInteger(row.input_micros_per_million, 'input_micros_per_million'),
      output_micros_per_million: nullableInteger(row.output_micros_per_million, 'output_micros_per_million'),
      cache_write_micros_per_million: nullableInteger(row.cache_write_micros_per_million, 'cache_write_micros_per_million'),
      cache_write_1h_micros_per_million: nullableInteger(row.cache_write_1h_micros_per_million, 'cache_write_1h_micros_per_million'),
      cache_read_micros_per_million: nullableInteger(row.cache_read_micros_per_million, 'cache_read_micros_per_million'),
      image_output_micros_per_million: nullableInteger(row.image_output_micros_per_million, 'image_output_micros_per_million'),
      per_request_micros: nullableInteger(row.per_request_micros, 'per_request_micros'),
      models: modelValues.map((model, sortOrder) => ({
        model_pattern: pattern(model, `${prefix}.models`),
        is_wildcard: model.endsWith('*') ? 1 : 0,
        sort_order: sortOrder,
      })),
      intervals,
    }
    if (billingMode === 'per_request' || billingMode === 'image') {
      if (intervals.length > 0 || parsed.per_request_micros === null || parsed.per_request_micros <= 0) {
        throw new GatewayError(
          409,
          'invalid_account_stats_pricing_rules',
          `${prefix} requires a top-level per_request_micros greater than zero and does not support intervals`,
        )
      }
    }
    return parsed
  })
  validatePricingPatterns(prices)
  return prices
}

function parseStatsInterval(value: unknown, prefix: string, index: number): ParsedStatsInterval {
  const row = object(value, `${prefix}.intervals[${index}]`)
  for (const field of [
    'cache_write_1h_micros_per_million',
    'image_output_micros_per_million',
  ]) {
    if (row[field] !== undefined && row[field] !== null) {
      throw new GatewayError(
        409,
        'account_stats_price_field_not_supported',
        `${prefix}.intervals[${index}].${field} is not calculated by the Worker runtime yet`,
      )
    }
  }
  const min = integer(row.min_tokens ?? 0, 'min_tokens')
  const max = nullableInteger(row.max_tokens, 'max_tokens')
  if (max !== null && max <= min) throw invalid('max_tokens', 'max_tokens must be greater than min_tokens')
  const result: ParsedStatsInterval = {
    id: optionalId(row.id, `${prefix}.intervals[${index}].id`),
    min_tokens: min,
    max_tokens: max,
    tier_label: text(row.tier_label ?? '', 'tier_label', 128, true),
    input_micros_per_million: nullableInteger(row.input_micros_per_million, 'input_micros_per_million'),
    output_micros_per_million: nullableInteger(row.output_micros_per_million, 'output_micros_per_million'),
    cache_write_micros_per_million: nullableInteger(row.cache_write_micros_per_million, 'cache_write_micros_per_million'),
    cache_write_1h_micros_per_million: nullableInteger(row.cache_write_1h_micros_per_million, 'cache_write_1h_micros_per_million'),
    cache_read_micros_per_million: nullableInteger(row.cache_read_micros_per_million, 'cache_read_micros_per_million'),
    per_request_micros: nullableInteger(row.per_request_micros, 'per_request_micros'),
    sort_order: integer(row.sort_order ?? index, 'sort_order'),
  }
  if ([
    result.input_micros_per_million, result.output_micros_per_million,
    result.cache_write_micros_per_million, result.cache_write_1h_micros_per_million,
    result.cache_read_micros_per_million, result.per_request_micros,
  ].every((item) => item === null)) {
    throw invalid('intervals', `${prefix}.intervals[${index}] has no price`)
  }
  return result
}

function validateIntervals(intervals: ParsedStatsInterval[], prefix: string, mode: StatsBillingMode): void {
  if (mode !== 'token') return
  const sorted = [...intervals].sort((left, right) => left.min_tokens - right.min_tokens)
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]
    if (previous.max_tokens === null || previous.max_tokens > sorted[index].min_tokens) {
      throw invalid('intervals', `${prefix}.intervals overlap`)
    }
  }
}

function validatePricingPatterns(prices: ParsedStatsPricing[]): void {
  const seen: Array<{ platform: string; pattern: string }> = []
  for (const price of prices) {
    for (const model of price.models) {
      const next = { platform: price.platform.toLowerCase(), pattern: normalizePattern(model.model_pattern) }
      for (const old of seen) {
        if (old.platform !== next.platform) continue
        const oldWildcard = old.pattern.endsWith('*')
        const nextWildcard = next.pattern.endsWith('*')
        const oldPrefix = oldWildcard ? old.pattern.slice(0, -1) : old.pattern
        const nextPrefix = nextWildcard ? next.pattern.slice(0, -1) : next.pattern
        if (
          (oldWildcard && nextPrefix.startsWith(oldPrefix)) ||
          (nextWildcard && oldPrefix.startsWith(nextPrefix)) ||
          (!oldWildcard && !nextWildcard && oldPrefix === nextPrefix)
        ) {
          throw invalid('account_stats_pricing_rules', 'account statistics pricing contains overlapping model patterns')
        }
      }
      seen.push(next)
    }
  }
}

export function accountStatsGraphRows(rules: ParsedAccountStatsRule[]): number {
  return rules.reduce((total, rule) => total + 1 + rule.group_ids.length + rule.account_ids.length
    + rule.pricing.reduce((priceTotal, price) => priceTotal + 1 + price.models.length + price.intervals.length, 0), 0)
}

export async function validateAccountStatsScopes(
  env: Env,
  channelGroupIds: string[],
  rules: ParsedAccountStatsRule[],
): Promise<void> {
  const channelGroups = new Set(channelGroupIds)
  const scopedGroups = [...new Set(rules.flatMap((rule) => rule.group_ids))]
  if (scopedGroups.some((id) => !channelGroups.has(id))) {
    throw new GatewayError(409, 'account_stats_group_not_in_channel', 'Every account statistics group scope must belong to the channel')
  }
  const accountIds = [...new Set(rules.flatMap((rule) => rule.account_ids))]
  if (accountIds.length === 0) return
  const placeholders = accountIds.map(() => '?').join(', ')
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT id) AS total FROM accounts WHERE id IN (${placeholders})`,
  ).bind(...accountIds).first<{ total: number }>()
  if (row === null || !Number.isSafeInteger(row.total)) {
    throw new GatewayError(500, 'invalid_account_stats_scope_projection', 'Account statistics scope validation is invalid', 'server_error')
  }
  if (row.total !== accountIds.length) {
    throw new GatewayError(409, 'account_stats_account_not_found', 'One or more account statistics account scopes do not exist')
  }
}

export async function materializeAccountStatsGraph(
  rules: ParsedAccountStatsRule[],
  key: string,
): Promise<MaterializedAccountStatsGraph> {
  return {
    rules: await Promise.all(rules.map(async (rule, ruleIndex) => ({
      ...rule,
      id: rule.id ?? await deterministicUuid('admin.channels.account-stats-rule.v1', `${key}:rule:${ruleIndex}`),
      pricing: await Promise.all(rule.pricing.map(async (price, priceIndex) => ({
        ...price,
        id: price.id ?? await deterministicUuid(
          'admin.channels.account-stats-pricing.v1',
          `${key}:rule:${ruleIndex}:pricing:${priceIndex}`,
        ),
        intervals: await Promise.all(price.intervals.map(async (interval, intervalIndex) => ({
          ...interval,
          id: interval.id ?? await deterministicUuid(
            'admin.channels.account-stats-interval.v1',
            `${key}:rule:${ruleIndex}:pricing:${priceIndex}:interval:${intervalIndex}`,
          ),
        }))),
      }))),
    }))),
  }
}

export function accountStatsStatements(
  env: Env,
  channelId: string,
  graph: MaterializedAccountStatsGraph,
  now: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  for (const rule of graph.rules) {
    statements.push(env.DB.prepare(
      `INSERT INTO channel_account_stats_pricing_rules (
         id, channel_id, name, sort_order, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(rule.id, channelId, rule.name, rule.sort_order, now, now))
    for (const groupId of rule.group_ids) {
      statements.push(env.DB.prepare(
        `INSERT INTO channel_account_stats_rule_groups (rule_id, group_id, created_at_ms)
         VALUES (?, ?, ?)`,
      ).bind(rule.id, groupId, now))
    }
    for (const accountId of rule.account_ids) {
      statements.push(env.DB.prepare(
        `INSERT INTO channel_account_stats_rule_accounts (rule_id, account_id, created_at_ms)
         VALUES (?, ?, ?)`,
      ).bind(rule.id, accountId, now))
    }
    for (const price of rule.pricing) {
      statements.push(env.DB.prepare(
        `INSERT INTO channel_account_stats_model_pricing (
           id, rule_id, platform, billing_mode, input_micros_per_million,
           output_micros_per_million, cache_write_micros_per_million,
           cache_write_1h_micros_per_million, cache_read_micros_per_million,
           image_output_micros_per_million, per_request_micros, sort_order,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        price.id, rule.id, price.platform, price.billing_mode,
        price.input_micros_per_million, price.output_micros_per_million,
        price.cache_write_micros_per_million, price.cache_write_1h_micros_per_million,
        price.cache_read_micros_per_million, price.image_output_micros_per_million,
        price.per_request_micros, price.sort_order, now, now,
      ))
      for (const model of price.models) {
        statements.push(env.DB.prepare(
          `INSERT INTO channel_account_stats_pricing_models (
             pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
           ) VALUES (?, ?, ?, ?, ?)`,
        ).bind(price.id, model.model_pattern, model.is_wildcard, model.sort_order, now))
      }
      for (const interval of price.intervals) {
        statements.push(env.DB.prepare(
          `INSERT INTO channel_account_stats_pricing_intervals (
             id, pricing_id, min_tokens, max_tokens, tier_label,
             input_micros_per_million, output_micros_per_million,
             cache_write_micros_per_million, cache_write_1h_micros_per_million,
             cache_read_micros_per_million, per_request_micros, sort_order,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          interval.id, price.id, interval.min_tokens, interval.max_tokens, interval.tier_label,
          interval.input_micros_per_million, interval.output_micros_per_million,
          interval.cache_write_micros_per_million, interval.cache_write_1h_micros_per_million,
          interval.cache_read_micros_per_million, interval.per_request_micros,
          interval.sort_order, now, now,
        ))
      }
    }
  }
  return statements
}

export async function loadAccountStatsRelated(env: Env, channelIds: string[]): Promise<AccountStatsRelated> {
  if (channelIds.length === 0) return emptyAccountStatsRelated()
  const placeholders = channelIds.map(() => '?').join(', ')
  const [rules, groups, accounts, pricing, models, intervals] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, channel_id, name, sort_order
         FROM channel_account_stats_pricing_rules
        WHERE channel_id IN (${placeholders})
        ORDER BY channel_id, sort_order, id`,
    ).bind(...channelIds),
    env.DB.prepare(
      `SELECT scope.rule_id, scope.group_id
         FROM channel_account_stats_rule_groups scope
         JOIN channel_account_stats_pricing_rules rule ON rule.id = scope.rule_id
        WHERE rule.channel_id IN (${placeholders})
        ORDER BY scope.rule_id, scope.group_id`,
    ).bind(...channelIds),
    env.DB.prepare(
      `SELECT scope.rule_id, scope.account_id
         FROM channel_account_stats_rule_accounts scope
         JOIN channel_account_stats_pricing_rules rule ON rule.id = scope.rule_id
        WHERE rule.channel_id IN (${placeholders})
        ORDER BY scope.rule_id, scope.account_id`,
    ).bind(...channelIds),
    env.DB.prepare(
      `SELECT price.id, price.rule_id, price.platform, price.billing_mode,
              price.input_micros_per_million, price.output_micros_per_million,
              price.cache_write_micros_per_million,
              price.cache_write_1h_micros_per_million,
              price.cache_read_micros_per_million,
              price.image_output_micros_per_million, price.per_request_micros,
              price.sort_order
         FROM channel_account_stats_model_pricing price
         JOIN channel_account_stats_pricing_rules rule ON rule.id = price.rule_id
        WHERE rule.channel_id IN (${placeholders})
        ORDER BY price.rule_id, price.sort_order, price.id`,
    ).bind(...channelIds),
    env.DB.prepare(
      `SELECT model.pricing_id, model.model_pattern, model.is_wildcard, model.sort_order
         FROM channel_account_stats_pricing_models model
         JOIN channel_account_stats_model_pricing price ON price.id = model.pricing_id
         JOIN channel_account_stats_pricing_rules rule ON rule.id = price.rule_id
        WHERE rule.channel_id IN (${placeholders})
        ORDER BY model.pricing_id, model.sort_order, model.model_pattern`,
    ).bind(...channelIds),
    env.DB.prepare(
      `SELECT interval.id, interval.pricing_id, interval.min_tokens,
              interval.max_tokens, interval.tier_label,
              interval.input_micros_per_million,
              interval.output_micros_per_million,
              interval.cache_write_micros_per_million,
              interval.cache_write_1h_micros_per_million,
              interval.cache_read_micros_per_million,
              interval.per_request_micros, interval.sort_order
         FROM channel_account_stats_pricing_intervals interval
         JOIN channel_account_stats_model_pricing price ON price.id = interval.pricing_id
         JOIN channel_account_stats_pricing_rules rule ON rule.id = price.rule_id
        WHERE rule.channel_id IN (${placeholders})
        ORDER BY interval.pricing_id, interval.sort_order, interval.id`,
    ).bind(...channelIds),
  ])
  return {
    rules: rules.results as unknown as RuleRow[],
    groups: groups.results as unknown as RuleGroupRow[],
    accounts: accounts.results as unknown as RuleAccountRow[],
    pricing: pricing.results as unknown as StatsPricingRow[],
    models: models.results as unknown as StatsModelRow[],
    intervals: intervals.results as unknown as StatsIntervalRow[],
  }
}

export function publicAccountStatsRules(channelId: string, related: AccountStatsRelated) {
  return related.rules.filter((rule) => rule.channel_id === channelId).map((rule) => ({
    id: rule.id,
    name: rule.name,
    group_ids: related.groups.filter((item) => item.rule_id === rule.id).map((item) => item.group_id),
    account_ids: related.accounts.filter((item) => item.rule_id === rule.id).map((item) => item.account_id),
    pricing: related.pricing.filter((item) => item.rule_id === rule.id).map((price) => ({
      id: price.id,
      platform: price.platform,
      models: related.models.filter((item) => item.pricing_id === price.id).map((item) => item.model_pattern),
      billing_mode: price.billing_mode,
      input_micros_per_million: price.input_micros_per_million,
      output_micros_per_million: price.output_micros_per_million,
      cache_write_micros_per_million: price.cache_write_micros_per_million,
      cache_write_1h_micros_per_million: price.cache_write_1h_micros_per_million,
      cache_read_micros_per_million: price.cache_read_micros_per_million,
      image_output_micros_per_million: price.image_output_micros_per_million,
      per_request_micros: price.per_request_micros,
      intervals: related.intervals.filter((item) => item.pricing_id === price.id).map((interval) => {
        const { pricing_id: _pricingId, ...value } = interval
        return value
      }),
      time_pricing: null,
    })),
  }))
}

export function parsedAccountStatsRules(channelId: string, related: AccountStatsRelated): ParsedAccountStatsRule[] {
  return related.rules.filter((rule) => rule.channel_id === channelId).map((rule) => ({
    id: rule.id,
    name: rule.name,
    sort_order: rule.sort_order,
    group_ids: related.groups.filter((item) => item.rule_id === rule.id).map((item) => item.group_id),
    account_ids: related.accounts.filter((item) => item.rule_id === rule.id).map((item) => item.account_id),
    pricing: related.pricing.filter((item) => item.rule_id === rule.id).map((price) => ({
      id: price.id,
      sort_order: price.sort_order,
      platform: price.platform,
      billing_mode: price.billing_mode,
      input_micros_per_million: price.input_micros_per_million,
      output_micros_per_million: price.output_micros_per_million,
      cache_write_micros_per_million: price.cache_write_micros_per_million,
      cache_write_1h_micros_per_million: price.cache_write_1h_micros_per_million,
      cache_read_micros_per_million: price.cache_read_micros_per_million,
      image_output_micros_per_million: price.image_output_micros_per_million,
      per_request_micros: price.per_request_micros,
      models: related.models.filter((item) => item.pricing_id === price.id).map((item) => ({
        model_pattern: item.model_pattern,
        is_wildcard: item.is_wildcard,
        sort_order: item.sort_order,
      })),
      intervals: related.intervals.filter((item) => item.pricing_id === price.id).map((interval) => {
        const { pricing_id: _pricingId, ...value } = interval
        return value
      }),
    })),
  }))
}

export function relatedAccountStatsFromGraph(
  channelId: string,
  graph: MaterializedAccountStatsGraph,
): AccountStatsRelated {
  return {
    rules: graph.rules.map((rule) => ({
      id: rule.id, channel_id: channelId, name: rule.name, sort_order: rule.sort_order,
    })),
    groups: graph.rules.flatMap((rule) => rule.group_ids.map((group_id) => ({ rule_id: rule.id, group_id }))),
    accounts: graph.rules.flatMap((rule) => rule.account_ids.map((account_id) => ({ rule_id: rule.id, account_id }))),
    pricing: graph.rules.flatMap((rule) => rule.pricing.map((price) => ({
      id: price.id, rule_id: rule.id, platform: price.platform, billing_mode: price.billing_mode,
      input_micros_per_million: price.input_micros_per_million,
      output_micros_per_million: price.output_micros_per_million,
      cache_write_micros_per_million: price.cache_write_micros_per_million,
      cache_write_1h_micros_per_million: price.cache_write_1h_micros_per_million,
      cache_read_micros_per_million: price.cache_read_micros_per_million,
      image_output_micros_per_million: price.image_output_micros_per_million,
      per_request_micros: price.per_request_micros, sort_order: price.sort_order,
    }))),
    models: graph.rules.flatMap((rule) => rule.pricing.flatMap((price) => price.models.map((model) => ({
      pricing_id: price.id, ...model,
    })))),
    intervals: graph.rules.flatMap((rule) => rule.pricing.flatMap((price) => price.intervals.map((interval) => ({
      pricing_id: price.id, ...interval,
    })))),
  }
}

function ids(value: unknown, field: string, maximum: number, maxLength = 128, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw invalid(field, `${field} must contain between ${minimum} and ${maximum} entries`)
  }
  const parsed = value.map((item) => {
    if ((typeof item !== 'string' && !Number.isSafeInteger(item)) || String(item).length > maxLength) {
      throw invalid(field, `${field} contains an invalid identifier`)
    }
    const normalized = String(item).trim()
    if (normalized === '') throw invalid(field, `${field} contains an empty identifier`)
    return normalized
  })
  if (new Set(parsed.map((item) => item.toLowerCase())).size !== parsed.length) {
    throw invalid(field, `${field} contains duplicate entries`)
  }
  return [...parsed].sort((left, right) => left.localeCompare(right))
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(field, `${field} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(field, `${field} is invalid`)
  }
  const normalized = value.trim()
  if (!allowEmpty && normalized === '') throw invalid(field, `${field} must not be empty`)
  return normalized
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SAFE) {
    throw invalid(field, `${field} must be an exact non-negative integer`)
  }
  return value as number
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === undefined || value === null ? null : integer(value, field)
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requireResourceId(String(value), field.replace(/[^a-z0-9]+/gi, '_'))
}

function pattern(value: string, field: string): string {
  const first = value.indexOf('*')
  if (first !== -1 && (first !== value.length - 1 || value.indexOf('*', first + 1) !== -1)) {
    throw invalid(field, `${field} only supports a single trailing wildcard`)
  }
  return value
}

function normalizePattern(value: string): string {
  const suffix = value.endsWith('*') ? '*' : ''
  let prefix = (suffix === '' ? value : value.slice(0, -1)).trim().toLowerCase()
  if (prefix.startsWith('claude-')) prefix = prefix.replaceAll('.', '-')
  return prefix + suffix
}

function invalid(field: string, message: string): GatewayError {
  return new GatewayError(400, `invalid_${field.replace(/[^a-z0-9]+/gi, '_')}`, message)
}
