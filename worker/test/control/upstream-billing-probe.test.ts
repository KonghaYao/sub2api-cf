import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { encryptCredential } from '../../src/gateway/crypto'
import { probeUpstreamBilling } from '../../src/control/upstream-billing-probe'
import * as proxyTransport from '../../src/gateway/proxy-fetch'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const declaration = { object: 'sub2api.key_billing', schema_version: 1, billing_scope: 'token', group_rate_multiplier: 1.5,
  resolved_rate_multiplier: 1.5, peak_rate_enabled: false, effective_rate_multiplier: 1.5, observed_at: '2026-09-07T08:00:00Z' }
async function fixture() {
  const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
  const env = { DB: d1, ENVIRONMENT: 'test', CREDENTIALS_MASTER_KEY: 'billing-master-key'.repeat(3) } as Env
  const secret = await encryptCredential({ api_key: 'private-key' }, env.CREDENTIALS_MASTER_KEY!, 'test/account/secret/1')
  raw.exec(`INSERT INTO accounts(id,platform,name,credential_ref,enabled,max_concurrency,created_at_ms,updated_at_ms,base_url,ui_config_json)
    VALUES('account','openai','Billing','secret',1,1,1,1,'https://relay.example.test/v1',
    '{"extra":{"upstream_billing_probe_enabled":true,"upstream_billing_rate_sync_enabled":true,"keep":"safe"}}')`)
  raw.prepare("INSERT INTO account_secrets(id,account_id,key_version,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES('secret','account',1,?,?,1,1)").run(secret.nonce_b64,secret.ciphertext_b64)
  return { raw, env, state: () => raw.prepare('SELECT * FROM accounts').get() as any }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('real D1 upstream billing observation', () => {
  it.each([false, true])('uses the proxy and rejects a changed proxy identity (changed=%s)', async changed => {
    const t = await fixture()
    try {
      t.raw.exec("INSERT INTO proxies(id,name,protocol,host,port,status,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES('billing-proxy','Billing','http','proxy.test',8080,'active','','',1,1)")
      t.raw.exec("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.proxy_id','billing-proxy')")
      const direct = vi.fn(); vi.stubGlobal('fetch', direct)
      const transport = vi.spyOn(proxyTransport, 'fetchAccountProxy').mockImplementation(async () => {
        if (changed) t.raw.exec("UPDATE proxies SET control_version=control_version+1,host='other-proxy.test'")
        return Response.json(declaration)
      })
      const pending = probeUpstreamBilling(t.env, 'account')
      if (changed) {
        await expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_BILLING_PROBE_IDENTITY_CHANGED' })
        expect(t.state().billing_rate_multiplier_ppm).toBe(1000000)
      } else expect(await pending).toMatchObject({ status: 'ok' })
      expect(transport.mock.calls[0][1]).toBe('billing-proxy')
      expect(direct).not.toHaveBeenCalled()
    } finally { t.raw.close() }
  })

  it('requests the billing endpoint and atomically saves sanitized data with the base account rate', async () => {
    const t = await fixture()
    try {
      const fetcher = vi.fn(async () => Response.json({ ...declaration, secret: 'discard' }))
      vi.stubGlobal('fetch', fetcher)
      const result = await probeUpstreamBilling(t.env, 'account')
      expect(result).toMatchObject({ status: 'ok', synced_rate_multiplier: 1.5, http_status: 200 })
      expect(result.data?.secret).toBeUndefined()
      const [url, init] = (fetcher.mock.calls as unknown as [URL, RequestInit][])[0]
      expect(url.href).toBe('https://relay.example.test/v1/sub2api/billing')
      expect(init.redirect).toBe('manual')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer private-key')
      const row = t.state()
      expect(row.billing_rate_multiplier_ppm).toBe(1500000)
      expect(row.control_version).toBe(1)
      expect(JSON.parse(row.ui_config_json).extra).toMatchObject({ keep: 'safe', upstream_billing_probe: result })
      expect(Date.parse(result.fresh_until!) - Date.parse(result.received_at!)).toBe(3600000)
    } finally { t.raw.close() }
  })

  it('retains valid data on unsupported responses and honors a longer Retry-After', async () => {
    const t = await fixture()
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(declaration))
        .mockResolvedValueOnce(new Response('not found', { status: 404, headers: { 'retry-after': '172800' } })))
      const good = await probeUpstreamBilling(t.env, 'account')
      const failed = await probeUpstreamBilling(t.env, 'account')
      expect(failed).toMatchObject({ status: 'unsupported', last_error: 'unsupported', data: good.data, fresh_until: good.fresh_until, failure_count: 1 })
      expect(Date.parse(failed.next_probe_at) - Date.parse(failed.last_attempt_at)).toBe(172800000)
      expect(failed.synced_rate_multiplier).toBeUndefined()
      expect(t.state().billing_rate_multiplier_ppm).toBe(1500000)
    } finally { t.raw.close() }
  })

  it.each(['oversize', 'invalid', 'zero'])('does not change the account rate for %s declarations', async mode => {
    const t = await fixture()
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mode === 'oversize' ? new Response('x'.repeat(65537)) :
        Response.json(mode === 'invalid' ? { ...declaration, effective_rate_multiplier: 100 } :
          { ...declaration, group_rate_multiplier: 0, resolved_rate_multiplier: 0, effective_rate_multiplier: 0 })))
      const result = await probeUpstreamBilling(t.env, 'account')
      expect(result.status).toBe(mode === 'zero' ? 'ok' : 'failed')
      expect(result.synced_rate_multiplier).toBeUndefined()
      expect(t.state().billing_rate_multiplier_ppm).toBe(1000000)
    } finally { t.raw.close() }
  })

  it('rejects stale results after a concurrent account edit', async () => {
    const t = await fixture()
    try {
      vi.stubGlobal('fetch', vi.fn(async () => {
        t.raw.exec("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.extra.upstream_billing_rate_sync_enabled',json('false')),config_version=config_version+1")
        return Response.json(declaration)
      }))
      await expect(probeUpstreamBilling(t.env, 'account')).rejects.toMatchObject({ code: 'UPSTREAM_BILLING_PROBE_IDENTITY_CHANGED' })
      expect(t.state().billing_rate_multiplier_ppm).toBe(1000000)
      expect(JSON.parse(t.state().ui_config_json).extra.upstream_billing_probe).toBeUndefined()
    } finally { t.raw.close() }
  })

  it('records unsupported official non-OpenAI targets without sending credentials', async () => {
    const t = await fixture()
    try {
      t.raw.exec("UPDATE accounts SET platform='anthropic',protocol='anthropic',auth_scheme='x-api-key',base_url='https://api.anthropic.com'")
      const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
      expect(await probeUpstreamBilling(t.env, 'account')).toMatchObject({ status: 'unsupported' })
      expect(fetcher).not.toHaveBeenCalled()
    } finally { t.raw.close() }
  })
})
