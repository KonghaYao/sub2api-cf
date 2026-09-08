import { expect, it } from 'vitest'
import type { Env } from '../../src/env'
import { accountQuotaAccrual, accountQuotaCost } from '../../src/gateway/account-quota-accrual'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
it('uses standard price times account multiplier with integer rounding', () => {
  expect(accountQuotaCost(50, 1250000)).toBe(63)
  expect(accountQuotaCost(100, 0)).toBe(0)
  expect(() => accountQuotaCost(Number.MAX_SAFE_INTEGER, 2000000)).toThrow('overflow')
})
it.each(['oauth', 'unlimited', 'free', 'race', 'normal', 'delayed'])('guards quota accrual eligibility and stale resets: %s', async scenario => {
  const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
  try {
    raw.exec("INSERT INTO accounts(id,platform,name,credential_ref,enabled,max_concurrency,created_at_ms,updated_at_ms) VALUES('a','openai','a','s',1,1,1,1)")
    raw.prepare('UPDATE accounts SET credential_kind=?,ui_config_json=?').run(scenario === 'oauth' ? 'oauth' : 'api_key', JSON.stringify({ extra: { quota_used: 1, quota_limit: scenario === 'unlimited' ? 0 : 10 } }))
    if (scenario === 'delayed') raw.prepare("UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$._worker_account_quota_reset_at_ms',?)").run(Date.now())
    const before = raw.prepare('SELECT * FROM accounts').get() as any
    const statements = await accountQuotaAccrual({ DB: d1 } as Env, 'a', scenario === 'free' ? 0 : 1000000, Date.now(), scenario === 'delayed' ? 1 : Date.now())
    if (['oauth','unlimited','free','delayed'].includes(scenario)) { expect(statements).toEqual([]); return }
    if (scenario === 'race') {
      raw.exec("UPDATE accounts SET control_version=control_version+1,ui_config_json=json_set(ui_config_json,'$.extra.quota_used',0)")
      await expect(d1.batch(statements)).rejects.toThrow()
      expect(JSON.parse((raw.prepare('SELECT ui_config_json FROM accounts').get() as any).ui_config_json).extra.quota_used).toBe(0)
    } else {
      await d1.batch(statements)
      const after = raw.prepare('SELECT * FROM accounts').get() as any
      expect(JSON.parse(after.ui_config_json).extra.quota_used).toBe(2)
      expect(after.control_version).toBe(before.control_version + 1)
    }
  } finally { raw.close() }
})
