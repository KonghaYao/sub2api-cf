import { describe, expect, it, vi } from 'vitest'
import type { Env, UsageSettledPayload } from '../../src/env'
import { consumeEvents, createUsageEvent } from '../../src/gateway/queue'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('account-cost D1 projection', () => {
  it('persists the complete immutable snapshot with the usage row', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    raw.exec(`
      INSERT INTO users (id,email,display_name,role,status,balance_micros,state_version,created_at_ms,updated_at_ms)
      VALUES ('user-1','projection@example.com','','user','active',1000000,0,1,1);
      INSERT INTO "groups" (id,name,platform,enabled,created_at_ms,updated_at_ms)
      VALUES ('group-1','Projection','openai',1,1,1);
      INSERT INTO api_keys (id,user_id,key_hash,name,enabled,created_at_ms,updated_at_ms,group_id)
      VALUES ('key-1','user-1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','',1,1,1,'group-1');
      INSERT INTO accounts (id,platform,name,credential_ref,enabled,max_concurrency,created_at_ms,updated_at_ms)
      VALUES ('account-1','openai','Projection','secret',1,1,1,1);
      INSERT INTO models (id,platform,public_name,upstream_name,endpoint,enabled,created_at_ms,updated_at_ms)
      VALUES ('model-1','openai','gpt-public','gpt-upstream','both',1,1,1);
      INSERT INTO group_models (group_id,model_id,enabled,sort_order,max_output_tokens,default_max_output_tokens,created_at_ms,updated_at_ms)
      VALUES ('group-1','model-1',1,0,16384,4096,1,1);
      INSERT INTO model_prices
        (id,group_id,model_id,version,active,input_micros_per_million,output_micros_per_million,
         cache_read_micros_per_million,per_request_micros,minimum_reservation_micros,effective_at_ms,created_at_ms)
      VALUES ('price-1','group-1','model-1',1,1,2000000,4000000,500000,0,1,1,1);
    `)
    const payload: UsageSettledPayload = {
      request_id: 'request-1', user_id: 'user-1', api_key_id: 'key-1', group_id: 'group-1',
      billing_type: 'balance', subscription_id: null, account_id: 'account-1', price_id: 'price-1',
      requested_model: 'gpt-public', upstream_model: 'gpt-upstream',
      input_tokens: 10, output_tokens: 5, cache_read_tokens: 2,
      input_amount_micros: 16, output_amount_micros: 20, cache_amount_micros: 1,
      base_amount_micros: 3, amount_micros: 40,
      standard_cost_micros: 50, account_stats_cost_micros: 32,
      account_rate_multiplier_ppm: 1_250_000, account_cost_micros: 40,
      outcome: 'completed', stream: false, platform: 'openai', request_type: 1,
      inbound_endpoint: '/v1/chat/completions', upstream_endpoint: '/v1/responses',
      billing_mode: 'token', native_compaction_v2: false, duration_ms: 12, estimated: false,
    }
    const item = {
      id: 'message-1', timestamp: new Date(), body: createUsageEvent(payload, 1_000), attempts: 1,
      ack: vi.fn(), retry: vi.fn(),
    }

    await consumeEvents(
      { queue: 'events', messages: [item] } as unknown as MessageBatch<unknown>,
      { DB: d1 } as Env,
    )

    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
    expect(raw.prepare(`
      SELECT standard_cost_micros, account_stats_cost_micros,
             account_rate_multiplier_ppm, account_cost_micros,
             account_stats_rollup_version
        FROM usage_projection WHERE event_id = ?
    `).get('usage:request-1')).toEqual({
      standard_cost_micros: 50,
      account_stats_cost_micros: 32,
      account_rate_multiplier_ppm: 1_250_000,
      account_cost_micros: 40,
      account_stats_rollup_version: 1,
    })
    expect(raw.prepare(`
      SELECT account_id, bucket_start_ms, model, inbound_endpoint, upstream_endpoint,
             requests, input_tokens, output_tokens, cache_read_tokens,
             standard_cost_micros, account_cost_micros, user_cost_micros,
             duration_total_ms, duration_count
        FROM account_usage_15m_rollup
    `).get()).toEqual({
      account_id: 'account-1', bucket_start_ms: 0, model: 'gpt-public',
      inbound_endpoint: '/v1/chat/completions', upstream_endpoint: '/v1/responses',
      requests: 1, input_tokens: 10, output_tokens: 5, cache_read_tokens: 2,
      standard_cost_micros: 50, account_cost_micros: 40, user_cost_micros: 40,
      duration_total_ms: 12, duration_count: 1,
    })
    raw.close()
  })
})
