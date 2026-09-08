import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { probeAdminAccountsUpstreamBilling } from '../../src/control/account-upstream-billing'
import * as probes from '../../src/control/upstream-billing-probe'
import * as settings from '../../src/control/upstream-billing-settings'

const app = new Hono<{ Bindings: Env }>()
app.post('/batch', probeAdminAccountsUpstreamBilling)
const request = (ids: unknown) => app.request('/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account_ids: ids }) }, {} as Env)
const snapshot: probes.BillingSnapshot = { status: 'ok', http_status: 200, last_attempt_at: '2026-09-07T00:00:00Z', next_probe_at: '2026-09-07T00:30:00Z' }
afterEach(() => vi.restoreAllMocks())
beforeEach(() => { vi.spyOn(settings, 'readUpstreamBillingSettings').mockResolvedValue({ enabled: true, interval_minutes: 30 }) })

it('deduplicates opaque IDs in input order and preserves per-account batch outcomes', async () => {
  // Concurrency and D1 query budgets are exercised through the real engine in
  // upstream-billing-probe-production.test.ts; this checks the HTTP adapter.
  const results = ['account-1','account-2','account-3','account-4','account-5'].map(account_id =>
    account_id === 'account-2' ? { account_id, error: 'account_identity_changed' } : { account_id, snapshot })
  const spy = vi.spyOn(probes, 'probeAccounts').mockResolvedValue(results)
  const response = await request(['account-1', 'account-2', 'account-1', 'account-3', 'account-4', 'account-5'])
  expect(response.status).toBe(200)
  expect(spy).toHaveBeenCalledExactlyOnceWith({}, ['account-1','account-2','account-3','account-4','account-5'], { enabled: true, interval_minutes: 30 })
  expect(await response.json()).toMatchObject({ data: { results } })
})

it('validates the whole batch before starting any probe', async () => {
  const spy = vi.spyOn(probes, 'probeAccounts').mockResolvedValue([])
  for (const ids of [[], null, Array(21).fill('account'), ['valid', false], [0], [-1], [1.5], ['']]) {
    expect((await request(ids)).status).toBe(400)
  }
  expect(spy).not.toHaveBeenCalled()
})
