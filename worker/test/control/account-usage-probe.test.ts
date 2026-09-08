import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import type { PrivacyAccount } from '../../src/control/account-privacy'
import { probeOpenAIAccountUsage } from '../../src/control/account-usage-probe'
import { codexUsageHeaderUpdates } from '../../src/gateway/codex-usage-headers'
import { encryptCredential } from '../../src/gateway/crypto'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
import * as proxy from '../../src/gateway/proxy-fetch'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
const now = Date.parse('2026-09-08T00:00:00Z')
describe('original Codex quota header observations', () => {
  it.each(['0x10', '0b10', '0o10', 'Infinity', 'NaN', '1e999', '12%', '1,5'])('rejects invalid percentage %s without fabricating an observation', value => {
    expect(codexUsageHeaderUpdates(new Headers({ 'x-codex-primary-used-percent': value,
      'x-codex-secondary-used-percent': value, 'x-codex-primary-over-secondary-limit-percent': value }), now)).toBeNull()
  })
  it.each(['0', '+2.5', '.25', '25.', '2.5e1', '-1'])('preserves finite decimal percentage %s', value => {
    expect(codexUsageHeaderUpdates(new Headers({ 'x-codex-secondary-used-percent': value,
      'x-codex-primary-over-secondary-limit-percent': value }), now)).toMatchObject({
      codex_5h_used_percent: Number(value), codex_primary_over_secondary_percent: Number(value) })
  })
  it.each([[300,10080,true], [10080,300,false], [300,300,false], [360,undefined,true], [undefined,10080,true], [undefined,undefined,false]] as const)
    ('normalizes primary %s and secondary %s minutes', (p,s,primaryShort) => {
      const headers = new Headers({ 'x-codex-primary-used-percent': '25', 'x-codex-secondary-used-percent': '50', 'x-codex-primary-reset-after-seconds': '-1' })
      if (p !== undefined) headers.set('x-codex-primary-window-minutes', String(p))
      if (s !== undefined) headers.set('x-codex-secondary-window-minutes', String(s))
      expect(codexUsageHeaderUpdates(headers, now)).toMatchObject({ codex_5h_used_percent: primaryShort ? 25 : 50,
        codex_7d_used_percent: primaryShort ? 50 : 25, [`codex_${primaryShort ? '5h' : '7d'}_reset_at`]: new Date(now).toISOString() })
    })
  it('does not manufacture quota data from malformed or absent headers', () => {
    expect(codexUsageHeaderUpdates(new Headers({ 'x-codex-primary-used-percent': 'bogus', 'x-codex-secondary-window-minutes': '2.5' }), now)).toBeNull()
    expect(codexUsageHeaderUpdates(new Headers(), now)).toBeNull()
  })
})
describe('OpenAI OAuth usage probe', () => {
  it.each(['success', '429', 'empty', 'failure', 'race', 'proxy'])('handles %s with truthful snapshot persistence', async scenario => {
    const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
    const master = 'm'.repeat(32)
    const secret = await encryptCredential({ api_key: 'usage-access', access_token: 'usage-access', chatgpt_account_id: 'usage-workspace' } as never, master, 'test/account/secret/1')
    if (scenario === 'proxy') raw.exec("INSERT INTO proxies(id,name,config_json,creation_key,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES(10001,'Usage proxy',json_object('protocol','http','host','proxy.test','port',8080,'status','active'),'proxy-1','','',1,1)")
    const ui = JSON.stringify({ extra: { keep: true, codex_5h_used_percent: 9 }, ...(scenario === 'proxy' ? { proxy_id: 10001 } : {}) })
    raw.prepare(`INSERT INTO accounts(id,platform,name,credential_ref,credential_kind,protocol,base_url,auth_scheme,ui_config_json,created_at_ms,updated_at_ms)
      VALUES('account','openai','Usage','secret','oauth','openai','https://api.openai.com','bearer',?,1,1)`).run(ui)
    raw.prepare('INSERT INTO account_secrets(id,account_id,key_version,nonce_b64,ciphertext_b64,created_at_ms,updated_at_ms) VALUES(?,?,1,?,?,1,1)')
      .run('secret','account',secret.nonce_b64,secret.ciphertext_b64)
    const account = { ...raw.prepare("SELECT * FROM accounts WHERE id='account'").get(), ...secret, secret_id: 'secret', key_version: 1 } as PrivacyAccount
    const env = { DB: d1, ENVIRONMENT: 'test', CREDENTIALS_MASTER_KEY: master } as Env
    const cancel = vi.fn()
    const receive = async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer usage-access')
      expect(headers.get('chatgpt-account-id')).toBe('usage-workspace')
      expect(headers.get('accept')).toBe('text/event-stream')
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'codex-auto-review', stream: true, store: false, instructions: expect.any(String) })
      if (scenario === 'race') raw.exec("UPDATE accounts SET control_version=control_version+1 WHERE id='account'")
      return new Response(new ReadableStream({ cancel }), { status: scenario === '429' ? 429 : scenario === 'failure' ? 500 : 200,
        headers: ['empty','failure'].includes(scenario) ? {} : { 'x-codex-secondary-used-percent': '42', 'x-codex-secondary-reset-after-seconds': '120' } })
    }
    vi.stubGlobal('fetch', vi.fn(receive))
    if (scenario === 'proxy') vi.spyOn(proxy, 'fetchAccountProxy').mockImplementation(async (_env, id, url, init) => { expect(id).toBe('10001'); return receive(url,init) })
    try {
      const result = probeOpenAIAccountUsage(env, account)
      if (scenario === 'race' || scenario === 'failure') await expect(result).rejects.toMatchObject({ status: scenario === 'race' ? 412 : 502 })
      else if (scenario === 'empty') await expect(result).resolves.toBeNull()
      else await expect(result).resolves.toMatchObject({ codex_5h_used_percent: 42 })
      expect(cancel).toHaveBeenCalledTimes(1)
      const after = raw.prepare("SELECT * FROM accounts WHERE id='account'").get()
      expect(JSON.parse(after.ui_config_json).extra).toMatchObject({ keep: true, codex_5h_used_percent: ['race','failure','empty'].includes(scenario) ? 9 : 42 })
      expect(after.control_version).toBe(account.control_version + (scenario === 'race' ? 1 : 0))
      expect(after.health_status).toBe('unknown')
    } finally { raw.close() }
  })
})
