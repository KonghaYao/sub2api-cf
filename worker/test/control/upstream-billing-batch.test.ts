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

it('deduplicates opaque IDs and retains input order with at most four active probes', async () => {
  let active = 0, maximum = 0
  const releases: Array<() => void> = []
  const spy = vi.spyOn(probes, 'probeUpstreamBilling').mockImplementation(async (_env, id) => {
    active++; maximum = Math.max(maximum, active)
    await new Promise<void>(resolve => releases.push(resolve))
    active--
    if (id === 'account-2') throw new Error('private-upstream-response')
    return snapshot
  })
  const pending = request(['account-1', 'account-2', 'account-1', 'account-3', 'account-4', 'account-5'])
  await vi.waitFor(() => expect(releases).toHaveLength(4))
  releases[3]()
  await vi.waitFor(() => expect(releases).toHaveLength(5))
  releases.forEach(release => release())
  const response = await pending
  expect(response.status).toBe(200)
  const body = await response.json() as any
  expect(body.data.results.map((result: any) => result.account_id)).toEqual(['account-1', 'account-2', 'account-3', 'account-4', 'account-5'])
  expect(body.data.results[1]).toEqual({ account_id: 'account-2', error: 'Upstream billing probe failed' })
  expect(body.data.results[4].snapshot.status).toBe('ok')
  expect(maximum).toBe(4)
  expect(spy).toHaveBeenCalledTimes(5)
  expect(JSON.stringify(body)).not.toContain('private-upstream-response')
})

it('validates the whole batch before starting any probe', async () => {
  const spy = vi.spyOn(probes, 'probeUpstreamBilling').mockResolvedValue(snapshot)
  for (const ids of [[], null, Array(21).fill('account'), ['valid', false], [0], [-1], [1.5], ['']]) {
    expect((await request(ids)).status).toBe(400)
  }
  expect(spy).not.toHaveBeenCalled()
})
