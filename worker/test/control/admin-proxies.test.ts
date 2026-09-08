import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import { createAdminProxy, deleteAdminProxy, getAdminProxy, listAdminProxies, listAdminProxyAccounts, updateAdminProxy, batchCreateAdminProxies, batchDeleteAdminProxies } from '../../src/control/proxies'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function fixture() {
  const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
  const env = { DB: d1, ENVIRONMENT: 'test', CREDENTIALS_MASTER_KEY: 'proxy-test-key-'.repeat(3) } as Env
  const app = new Hono<{ Bindings: Env }>()
  app.get('/proxies', listAdminProxies); app.get('/proxies/all', listAdminProxies)
  app.post('/proxies', createAdminProxy); app.get('/proxies/:id', getAdminProxy)
  app.post('/proxies/batch', batchCreateAdminProxies); app.post('/proxies/batch-delete', batchDeleteAdminProxies)
  app.put('/proxies/:id', updateAdminProxy); app.delete('/proxies/:id', deleteAdminProxy)
  app.get('/proxies/:id/accounts', listAdminProxyAccounts)
  const request = (path: string, method = 'GET', body?: object, headers = {}) => app.request(path, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  }, env)
  const input = { name: 'Primary', protocol: 'socks5h', host: 'proxy.example.test', port: 1080, username: 'proxy-user', password: 'private-password' }
  const create = async (body = input, key: string = crypto.randomUUID()) => {
    const response = await request('/proxies', 'POST', body, { 'idempotency-key': key })
    const data = await response.json() as any
    expect(response.status, JSON.stringify(data)).toBe(201)
    return data.data
  }
  return { raw, env, request, input, create }
}

describe('original proxy inventory on D1', () => {
  it('deduplicates batch identity without protocol and returns per-target deletion outcomes', async () => {
    const t = fixture()
    try {
      const result = await t.request('/proxies/batch', 'POST', { proxies: [
        t.input, { ...t.input, protocol: 'https' }, { ...t.input, password: 'distinct' },
      ] })
      expect(await result.json()).toMatchObject({ data: { created: 2, skipped: 1 } })
      expect(await (await t.request('/proxies/batch', 'POST', { proxies: [t.input] })).json()).toMatchObject({ data: { created: 0, skipped: 1 } })
      const rows = t.raw.prepare('SELECT id, name FROM proxies ORDER BY id').all() as Array<{ id: string; name: string }>
      expect(rows.every(row => row.name === 'default')).toBe(true)
      t.raw.prepare(`INSERT INTO accounts (id, platform, name, credential_ref, created_at_ms, updated_at_ms, ui_config_json)
        VALUES ('batch-linked', 'openai', 'Batch linked', 'none', 1, 1, ?)`).run(JSON.stringify({ proxy_id: rows[0].id }))
      const deleted = await t.request('/proxies/batch-delete', 'POST', { ids: [rows[0].id, rows[1].id, 'missing-proxy'] })
      expect(await deleted.json()).toMatchObject({ data: { deleted_ids: [rows[1].id], skipped: [
        { id: rows[0].id, reason: expect.stringContaining('referenced') }, { id: 'missing-proxy', reason: 'Proxy not found' },
      ] } })
      expect(t.raw.prepare('SELECT COUNT(*) AS count FROM proxies').get()).toEqual({ count: 1 })
    } finally { t.raw.close() }
  })

  it('encrypts credentials, replays create safely, filters inventory and preserves original update semantics', async () => {
    const t = fixture()
    try {
      const proxy = await t.create(t.input, 'create-proxy-once')
      expect(await t.create(t.input, 'create-proxy-once')).toMatchObject({ id: proxy.id })
      const stored = JSON.stringify(t.raw.prepare('SELECT * FROM proxies').all())
      expect(stored).not.toContain('private-password'); expect(stored).not.toContain('proxy-user')
      expect(JSON.stringify(t.raw.prepare('SELECT * FROM control_idempotency').all())).not.toContain('private-password')
      expect(proxy).toMatchObject({ ...t.input, fallback_mode: 'none', control_version: 0 })
      expect((await t.request('/proxies', 'POST', { ...t.input, port: 999 }, { 'idempotency-key': 'create-proxy-once' })).status).toBe(409)
      await t.create({ ...t.input, name: 'Other', protocol: 'https' })
      expect(await (await t.request('/proxies?protocol=socks5h&search=PRIMARY&page_size=1')).json()).toMatchObject({ data: { total: 1, pages: 1, items: [{ id: proxy.id }] } })
      const updated = await t.request(`/proxies/${proxy.id}`, 'PUT', { status: 'inactive', username: '', password: '' }, { 'if-match': '"0"' })
      expect(await updated.json()).toMatchObject({ data: { username: 'proxy-user', password: 'private-password', status: 'inactive', control_version: 1 } })
      expect((await t.request(`/proxies/${proxy.id}`, 'PUT', { status: 'active' }, { 'if-match': '"0"' })).status).toBe(409)
      const all = await (await t.request('/proxies/all?with_count=true')).json() as any
      expect(all.data).toHaveLength(1); expect(all.data[0]).toMatchObject({ name: 'Other', account_count: 0 })
    } finally { t.raw.close() }
  })

  it('returns actual linked accounts and blocks deletion atomically while referenced', async () => {
    const t = fixture()
    try {
      const proxy = await t.create()
      t.raw.prepare(`INSERT INTO accounts (id, platform, name, credential_ref, created_at_ms, updated_at_ms, ui_config_json)
        VALUES ('linked-account', 'openai', 'Linked', 'no-secret', 1, 1, ?)`).run(JSON.stringify({ proxy_id: proxy.id, type: 'apikey' }))
      expect(await (await t.request(`/proxies/${proxy.id}/accounts`)).json()).toMatchObject({ data: [{ id: 'linked-account', name: 'Linked', platform: 'openai', type: 'apikey', status: 'active' }] })
      expect(await (await t.request('/proxies/all?with_count=true')).json()).toMatchObject({ data: [{ account_count: 1 }] })
      expect((await t.request(`/proxies/${proxy.id}`, 'DELETE')).status).toBe(409)
      expect(() => t.raw.prepare('DELETE FROM proxies WHERE id=?').run(proxy.id)).toThrow('proxy_in_use')
      t.raw.exec("UPDATE accounts SET ui_config_json='{}'")
      expect((await t.request(`/proxies/${proxy.id}`, 'DELETE')).status).toBe(200)
      expect((await t.request(`/proxies/${proxy.id}`)).status).toBe(404)
      expect(() => t.raw.prepare('UPDATE accounts SET ui_config_json=?').run(JSON.stringify({ proxy_id: proxy.id }))).toThrow('invalid_account_proxy')
    } finally { t.raw.close() }
  })

  it('validates fallback references and protects a backup proxy from deletion', async () => {
    const t = fixture()
    try {
      for (const patch of [{ port: 0 }, { protocol: 'ssh' }, { fallback_mode: 'proxy' }, { host: 'https://bad.test' }, { expiry_warn_days: -1 }]) {
        expect((await t.request('/proxies', 'POST', { ...t.input, ...patch })).status).toBe(400)
      }
      const backup = await t.create()
      const primaryResponse = await t.request('/proxies', 'POST', { ...t.input, name: 'Fallback', fallback_mode: 'proxy', backup_proxy_id: backup.id, expires_at: 1900000000 })
      expect(primaryResponse.status).toBe(201)
      const primary = (await primaryResponse.json() as any).data
      expect(primary.expires_at).toBe(new Date(1900000000000).toISOString())
      expect((await t.request(`/proxies/${backup.id}`, 'DELETE')).status).toBe(409)
      expect((await t.request(`/proxies/${primary.id}`, 'PUT', { fallback_mode: 'proxy', backup_proxy_id: primary.id })).status).toBe(400)
      expect((await t.request(`/proxies/${primary.id}`, 'DELETE')).status).toBe(200)
      expect((await t.request(`/proxies/${backup.id}`, 'DELETE')).status).toBe(200)
    } finally { t.raw.close() }
  })
})
