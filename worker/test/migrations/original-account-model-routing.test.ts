import { describe, expect, it } from 'vitest'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

describe('original account routing migration', () => {
  it('restores identifiable legacy whitelist intent while preserving explicit closure and account state', () => {
    const { raw } = createSqliteD1()
    try {
      applyMigrations(raw, 81)
      const insert = raw.prepare(`INSERT INTO accounts (id, platform, name, credential_ref, enabled, max_concurrency,
        created_at_ms, updated_at_ms, protocol, base_url, auth_scheme, ui_config_json)
        VALUES (?, 'openai', ?, 'secret', 0, 4, 1, 1, 'openai', 'https://api.openai.com', 'bearer', ?)`)
      const mapping = { credentials: { model_mapping: { public: 'upstream' } }, schedulable: false, notes: 'keep' }
      insert.run('legacy', 'legacy', JSON.stringify(mapping))
      insert.run('explicit', 'explicit', JSON.stringify({ ...mapping, original_model_routing: false }))
      insert.run('empty', 'empty', JSON.stringify({ credentials: { model_mapping: {} } }))
      insert.run('configured', 'configured', JSON.stringify(mapping))
      raw.exec(`INSERT INTO models (id, platform, public_name, upstream_name, endpoint, enabled, created_at_ms, updated_at_ms)
        VALUES ('model', 'openai', 'public', 'upstream', 'both', 1, 1, 1);
        INSERT INTO account_models (account_id, model_id, chat_completions, responses, created_at_ms, updated_at_ms)
        VALUES ('configured', 'model', 1, 1, 1, 1);`)
      const before = raw.prepare('SELECT revision FROM gateway_config_revision').get() as any
      applyMigrations(raw, 82)
      const rows = raw.prepare('SELECT id, enabled, config_version, control_version, ui_config_json FROM accounts ORDER BY id').all() as any[]
      const legacy = rows.find(row => row.id === 'legacy')
      expect(legacy).toMatchObject({ enabled: 0, control_version: 1, config_version: 2 })
      expect(JSON.parse(legacy.ui_config_json)).toEqual({ ...mapping, original_model_routing: true })
      for (const row of rows.filter(row => row.id !== 'legacy')) expect(row.control_version).toBe(0)
      expect(JSON.parse(rows.find(row => row.id === 'explicit').ui_config_json).original_model_routing).toBe(false)
      expect((raw.prepare('SELECT revision FROM gateway_config_revision').get() as any).revision).toBeGreaterThan(before.revision)
      applyMigrations(raw, 82)
      expect(raw.prepare("SELECT control_version FROM accounts WHERE id='legacy'").get()).toEqual({ control_version: 1 })
    } finally { raw.close() }
  })
})
