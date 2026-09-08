import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { Env } from '../../src/env'
import { resolveProxyFallback, sweepExpiredProxies, revertAdminProxyFallback, type ProxyFallbackRow } from '../../src/control/proxy-expiry'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const proxy = (id: string, fallback_mode = 'none', backup_proxy_id: string | null = null, expires_at: number | null = 10): ProxyFallbackRow =>
  ({ id, fallback_mode, backup_proxy_id, expires_at, status: 'active', control_version: 0 })

describe('original proxy expiry fallback', () => {
  it('matches none, direct, multi-hop, cycles and inactive-backup rules', () => {
    for (const [rows, expected] of [
      [[proxy('a')], { change: false, target: null }],
      [[proxy('a', 'direct')], { change: true, target: null }],
      [[proxy('a', 'proxy', 'b'), proxy('b', 'proxy', 'c'), proxy('c', 'none', null, 20)], { change: true, target: 'c' }],
      [[proxy('a', 'proxy', 'b'), proxy('b', 'proxy', 'a')], { change: false, target: null }],
      [[proxy('a', 'proxy', 'b'), proxy('b', 'direct')], { change: true, target: null }],
      [[proxy('a', 'proxy', 'missing')], { change: false, target: null }],
      [[proxy('a', 'proxy', 'b'), { ...proxy('b', 'none', null, null), status: 'inactive' }], { change: true, target: 'b' }],
    ] as Array<[ProxyFallbackRow[], { change: boolean; target: string | null }]>) {
      expect(resolveProxyFallback(rows[0], new Map(rows.map(row => [row.id, row])), 10000)).toEqual(expected)
    }
  })

  function fixture() {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
    for (const id of [1, 2, 3]) raw.prepare(`INSERT INTO proxies
      (id,name,config_json,nonce_b64,ciphertext_b64,creation_key,control_version,created_at_ms,updated_at_ms)
      VALUES (?,?,?,'unused','unused',?,0,1,1)`).run(id, String(id), JSON.stringify({
        protocol: 'http', host: 'proxy.test', port: 8080, status: 'active',
        expires_at: id === 3 ? 20 : 10, fallback_mode: 'none', backup_proxy_id: null,
      }), `creation-${id}`)
    raw.exec("UPDATE proxies SET config_json=json_set(config_json,'$.fallback_mode','proxy','$.backup_proxy_id',2) WHERE id=1; UPDATE proxies SET config_json=json_set(config_json,'$.fallback_mode','proxy','$.backup_proxy_id',3) WHERE id=2")
    raw.prepare(`INSERT INTO accounts (id,platform,name,credential_ref,created_at_ms,updated_at_ms,ui_config_json)
      VALUES ('account','openai','Account','unused',1,1,?)`).run(JSON.stringify({ proxy_id: 1, extra: { upstream_billing_probe: { state: 'old' }, keep: true } }))
    return { raw, env: { DB: d1 } as Env }
  }

  it('atomically marks expiry, changes only eligible account bindings and invalidates observations once', async () => {
    const t = fixture()
    try {
      expect(await sweepExpiredProxies(t.env, 10000)).toBe(1)
      const row = t.raw.prepare('SELECT ui_config_json,control_version,config_version FROM accounts').get() as any
      expect(JSON.parse(row.ui_config_json)).toEqual({ proxy_id: 3, proxy_fallback_origin_id: 1, extra: { keep: true } })
      expect(row.control_version).toBe(1)
      expect(t.raw.prepare("SELECT status FROM proxies WHERE id=1").get()).toEqual({ status: 'expired' })
      expect(await sweepExpiredProxies(t.env, 10000)).toBe(0)
      t.raw.exec("UPDATE proxies SET config_json=json_set(config_json,'$.fallback_mode','direct') WHERE id=3")
      // Original origin marker prevents a second automatic rebind.
      expect(await sweepExpiredProxies(t.env, 20000)).toBe(0)
      expect(JSON.parse((t.raw.prepare('SELECT ui_config_json FROM accounts').get() as any).ui_config_json).proxy_id).toBe(3)
    } finally { t.raw.close() }
  })

  it('rolls back proxy status if the account update fails', async () => {
    const t = fixture()
    try {
      t.raw.exec("CREATE TRIGGER fail_rebind BEFORE UPDATE OF ui_config_json ON accounts BEGIN SELECT RAISE(ABORT,'injected_rebind_failure'); END")
      await expect(sweepExpiredProxies(t.env, 10000)).rejects.toThrow('injected_rebind_failure')
      expect(t.raw.prepare("SELECT status,control_version FROM proxies WHERE id=1").get()).toEqual({ status: 'active', control_version: 0 })
    } finally { t.raw.close() }
  })

  it('restores the original proxy through the admin action and rejects a second revert', async () => {
    const t = fixture()
    const app = new Hono<{ Bindings: Env }>()
    app.post('/accounts/:id/revert-proxy-fallback', revertAdminProxyFallback)
    try {
      await sweepExpiredProxies(t.env, 10000)
      const invoke = () => app.request('/accounts/account/revert-proxy-fallback', { method: 'POST' }, t.env)
      expect(await (await invoke()).json()).toMatchObject({ data: { message: 'reverted' } })
      const row = t.raw.prepare('SELECT ui_config_json,control_version FROM accounts').get() as any
      expect(JSON.parse(row.ui_config_json)).toMatchObject({ proxy_id: 1, proxy_fallback_origin_id: null })
      expect(row.control_version).toBe(2)
      expect((await invoke()).status).toBe(400)
    } finally { t.raw.close() }
  })

  it('keeps the active fallback when the original proxy was deleted before manual restoration', async () => {
    const t = fixture()
    const app = new Hono<{ Bindings: Env }>()
    app.post('/accounts/:id/revert-proxy-fallback', revertAdminProxyFallback)
    try {
      await sweepExpiredProxies(t.env, 10000)
      t.raw.exec('DELETE FROM proxies WHERE id=1')
      const response = await app.request('/accounts/account/revert-proxy-fallback', { method: 'POST' }, t.env)
      expect(response.status).toBe(409)
      const row = t.raw.prepare('SELECT ui_config_json,control_version FROM accounts').get() as any
      expect(JSON.parse(row.ui_config_json)).toMatchObject({ proxy_id: 3, proxy_fallback_origin_id: 1 })
      expect(row.control_version).toBe(1)
    } finally { t.raw.close() }
  })

  it('does not use a fallback chain edited after the snapshot read', async () => {
    const t = fixture()
    const batch = t.env.DB.batch.bind(t.env.DB)
    let changed = false
    t.env.DB.batch = async statements => {
      if (!changed) { changed = true; t.raw.exec("UPDATE proxies SET control_version=control_version+1 WHERE id=3") }
      return batch(statements)
    }
    try {
      expect(await sweepExpiredProxies(t.env, 10000)).toBe(0)
      expect(t.raw.prepare("SELECT status FROM proxies WHERE id=1").get()).toEqual({ status: 'active' })
      expect(await sweepExpiredProxies(t.env, 10000)).toBe(1)
    } finally { t.raw.close() }
  })
})
