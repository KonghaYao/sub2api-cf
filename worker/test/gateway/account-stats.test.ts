import { beforeEach, describe, expect, it } from 'vitest'
import { resolveAccountCostSnapshot } from '../../src/gateway/account-stats'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('gateway account-cost snapshots', () => {
  let raw: any
  let d1: D1Database

  beforeEach(() => {
    ;({ raw, d1 } = createSqliteD1())
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO users (id,email,display_name,role,status,balance_micros,state_version,created_at_ms,updated_at_ms)
      VALUES ('user-1','user@example.com','','user','active',1000000,0,1,1);
      INSERT INTO "groups" (id,name,platform,enabled,created_at_ms,updated_at_ms)
      VALUES ('group-1','Default','openai',1,1,1);
      INSERT INTO accounts (id,platform,name,credential_ref,enabled,max_concurrency,created_at_ms,updated_at_ms,billing_rate_multiplier_ppm)
      VALUES ('account-1','openai','Primary','secret',1,1,1,1,1250000);
      INSERT INTO account_groups (account_id,group_id,priority,weight,created_at_ms,updated_at_ms)
      VALUES ('account-1','group-1',0,1,1,1);
      INSERT INTO channels (id,name,status,apply_pricing_to_account_stats,created_at_ms,updated_at_ms)
      VALUES ('channel-1','Main','active',0,1,1);
      INSERT INTO channel_groups (channel_id,group_id,created_at_ms)
      VALUES ('channel-1','group-1',1);
    `)
  })

  it('continues after a scoped rule model miss and prefers exact over wildcard pricing', async () => {
    raw.exec(`
      UPDATE channels SET apply_pricing_to_account_stats = 1 WHERE id = 'channel-1';
      INSERT INTO channel_account_stats_pricing_rules (id,channel_id,name,sort_order,created_at_ms,updated_at_ms)
      VALUES
        ('rule-miss','channel-1','miss',0,1,1),
        ('rule-match','channel-1','match',1,1,1);
      INSERT INTO channel_account_stats_rule_groups (rule_id,group_id,created_at_ms)
      VALUES ('rule-miss','group-1',1);
      INSERT INTO channel_account_stats_rule_accounts (rule_id,account_id,created_at_ms)
      VALUES ('rule-match','account-1',1);
      INSERT INTO channel_account_stats_model_pricing
        (id,rule_id,platform,billing_mode,input_micros_per_million,output_micros_per_million,sort_order,created_at_ms,updated_at_ms)
      VALUES
        ('price-miss','rule-miss','','token',9000000,9000000,0,1,1),
        ('price-wild','rule-match','','token',9000000,9000000,0,1,1),
        ('price-exact','rule-match','openai','token',2000000,4000000,1,1,1);
      INSERT INTO channel_account_stats_pricing_models (pricing_id,model_pattern,is_wildcard,sort_order,created_at_ms)
      VALUES
        ('price-miss','other-*',1,0,1),
        ('price-wild','gpt-*',1,0,1),
        ('price-exact','GPT-UPSTREAM',0,0,1);
    `)

    const result = await resolveAccountCostSnapshot({ DB: d1 }, {
      accountId: 'account-1',
      groupId: 'group-1',
      platform: 'openai',
      upstreamModel: 'gpt-upstream',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, estimated: false },
      standardCostMicros: 40,
      channelPricingBasisMicros: 99,
      requestCount: 1,
    })

    // Exact custom price beats the 99µUSD channel basis:
    // (8 regular input * 2) + (5 output * 4) + (2 cache * 0) = 36µUSD.
    expect(result).toEqual({
      standard_cost_micros: 40,
      account_stats_cost_micros: 36,
      account_rate_multiplier_ppm: 1_250_000,
      account_cost_micros: 45,
    })
  })

  it('uses the left-open/right-closed token interval and optional platform match', async () => {
    raw.exec(`
      INSERT INTO channel_account_stats_pricing_rules (id,channel_id,name,sort_order,created_at_ms,updated_at_ms)
      VALUES ('rule-1','channel-1','interval',0,1,1);
      INSERT INTO channel_account_stats_rule_groups (rule_id,group_id,created_at_ms)
      VALUES ('rule-1','group-1',1);
      INSERT INTO channel_account_stats_model_pricing
        (id,rule_id,platform,billing_mode,input_micros_per_million,sort_order,created_at_ms,updated_at_ms)
      VALUES ('price-1','rule-1','','token',1000000,0,1,1);
      INSERT INTO channel_account_stats_pricing_models (pricing_id,model_pattern,is_wildcard,sort_order,created_at_ms)
      VALUES ('price-1','gpt-upstream',0,0,1);
      INSERT INTO channel_account_stats_pricing_intervals
        (id,pricing_id,min_tokens,max_tokens,tier_label,input_micros_per_million,sort_order,created_at_ms,updated_at_ms)
      VALUES
        ('interval-1','price-1',0,100,'small',3000000,0,1,1),
        ('interval-2','price-1',100,NULL,'large',7000000,1,1,1);
    `)

    const atBoundary = await resolveAccountCostSnapshot({ DB: d1 }, {
      accountId: 'account-1', groupId: 'group-1', platform: 'openai', upstreamModel: 'gpt-upstream',
      usage: { input_tokens: 100, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      standardCostMicros: 10, requestCount: 1,
    })
    const overBoundary = await resolveAccountCostSnapshot({ DB: d1 }, {
      accountId: 'account-1', groupId: 'group-1', platform: 'openai', upstreamModel: 'gpt-upstream',
      usage: { input_tokens: 101, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      standardCostMicros: 10, requestCount: 1,
    })

    expect(atBoundary.account_stats_cost_micros).toBe(300)
    expect(overBoundary.account_stats_cost_micros).toBe(707)
  })

  it('supports per-request/image rules and falls back to the standard snapshot', async () => {
    raw.exec(`
      INSERT INTO channel_account_stats_pricing_rules (id,channel_id,name,sort_order,created_at_ms,updated_at_ms)
      VALUES ('rule-image','channel-1','image',0,1,1);
      INSERT INTO channel_account_stats_rule_groups (rule_id,group_id,created_at_ms)
      VALUES ('rule-image','group-1',1);
      INSERT INTO channel_account_stats_model_pricing
        (id,rule_id,platform,billing_mode,per_request_micros,sort_order,created_at_ms,updated_at_ms)
      VALUES ('price-image','rule-image','openai','image',11,0,1,1);
      INSERT INTO channel_account_stats_pricing_models (pricing_id,model_pattern,is_wildcard,sort_order,created_at_ms)
      VALUES ('price-image','gpt-image-*',1,0,1);
    `)
    const image = await resolveAccountCostSnapshot({ DB: d1 }, {
      accountId: 'account-1', groupId: 'group-1', platform: 'openai', upstreamModel: 'gpt-image-2',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      standardCostMicros: 100, requestCount: 3,
    })
    expect(image.account_stats_cost_micros).toBe(33)
    expect(image.account_cost_micros).toBe(42)

    raw.exec(`
      INSERT INTO channel_account_stats_pricing_intervals
        (id,pricing_id,min_tokens,max_tokens,tier_label,per_request_micros,sort_order,created_at_ms,updated_at_ms)
      VALUES ('legacy-image-tier','price-image',0,NULL,'ignored',999,0,1,1)
    `)
    const legacyTier = await resolveAccountCostSnapshot({ DB: d1 }, {
      accountId: 'account-1', groupId: 'group-1', platform: 'openai', upstreamModel: 'gpt-image-2',
      usage: { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      standardCostMicros: 100, requestCount: 2,
    })
    expect(legacyTier.account_stats_cost_micros).toBe(22)

    raw.exec(`DELETE FROM channel_account_stats_pricing_rules`)
    const fallback = await resolveAccountCostSnapshot({ DB: d1 }, {
      accountId: 'account-1', groupId: 'group-1', platform: 'openai', upstreamModel: 'unpriced',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      standardCostMicros: 101, requestCount: 1,
    })
    expect(fallback).toEqual({
      standard_cost_micros: 101,
      account_stats_cost_micros: null,
      account_rate_multiplier_ppm: 1_250_000,
      account_cost_micros: 127,
    })
  })

  it('uses the channel pricing basis when the active channel enables account statistics pricing', async () => {
    raw.exec(`UPDATE channels SET apply_pricing_to_account_stats = 1 WHERE id = 'channel-1'`)
    const result = await resolveAccountCostSnapshot({ DB: d1 }, {
      accountId: 'account-1', groupId: 'group-1', platform: 'openai', upstreamModel: 'gpt-upstream',
      usage: { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      standardCostMicros: 80, channelPricingBasisMicros: 64, requestCount: 1,
    })
    expect(result.account_stats_cost_micros).toBe(64)
    expect(result.account_cost_micros).toBe(80)
  })

  it('ignores a channel pricing basis when the toggle is disabled or the basis is invalid', async () => {
    const disabled = await resolveAccountCostSnapshot({ DB: d1 }, {
      accountId: 'account-1', groupId: 'group-1', platform: 'openai', upstreamModel: 'gpt-upstream',
      usage: { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      standardCostMicros: 80, channelPricingBasisMicros: 64, requestCount: 1,
    })
    raw.exec(`UPDATE channels SET apply_pricing_to_account_stats = 1 WHERE id = 'channel-1'`)
    const invalid = await resolveAccountCostSnapshot({ DB: d1 }, {
      accountId: 'account-1', groupId: 'group-1', platform: 'openai', upstreamModel: 'gpt-upstream',
      usage: { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      standardCostMicros: 80, channelPricingBasisMicros: Number.MAX_SAFE_INTEGER + 1, requestCount: 1,
    })
    expect(disabled.account_stats_cost_micros).toBeNull()
    expect(disabled.account_cost_micros).toBe(100)
    expect(invalid.account_stats_cost_micros).toBeNull()
    expect(invalid.account_cost_micros).toBe(100)
  })

  it('uses the routed upstream catalog snapshot as the default basis and preserves service tier pricing', async () => {
    const result = await resolveAccountCostSnapshot({ DB: d1 }, {
      accountId: 'account-1', groupId: 'group-1', platform: 'openai', upstreamModel: 'gpt-5.6-upstream',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, estimated: false },
      standardCostMicros: 40,
      accountCostBasePrice: {
        input_micros_per_million: 3_000_000,
        output_micros_per_million: 7_000_000,
        cache_read_micros_per_million: 1_000_000,
        per_request_micros: 2,
      },
      serviceTier: 'priority',
      requestCount: 1,
    })

    // B base: ((8 * 3) + (5 * 7) + (2 * 1) + 2) * priority 2x = 126µUSD.
    expect(result).toEqual({
      standard_cost_micros: 126,
      account_stats_cost_micros: null,
      account_rate_multiplier_ppm: 1_250_000,
      account_cost_micros: 158,
    })
  })

  it('keeps settlement compatible with a pre-v0.31 database', async () => {
    const legacy = createSqliteD1()
    applyMigrations(legacy.raw, 52)
    const result = await resolveAccountCostSnapshot({ DB: legacy.d1 }, {
      accountId: 'missing', groupId: 'missing', platform: 'openai', upstreamModel: 'gpt-upstream',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, estimated: false },
      standardCostMicros: 25, requestCount: 1,
    })
    expect(result).toEqual({
      standard_cost_micros: 25,
      account_stats_cost_micros: null,
      account_rate_multiplier_ppm: 1_000_000,
      account_cost_micros: 25,
    })
  })

  it('retains a resolved account multiplier when optional rule lookup fails', async () => {
    const partiallyAvailable = {
      prepare(query: string) {
        if (query.includes('channel_account_stats_pricing_rules')) throw new Error('rules unavailable')
        return d1.prepare(query)
      },
    } as D1Database
    const result = await resolveAccountCostSnapshot({ DB: partiallyAvailable }, {
      accountId: 'account-1', groupId: 'group-1', platform: 'openai', upstreamModel: 'gpt-upstream',
      usage: { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      standardCostMicros: 81, requestCount: 1,
    })
    expect(result).toEqual({
      standard_cost_micros: 81,
      account_stats_cost_micros: null,
      account_rate_multiplier_ppm: 1_250_000,
      account_cost_micros: 102,
    })
  })

  it('ignores custom pricing and the toggle from an inactive channel while retaining the account multiplier', async () => {
    raw.exec(`
      UPDATE channels
         SET status = 'inactive', apply_pricing_to_account_stats = 1
       WHERE id = 'channel-1';
      INSERT INTO channel_account_stats_pricing_rules (id,channel_id,name,sort_order,created_at_ms,updated_at_ms)
      VALUES ('inactive-rule','channel-1','inactive',0,1,1);
      INSERT INTO channel_account_stats_rule_groups (rule_id,group_id,created_at_ms)
      VALUES ('inactive-rule','group-1',1);
      INSERT INTO channel_account_stats_model_pricing
        (id,rule_id,platform,billing_mode,per_request_micros,sort_order,created_at_ms,updated_at_ms)
      VALUES ('inactive-price','inactive-rule','openai','per_request',999,0,1,1);
      INSERT INTO channel_account_stats_pricing_models (pricing_id,model_pattern,is_wildcard,sort_order,created_at_ms)
      VALUES ('inactive-price','gpt-upstream',0,0,1);
    `)
    const result = await resolveAccountCostSnapshot({ DB: d1 }, {
      accountId: 'account-1', groupId: 'group-1', platform: 'openai', upstreamModel: 'gpt-upstream',
      usage: { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      standardCostMicros: 80, channelPricingBasisMicros: 64, requestCount: 1,
    })
    expect(result).toEqual({
      standard_cost_micros: 80,
      account_stats_cost_micros: null,
      account_rate_multiplier_ppm: 1_250_000,
      account_cost_micros: 100,
    })
  })

  it('fails soft to a 1x standard snapshot when a stored multiplier overflows the safe integer boundary', async () => {
    raw.prepare('UPDATE accounts SET billing_rate_multiplier_ppm = ? WHERE id = ?')
      .run(Number.MAX_SAFE_INTEGER, 'account-1')
    const result = await resolveAccountCostSnapshot({ DB: d1 }, {
      accountId: 'account-1', groupId: 'group-1', platform: 'openai', upstreamModel: 'gpt-upstream',
      usage: { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, estimated: false },
      standardCostMicros: Number.MAX_SAFE_INTEGER, requestCount: 1,
    })
    expect(result).toEqual({
      standard_cost_micros: Number.MAX_SAFE_INTEGER,
      account_stats_cost_micros: null,
      account_rate_multiplier_ppm: 1_000_000,
      account_cost_micros: Number.MAX_SAFE_INTEGER,
    })
  })
})
