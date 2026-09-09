import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { apiKeyDigest } from '../../src/gateway/crypto'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const PEPPER = 'model-sync-test-pepper-value-32-bytes'
const MASTER_KEY = 'm'.repeat(32)
const USER_KEY = 'sk-model-sync-user-key'

async function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  const now = Date.now()
  const adminToken = createOpaqueToken('access')
  const refreshToken = createOpaqueToken('refresh')
  raw.prepare(`INSERT INTO users (id,email,display_name,role,status,balance_micros,auth_version,created_at_ms,updated_at_ms)
    VALUES ('admin-sync','admin-sync@example.test','Admin Sync','admin','active',100000000,1,?,?)`).run(now, now)
  raw.prepare(`INSERT INTO user_sessions (id,family_id,user_id,auth_version,access_token_hash,refresh_token_hash,
    created_at_ms,access_expires_at_ms,refresh_expires_at_ms,step_up_expires_at_ms)
    VALUES ('sync-session','sync-family','admin-sync',1,?,?,?,?,?,?)`).run(
    await tokenDigest(adminToken, PEPPER, 'access'), await tokenDigest(refreshToken, PEPPER, 'refresh'),
    now, now + 60_000, now + 120_000, now + 60_000,
  )
  raw.prepare(`INSERT INTO "groups" (id,name,platform,enabled,catalog_mode,rate_multiplier_ppm,group_type,is_exclusive,
    created_at_ms,updated_at_ms) VALUES ('sync-group','Sync Group','openai',1,'allowlist',1000000,'standard',0,?,?)`).run(now, now)
  raw.prepare(`INSERT INTO api_keys (id,user_id,key_hash,name,enabled,group_id,key_prefix,created_at_ms,updated_at_ms)
    VALUES ('sync-user-key','admin-sync',?,'Sync user key',1,'sync-group','sk-model',?,?)`).run(
    await apiKeyDigest(USER_KEY, PEPPER), now, now,
  )
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER, CREDENTIALS_MASTER_KEY: MASTER_KEY,
    DB: d1, ASSETS: {} as Fetcher, CONFIG_KV: {} as KVNamespace, OBJECTS: {} as R2Bucket,
    EVENTS_QUEUE: { send: async () => undefined } as unknown as Queue,
    USER_STATE: {} as DurableObjectNamespace, SUBSCRIPTION_STATE: {} as DurableObjectNamespace,
    POOL_STATE: {} as DurableObjectNamespace, AUTH_RATE_LIMIT: {} as DurableObjectNamespace,
    API_KEY_LIMIT_STATE: {} as DurableObjectNamespace,
  } as Env
  return { raw, env, app: createApp(), adminHeaders: { authorization: `Bearer ${adminToken}`, origin: 'http://localhost' } }
}

describe('account model mapping publication loop on createApp and SQLite', () => {
  it('rejects account and group model sets above the 500-model control-plane limit', async () => {
    const test = await fixture()
    try {
      const mapping = Object.fromEntries(Array.from({ length: 501 }, (_, index) => [`model-${index}`, `upstream-${index}`]))
      const oversizedMapping = await test.app.request('/api/v1/admin/accounts', {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'idempotency-key': 'oversized-mapping' },
        body: JSON.stringify({ name: 'Too many mappings', platform: 'openai', type: 'apikey',
          base_url: 'https://api.openai.test/v1', api_key: 'upstream-secret', credentials: { model_mapping: mapping } }),
      }, test.env)
      expect(oversizedMapping.status).toBe(400)
      await expect(oversizedMapping.json()).resolves.toMatchObject({ code: 'too_many_account_models' })

      const oversizedExplicit = await test.app.request('/api/v1/admin/accounts', {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'idempotency-key': 'oversized-explicit' },
        body: JSON.stringify({ name: 'Too many explicit models', platform: 'openai', type: 'apikey',
          base_url: 'https://api.openai.test/v1', api_key: 'upstream-secret', model_capabilities: Array.from({ length: 501 }, (_, index) => ({
            model_id: `model-${index}`, chat_completions: true, responses: false,
          })) }),
      }, test.env)
      expect(oversizedExplicit.status).toBe(400)
      await expect(oversizedExplicit.json()).resolves.toMatchObject({ code: 'invalid_model_capabilities' })

      const account = await test.app.request('/api/v1/admin/accounts', {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'idempotency-key': 'group-limit-account' },
        body: JSON.stringify({ name: 'Group limit account', platform: 'openai', type: 'apikey',
          base_url: 'https://api.openai.test/v1', api_key: 'upstream-secret',
          group_links: [{ group_id: 'sync-group', priority: 0, weight: 1 }] }),
      }, test.env)
      const accountId = (await account.json() as any).data.id
      const insertModel = test.raw.prepare(`INSERT INTO models
        (id,platform,public_name,upstream_name,endpoint,enabled,created_at_ms,updated_at_ms)
        VALUES (?,'openai',?,?,'chat_completions',1,1,1)`)
      const insertCapability = test.raw.prepare(`INSERT INTO account_models
        (account_id,model_id,chat_completions,responses,source,created_at_ms,updated_at_ms)
        VALUES (?,?,1,0,'explicit',1,1)`)
      for (let index = 0; index < 501; index += 1) {
        insertModel.run(`limit-model-${index}`, `limit-public-${index}`, `limit-upstream-${index}`)
        insertCapability.run(accountId, `limit-model-${index}`)
      }
      const oversizedGroup = await test.app.request('/api/v1/admin/groups/sync-group/models/sync-accounts', {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'idempotency-key': 'oversized-group-sync' }, body: '{}',
      }, test.env)
      expect(oversizedGroup.status).toBe(400)
      await expect(oversizedGroup.json()).resolves.toMatchObject({ code: 'too_many_group_account_models' })
    } finally { test.raw.close() }
  })

  it('keeps linked group models synchronized when an account model set changes', async () => {
    const test = await fixture()
    try {
      test.raw.exec(`INSERT INTO models
        (id,platform,public_name,upstream_name,endpoint,enabled,created_at_ms,updated_at_ms) VALUES
        ('sync-model-a','openai','sync-public-a','sync-upstream-a','chat_completions',1,1,1),
        ('sync-model-b','openai','sync-public-b','sync-upstream-b','chat_completions',1,1,1)`)
      const create = await test.app.request('/api/v1/admin/accounts', {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'idempotency-key': 'automatic-group-sync-create' },
        body: JSON.stringify({ name: 'Automatic sync account', platform: 'openai', type: 'apikey',
          base_url: 'https://api.openai.test/v1', api_key: 'upstream-secret',
          group_links: [{ group_id: 'sync-group', priority: 0, weight: 1 }],
          model_capabilities: [{ model_id: 'sync-model-a', chat_completions: true, responses: false }] }),
      }, test.env)
      expect(create.status, await create.clone().text()).toBe(201)
      const account = (await create.json() as any).data
      expect(test.raw.prepare(`SELECT model_id,enabled,disabled_by_account_sync FROM group_models
        WHERE group_id='sync-group' ORDER BY model_id`).all()).toEqual([
        { model_id: 'sync-model-a', enabled: 1, disabled_by_account_sync: 0 },
      ])

      const update = await test.app.request(`/api/v1/admin/accounts/${account.id}`, {
        method: 'PUT', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'if-match': `"${account.control_version}"` },
        body: JSON.stringify({ model_capabilities: [
          { model_id: 'sync-model-b', chat_completions: true, responses: false },
        ] }),
      }, test.env)
      expect(update.status, await update.clone().text()).toBe(200)
      expect(test.raw.prepare(`SELECT model_id,enabled,disabled_by_account_sync FROM group_models
        WHERE group_id='sync-group' ORDER BY model_id`).all()).toEqual([
        { model_id: 'sync-model-a', enabled: 0, disabled_by_account_sync: 1 },
        { model_id: 'sync-model-b', enabled: 1, disabled_by_account_sync: 0 },
      ])

      const disableB = await test.app.request('/api/v1/admin/groups/sync-group/models/sync-model-b', {
        method: 'DELETE', headers: { ...test.adminHeaders, 'content-type': 'application/json',
          'idempotency-key': 'disable-sync-model-b', 'if-match': '"0"' }, body: '{}',
      }, test.env)
      expect(disableB.status, await disableB.clone().text()).toBe(200)
      const sync = await test.app.request('/api/v1/admin/groups/sync-group/models/sync-accounts', {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json',
          'idempotency-key': 'sync-models-after-disable' }, body: '{}',
      }, test.env)
      expect(sync.status, await sync.clone().text()).toBe(200)
      expect(test.raw.prepare(`SELECT enabled,disabled_by_account_sync FROM group_models
        WHERE group_id='sync-group' AND model_id='sync-model-b'`).get())
        .toEqual({ enabled: 0, disabled_by_account_sync: 0 })
    } finally { test.raw.close() }
  })

  it('shrinks mapped group support and preserves it until the last account mapping is removed', async () => {
    const test = await fixture()
    try {
      const create = await test.app.request('/api/v1/admin/accounts', {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'idempotency-key': 'mapping-shrink-primary' },
        body: JSON.stringify({ name: 'Mapping shrink primary', platform: 'openai', type: 'apikey',
          base_url: 'https://api.openai.test/v1', api_key: 'upstream-primary',
          group_links: [{ group_id: 'sync-group', priority: 0, weight: 1 }],
          credentials: { model_mapping: { 'mapped-a': 'mapped-a', 'mapped-b': 'mapped-b' } } }),
      }, test.env)
      expect(create.status, await create.clone().text()).toBe(201)
      const primary = (await create.json() as any).data
      expect(test.raw.prepare("SELECT json_extract(ui_config_json, '$.original_model_routing') AS original FROM accounts WHERE id=?")
        .get(primary.id)).toEqual({ original: 0 })

      // Reproduce an account retained from the legacy original-form migration.
      test.raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json, '$.original_model_routing', json('true')) WHERE id=?")
        .run(primary.id)
      const shrink = await test.app.request(`/api/v1/admin/accounts/${primary.id}`, {
        method: 'PUT', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'if-match': `"${primary.control_version}"` },
        body: JSON.stringify({ credentials: { model_mapping: { 'mapped-b': 'mapped-b' } } }),
      }, test.env)
      expect(shrink.status, await shrink.clone().text()).toBe(200)
      const shrunk = (await shrink.json() as any).data
      expect(test.raw.prepare(`SELECT m.public_name,gm.enabled,gm.disabled_by_account_sync
        FROM group_models gm JOIN models m ON m.id=gm.model_id
        WHERE gm.group_id='sync-group' AND m.public_name IN ('mapped-a','mapped-b') ORDER BY m.public_name`).all()).toEqual([
        { public_name: 'mapped-a', enabled: 0, disabled_by_account_sync: 1 },
        { public_name: 'mapped-b', enabled: 1, disabled_by_account_sync: 0 },
      ])
      expect(test.raw.prepare("SELECT json_extract(ui_config_json, '$.original_model_routing') AS original FROM accounts WHERE id=?")
        .get(primary.id)).toEqual({ original: 0 })

      const createShared = await test.app.request('/api/v1/admin/accounts', {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'idempotency-key': 'mapping-shrink-secondary' },
        body: JSON.stringify({ name: 'Mapping shrink secondary', platform: 'openai', type: 'apikey',
          base_url: 'https://api.openai.test/v1', api_key: 'upstream-secondary',
          group_links: [{ group_id: 'sync-group', priority: 0, weight: 1 }],
          credentials: { model_mapping: { 'mapped-b': 'mapped-b' } } }),
      }, test.env)
      expect(createShared.status, await createShared.clone().text()).toBe(201)
      const secondary = (await createShared.json() as any).data

      const clearPrimary = await test.app.request(`/api/v1/admin/accounts/${primary.id}`, {
        method: 'PUT', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'if-match': `"${shrunk.control_version}"` },
        body: JSON.stringify({ credentials: { model_mapping: {} } }),
      }, test.env)
      expect(clearPrimary.status, await clearPrimary.clone().text()).toBe(200)
      expect(test.raw.prepare("SELECT COUNT(*) AS count FROM account_models WHERE account_id=? AND source='mapping'")
        .get(primary.id)).toEqual({ count: 0 })
      expect(test.raw.prepare(`SELECT gm.enabled,gm.disabled_by_account_sync FROM group_models gm JOIN models m ON m.id=gm.model_id
        WHERE gm.group_id='sync-group' AND m.public_name='mapped-b'`).get())
        .toEqual({ enabled: 1, disabled_by_account_sync: 0 })

      const clearSecondary = await test.app.request(`/api/v1/admin/accounts/${secondary.id}`, {
        method: 'PUT', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'if-match': `"${secondary.control_version}"` },
        body: JSON.stringify({ credentials: { model_mapping: {} } }),
      }, test.env)
      expect(clearSecondary.status, await clearSecondary.clone().text()).toBe(200)
      expect(test.raw.prepare(`SELECT gm.enabled,gm.disabled_by_account_sync FROM group_models gm JOIN models m ON m.id=gm.model_id
        WHERE gm.group_id='sync-group' AND m.public_name='mapped-b'`).get())
        .toEqual({ enabled: 0, disabled_by_account_sync: 1 })
    } finally { test.raw.close() }
  })

  it('migration 124 removes broad legacy support and converges stale group models', () => {
    const { raw } = createSqliteD1()
    try {
      applyMigrations(raw, 123)
      raw.exec(`
        INSERT INTO "groups" (id,name,platform,enabled,created_at_ms,updated_at_ms)
        VALUES ('legacy-group','Legacy Group','openai',1,1,1);
        INSERT INTO models (id,platform,public_name,upstream_name,endpoint,enabled,created_at_ms,updated_at_ms) VALUES
        ('legacy-a','openai','legacy-public-a','legacy-route-a','chat_completions',1,1,1),
        ('legacy-b','openai','legacy-public-b','legacy-route-b','chat_completions',1,1,1);
        INSERT INTO accounts (id,platform,name,credential_ref,enabled,ui_config_json,created_at_ms,updated_at_ms)
        VALUES ('legacy-account','openai','Legacy Account','legacy-secret',1,
          '{"original_model_routing":true,"credentials":{"model_mapping":{"legacy-route-a":"upstream-a"}}}',1,1);
        INSERT INTO account_groups (account_id,group_id,created_at_ms,updated_at_ms)
        VALUES ('legacy-account','legacy-group',1,1);
        INSERT INTO group_models (group_id,model_id,enabled,created_at_ms,updated_at_ms) VALUES
        ('legacy-group','legacy-a',1,1,1),('legacy-group','legacy-b',1,1,1);
      `)
      expect(raw.prepare("SELECT model_id FROM group_model_account_support WHERE group_id='legacy-group' ORDER BY model_id").all())
        .toEqual([{ model_id: 'legacy-a' }, { model_id: 'legacy-b' }])

      applyMigrations(raw, 124)

      expect(raw.prepare("SELECT model_id FROM group_model_account_support WHERE group_id='legacy-group' ORDER BY model_id").all())
        .toEqual([{ model_id: 'legacy-a' }])
      expect(raw.prepare("SELECT model_id,enabled,disabled_by_account_sync FROM group_models WHERE group_id='legacy-group' ORDER BY model_id").all())
        .toEqual([
          { model_id: 'legacy-a', enabled: 1, disabled_by_account_sync: 0 },
          { model_id: 'legacy-b', enabled: 0, disabled_by_account_sync: 1 },
        ])
    } finally { raw.close() }
  })

  it('keeps shared support active and suspends it after the last linked account is removed', async () => {
    const test = await fixture()
    try {
      test.raw.exec(`INSERT INTO models
        (id,platform,public_name,upstream_name,endpoint,enabled,created_at_ms,updated_at_ms)
        VALUES ('shared-model','openai','shared-public','shared-upstream','chat_completions',1,1,1)`)
      const accounts: Array<{ id: string; control_version: number }> = []
      for (const key of ['first', 'second']) {
        const created = await test.app.request('/api/v1/admin/accounts', {
          method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json',
            'idempotency-key': `shared-${key}` },
          body: JSON.stringify({ name: `Shared ${key}`, platform: 'openai', type: 'apikey',
            base_url: 'https://api.openai.test/v1', api_key: `upstream-${key}`,
            group_links: [{ group_id: 'sync-group', priority: 0, weight: 1 }],
            model_capabilities: [{ model_id: 'shared-model', chat_completions: true, responses: false }] }),
        }, test.env)
        expect(created.status, await created.clone().text()).toBe(201)
        accounts.push((await created.json() as any).data)
      }

      const firstDelete = await test.app.request(`/api/v1/admin/accounts/${accounts[0]!.id}`, {
        method: 'DELETE', headers: { ...test.adminHeaders, 'content-type': 'application/json',
          'idempotency-key': 'delete-first-shared', 'if-match': `"${accounts[0]!.control_version}"` }, body: '{}',
      }, test.env)
      expect(firstDelete.status, await firstDelete.clone().text()).toBe(200)
      expect(test.raw.prepare(`SELECT enabled,disabled_by_account_sync FROM group_models
        WHERE group_id='sync-group' AND model_id='shared-model'`).get())
        .toEqual({ enabled: 1, disabled_by_account_sync: 0 })

      const secondDelete = await test.app.request(`/api/v1/admin/accounts/${accounts[1]!.id}`, {
        method: 'DELETE', headers: { ...test.adminHeaders, 'content-type': 'application/json',
          'idempotency-key': 'delete-second-shared', 'if-match': `"${accounts[1]!.control_version}"` }, body: '{}',
      }, test.env)
      expect(secondDelete.status, await secondDelete.clone().text()).toBe(200)
      expect(test.raw.prepare(`SELECT enabled,disabled_by_account_sync FROM group_models
        WHERE group_id='sync-group' AND model_id='shared-model'`).get())
        .toEqual({ enabled: 0, disabled_by_account_sync: 1 })
    } finally { test.raw.close() }
  })

  it('synchronizes models when account group links and enabled state change', async () => {
    const test = await fixture()
    try {
      test.raw.exec(`INSERT INTO models
        (id,platform,public_name,upstream_name,endpoint,enabled,created_at_ms,updated_at_ms)
        VALUES ('link-model','openai','link-public','link-upstream','chat_completions',1,1,1)`)
      const created = await test.app.request('/api/v1/admin/accounts', {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json',
          'idempotency-key': 'link-model-account' },
        body: JSON.stringify({ name: 'Link model account', platform: 'openai', type: 'apikey',
          base_url: 'https://api.openai.test/v1', api_key: 'upstream-link',
          model_capabilities: [{ model_id: 'link-model', chat_completions: true, responses: false }] }),
      }, test.env)
      expect(created.status, await created.clone().text()).toBe(201)
      const account = (await created.json() as any).data

      const link = await test.app.request(`/api/v1/admin/accounts/${account.id}/groups/sync-group`, {
        method: 'PUT', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'if-match': '"0"' },
        body: JSON.stringify({ priority: 0, weight: 1 }),
      }, test.env)
      expect(link.status, await link.clone().text()).toBe(200)
      expect(test.raw.prepare(`SELECT enabled,disabled_by_account_sync FROM group_models
        WHERE group_id='sync-group' AND model_id='link-model'`).get())
        .toEqual({ enabled: 1, disabled_by_account_sync: 0 })

      const disable = await test.app.request(`/api/v1/admin/accounts/${account.id}`, {
        method: 'PUT', headers: { ...test.adminHeaders, 'content-type': 'application/json',
          'idempotency-key': 'disable-link-account', 'if-match': '"1"' },
        body: JSON.stringify({ enabled: false }),
      }, test.env)
      expect(disable.status, await disable.clone().text()).toBe(200)
      expect(test.raw.prepare(`SELECT enabled,disabled_by_account_sync FROM group_models
        WHERE group_id='sync-group' AND model_id='link-model'`).get())
        .toEqual({ enabled: 0, disabled_by_account_sync: 1 })

      const enable = await test.app.request(`/api/v1/admin/accounts/${account.id}`, {
        method: 'PUT', headers: { ...test.adminHeaders, 'content-type': 'application/json',
          'idempotency-key': 'enable-link-account', 'if-match': '"2"' },
        body: JSON.stringify({ enabled: true }),
      }, test.env)
      expect(enable.status, await enable.clone().text()).toBe(200)
      expect(test.raw.prepare(`SELECT enabled,disabled_by_account_sync FROM group_models
        WHERE group_id='sync-group' AND model_id='link-model'`).get())
        .toEqual({ enabled: 1, disabled_by_account_sync: 0 })

      const unlink = await test.app.request(`/api/v1/admin/accounts/${account.id}/groups/sync-group`, {
        method: 'DELETE', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'if-match': '"3"' }, body: '{}',
      }, test.env)
      expect(unlink.status, await unlink.clone().text()).toBe(200)
      expect(test.raw.prepare(`SELECT enabled,disabled_by_account_sync FROM group_models
        WHERE group_id='sync-group' AND model_id='link-model'`).get())
        .toEqual({ enabled: 0, disabled_by_account_sync: 1 })
    } finally { test.raw.close() }
  })

  it('publishes a mapped image model only after group sync and active pricing, preserving explicit overlap', async () => {
    const test = await fixture()
    try {
      const create = await test.app.request('/api/v1/admin/accounts', {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'idempotency-key': 'sync-account-create' },
        body: JSON.stringify({ name: 'Image account', platform: 'openai', type: 'apikey', base_url: 'https://api.openai.test/v1',
          api_key: 'upstream-secret', group_links: [{ group_id: 'sync-group', priority: 0, weight: 1 }],
          credentials: { model_mapping: { 'gpt-image-2': 'gpt-image-2' }, openai_capabilities: ['chat_completions'] } }),
      }, test.env)
      expect(create.status, await create.clone().text()).toBe(201)
      const account = (await create.json() as any).data
      const model = test.raw.prepare(`SELECT m.id,m.public_name,m.image_generation,am.chat_completions,am.responses,
        am.embeddings,am.image_generation AS account_image_generation,am.source FROM models m
        JOIN account_models am ON am.model_id=m.id WHERE am.account_id=?`).get(account.id)
      expect(model).toMatchObject({ public_name: 'gpt-image-2', image_generation: 1, chat_completions: 0,
        responses: 0, embeddings: 0, account_image_generation: 1, source: 'mapping' })

      const sync = await test.app.request('/api/v1/admin/groups/sync-group/models/sync-accounts', {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'idempotency-key': 'group-model-sync' }, body: '{}',
      }, test.env)
      expect(sync.status, await sync.clone().text()).toBe(200)
      await expect(sync.json()).resolves.toMatchObject({ data: { synchronized: 1, pending_price: 1 } })
      const replay = await test.app.request('/api/v1/admin/groups/sync-group/models/sync-accounts', {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'idempotency-key': 'group-model-sync' }, body: '{}',
      }, test.env)
      await expect(replay.json()).resolves.toMatchObject({ data: { synchronized: 1, pending_price: 1 } })
      expect(test.raw.prepare('SELECT enabled,catalog_visible,max_output_tokens,default_max_output_tokens FROM group_models').get())
        .toEqual({ enabled: 1, catalog_visible: 1, max_output_tokens: 65536, default_max_output_tokens: 32768 })
      test.raw.prepare(`UPDATE group_models SET enabled=0,catalog_visible=0,sort_order=19,max_output_tokens=12345,
        default_max_output_tokens=6789,upstream_name_override='gpt-image-2'`).run()
      const restore = await test.app.request('/api/v1/admin/groups/sync-group/models/sync-accounts', {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'idempotency-key': 'group-model-restore' }, body: '{}',
      }, test.env)
      await expect(restore.json()).resolves.toMatchObject({ data: { synchronized: 1, pending_price: 1 } })
      expect(test.raw.prepare(`SELECT enabled,catalog_visible,sort_order,max_output_tokens,default_max_output_tokens,
        upstream_name_override FROM group_models`).get()).toEqual({ enabled: 0, catalog_visible: 0, sort_order: 19,
        max_output_tokens: 12345, default_max_output_tokens: 6789, upstream_name_override: 'gpt-image-2' })
      const enable = await test.app.request(`/api/v1/admin/groups/sync-group/models/${model.id}`, {
        method: 'PUT', headers: { ...test.adminHeaders, 'content-type': 'application/json',
          'idempotency-key': 'group-model-enable', 'if-match': '"0"' },
        body: JSON.stringify({ enabled: true, catalog_visible: true }),
      }, test.env)
      expect(enable.status, await enable.clone().text()).toBe(200)
      const pending = await test.app.request('/v1/models', { headers: { authorization: `Bearer ${USER_KEY}` } }, test.env)
      expect((await pending.json() as any).data).toEqual([])

      const price = await test.app.request(`/api/v1/admin/groups/sync-group/models/${model.id}/prices`, {
        method: 'POST', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'idempotency-key': 'publish-image-price', 'if-match': '"1"' },
        body: JSON.stringify({ input_micros_per_million: 0, output_micros_per_million: 0, per_request_micros: 1000, minimum_reservation_micros: 1 }),
      }, test.env)
      expect(price.status, await price.clone().text()).toBe(201)
      const published = await test.app.request('/v1/models', { headers: { authorization: `Bearer ${USER_KEY}` } }, test.env)
      expect((await published.json() as any).data.map((entry: any) => entry.id)).toContain('gpt-image-2')

      const explicit = await test.app.request(`/api/v1/admin/accounts/${account.id}/models/${model.id}`, {
        method: 'PUT', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'if-match': `"${account.control_version}"` },
        body: JSON.stringify({ chat_completions: false, responses: false, embeddings: false, image_generation: true }),
      }, test.env)
      expect(explicit.status, await explicit.clone().text()).toBe(200)
      const updated = (await explicit.json() as any).data
      const removeMapping = await test.app.request(`/api/v1/admin/accounts/${account.id}`, {
        method: 'PUT', headers: { ...test.adminHeaders, 'content-type': 'application/json', 'if-match': `"${updated.control_version}"` },
        body: JSON.stringify({ credentials: { model_mapping: {} }, model_capabilities: [{ model_id: model.id,
          chat_completions: false, responses: false, embeddings: false, image_generation: true }] }),
      }, test.env)
      expect(removeMapping.status, await removeMapping.clone().text()).toBe(200)
      expect(test.raw.prepare('SELECT source,image_generation FROM account_models WHERE account_id=? AND model_id=?').get(account.id, model.id))
        .toEqual({ source: 'explicit', image_generation: 1 })

      const clearExplicit = await test.app.request(`/api/v1/admin/accounts/${account.id}`, {
        method: 'PUT', headers: { ...test.adminHeaders, 'content-type': 'application/json',
          'if-match': `"${(await removeMapping.json() as any).data.control_version}"` },
        body: JSON.stringify({ model_capabilities: [] }),
      }, test.env)
      expect(clearExplicit.status, await clearExplicit.clone().text()).toBe(200)
      expect(test.raw.prepare('SELECT COUNT(*) AS total FROM account_models WHERE account_id=?').get(account.id))
        .toEqual({ total: 0 })
    } finally { test.raw.close() }
  })
})
