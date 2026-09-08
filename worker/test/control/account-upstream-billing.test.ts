import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import { setAdminAccountUpstreamBillingProbeEnabled } from '../../src/control/account-upstream-billing'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function fixture() {
  const { raw, d1 } = createSqliteD1()
  applyMigrations(raw)
  raw.exec(`INSERT INTO accounts(id,platform,name,credential_ref,enabled,max_concurrency,created_at_ms,updated_at_ms,ui_config_json)
    VALUES('opaque-account','openai','Billing','secret',1,1,1,1,
    '{"extra":{"upstream_billing_probe_enabled":true,"upstream_billing_rate_sync_enabled":true,"upstream_billing_probe":{"status":"success"},"other":"keep"}}')`)
  const app = new Hono<{ Bindings: Env }>()
  app.put('/accounts/:id/upstream-billing-probe', setAdminAccountUpstreamBillingProbeEnabled)
  const request = (body: unknown, id = 'opaque-account') => app.request(`/accounts/${id}/upstream-billing-probe`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, { DB: d1 } as Env)
  const state = () => raw.prepare('SELECT ui_config_json,config_version,control_version FROM accounts').get() as any
  return { raw, request, state }
}

describe('original account upstream billing probe switch', () => {
  it('disables rate synchronization atomically, retains the snapshot and does not re-enable rate sync', async () => {
    const t = fixture()
    try {
      expect(await (await t.request({ enabled: false })).json()).toEqual({ code: 0, data: { account_id: 'opaque-account', enabled: false } })
      let row = t.state()
      expect(JSON.parse(row.ui_config_json).extra).toEqual({ upstream_billing_probe_enabled: false,
        upstream_billing_rate_sync_enabled: false, upstream_billing_probe: { status: 'success' }, other: 'keep' })
      expect(row.control_version).toBe(1)
      expect((await t.request({ enabled: true })).status).toBe(200)
      row = t.state()
      expect(JSON.parse(row.ui_config_json).extra).toMatchObject({ upstream_billing_probe_enabled: true, upstream_billing_rate_sync_enabled: false })
      expect(row.control_version).toBe(2)
    } finally { t.raw.close() }
  })

  it('initializes absent extras without replacing unrelated account settings', async () => {
    const t = fixture()
    try {
      t.raw.exec(`UPDATE accounts SET ui_config_json='{"notes":"keep"}'`)
      expect((await t.request({ enabled: true })).status).toBe(200)
      expect(JSON.parse(t.state().ui_config_json)).toEqual({ notes: 'keep', extra: { upstream_billing_probe_enabled: true } })
    } finally { t.raw.close() }
  })

  it('rejects missing booleans, missing accounts and OAuth identities without mutation', async () => {
    const t = fixture()
    try {
      const before = t.state()
      for (const body of [{}, { enabled: null }, { enabled: 1 }, { enabled: 'false' }]) expect((await t.request(body)).status).toBe(400)
      expect((await t.request({ enabled: true }, 'missing')).status).toBe(404)
      expect(t.state()).toEqual(before)
      t.raw.exec("UPDATE accounts SET credential_kind='oauth'")
      expect((await t.request({ enabled: true })).status).toBe(400)
      expect(t.state()).toEqual(before)
    } finally { t.raw.close() }
  })
})
