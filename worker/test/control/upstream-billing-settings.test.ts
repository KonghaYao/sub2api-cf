import { Hono } from 'hono'
import { afterEach, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { getAdminUpstreamBillingSettings, updateAdminUpstreamBillingSettings, runDueUpstreamBillingProbes } from '../../src/control/upstream-billing-settings'
import * as probes from '../../src/control/upstream-billing-probe'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function fixture() {
  const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
  const env = { DB: d1 } as Env
  const app = new Hono<{ Bindings: Env }>()
  app.get('/settings', getAdminUpstreamBillingSettings)
  app.put('/settings', updateAdminUpstreamBillingSettings)
  const put = (body: unknown) => app.request('/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env)
  return { raw, env, app, put }
}
afterEach(() => vi.restoreAllMocks())

it('persists original defaults and valid settings and rejects invalid intervals without mutation', async () => {
  const t = fixture()
  try {
    expect(await (await t.app.request('/settings', {}, t.env)).json()).toEqual({ code: 0, data: { enabled: true, interval_minutes: 30 } })
    expect(await (await t.put({ enabled: false, interval_minutes: 1440 })).json()).toEqual({ code: 0, data: { enabled: false, interval_minutes: 1440 } })
    for (const interval of [0, 4, 1441, 5.5, '30', null]) expect((await t.put({ enabled: true, interval_minutes: interval })).status).toBe(400)
    expect((await t.put({ enabled: 'true', interval_minutes: 30 })).status).toBe(400)
    expect(await runDueUpstreamBillingProbes(t.env)).toBe(0)
    expect(await (await t.app.request('/settings', {}, t.env)).json()).toMatchObject({ data: { enabled: false, interval_minutes: 1440 } })
  } finally { t.raw.close() }
})

it('leases one bounded periodic scan and excludes disabled, opted-out and future accounts', async () => {
  const t = fixture()
  try {
    const insert = t.raw.prepare(`INSERT INTO accounts(id,platform,name,credential_ref,enabled,max_concurrency,created_at_ms,updated_at_ms,ui_config_json)
      VALUES(?,'openai',?,'secret',?,1,1,1,?)`)
    const seed = (id: string, enabled: number, config: string) => insert.run(id,id,enabled,config)
    for (let i = 0; i < 24; i++) seed(`due-${i}`,1,JSON.stringify({ extra: { upstream_billing_probe_enabled: true } }))
    seed('disabled',0,JSON.stringify({ extra: { upstream_billing_probe_enabled: true } }))
    seed('opted-out',1,'{}')
    seed('future',1,JSON.stringify({ extra: { upstream_billing_probe_enabled: true, upstream_billing_probe: { next_probe_at: '2099-01-01T00:00:00Z' } } }))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const spy = vi.spyOn(probes, 'probeUpstreamBilling').mockImplementation(async () => {
      await gate
      return { status: 'ok', http_status: 200, last_attempt_at: '', next_probe_at: '' }
    })
    const pending = runDueUpstreamBillingProbes(t.env)
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(4))
    expect(await runDueUpstreamBillingProbes(t.env)).toBe(0)
    release()
    expect(await pending).toBe(20)
    expect(spy).toHaveBeenCalledTimes(20)
    expect(spy.mock.calls.every(([, id, interval, scheduled]) => id.startsWith('due-') && interval === 30 && scheduled === true)).toBe(true)
    expect(t.raw.prepare('SELECT lease_token,lease_expires_at_ms FROM upstream_billing_probe_settings').get()).toEqual({ lease_token: null, lease_expires_at_ms: 0 })
  } finally { t.raw.close() }
})
