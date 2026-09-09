import { persistAccountTempUnschedulable } from '../../src/gateway/account-temp-unschedulable'
import { accountModelRateLimited } from '../../src/gateway/account-model-rate-limit'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import {
  getAccountCredential,
  listModels,
  resolveGatewayRoute,
  resolveResponseModelPricing,
} from '../../src/gateway/repository'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
import { persistOpenAIRateLimit } from '../../src/gateway/openai-rate-limit-persistence'

describe('gateway repository embeddings routing', () => {
  it('enforces the same privacy gate through external channel aliases', async () => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}'); seedChannel(raw, { restrictModels: false })
    try {
      raw.exec(`INSERT INTO channel_model_mappings(channel_id,platform,source_pattern,target_pattern,source_is_wildcard,target_is_wildcard,sort_order,created_at_ms)
        VALUES('channel-openai','openai','privacy-alias','openai-public',0,0,0,1);
        UPDATE "groups" SET ui_config_json='{"require_privacy_set":true}' WHERE id='group-openai'`)
      const route = () => resolveGatewayRoute({ DB: d1 } as Env, 'group-openai', 'privacy-alias', 'responses', 'user-1')
      await expect(route()).rejects.toMatchObject({ code: 'no_upstream_accounts' })
      raw.exec(`UPDATE accounts SET ui_config_json='{"extra":{"privacy_mode":"training_off"}}' WHERE platform='openai'`)
      await expect(route()).resolves.toMatchObject({ candidates: [{ platform: 'openai' }] })
    } finally { raw.close() }
  })

  it('does not invent privacy requirements for Gemini accounts', async () => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
    seedProviderRoute(raw, 'gemini', 'gemini', 'x-goog-api-key', '{}')
    try {
      raw.exec(`UPDATE "groups" SET ui_config_json='{"require_privacy_set":true}' WHERE id='group-gemini'`)
      await expect(resolveGatewayRoute({ DB: d1 } as Env, 'group-gemini', 'gemini-public', 'responses', 'user-1'))
        .resolves.toMatchObject({ candidates: [{ platform: 'gemini' }] })
    } finally { raw.close() }
  })

  it('applies privacy per group at selection and final read without poisoning the shared account', async () => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw); seedEmbeddingRoute(raw)
    const env = { DB: d1 } as Env
    try {
      const route = () => resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1')
      const credential = () => getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1')
      await expect(route()).resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })
      raw.exec(`UPDATE "groups" SET ui_config_json='{"require_privacy_set":true}' WHERE id='group-1'`)
      await expect(route()).rejects.toMatchObject({ code: 'no_upstream_accounts' })
      await expect(credential()).rejects.toMatchObject({ code: 'credential_unavailable' })
      for (const privacy of ['training_set_failed', 'training_set_cf_blocked', 'training_off ', null]) {
        raw.prepare('UPDATE accounts SET ui_config_json=? WHERE id=?').run(JSON.stringify({ extra: { privacy_mode: privacy } }), 'account-1')
        await expect(credential()).rejects.toMatchObject({ code: 'credential_unavailable' })
      }
      raw.exec(`UPDATE accounts SET ui_config_json='{"extra":{"privacy_mode":"training_off"}}' WHERE id='account-1'`)
      await expect(route()).resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })
      await expect(credential()).resolves.toMatchObject({ account_id: 'account-1' })
      raw.exec(`UPDATE accounts SET ui_config_json='{}' WHERE id='account-1'; UPDATE "groups" SET ui_config_json='{"require_privacy_set":false}' WHERE id='group-1'`)
      await expect(route()).resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })
      expect(raw.prepare('SELECT health_status FROM accounts WHERE id=?').get('account-1').health_status).toBe('unknown')
    } finally { raw.close() }
  })

  it.each(['total', 'daily', 'weekly'])('blocks final credential reads when %s account quota reaches its limit', async dimension => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw); seedEmbeddingRoute(raw)
    const env = { DB: d1 } as Env
    try {
      const prefix = dimension === 'total' ? 'quota' : `quota_${dimension}`
      const extra = { [`${prefix}_limit`]: 10, [`${prefix}_used`]: 9, [`${prefix}_start`]: new Date().toISOString() }
      const configure = () => raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify({ extra }))
      const credential = () => getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1')
      configure()
      await expect(credential()).resolves.toMatchObject({ account_id: 'account-1' })
      // A quota update after route selection must invalidate the final read.
      extra[`${prefix}_used`] = 10; configure()
      await expect(credential()).rejects.toMatchObject({ code: 'credential_unavailable', status: 503 })
      await expect(resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1')).rejects.toMatchObject({ code: 'no_upstream_accounts' })
      if (dimension === 'total') extra[`${prefix}_used`] = 0
      else extra[`${prefix}_start`] = '2000-01-01T00:00:00Z'
      configure()
      await expect(credential()).resolves.toMatchObject({ account_id: 'account-1' })
    } finally { raw.close() }
  })

  it.each(['header', 'body', 'unknown', 'race', 'oversized'])('persists actual upstream 429 against the selected credential snapshot: %s', async source => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw); seedEmbeddingRoute(raw)
    const env = { DB: d1 } as Env
    try {
      const credential = () => getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1')
      const account = await credential()
      expect(account.runtime_snapshot).toBeDefined()
      if (source === 'race') raw.exec('UPDATE accounts SET config_version=config_version+1,control_version=control_version+1')
      const body = source === 'unknown' ? '{}' : source === 'oversized' ? 'x'.repeat(65537)
        : JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 120 } })
      const response = new Response(body, { status: 429, headers: source === 'header' ? { 'x-codex-primary-reset-after-seconds': '300' } : {} })
      const saved = await persistOpenAIRateLimit(env, account, response)
      expect(await response.text()).toBe(body)
      expect(saved).toBe(source === 'header' || source === 'body')
      const row = raw.prepare('SELECT * FROM accounts WHERE id=?').get('account-1') as any
      if (saved) {
        const reset = Date.parse(JSON.parse(row.ui_config_json).rate_limit_reset_at)
        expect(reset).toBeGreaterThan(Date.now() + (source === 'header' ? 290000 : 110000))
        expect(row.control_version).toBe(account.runtime_snapshot!.control_version + 1)
        await expect(credential()).rejects.toMatchObject({ code: 'credential_unavailable' })
      } else {
        expect(JSON.parse(row.ui_config_json)).not.toHaveProperty('rate_limit_reset_at')
        await expect(credential()).resolves.toMatchObject({ account_id: 'account-1' })
      }
    } finally { raw.close() }
  })

  it.each(['temp_unschedulable_until', 'overload_until'])('honors %s at discovery, selection and final reads until expiry', async field => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw); seedEmbeddingRoute(raw)
    const env = { DB: d1 } as Env
    try {
      const route = () => resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1')
      const credential = () => getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1')
      await expect(route()).resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })
      raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify({ [field]: new Date(Date.now() + 60000).toISOString() }))
      expect(await listModels(env, 'group-1')).toEqual([])
      await expect(route()).rejects.toMatchObject({ code: 'no_upstream_accounts' })
      await expect(credential()).rejects.toMatchObject({ code: 'credential_unavailable' })
      raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify({ [field]: new Date(Date.now() - 1000).toISOString() }))
      await expect(route()).resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })
      await expect(credential()).resolves.toMatchObject({ account_id: 'account-1' })
    } finally { raw.close() }
  })

  it.each(['model', 'account', 'expired', 'unmatched', 'disabled', 'custom', 'pool401', 'race', 'repeat401'])('applies original temporary error rules without widening model failures: %s', async scenario => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw); seedEmbeddingRoute(raw)
    const env = { DB: d1 } as Env
    try {
      const model = 'mapped-embed'
      const ui = { credentials: { model_mapping: { 'text-embedding-test': model } }, extra: { keep: true },
        ...(scenario === 'repeat401' ? { temp_unschedulable_until: '2000-01-01T00:00:00Z', temp_unschedulable_reason: JSON.stringify({ status_code: 401 }) } : {}) }
      raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify(ui))
      const account = await getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1', 'text-embedding-test')
      if (scenario === 'race') raw.exec('UPDATE accounts SET control_version=control_version+1')
      const code = ['account', 'pool401', 'repeat401'].includes(scenario) ? 401 : 400
      const credential = { api_key: 'test', temp_unschedulable_enabled: scenario !== 'disabled', custom_error_codes_enabled: scenario === 'custom', pool_mode: scenario === 'pool401',
        temp_unschedulable_rules: [{ error_code: code, keywords: [' Maintenance '], duration_minutes: '2' }] }
      const response = new Response(scenario === 'unmatched' ? 'other error' : 'MODEL MAINTENANCE', { status: code })
      const matched = await persistAccountTempUnschedulable(env, account, credential, response, model)
      expect(await response.text()).toBe(scenario === 'unmatched' ? 'other error' : 'MODEL MAINTENANCE')
      expect(matched).toBe(!['unmatched', 'disabled', 'custom', 'pool401'].includes(scenario))
      let row = raw.prepare('SELECT * FROM accounts WHERE id=?').get('account-1') as any
      const after = JSON.parse(row.ui_config_json)
      expect(after.extra.keep).toBe(true)
      if (scenario === 'repeat401') expect(row.health_status).toBe('unhealthy')
      else expect(row.health_status).toBe('unknown')
      if (scenario === 'account') expect(Date.parse(after.temp_unschedulable_until)).toBeGreaterThan(Date.now())
      if (['model', 'expired'].includes(scenario)) {
        expect(after).not.toHaveProperty('temp_unschedulable_until')
        expect(accountModelRateLimited(after, 'text-embedding-test', 'openai')).toBe(true)
        expect(accountModelRateLimited(after, 'unrelated-model', 'openai')).toBe(false)
        await expect(getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1', 'text-embedding-test')).rejects.toMatchObject({ code: 'credential_unavailable' })
        if (scenario === 'expired') {
          after.extra.model_rate_limits[model].rate_limit_reset_at = '2000-01-01T00:00:00Z'
          raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify(after))
          await expect(getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1', 'text-embedding-test')).resolves.toMatchObject({ account_id: 'account-1' })
        }
      }
      if (['unmatched', 'disabled', 'custom', 'pool401', 'race'].includes(scenario)) expect(after).toEqual(ui)
    } finally { raw.close() }
  })

  it('filters model cooldowns from normal and alias candidate selection', async () => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}'); seedChannel(raw, { restrictModels: false })
    try {
      raw.exec(`INSERT INTO channel_model_mappings(channel_id,platform,source_pattern,target_pattern,source_is_wildcard,target_is_wildcard,sort_order,created_at_ms)
        VALUES('channel-openai','openai','temp-alias','openai-public',0,0,0,1)`)
      const env = { DB: d1 } as Env
      const route = (name: string) => resolveGatewayRoute(env, 'group-openai', name, 'responses', 'user-1')
      await expect(route('openai-public')).resolves.toBeDefined()
      const row = raw.prepare('SELECT upstream_name FROM models WHERE platform=?').get('openai') as any
      raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify({ extra: { model_rate_limits: { [row.upstream_name]: { rate_limit_reset_at: '2099-01-01T00:00:00Z' } } } }))
      await expect(route('openai-public')).rejects.toMatchObject({ code: 'no_upstream_accounts' })
      await expect(route('temp-alias')).rejects.toMatchObject({ code: 'no_upstream_accounts' })
    } finally { raw.close() }
  })

  it.each(['pool', 'pool-rule', 'custom-skip', 'custom-match', 'custom-empty', 'custom-string', 'custom-pool-match', 'oauth', 'setup-token'])('honors original error policy before persisting a 429 cooldown: %s', async scenario => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw); seedEmbeddingRoute(raw)
    const env = { DB: d1 } as Env
    try {
      const custom = scenario.startsWith('custom')
      const credentials = { pool_mode: scenario.startsWith('pool') || scenario === 'custom-pool-match' || scenario === 'oauth' || scenario === 'setup-token',
        custom_error_codes_enabled: custom || scenario === 'oauth' || scenario === 'setup-token',
        custom_error_codes: scenario === 'custom-empty' ? [] : scenario === 'custom-string' ? ['503'] : ['custom-match', 'custom-pool-match'].includes(scenario) ? [429] : [503],
        temp_unschedulable_enabled: scenario === 'pool-rule', temp_unschedulable_rules: [{ error_code: 429, keywords: ['quota'], duration_minutes: 2 }] }
      const ui = { type: ['oauth', 'setup-token'].includes(scenario) ? scenario : 'apikey', credentials, extra: { quota_used: 3, keep: true } }
      raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify(ui))
      const account = await getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1')
      const response = new Response('quota unavailable', { status: 429, headers: { 'x-codex-primary-reset-after-seconds': '300' } })
      const saved = await persistOpenAIRateLimit(env, account, response)
      expect(saved).toBe(!['pool', 'pool-rule', 'custom-skip'].includes(scenario))
      expect(await response.text()).toBe('quota unavailable')
      const row = raw.prepare('SELECT * FROM accounts WHERE id=?').get('account-1') as any
      const after = JSON.parse(row.ui_config_json)
      expect(after.extra).toEqual(ui.extra)
      if (saved) await expect(getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1')).rejects.toMatchObject({ code: 'credential_unavailable' })
      else { expect(after).toEqual(ui); expect(row.control_version).toBe(account.runtime_snapshot!.control_version) }
      if (scenario === 'pool-rule') {
        expect(await persistAccountTempUnschedulable(env, account, { api_key: 'test', ...credentials }, new Response('quota unavailable', { status: 429 }), 'model')).toBe(true)
        expect(JSON.parse(raw.prepare('SELECT ui_config_json FROM accounts WHERE id=?').get('account-1').ui_config_json).extra.model_rate_limits.model).toBeDefined()
      }
    } finally { raw.close() }
  })

  it.each(['temporary', '429'])('merges a %s observation across automatic probe metadata without losing either result', async kind => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw); seedEmbeddingRoute(raw)
    const env = { DB: d1 } as Env
    try {
      const account = await getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1')
      raw.exec("UPDATE accounts SET config_version=config_version+1,ui_config_json=json_set(ui_config_json,'$.extra.openai_responses_supported',json('true'))")
      const response = new Response('maintenance', { status: kind === '429' ? 429 : 400, headers: { 'x-codex-primary-reset-after-seconds': '120' } })
      const saved = kind === '429' ? await persistOpenAIRateLimit(env, account, response) : await persistAccountTempUnschedulable(env, account,
        { api_key: 'test', temp_unschedulable_enabled: true, temp_unschedulable_rules: [{ error_code: 400, keywords: ['maintenance'], duration_minutes: 2 }] } as any, response, 'model')
      expect(saved).toBe(true)
      const ui = JSON.parse(raw.prepare('SELECT ui_config_json FROM accounts').get().ui_config_json)
      expect(ui.extra.openai_responses_supported).toBe(true)
      if (kind === '429') expect(Date.parse(ui.rate_limit_reset_at)).toBeGreaterThan(Date.now())
      else expect(ui.extra.model_rate_limits.model).toBeDefined()
    } finally { raw.close() }
  })

  it('applies persisted cooldown at discovery, route selection and cached-route credential reads until expiry', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw); seedEmbeddingRoute(raw)
    const env = { DB: d1 } as Env
    try {
      const route = () => resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1')
      const credential = () => getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1')
      await expect(route()).resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })
      raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify({ rate_limit_reset_at: new Date(Date.now() + 60000).toISOString() }))
      expect(await listModels(env, 'group-1')).toEqual([])
      await expect(route()).rejects.toMatchObject({ code: 'no_upstream_accounts' })
      await expect(credential()).rejects.toMatchObject({ code: 'credential_unavailable' })
      raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify({ rate_limit_reset_at: new Date(Date.now() - 1000).toISOString() }))
      expect(await listModels(env, 'group-1')).toHaveLength(1)
      await expect(route()).resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })
      await expect(credential()).resolves.toMatchObject({ account_id: 'account-1' })
    } finally { raw.close() }
  })

  it('enforces account expiry at discovery, selection and final credential reads, with explicit opt-out', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedEmbeddingRoute(raw)
    const env = { DB: d1 } as Env
    try {
      const configure = (value: object) => raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify(value))
      const route = () => resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1')
      const credential = () => getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1')
      configure({ expires_at: Math.floor(Date.now() / 1000) + 60, load_factor: 7 })
      await expect(route()).resolves.toMatchObject({ candidates: [{ account_id: 'account-1', load_factor: 7 }] })
      await expect(credential()).resolves.toMatchObject({ account_id: 'account-1' })
      // Simulate expiration after a route was selected: credential access must
      // reject it even when the caller still holds the old candidate snapshot.
      configure({ expires_at: Math.floor(Date.now() / 1000) })
      expect(await listModels(env, 'group-1')).toEqual([])
      await expect(route()).rejects.toMatchObject({ code: 'no_upstream_accounts' })
      await expect(credential()).rejects.toMatchObject({ code: 'credential_unavailable' })
      for (const config of [{ expires_at: 1, auto_pause_on_expired: false }, { expires_at: 0 }, { expires_at: null }]) {
        configure(config)
        expect(await listModels(env, 'group-1')).toHaveLength(1)
        await expect(route()).resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })
        await expect(credential()).resolves.toMatchObject({ account_id: 'account-1' })
      }
    } finally { raw.close() }
  })

  it('excludes incompatible empty-mapping OAuth accounts consistently and permits explicit mappings', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedEmbeddingRoute(raw)
    const env = { DB: d1 } as Env
    try {
      raw.exec("UPDATE accounts SET credential_kind='oauth'; UPDATE models SET upstream_name='namespace/DeepSeek-V4'")
      await expect(resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1')).rejects.toMatchObject({ code: 'no_upstream_accounts' })
      expect(await listModels(env, 'group-1')).toEqual([])
      await expect(getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1')).rejects.toMatchObject({ code: 'credential_unavailable' })
      raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify({ credentials: { model_mapping: { 'namespace/DeepSeek-V4': 'gpt-5' } } }))
      await expect(resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1')).resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })
      expect(await listModels(env, 'group-1')).toHaveLength(1)
      await expect(getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1')).resolves.toMatchObject({ upstream_model_name: 'gpt-5' })
      raw.exec("UPDATE accounts SET ui_config_json='{}'; UPDATE group_models SET upstream_name_override='gpt-5'")
      // Listing must evaluate the group's overridden name, just like dispatch.
      expect(await listModels(env, 'group-1')).toHaveLength(1)
      await expect(resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1')).resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })
      await expect(getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1', 'gpt-5')).resolves.toMatchObject({ upstream_model_name: 'gpt-5' })
    } finally { raw.close() }
  })

  it.each(['responses', 'chat_completions'] as const)('bridges a single-protocol OpenAI catalog through %s with pricing and final credential checks', async endpoint => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw); seedEmbeddingRoute(raw)
    const env = { DB: d1 } as Env
    const upstream = endpoint === 'responses' ? 'chat_completions' : 'responses'
    try {
      raw.prepare('UPDATE models SET endpoint=?').run(upstream)
      raw.exec('DELETE FROM account_models')
      raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify({ original_model_routing: true, extra: { openai_responses_mode: `force_${upstream}` } }))
      const route = await resolveGatewayRoute(env, 'group-1', 'embed-public', endpoint, 'user-1', upstream, true)
      expect(route.candidates).toMatchObject([{ account_id: 'account-1', upstream_endpoint: upstream }])
      expect(route.model).toMatchObject({ model_id: 'model-1' })
      await expect(getAccountCredential(env, 'group-1', 'model-1', upstream, 'account-1')).resolves.toMatchObject({ account_id: 'account-1' })
      raw.exec('UPDATE group_models SET enabled=0')
      await expect(resolveGatewayRoute(env, 'group-1', 'embed-public', endpoint, 'user-1', upstream, true)).rejects.toMatchObject({ code: 'model_not_found' })
    } finally { raw.close() }
  })

  it.each(['responses', 'chat_completions'] as const)('combines mixed-protocol candidates by account priority for %s', async endpoint => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw); seedEmbeddingRoute(raw); seedAlternateEmbeddingAccount(raw)
    const env = { DB: d1 } as Env
    try {
      raw.exec('DELETE FROM account_models')
      for (const [id, mode, priority] of [['account-1', 'force_chat_completions', 50], ['account-2', 'force_responses', 5]] as const) {
        raw.prepare('UPDATE accounts SET ui_config_json=? WHERE id=?').run(JSON.stringify({ original_model_routing: true, extra: { openai_responses_mode: mode } }), id)
        raw.prepare('UPDATE account_groups SET priority=? WHERE account_id=?').run(priority, id)
      }
      const route = await resolveGatewayRoute(env, 'group-1', 'embed-public', endpoint, 'user-1', endpoint === 'responses' ? 'chat_completions' : 'responses', true)
      expect(route.upstream_endpoint).toBe(endpoint)
      expect(route.candidates.map(candidate => [candidate.account_id, candidate.upstream_endpoint])).toEqual([
        ['account-2', 'responses'], ['account-1', 'chat_completions'],
      ])
    } finally { raw.close() }
  })

  it.each([
    [{}, 'responses'],
    [{ openai_responses_supported: false }, 'chat_completions'],
    [{ openai_responses_supported: true, openai_responses_mode: 'force_chat_completions' }, 'chat_completions'],
    [{ openai_responses_supported: false, openai_responses_mode: 'force_responses' }, 'responses'],
  ] as const)('uses original account protocol policy %j for both public endpoints', async (extra, expected) => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw); seedEmbeddingRoute(raw)
    const env = { DB: d1 } as Env
    try {
      raw.exec('DELETE FROM account_models')
      raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify({ original_model_routing: true, extra }))
      for (const endpoint of ['responses', 'chat_completions'] as const) {
        const fallback = endpoint === 'responses' ? 'chat_completions' : 'responses'
        await expect(resolveGatewayRoute(env, 'group-1', 'embed-public', endpoint, 'user-1', fallback))
          .resolves.toMatchObject({ upstream_endpoint: expected, candidates: [{ account_id: 'account-1' }] })
      }
      await expect(getAccountCredential(env, 'group-1', 'model-1', expected, 'account-1')).resolves.toMatchObject({ account_id: 'account-1' })
      raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify({ original_model_routing: true,
        extra: { openai_responses_mode: expected === 'responses' ? 'force_chat_completions' : 'force_responses' } }))
      await expect(getAccountCredential(env, 'group-1', 'model-1', expected, 'account-1')).rejects.toMatchObject({ code: 'credential_unavailable' })
    } finally { raw.close() }
  })

  it('routes original form accounts without manual capability rows and rechecks whitelist before loading credentials', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedEmbeddingRoute(raw)
    const env = { DB: d1 } as Env
    try {
      const upstream = raw.prepare("SELECT upstream_name FROM models WHERE id='model-1'").get() as any
      raw.exec('DELETE FROM account_models')
      const configure = (mapping: Record<string, string>) => raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify({ original_model_routing: true, credentials: { model_mapping: mapping } }))
      configure({ [upstream.upstream_name]: 'mapped-embedding' })
      await expect(resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1')).resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })
      expect(await listModels(env, 'group-1')).toHaveLength(1)
      await expect(getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1')).resolves.toMatchObject({ upstream_model_name: 'mapped-embedding' })
      configure({ forbidden: 'other' })
      await expect(resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1')).rejects.toMatchObject({ code: 'no_upstream_accounts' })
      expect(await listModels(env, 'group-1')).toEqual([])
      await expect(getAccountCredential(env, 'group-1', 'model-1', 'embeddings', 'account-1')).rejects.toMatchObject({ code: 'credential_unavailable' })
      configure({})
      await expect(resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1')).resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })
      raw.exec("UPDATE accounts SET ui_config_json='{}'")
      await expect(resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1')).rejects.toMatchObject({ code: 'model_not_found' })
    } finally { raw.close() }
  })

  it('excludes unschedulable accounts from routing and discovery without enabling disabled accounts', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedEmbeddingRoute(raw)
    seedAlternateEmbeddingAccount(raw)
    const env = { DB: d1 } as Env
    try {
      raw.exec(`UPDATE accounts SET ui_config_json = '{"schedulable":false}' WHERE id = 'account-1'`)
      await expect(resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1'))
        .resolves.toMatchObject({ candidates: [{ account_id: 'account-2' }] })
      raw.exec(`UPDATE accounts SET ui_config_json = '{"schedulable":false}' WHERE id = 'account-2'`)
      await expect(resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1'))
        .rejects.toMatchObject({ code: 'no_upstream_accounts' })
      expect(await listModels(env, 'group-1')).toEqual([])
      raw.exec(`UPDATE accounts SET enabled = 0, ui_config_json = '{"schedulable":true}' WHERE id = 'account-1'`)
      expect(await listModels(env, 'group-1')).toEqual([])
      raw.exec(`UPDATE accounts SET enabled = 1 WHERE id = 'account-1'`)
      await expect(resolveGatewayRoute(env, 'group-1', 'embed-public', 'embeddings', 'user-1'))
        .resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })
    } finally { raw.close() }
  })

  it('routes a matching model only to its configured accounts, with exact patterns first', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedEmbeddingRoute(raw)
    seedAlternateEmbeddingAccount(raw)
    const env = { DB: d1 } as Env

    raw.prepare(`UPDATE "groups" SET ui_config_json = ? WHERE id = ?`).run(
      JSON.stringify({
        model_routing_enabled: true,
        model_routing: { 'embed-*': ['account-2'], 'embed-public': ['account-1'] },
      }),
      'group-1',
    )
    await expect(resolveGatewayRoute(
      env, 'group-1', 'embed-public', 'embeddings', 'user-1',
    )).resolves.toMatchObject({ candidates: [{ account_id: 'account-1' }] })

    raw.prepare(`UPDATE "groups" SET ui_config_json = ? WHERE id = ?`).run(
      JSON.stringify({ model_routing_enabled: true, model_routing: { 'embed-*': ['account-2'] } }),
      'group-1',
    )
    await expect(resolveGatewayRoute(
      env, 'group-1', 'embed-public', 'embeddings', 'user-1',
    )).resolves.toMatchObject({ candidates: [{ account_id: 'account-2' }] })

    raw.prepare(`UPDATE "groups" SET ui_config_json = ? WHERE id = ?`).run(
      JSON.stringify({ model_routing_enabled: true, model_routing: { 'embed-public': ['not-in-group'] } }),
      'group-1',
    )
    await expect(resolveGatewayRoute(
      env, 'group-1', 'embed-public', 'embeddings', 'user-1',
    )).rejects.toMatchObject({ status: 503, code: 'no_upstream_accounts' })
    raw.close()
  })

  it('honors model-list membership and order without changing direct routing', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedEmbeddingRoute(raw)
    seedSecondEmbeddingRoute(raw)
    raw.prepare(`UPDATE "groups" SET ui_config_json = ? WHERE id = ?`).run(
      JSON.stringify({ models_list_config: { enabled: true, models: ['embed-second', 'missing', 'embed-public'] } }),
      'group-1',
    )
    const env = { DB: d1 } as Env

    await expect(listModels(env, 'group-1')).resolves.toMatchObject([
      { public_name: 'embed-second' },
      { public_name: 'embed-public' },
    ])
    await expect(resolveGatewayRoute(
      env, 'group-1', 'embed-public', 'embeddings', 'user-1',
    )).resolves.toMatchObject({ model: { public_name: 'embed-public' } })
    raw.close()
  })

  it('lists and resolves an embeddings route only when both model and account capabilities are enabled', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedEmbeddingRoute(raw)
    const testEnv = { DB: d1 } as Env

    const models = await listModels(testEnv, 'group-1')
    expect(models).toEqual([
      expect.objectContaining({
        model_id: 'model-1',
        public_name: 'embed-public',
        upstream_name: 'embed-upstream',
        embeddings: 1,
      }),
    ])

    const route = await resolveGatewayRoute(
      testEnv,
      'group-1',
      'embed-public',
      'embeddings',
      'user-1',
    )
    expect(route.model).toMatchObject({ model_id: 'model-1', embeddings: 1 })
    expect(route.candidates).toEqual([
      expect.objectContaining({ account_id: 'account-1', base_url: 'https://upstream.example/v1' }),
    ])

    const credential = await getAccountCredential(testEnv, 'group-1', 'model-1', 'embeddings', 'account-1')
    expect(credential).toMatchObject({ account_id: 'account-1', secret_id: 'secret-1' })

    raw.prepare('UPDATE account_models SET embeddings = 0, updated_at_ms = 2 WHERE account_id = ? AND model_id = ?')
      .run('account-1', 'model-1')
    await expect(resolveGatewayRoute(
      testEnv,
      'group-1',
      'embed-public',
      'embeddings',
      'user-1',
    )).rejects.toMatchObject({
      status: 404,
      code: 'model_not_found',
    })
    await expect(
      getAccountCredential(testEnv, 'group-1', 'model-1', 'embeddings', 'account-1'),
    ).rejects.toMatchObject({ status: 503, code: 'credential_unavailable' })
    raw.close()
  })

  it('does not resolve embeddings when only the account capability is enabled', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedEmbeddingRoute(raw)
    raw.prepare('UPDATE models SET embeddings = 0, updated_at_ms = 2 WHERE id = ?').run('model-1')

    await expect(
      resolveGatewayRoute(
        { DB: d1 } as Env,
        'group-1',
        'embed-public',
        'embeddings',
        'user-1',
      ),
    ).rejects.toMatchObject({ status: 404, code: 'model_not_found' })
    raw.close()
  })

  it('keeps unknown accounts schedulable while excluding unhealthy accounts from every route seam', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedEmbeddingRoute(raw)
    raw.exec(`
      INSERT INTO accounts (
        id, platform, name, credential_ref, enabled, max_concurrency,
        created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version,
        health_status
      ) VALUES (
        'account-2', 'openai', 'unknown-health', 'secret-2', 1, 4,
        1, 1, 'openai', 'https://upstream-two.example/v1', 'bearer', 1,
        'unknown'
      );
      INSERT INTO account_secrets (
        id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
      ) VALUES ('secret-2', 'account-2', 1, 'nonce-2', 'ciphertext-2', 1, 1);
      INSERT INTO account_groups (
        account_id, group_id, priority, weight, created_at_ms, updated_at_ms
      ) VALUES ('account-2', 'group-1', 1, 1, 1, 1);
      INSERT INTO account_models (
        account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms
      ) VALUES ('account-2', 'model-1', 0, 0, 1, 1, 1);
      UPDATE accounts SET health_status = 'unhealthy' WHERE id = 'account-1';
    `)
    const testEnv = { DB: d1 } as Env

    await expect(listModels(testEnv, 'group-1')).resolves.toHaveLength(1)
    const route = await resolveGatewayRoute(
      testEnv,
      'group-1',
      'embed-public',
      'embeddings',
      'user-1',
    )
    expect(route.candidates.map((candidate) => candidate.account_id)).toEqual(['account-2'])
    await expect(
      getAccountCredential(testEnv, 'group-1', 'model-1', 'embeddings', 'account-1'),
    ).rejects.toMatchObject({ status: 503, code: 'credential_unavailable' })
    await expect(
      getAccountCredential(testEnv, 'group-1', 'model-1', 'embeddings', 'account-2'),
    ).resolves.toMatchObject({ account_id: 'account-2' })

    raw.prepare("UPDATE accounts SET health_status = 'unhealthy' WHERE id = ?").run('account-2')
    await expect(listModels(testEnv, 'group-1')).resolves.toEqual([])
    await expect(resolveGatewayRoute(
      testEnv,
      'group-1',
      'embed-public',
      'embeddings',
      'user-1',
    )).rejects.toMatchObject({ status: 503, code: 'no_upstream_accounts' })
    raw.close()
  })
})

describe('gateway repository image routing', () => {
  it('lists, resolves and loads credentials only when model and account image capabilities are enabled', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedImageRoute(raw)
    const testEnv = { DB: d1 } as Env

    await expect(listModels(testEnv, 'group-images')).resolves.toEqual([
      expect.objectContaining({
        model_id: 'model-images',
        public_name: 'gpt-image-public',
        image_generation: 1,
      }),
    ])
    const route = await resolveGatewayRoute(
      testEnv,
      'group-images',
      'gpt-image-public',
      'images',
      'user-1',
    )
    expect(route.upstream_endpoint).toBe('images')
    expect(route.model).toMatchObject({ model_id: 'model-images', image_generation: 1 })
    expect(route.candidates).toEqual([
      expect.objectContaining({
        account_id: 'account-images',
        image_adapter: 'direct_images',
        credential_kind: 'api_key',
      }),
    ])
    await expect(getAccountCredential(
      testEnv,
      'group-images',
      'model-images',
      'images',
      'account-images',
    )).resolves.toMatchObject({
      account_id: 'account-images',
      secret_id: 'secret-images',
      image_adapter: 'direct_images',
      credential_kind: 'api_key',
    })

    raw.prepare(`UPDATE account_models SET image_generation = 0 WHERE account_id = 'account-images'`)
      .run()
    await expect(resolveGatewayRoute(
      testEnv,
      'group-images',
      'gpt-image-public',
      'images',
      'user-1',
    )).rejects.toMatchObject({ status: 404, code: 'model_not_found' })
    await expect(getAccountCredential(
      testEnv,
      'group-images',
      'model-images',
      'images',
      'account-images',
    )).rejects.toMatchObject({ status: 503, code: 'credential_unavailable' })
    raw.close()
  })

  it('does not resolve an image route when only the account capability is enabled', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedImageRoute(raw)
    raw.prepare(`UPDATE models SET image_generation = 0 WHERE id = 'model-images'`).run()

    await expect(resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-images',
      'gpt-image-public',
      'images',
      'user-1',
    )).rejects.toMatchObject({ status: 404, code: 'model_not_found' })
    raw.close()
  })
})

describe('gateway repository provider routing', () => {
  it('keeps primary protocol cohorts separate and falls back from Chat to Responses explicitly', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    raw.prepare("UPDATE models SET endpoint = 'both' WHERE id = ?").run('model-openai')
    const testEnv = { DB: d1 } as Env

    await expect(listModels(testEnv, 'group-openai')).resolves.toEqual([
      expect.objectContaining({ public_name: 'openai-public', endpoint: 'both' }),
    ])
    await expect(resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'chat_completions',
      'user-1',
    )).rejects.toMatchObject({ status: 503, code: 'no_upstream_accounts' })

    const bridged = await resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'chat_completions',
      'user-1',
      'responses',
    )
    expect(bridged.upstream_endpoint).toBe('responses')
    expect(bridged.candidates.map((candidate) => candidate.account_id)).toEqual(['account-openai'])
    await expect(getAccountCredential(
      testEnv,
      'group-openai',
      'model-openai',
      'responses',
      'account-openai',
    )).resolves.toMatchObject({ account_id: 'account-openai' })
    await expect(getAccountCredential(
      testEnv,
      'group-openai',
      'model-openai',
      'chat_completions',
      'account-openai',
    )).rejects.toMatchObject({ status: 503, code: 'credential_unavailable' })

    raw.exec(`
      INSERT INTO accounts (
        id, platform, name, credential_ref, enabled, max_concurrency,
        created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version
      ) VALUES (
        'account-chat', 'openai', 'chat-primary', 'secret-chat', 1, 4,
        1, 1, 'openai', 'https://chat.upstream.example/v1', 'bearer', 1
      );
      INSERT INTO account_groups (
        account_id, group_id, priority, weight, created_at_ms, updated_at_ms
      ) VALUES ('account-chat', 'group-openai', 9, 1, 1, 1);
      INSERT INTO account_models (
        account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms
      ) VALUES ('account-chat', 'model-openai', 1, 0, 0, 1, 1);
    `)
    const primary = await resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'chat_completions',
      'user-1',
      'responses',
    )
    expect(primary.upstream_endpoint).toBe('chat_completions')
    expect(primary.candidates.map((candidate) => candidate.account_id)).toEqual(['account-chat'])
    raw.close()
  })

  it.each([
    ['openai', 'openai', 'bearer', '{}'],
    ['anthropic', 'anthropic', 'x-api-key', '{}'],
    ['gemini', 'gemini', 'x-goog-api-key', '{}'],
    ['codex', 'codex', 'bearer', '{"account_id":"org-codex"}'],
  ] as const)(
    'selects %s accounts for a same-platform group and projects the provider contract',
    async (platform, protocol, authScheme, providerConfigJson) => {
      const { raw, d1 } = createSqliteD1()
      applyMigrations(raw)
      seedProviderRoute(raw, platform, protocol, authScheme, providerConfigJson)
      const testEnv = { DB: d1 } as Env

      const route = await resolveGatewayRoute(
        testEnv,
        `group-${platform}`,
        `${platform}-public`,
        'responses',
        'user-1',
      )

      expect(route.model).toMatchObject({
        platform,
        model_id: `model-${platform}`,
        public_name: `${platform}-public`,
      })
      expect(route.candidates).toEqual([
        expect.objectContaining({
          account_id: `account-${platform}`,
          platform,
          protocol,
          auth_scheme: authScheme,
          provider_config: JSON.parse(providerConfigJson),
        }),
      ])
      const credential = await getAccountCredential(
        testEnv,
        `group-${platform}`,
        `model-${platform}`,
        'responses',
        `account-${platform}`,
      )
      expect(credential).toMatchObject({
        account_id: `account-${platform}`,
        platform,
        protocol,
        auth_scheme: authScheme,
        provider_config: JSON.parse(providerConfigJson),
      })
      raw.close()
    },
  )
})

describe('gateway repository channel model policy', () => {
  it('resolves an exact channel alias outside the catalog through its backing model', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES (
        'channel-openai', 'openai', 'customer-alias', 'openai-public',
        0, 0, 0, 1
      );
      INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'alias@example.test', 'Alias user', 1, 1);
      INSERT INTO user_platform_quotas (
        user_id, platform, enabled, daily_limit_micros, weekly_limit_micros,
        monthly_limit_micros, control_version, created_at_ms, updated_at_ms
      ) VALUES ('user-1', 'openai', 1, 1000, 2000, 3000, 7, 1, 1);
    `)

    const route = await resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-openai',
      'customer-alias',
      'responses',
      'user-1',
    )

    expect(route.model).toMatchObject({
      model_id: 'model-openai',
      platform: 'openai',
      public_name: 'customer-alias',
      upstream_name: 'openai-upstream',
      price_id: 'price-openai',
      account_cost_base_price_id: 'price-openai',
      account_cost_base_price_version: 1,
      account_cost_base_input_micros_per_million: 1000,
      account_cost_base_output_micros_per_million: 2000,
    })
    expect(route.candidates.map((candidate) => candidate.account_id)).toEqual(['account-openai'])
    expect(route.platform_quota).toMatchObject({
      platform: 'openai',
      control_version: 7,
      daily_limit_micros: 1000,
      weekly_limit_micros: 2000,
      monthly_limit_micros: 3000,
    })
    await expect(getAccountCredential(
      { DB: d1 } as Env,
      'group-openai',
      route.model.model_id,
      'responses',
      'account-openai',
    )).resolves.toMatchObject({
      account_id: 'account-openai',
      platform: 'openai',
      secret_id: 'secret-openai',
    })
    raw.close()
  })

  it('expands a suffix wildcard channel alias before resolving its backing model', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    raw.prepare("UPDATE models SET upstream_name = 'vendor-sol' WHERE id = 'model-openai'").run()
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES (
        'channel-openai', 'openai', 'customer-*', 'vendor-*',
        1, 1, 0, 1
      );
    `)

    const route = await resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-openai',
      'customer-sol',
      'responses',
      'user-1',
    )

    expect(route.model).toMatchObject({
      model_id: 'model-openai',
      public_name: 'customer-sol',
      upstream_name: 'vendor-sol',
    })
    expect(route.candidates.map((candidate) => candidate.account_id)).toEqual(['account-openai'])
    raw.close()
  })

  it.each([
    ['requested', 'requested-price', 'openai-public'],
    ['upstream', 'upstream-price', 'vendor-target'],
  ])(
    'matches channel pricing against the %s model source',
    async (billingSource, pricingId, matchedModel) => {
      const { raw, d1 } = createSqliteD1()
      applyMigrations(raw)
      seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
      seedChannel(raw, { restrictModels: true })
      raw.exec(`
        UPDATE channels SET billing_model_source = '${billingSource}' WHERE id = 'channel-openai';
        INSERT INTO channel_model_mappings (
          channel_id, platform, source_pattern, target_pattern,
          source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
        ) VALUES ('channel-openai', 'openai', 'openai-public', 'vendor-target', 0, 0, 0, 1);
        INSERT INTO channel_model_pricing (
          id, channel_id, platform, billing_mode, per_request_micros,
          control_version, created_at_ms, updated_at_ms
        ) VALUES
          ('requested-price', 'channel-openai', 'openai', 'per_request', 11, 1, 1, 1),
          ('upstream-price', 'channel-openai', 'openai', 'per_request', 22, 1, 1, 1);
        INSERT INTO channel_pricing_models (
          pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
        ) VALUES
          ('requested-price', 'openai-public', 0, 0, 1),
          ('upstream-price', 'vendor-target', 0, 0, 1);
      `)

      await expect(resolveGatewayRoute(
        { DB: d1 } as Env,
        'group-openai',
        'openai-public',
        'responses',
        'user-1',
      )).resolves.toMatchObject({
        model: { upstream_name: 'vendor-target' },
        customer_pricing: { pricing_id: pricingId, matched_model_pattern: matchedModel },
      })
      raw.close()
    },
  )

  it('fails closed when a composite channel alias resolves to multiple provider platforms', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    raw.prepare("UPDATE models SET upstream_name = 'shared-upstream' WHERE id = 'model-openai'").run()
    raw.prepare("UPDATE \"groups\" SET platform = 'composite' WHERE id = 'group-openai'").run()
    seedProviderRoute(raw, 'anthropic', 'anthropic', 'x-api-key', '{}')
    raw.prepare("UPDATE models SET upstream_name = 'shared-upstream' WHERE id = 'model-anthropic'").run()
    raw.exec(`
      INSERT INTO group_models (
        group_id, model_id, enabled, catalog_visible, sort_order, created_at_ms, updated_at_ms
      ) VALUES ('group-openai', 'model-anthropic', 1, 1, 1, 1, 1);
      INSERT INTO model_prices (
        id, group_id, model_id, version, active,
        input_micros_per_million, output_micros_per_million,
        cache_read_micros_per_million, per_request_micros,
        minimum_reservation_micros, effective_at_ms, created_at_ms
      ) VALUES (
        'price-composite-anthropic', 'group-openai', 'model-anthropic', 1, 1,
        3000, 4000, 0, 0, 1, 1, 1
      );
      INSERT INTO account_groups (
        account_id, group_id, priority, weight, created_at_ms, updated_at_ms
      ) VALUES ('account-anthropic', 'group-openai', 0, 1, 1, 1);
    `)
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES
        ('channel-openai', 'openai', 'shared-alias', 'shared-upstream', 0, 0, 0, 1),
        ('channel-openai', 'anthropic', 'shared-alias', 'shared-upstream', 0, 0, 0, 1);
    `)

    await expect(resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-openai',
      'shared-alias',
      'responses',
      'user-1',
    )).rejects.toMatchObject({
      status: 409,
      code: 'ambiguous_model_alias',
    })

    raw.exec(`
      DELETE FROM channel_model_mappings
       WHERE channel_id = 'channel-openai' AND platform = 'openai';
      INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'composite-alias@example.test', 'Composite alias user', 1, 1);
      INSERT INTO user_platform_quotas (
        user_id, platform, enabled, daily_limit_micros, weekly_limit_micros,
        monthly_limit_micros, control_version, created_at_ms, updated_at_ms
      ) VALUES ('user-1', 'anthropic', 1, 1100, 2200, 3300, 9, 1, 1);
    `)
    const resolved = await resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-openai',
      'shared-alias',
      'responses',
      'user-1',
    )
    expect(resolved).toMatchObject({
      model: {
        model_id: 'model-anthropic',
        platform: 'anthropic',
        public_name: 'shared-alias',
        upstream_name: 'shared-upstream',
      },
      platform_quota: {
        platform: 'anthropic',
        control_version: 9,
        daily_limit_micros: 1100,
      },
    })
    expect(resolved.candidates.map((candidate) => [candidate.account_id, candidate.platform]))
      .toEqual([['account-anthropic', 'anthropic']])
    raw.close()
  })

  it('keeps customer pricing on the requested model and snapshots a uniquely mapped catalog model for account cost', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO models (
        id, platform, public_name, upstream_name, endpoint, embeddings,
        enabled, created_at_ms, updated_at_ms
      ) VALUES (
        'model-account-cost', 'openai', 'account-cost-public', 'exact-upstream',
        'responses', 0, 1, 1, 1
      );
      INSERT INTO group_models (
        group_id, model_id, enabled, catalog_visible, sort_order, created_at_ms, updated_at_ms
      ) VALUES ('group-openai', 'model-account-cost', 1, 1, 1, 1, 1);
      INSERT INTO model_prices (
        id, group_id, model_id, version, active,
        input_micros_per_million, output_micros_per_million,
        cache_read_micros_per_million, per_request_micros,
        minimum_reservation_micros, effective_at_ms, created_at_ms
      ) VALUES (
        'price-account-cost', 'group-openai', 'model-account-cost', 7, 1,
        3000, 5000, 700, 11, 1, 1, 1
      );
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES
        ('channel-openai', 'openai', 'openai-*', 'wildcard-*', 1, 1, 0, 1),
        ('channel-openai', 'openai', 'openai-public', 'exact-upstream', 0, 0, 99, 1);
    `)

    const route = await resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )

    expect(route.model).toMatchObject({
      public_name: 'openai-public',
      upstream_name: 'exact-upstream',
      price_id: 'price-openai',
      input_micros_per_million: 1000,
      output_micros_per_million: 2000,
      account_cost_base_price_id: 'price-account-cost',
      account_cost_base_price_version: 7,
      account_cost_base_input_micros_per_million: 3000,
      account_cost_base_output_micros_per_million: 5000,
      account_cost_base_cache_read_micros_per_million: 700,
      account_cost_base_per_request_micros: 11,
    })
    expect(route.candidates.map((candidate) => candidate.account_id)).toEqual(['account-openai'])
    raw.close()
  })

  it('falls back to requested-model account-cost pricing for unknown or ambiguous mapped targets', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-openai', 'openai', 'openai-public', 'unknown-upstream', 0, 0, 0, 1);
    `)
    const testEnv = { DB: d1 } as Env

    await expect(resolveGatewayRoute(
      testEnv, 'group-openai', 'openai-public', 'responses', 'user-1',
    )).resolves.toMatchObject({
      model: {
        upstream_name: 'unknown-upstream',
        account_cost_base_price_id: 'price-openai',
        account_cost_base_input_micros_per_million: 1000,
        account_cost_base_output_micros_per_million: 2000,
      },
    })

    raw.exec(`
      INSERT INTO models (
        id, platform, public_name, upstream_name, endpoint, embeddings,
        enabled, created_at_ms, updated_at_ms
      ) VALUES
        ('ambiguous-one', 'openai', 'ambiguous-public-one', 'ambiguous-upstream', 'responses', 0, 1, 1, 1),
        ('ambiguous-two', 'openai', 'ambiguous-upstream', 'other-upstream', 'responses', 0, 1, 1, 1);
      INSERT INTO group_models (
        group_id, model_id, enabled, catalog_visible, sort_order, created_at_ms, updated_at_ms
      ) VALUES
        ('group-openai', 'ambiguous-one', 1, 1, 1, 1, 1),
        ('group-openai', 'ambiguous-two', 1, 1, 2, 1, 1);
      INSERT INTO model_prices (
        id, group_id, model_id, version, active,
        input_micros_per_million, output_micros_per_million,
        cache_read_micros_per_million, per_request_micros,
        minimum_reservation_micros, effective_at_ms, created_at_ms
      ) VALUES
        ('ambiguous-price-one', 'group-openai', 'ambiguous-one', 1, 1, 9000, 9000, 0, 0, 1, 1, 1),
        ('ambiguous-price-two', 'group-openai', 'ambiguous-two', 1, 1, 8000, 8000, 0, 0, 1, 1, 1);
      UPDATE channel_model_mappings SET target_pattern = 'ambiguous-upstream';
    `)

    await expect(resolveGatewayRoute(
      testEnv, 'group-openai', 'openai-public', 'responses', 'user-1',
    )).resolves.toMatchObject({
      model: {
        upstream_name: 'ambiguous-upstream',
        account_cost_base_price_id: 'price-openai',
        account_cost_base_input_micros_per_million: 1000,
        account_cost_base_output_micros_per_million: 2000,
      },
    })
    raw.close()
  })

  it('expands the requested suffix into a wildcard mapping target', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-openai', 'openai', 'openai-*', 'vendor-*', 1, 1, 0, 1);
    `)

    const route = await resolveGatewayRoute(
      { DB: d1 } as Env,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )

    expect(route.model.upstream_name).toBe('vendor-public')
    raw.close()
  })

  it('rejects an unmapped restricted model unless channel pricing explicitly covers it', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: true })
    const testEnv = { DB: d1 } as Env

    await expect(resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )).rejects.toMatchObject({ status: 404, code: 'model_not_found' })

    raw.exec(`
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, control_version, created_at_ms, updated_at_ms
      ) VALUES ('channel-price-openai', 'channel-openai', 'openai', 'token', 0, 1, 1);
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-price-openai', 'openai-*', 1, 0, 1);
    `)

    await expect(resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )).resolves.toMatchObject({
      model: { upstream_name: 'openai-upstream', price_id: 'price-openai' },
    })
    raw.close()
  })

  it('allows a mapped restricted model and leaves inactive channels as pass-through', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: true })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-openai', 'openai', 'openai-public', 'mapped-upstream', 0, 0, 0, 1);
    `)
    const testEnv = { DB: d1 } as Env

    await expect(resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )).resolves.toMatchObject({ model: { upstream_name: 'mapped-upstream' } })

    raw.prepare("UPDATE channels SET status = 'inactive', updated_at_ms = 2 WHERE id = 'channel-openai'").run()
    await expect(resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )).resolves.toMatchObject({ model: { upstream_name: 'openai-upstream' } })
    raw.close()
  })

  it('uses the resolved concrete model platform for composite channel mapping and pricing', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    raw.exec(`
      INSERT INTO users (id, email, display_name, created_at_ms, updated_at_ms)
      VALUES ('user-1', 'composite@example.test', 'Composite user', 1, 1);
      INSERT INTO user_platform_quotas (
        user_id, platform, enabled, daily_limit_micros, weekly_limit_micros,
        monthly_limit_micros, control_version, created_at_ms, updated_at_ms
      ) VALUES ('user-1', 'openai', 1, 1000, 2000, 3000, 4, 1, 1);
    `)
    raw.prepare("UPDATE \"groups\" SET platform = 'composite' WHERE id = 'group-openai'").run()
    seedProviderRoute(raw, 'anthropic', 'anthropic', 'x-api-key', '{}')
    raw.exec(`
      UPDATE models SET public_name = 'openai-public'
       WHERE id = 'model-anthropic';
      INSERT INTO group_models (
        group_id, model_id, enabled, catalog_visible, sort_order, created_at_ms, updated_at_ms
      ) VALUES ('group-openai', 'model-anthropic', 1, 1, 1, 1, 1);
      INSERT INTO model_prices (
        id, group_id, model_id, version, active,
        input_micros_per_million, output_micros_per_million,
        cache_read_micros_per_million, per_request_micros,
        minimum_reservation_micros, effective_at_ms, created_at_ms
      ) VALUES (
        'price-composite-anthropic', 'group-openai', 'model-anthropic', 1, 1,
        3000, 4000, 0, 0, 1, 1, 1
      );
      INSERT INTO account_groups (
        account_id, group_id, priority, weight, created_at_ms, updated_at_ms
      ) VALUES ('account-anthropic', 'group-openai', 0, 1, 1, 1);
    `)
    seedChannel(raw, { restrictModels: true })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES
        ('channel-openai', 'composite', 'openai-public', 'wrong-upstream', 0, 0, 0, 1),
        ('channel-openai', 'openai', 'openai-public', 'resolved-upstream', 0, 0, 0, 1);
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, control_version, created_at_ms, updated_at_ms
      ) VALUES ('channel-price-openai', 'channel-openai', 'openai', 'token', 0, 1, 1);
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-price-openai', 'openai-public', 0, 0, 1);
    `)
    const testEnv = { DB: d1 } as Env

    const route = await resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )
    expect(route).toMatchObject({
      model: { platform: 'openai', upstream_name: 'resolved-upstream' },
      platform_quota: {
        platform: 'openai', control_version: 4,
        daily_limit_micros: 1000, weekly_limit_micros: 2000, monthly_limit_micros: 3000,
      },
    })
    expect(route.candidates.map((candidate) => [candidate.account_id, candidate.platform]))
      .toEqual([['account-openai', 'openai']])
    await expect(getAccountCredential(
      testEnv,
      'group-openai',
      'model-openai',
      'responses',
      'account-openai',
    )).resolves.toMatchObject({
      account_id: 'account-openai', platform: 'openai', secret_id: 'secret-openai',
    })
    await expect(listModels(testEnv, 'group-openai')).resolves.toEqual([
      expect.objectContaining({ model_id: 'model-openai', platform: 'openai' }),
      expect.objectContaining({ model_id: 'model-anthropic', platform: 'anthropic' }),
    ])

    raw.prepare('DELETE FROM channel_model_mappings WHERE channel_id = ?').run('channel-openai')
    await expect(resolveGatewayRoute(
      testEnv,
      'group-openai',
      'openai-public',
      'responses',
      'user-1',
    )).resolves.toMatchObject({
      model: { platform: 'openai', upstream_name: 'openai-upstream' },
    })
    raw.close()
  })

  it('freezes requested-model token pricing while preserving explicit zero and nullable inheritance', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      UPDATE channels SET control_version = 9 WHERE id = 'channel-openai';
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode,
        input_micros_per_million, output_micros_per_million,
        cache_read_micros_per_million, per_request_micros,
        fast_multiplier_ppm, flex_multiplier_ppm, time_pricing_json,
        control_version, created_at_ms, updated_at_ms
      ) VALUES (
        'customer-price', 'channel-openai', 'openai', 'token',
        0, NULL, 30, NULL, NULL, 0,
        '{"timezone":"Asia/Shanghai","weekdays_only":false,"periods":[]}',
        4, 1, 1
      );
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES ('customer-price', 'openai-public', 0, 7, 1);
      INSERT INTO channel_pricing_intervals (
        id, pricing_id, min_tokens, max_tokens, tier_label,
        input_micros_per_million, output_micros_per_million,
        cache_read_micros_per_million, input_multiplier_ppm,
        output_multiplier_ppm, cache_read_multiplier_ppm,
        per_request_micros, sort_order, created_at_ms, updated_at_ms
      ) VALUES (
        'customer-interval', 'customer-price', 0, 1000, 'small',
        NULL, 0, NULL, 1000000, NULL, 0, NULL, 0, 1, 1
      );
    `)

    raw.exec(`
      UPDATE channel_model_pricing SET cache_write_micros_per_million=0,
        cache_write_1h_micros_per_million=60 WHERE id='customer-price';
      UPDATE channel_pricing_intervals SET cache_write_micros_per_million=40,
        cache_write_1h_micros_per_million=0, cache_write_multiplier_ppm=1500000
        WHERE id='customer-interval';
    `)
    const route = await resolveGatewayRoute(
      { DB: d1 } as Env, 'group-openai', 'openai-public', 'responses', 'user-1',
    )

    expect(route.customer_pricing).toEqual({
      version: 1,
      channel_id: 'channel-openai',
      channel_control_version: 9,
      pricing_id: 'customer-price',
      matched_model_pattern: 'openai-public',
      platform: 'openai',
      billing_model: 'token',
      input_micros_per_million: 0,
      output_micros_per_million: null,
      cache_read_micros_per_million: 30,
      cache_write_micros_per_million: 0,
      cache_write_1h_micros_per_million: 60,
      per_request_micros: null,
      fast_multiplier_ppm: null,
      flex_multiplier_ppm: 0,
      intervals: [{
        id: 'customer-interval', min_tokens: 0, max_tokens: 1000, tier_label: 'small',
        input_micros_per_million: null, output_micros_per_million: 0,
        cache_read_micros_per_million: null, input_multiplier_ppm: 1000000,
        output_multiplier_ppm: null, cache_read_multiplier_ppm: 0,
        per_request_micros: null,
        cache_write_micros_per_million: 40,
        cache_write_1h_micros_per_million: 0,
        cache_write_multiplier_ppm: 1500000,
      }],
      time_pricing: { timezone: 'Asia/Shanghai', weekdays_only: false, periods: [] },
    })
    raw.close()
  })

  it('matches mapped billing models with exact-before-longest-wildcard precedence', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-openai', 'openai', 'openai-public', 'vendor-target', 0, 0, 0, 1);
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, per_request_micros,
        control_version, created_at_ms, updated_at_ms
      ) VALUES
        ('price-short', 'channel-openai', 'openai', 'per_request', 1, 1, 1, 1),
        ('price-long', 'channel-openai', 'openai', 'per_request', 2, 2, 1, 1),
        ('price-exact', 'channel-openai', 'openai', 'per_request', 3, 3, 1, 1);
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES
        ('price-short', 'vendor-*', 1, 0, 1),
        ('price-long', 'vendor-tar*', 1, 99, 1),
        ('price-exact', 'vendor-target', 0, 999, 1);
    `)
    const env = { DB: d1 } as Env

    await expect(resolveGatewayRoute(
      env, 'group-openai', 'openai-public', 'responses', 'user-1',
    )).resolves.toMatchObject({
      customer_pricing: {
        pricing_id: 'price-exact', matched_model_pattern: 'vendor-target',
        billing_model: 'per_request', per_request_micros: 3,
      },
    })

    raw.prepare("DELETE FROM channel_model_pricing WHERE id = 'price-exact'").run()
    await expect(resolveGatewayRoute(
      env, 'group-openai', 'openai-public', 'responses', 'user-1',
    )).resolves.toMatchObject({
      customer_pricing: {
        pricing_id: 'price-long', matched_model_pattern: 'vendor-tar*',
        per_request_micros: 2,
      },
    })
    raw.close()
  })

  it('keeps a response-model channel baseline for reservation and resolves its declared model price', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      UPDATE channels SET billing_model_source = 'response_model' WHERE id = 'channel-openai';
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, per_request_micros,
        control_version, created_at_ms, updated_at_ms
      ) VALUES
        ('baseline-price', 'channel-openai', 'openai', 'per_request', 10, 1, 1, 1),
        ('response-price', 'channel-openai', 'openai', 'per_request', 30, 2, 1, 1);
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES
        ('baseline-price', 'openai-public', 0, 0, 1),
        ('response-price', 'actual-upstream-model', 0, 0, 1);
    `)
    const route = await resolveGatewayRoute(
      { DB: d1 } as Env, 'group-openai', 'openai-public', 'responses', 'user-1',
    )
    expect(route.customer_pricing).toMatchObject({
      pricing_id: 'baseline-price', response_model_billing: true, per_request_micros: 10,
    })
    await expect(resolveResponseModelPricing(
      { DB: d1 } as Env,
      route.customer_pricing!,
      'actual-upstream-model',
    )).resolves.toMatchObject({
      pricing_id: 'response-price', per_request_micros: 30, response_model_billing: true,
    })
    raw.close()
  })

  it('freezes pricing for an external alias without adding a routing statement', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES ('channel-openai', 'openai', 'external-alias', 'openai-public', 0, 0, 0, 1);
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, per_request_micros,
        control_version, created_at_ms, updated_at_ms
      ) VALUES ('external-price', 'channel-openai', 'openai', 'per_request', 55, 6, 1, 1);
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES ('external-price', 'openai-public', 0, 0, 1);
    `)
    const batchSizes: number[] = []
    const counted = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        batchSizes.push(statements.length)
        return d1.batch(statements)
      },
    } as unknown as D1Database

    const route = await resolveGatewayRoute(
      { DB: counted } as Env, 'group-openai', 'external-alias', 'responses', 'user-1',
    )
    expect(route.customer_pricing).toMatchObject({
      pricing_id: 'external-price', matched_model_pattern: 'openai-public',
      platform: 'openai', billing_model: 'per_request', per_request_micros: 55,
    })
    expect(batchSizes).toEqual([4, 3])

    raw.exec(`
      UPDATE channels SET billing_model_source = 'requested' WHERE id = 'channel-openai';
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, per_request_micros,
        control_version, created_at_ms, updated_at_ms
      ) VALUES
        ('external-requested-price', 'channel-openai', 'openai', 'per_request', 66, 1, 1, 1),
        ('external-upstream-price', 'channel-openai', 'openai', 'per_request', 77, 1, 1, 1);
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES
        ('external-requested-price', 'external-alias', 0, 0, 1),
        ('external-upstream-price', 'openai-upstream', 0, 0, 1);
    `)
    batchSizes.length = 0
    await expect(resolveGatewayRoute(
      { DB: counted } as Env, 'group-openai', 'external-alias', 'responses', 'user-1',
    )).resolves.toMatchObject({
      customer_pricing: {
        pricing_id: 'external-requested-price', matched_model_pattern: 'external-alias',
        per_request_micros: 66,
      },
    })

    raw.prepare("UPDATE channels SET billing_model_source = 'upstream' WHERE id = 'channel-openai'").run()
    await expect(resolveGatewayRoute(
      { DB: counted } as Env, 'group-openai', 'external-alias', 'responses', 'user-1',
    )).resolves.toMatchObject({
      customer_pricing: {
        pricing_id: 'external-upstream-price', matched_model_pattern: 'openai-upstream',
        per_request_micros: 77,
      },
    })
    expect(batchSizes).toEqual([4, 3, 4, 3])
    raw.close()
  })

  it('normalizes Claude dots and dashes for direct and external pricing matches', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      UPDATE models
         SET public_name = 'claude-sonnet-4-5', upstream_name = 'claude-sonnet-4-5'
       WHERE id = 'model-openai';
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES (
        'channel-openai', 'openai', 'customer-claude', 'claude-sonnet-4-5',
        0, 0, 0, 1
      );
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, per_request_micros,
        control_version, created_at_ms, updated_at_ms
      ) VALUES (
        'claude-price', 'channel-openai', 'openai', 'per_request', 73,
        1, 1, 1
      );
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES ('claude-price', 'claude-sonnet-4.5', 0, 0, 1);
    `)
    const env = { DB: d1 } as Env

    await expect(resolveGatewayRoute(
      env, 'group-openai', 'claude-sonnet-4-5', 'responses', 'user-1',
    )).resolves.toMatchObject({
      customer_pricing: {
        pricing_id: 'claude-price', matched_model_pattern: 'claude-sonnet-4.5',
        per_request_micros: 73,
      },
    })
    await expect(resolveGatewayRoute(
      env, 'group-openai', 'customer-claude', 'responses', 'user-1',
    )).resolves.toMatchObject({
      customer_pricing: {
        pricing_id: 'claude-price', matched_model_pattern: 'claude-sonnet-4.5',
        per_request_micros: 73,
      },
    })
    raw.close()
  })

  it('falls back to OpenAI/Codex base pricing after literal variant matching', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      UPDATE models
         SET public_name = 'gpt-5.6-luna-high',
             upstream_name = 'gpt-5.6-luna-2026-08-01'
       WHERE id = 'model-openai';
      INSERT INTO channel_model_mappings (
        channel_id, platform, source_pattern, target_pattern,
        source_is_wildcard, target_is_wildcard, sort_order, created_at_ms
      ) VALUES (
        'channel-openai', 'openai', 'customer-luna', 'gpt-5.6-luna-2026-08-01',
        0, 0, 0, 1
      );
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, per_request_micros,
        control_version, created_at_ms, updated_at_ms
      ) VALUES (
        'luna-base-price', 'channel-openai', 'openai', 'per_request', 81,
        1, 1, 1
      );
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES ('luna-base-price', 'gpt-5.6-luna', 0, 0, 1);
    `)
    const env = { DB: d1 } as Env

    await expect(resolveGatewayRoute(
      env, 'group-openai', 'gpt-5.6-luna-high', 'responses', 'user-1',
    )).resolves.toMatchObject({
      customer_pricing: { pricing_id: 'luna-base-price', per_request_micros: 81 },
    })
    await expect(resolveGatewayRoute(
      env, 'group-openai', 'customer-luna', 'responses', 'user-1',
    )).resolves.toMatchObject({
      customer_pricing: { pricing_id: 'luna-base-price', per_request_micros: 81 },
    })

    raw.exec(`
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, per_request_micros,
        control_version, created_at_ms, updated_at_ms
      ) VALUES (
        'luna-variant-price', 'channel-openai', 'openai', 'per_request', 99,
        1, 1, 1
      );
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES ('luna-variant-price', 'gpt-5.6-luna-high', 0, 0, 1);
    `)
    await expect(resolveGatewayRoute(
      env, 'group-openai', 'gpt-5.6-luna-high', 'responses', 'user-1',
    )).resolves.toMatchObject({
      customer_pricing: { pricing_id: 'luna-variant-price', per_request_micros: 99 },
    })
    raw.close()
  })

  it('fails closed for ambiguous pricing and freezes non-text billing modes for the caller', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    seedChannel(raw, { restrictModels: false })
    raw.exec(`
      INSERT INTO channel_model_pricing (
        id, channel_id, platform, billing_mode, per_request_micros,
        control_version, created_at_ms, updated_at_ms
      ) VALUES
        ('ambiguous-a', 'channel-openai', 'openai', 'per_request', 1, 0, 1, 1),
        ('ambiguous-b', 'channel-openai', 'openai', 'per_request', 2, 0, 1, 1);
      INSERT INTO channel_pricing_models (
        pricing_id, model_pattern, is_wildcard, sort_order, created_at_ms
      ) VALUES
        ('ambiguous-a', 'openai-*', 1, 0, 1),
        ('ambiguous-b', 'openai-*', 1, 1, 1);
    `)
    const env = { DB: d1 } as Env

    await expect(resolveGatewayRoute(
      env, 'group-openai', 'openai-public', 'responses', 'user-1',
    )).rejects.toMatchObject({ status: 409, code: 'ambiguous_channel_pricing' })

    raw.prepare("DELETE FROM channel_model_pricing WHERE id = 'ambiguous-b'").run()
    raw.prepare("UPDATE channel_model_pricing SET billing_mode = 'image' WHERE id = 'ambiguous-a'").run()
    await expect(resolveGatewayRoute(
      env, 'group-openai', 'openai-public', 'responses', 'user-1',
    )).resolves.toMatchObject({
      customer_pricing: { pricing_id: 'ambiguous-a', billing_model: 'image' },
    })
    raw.close()
  })

  it('keeps the direct route statement budget at four, or five with endpoint fallback', async () => {
    const { raw, d1 } = createSqliteD1()
    applyMigrations(raw)
    seedProviderRoute(raw, 'openai', 'openai', 'bearer', '{}')
    const batchSizes: number[] = []
    const counted = {
      prepare: d1.prepare.bind(d1),
      batch: async (statements: D1PreparedStatement[]) => {
        batchSizes.push(statements.length)
        return d1.batch(statements)
      },
    } as unknown as D1Database
    const env = { DB: counted } as Env

    await resolveGatewayRoute(env, 'group-openai', 'openai-public', 'responses', 'user-1')
    await resolveGatewayRoute(
      env, 'group-openai', 'openai-public', 'responses', 'user-1', 'chat_completions',
    )
    expect(batchSizes).toEqual([4, 5])
    raw.close()
  })
})

function seedEmbeddingRoute(database: any): void {
  database.exec(`
    INSERT INTO "groups" (
      id, name, platform, enabled, created_at_ms, updated_at_ms
    ) VALUES ('group-1', 'default', 'openai', 1, 1, 1);
    INSERT INTO models (
      id, platform, public_name, upstream_name, endpoint, embeddings,
      enabled, created_at_ms, updated_at_ms
    ) VALUES ('model-1', 'openai', 'embed-public', 'embed-upstream', 'both', 1, 1, 1, 1);
    INSERT INTO group_models (
      group_id, model_id, enabled, catalog_visible, created_at_ms, updated_at_ms
    ) VALUES ('group-1', 'model-1', 1, 1, 1, 1);
    INSERT INTO model_prices (
      id, group_id, model_id, version, active,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, per_request_micros,
      minimum_reservation_micros, effective_at_ms, created_at_ms
    ) VALUES ('price-1', 'group-1', 'model-1', 1, 1, 1000, 0, 0, 0, 1, 1, 1);
    INSERT INTO accounts (
      id, platform, name, credential_ref, enabled, max_concurrency,
      created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version
    ) VALUES (
      'account-1', 'openai', 'primary', 'secret-1', 1, 4,
      1, 1, 'openai', 'https://upstream.example/v1', 'bearer', 1
    );
    INSERT INTO account_secrets (
      id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
    ) VALUES ('secret-1', 'account-1', 1, 'nonce', 'ciphertext', 1, 1);
    INSERT INTO account_groups (
      account_id, group_id, priority, weight, created_at_ms, updated_at_ms
    ) VALUES ('account-1', 'group-1', 0, 1, 1, 1);
    INSERT INTO account_models (
      account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms
    ) VALUES ('account-1', 'model-1', 0, 0, 1, 1, 1);
  `)
}

function seedSecondEmbeddingRoute(database: any): void {
  database.exec(`
    INSERT INTO models (id, platform, public_name, upstream_name, endpoint, embeddings, enabled, created_at_ms, updated_at_ms)
    VALUES ('model-2', 'openai', 'embed-second', 'embed-second-upstream', 'both', 1, 1, 1, 1);
    INSERT INTO group_models (group_id, model_id, enabled, catalog_visible, sort_order, created_at_ms, updated_at_ms)
    VALUES ('group-1', 'model-2', 1, 1, 1, 1, 1);
    INSERT INTO model_prices (id, group_id, model_id, version, active, input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, per_request_micros, minimum_reservation_micros, effective_at_ms, created_at_ms)
    VALUES ('price-2', 'group-1', 'model-2', 1, 1, 1000, 0, 0, 0, 1, 1, 1);
    INSERT INTO account_models (account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms)
    VALUES ('account-1', 'model-2', 0, 0, 1, 1, 1);
  `)
}

function seedAlternateEmbeddingAccount(database: any): void {
  database.exec(`
    INSERT INTO accounts (id, platform, name, credential_ref, enabled, max_concurrency, created_at_ms, updated_at_ms,
      protocol, base_url, auth_scheme, config_version)
    VALUES ('account-2', 'openai', 'alternate', 'secret-2', 1, 4, 1, 1, 'openai', 'https://alternate.example/v1', 'bearer', 1);
    INSERT INTO account_secrets (id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms)
    VALUES ('secret-2', 'account-2', 1, 'nonce-2', 'ciphertext-2', 1, 1);
    INSERT INTO account_groups (account_id, group_id, priority, weight, created_at_ms, updated_at_ms)
    VALUES ('account-2', 'group-1', 0, 1, 1, 1);
    INSERT INTO account_models (account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms)
    VALUES ('account-2', 'model-1', 0, 0, 1, 1, 1);
  `)
}

function seedImageRoute(database: any): void {
  database.exec(`
    INSERT INTO "groups" (
      id, name, platform, enabled, created_at_ms, updated_at_ms
    ) VALUES ('group-images', 'images', 'openai', 1, 1, 1);
    INSERT INTO models (
      id, platform, public_name, upstream_name, endpoint, embeddings, image_generation,
      enabled, created_at_ms, updated_at_ms
    ) VALUES (
      'model-images', 'openai', 'gpt-image-public', 'gpt-image-upstream',
      'responses', 0, 1, 1, 1, 1
    );
    INSERT INTO group_models (
      group_id, model_id, enabled, catalog_visible, created_at_ms, updated_at_ms
    ) VALUES ('group-images', 'model-images', 1, 1, 1, 1);
    INSERT INTO model_prices (
      id, group_id, model_id, version, active,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, per_request_micros,
      minimum_reservation_micros, effective_at_ms, created_at_ms
    ) VALUES (
      'price-images', 'group-images', 'model-images', 1, 1,
      0, 0, 0, 0, 1, 1, 1
    );
    INSERT INTO accounts (
      id, platform, name, credential_ref, enabled, max_concurrency,
      created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, config_version
    ) VALUES (
      'account-images', 'openai', 'images-primary', 'secret-images', 1, 4,
      1, 1, 'openai', 'https://images.upstream.example/v1', 'bearer', 1
    );
    INSERT INTO account_secrets (
      id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
    ) VALUES ('secret-images', 'account-images', 1, 'nonce', 'ciphertext', 1, 1);
    INSERT INTO account_groups (
      account_id, group_id, priority, weight, created_at_ms, updated_at_ms
    ) VALUES ('account-images', 'group-images', 0, 1, 1, 1);
    INSERT INTO account_models (
      account_id, model_id, chat_completions, responses, embeddings, image_generation,
      created_at_ms, updated_at_ms
    ) VALUES ('account-images', 'model-images', 0, 0, 0, 1, 1, 1);
  `)
}

function seedProviderRoute(
  database: any,
  platform: 'openai' | 'anthropic' | 'gemini' | 'codex',
  protocol: 'openai' | 'anthropic' | 'gemini' | 'codex',
  authScheme: 'bearer' | 'x-api-key' | 'x-goog-api-key',
  providerConfigJson: string,
): void {
  database.prepare(`
    INSERT INTO "groups" (
      id, name, platform, enabled, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 1, 1, 1)
  `).run(`group-${platform}`, `group-${platform}`, platform)
  database.prepare(`
    INSERT INTO models (
      id, platform, public_name, upstream_name, endpoint, embeddings,
      enabled, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, 'responses', 0, 1, 1, 1)
  `).run(`model-${platform}`, platform, `${platform}-public`, `${platform}-upstream`)
  database.prepare(`
    INSERT INTO group_models (
      group_id, model_id, enabled, catalog_visible, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 1, 1, 1, 1)
  `).run(`group-${platform}`, `model-${platform}`)
  database.prepare(`
    INSERT INTO model_prices (
      id, group_id, model_id, version, active,
      input_micros_per_million, output_micros_per_million,
      cache_read_micros_per_million, per_request_micros,
      minimum_reservation_micros, effective_at_ms, created_at_ms
    ) VALUES (?, ?, ?, 1, 1, 1000, 2000, 0, 0, 1, 1, 1)
  `).run(`price-${platform}`, `group-${platform}`, `model-${platform}`)
  database.prepare(`
    INSERT INTO accounts (
      id, platform, name, credential_ref, enabled, max_concurrency,
      created_at_ms, updated_at_ms, protocol, base_url, auth_scheme,
      config_version, provider_config_json
    ) VALUES (?, ?, ?, ?, 1, 4, 1, 1, ?, ?, ?, 1, ?)
  `).run(
    `account-${platform}`,
    platform,
    `account-${platform}`,
    `secret-${platform}`,
    protocol,
    `https://${platform}.upstream.example`,
    authScheme,
    providerConfigJson,
  )
  database.prepare(`
    INSERT INTO account_secrets (
      id, account_id, key_version, nonce_b64, ciphertext_b64, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 1, 'nonce', 'ciphertext', 1, 1)
  `).run(`secret-${platform}`, `account-${platform}`)
  database.prepare(`
    INSERT INTO account_groups (
      account_id, group_id, priority, weight, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 0, 1, 1, 1)
  `).run(`account-${platform}`, `group-${platform}`)
  database.prepare(`
    INSERT INTO account_models (
      account_id, model_id, chat_completions, responses, embeddings, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 0, 1, 0, 1, 1)
  `).run(`account-${platform}`, `model-${platform}`)
}

function seedChannel(
  database: any,
  options: { restrictModels: boolean },
): void {
  database.prepare(`
    INSERT INTO channels (
      id, name, status, restrict_models, created_at_ms, updated_at_ms
    ) VALUES ('channel-openai', 'OpenAI channel', 'active', ?, 1, 1)
  `).run(options.restrictModels ? 1 : 0)
  database.exec(`
    INSERT INTO channel_groups (channel_id, group_id, created_at_ms)
    VALUES ('channel-openai', 'group-openai', 1);
  `)
}
