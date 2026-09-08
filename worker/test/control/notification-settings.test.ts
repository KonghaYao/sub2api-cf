import { createApp } from '../../src/app'
import { describe, it, expect, vi } from 'vitest'
import type { Env } from '../../src/env'
import { createOpaqueToken, tokenDigest } from '../../src/auth/tokens'
import { encryptTotpSecret } from '../../src/auth/totp'
import { deliverPlatformEmail, hasEmailDeliveryConfigured } from '../../src/email/delivery'
import { scanSystemNotifications, quotaWindowStart } from '../../src/notifications/scanner'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'
const PEPPER = 'p'.repeat(32)
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP'
async function clearHarness(enableTotp = true): Promise<any> {
  const database = createSqliteD1()
  applyMigrations(database.raw)
  const now = Date.now()
  const accessToken = createOpaqueToken('access')
  const refreshToken = createOpaqueToken('refresh')
  database.raw.prepare(
    `INSERT INTO users (
       id, email, display_name, role, status, auth_version, created_at_ms, updated_at_ms
     ) VALUES ('clear-admin', 'clear@example.com', 'Clear Admin', 'admin', 'active', 1, ?, ?)`,
  ).run(now, now)
  database.raw.prepare(
    `INSERT INTO user_sessions (
       id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
       created_at_ms, access_expires_at_ms, refresh_expires_at_ms, step_up_expires_at_ms
     ) VALUES ('clear-session', 'clear-family', 'clear-admin', 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    await tokenDigest(accessToken, PEPPER, 'access'),
    await tokenDigest(refreshToken, PEPPER, 'refresh'),
    now,
    now + 60_000,
    now + 120_000,
    now + 60_000,
  )
  const env = {
    APP_VERSION: 'test', ENVIRONMENT: 'test', API_KEY_PEPPER: PEPPER,
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    DB: database.d1, ASSETS: {} as Fetcher, CONFIG_KV: {} as KVNamespace,
    OBJECTS: {} as R2Bucket, EVENTS_QUEUE: {} as Queue,
    USER_STATE: {} as DurableObjectNamespace, POOL_STATE: {} as DurableObjectNamespace,
  } as Env
  if (enableTotp) {
    const encrypted = await encryptTotpSecret(env, 'clear-admin', TOTP_SECRET)
    database.raw.prepare(
      `INSERT INTO user_totp_credentials (
         user_id, secret_version, nonce_b64, ciphertext_b64,
         enabled_at_ms, created_at_ms, updated_at_ms
       ) VALUES ('clear-admin', ?, ?, ?, ?, ?, ?)`,
    ).run(
      encrypted.secret_version,
      encrypted.nonce_b64,
      encrypted.ciphertext_b64,
      now,
      now,
      now,
    )
  }
  return { env, raw: database.raw, accessToken }
}


describe('notification settings and real scheduled consumption', () => {
  it('persists CAS settings, sends actual balance/subscription/account content, deduplicates, retries and rearms', async () => {
    const f = await clearHarness(false)
    const send = vi.fn(async (_message: unknown) => undefined)
    f.env.SEND_EMAIL = { send }; f.env.EMAIL_FROM_ADDRESS = 'notify@example.test'
    const app = createApp()
    const now = Date.now()
    const call = (method: string, body?: unknown, version?: number) => app.request('/api/v1/admin/settings/notifications', { method, headers: { authorization: `Bearer ${f.accessToken}`, 'content-type': 'application/json', ...(version === undefined ? {} : { 'if-match': `"${version}"` }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env)
    try {
      expect((await call('GET')).status).toBe(200)
      const config = { balance_low_notify_enabled: true, balance_low_notify_threshold: 5, balance_low_notify_recharge_url: 'https://site.test/recharge', subscription_expiry_notify_enabled: true, account_quota_notify_enabled: true, account_quota_notify_emails: [{ email: 'operator@example.test', disabled: false, verified: true }] }
      expect((await call('PUT', config)).status).toBe(428)
      expect((await call('PUT', config, 0)).status).toBe(200)
      expect((await call('PUT', config, 0)).status).toBe(412)
      f.raw.prepare("UPDATE users SET balance_micros=2000000 WHERE id='clear-admin'").run()
      f.raw.prepare(`INSERT INTO "groups"(id,name,platform,group_type,created_at_ms,updated_at_ms) VALUES('notify-group','Notify Plan','openai','subscription',?,?)`).run(now,now)
      f.raw.prepare(`INSERT INTO user_subscriptions(id,user_id,group_id,starts_at_ms,expires_at_ms,source_type,source_id,created_at_ms,updated_at_ms) VALUES('notify-sub','clear-admin','notify-group',?,?,'admin','test',?,?)`).run(now-1000,now+3*86400000,now,now)
      const extra = { quota_notify_total_enabled: true, quota_notify_total_threshold: 2, quota_notify_total_threshold_type: 'fixed', quota_limit: 10 }
      f.raw.prepare(`INSERT INTO accounts(id,name,platform,credential_ref,ui_config_json,created_at_ms,updated_at_ms) VALUES('notify-account','Gateway Account','openai','test',?,?,?)`).run(JSON.stringify({extra}),now,now)
      f.raw.prepare(`INSERT INTO usage_projection(event_id,request_id,user_id,account_id,model,amount_micros,account_cost_micros,occurred_at_ms,projected_at_ms) VALUES('notify-usage','notify-request','clear-admin','notify-account','gpt-4o-mini',9000000,3000000,?,?)`).run(now,now)
      await scanSystemNotifications(f.env,{scanLimit:50,deliveryLimit:20,nowMs:now})
      expect(send).toHaveBeenCalledTimes(3)
      const messages = JSON.stringify(send.mock.calls)
      expect(messages).toContain('https://site.test/recharge')
      expect(messages).toContain('Notify Plan')
      expect(messages).toContain('Gateway total usage')
      expect(messages).toContain('Gateway Account')
      expect(f.raw.prepare("SELECT COUNT(*) AS n FROM system_notification_deliveries WHERE status='sent'").get().n).toBe(3)
      await scanSystemNotifications(f.env,{scanLimit:50,deliveryLimit:20,nowMs:now+1000}); expect(send).toHaveBeenCalledTimes(3)
      f.raw.prepare("UPDATE users SET balance_micros=6000000 WHERE id='clear-admin'").run()
      await scanSystemNotifications(f.env,{scanLimit:50,deliveryLimit:20,nowMs:now+2000})
      f.raw.prepare("UPDATE users SET balance_micros=1000000 WHERE id='clear-admin'").run()
      send.mockRejectedValueOnce(new Error('provider temporarily unavailable'))
      await scanSystemNotifications(f.env,{scanLimit:50,deliveryLimit:20,nowMs:now+3000}); expect(send).toHaveBeenCalledTimes(4)
      expect(f.raw.prepare("SELECT attempts FROM system_notification_deliveries WHERE status='pending'").get().attempts).toBe(1)
      await scanSystemNotifications(f.env,{scanLimit:50,deliveryLimit:20,nowMs:now+4000}); expect(send).toHaveBeenCalledTimes(4)
      await scanSystemNotifications(f.env,{scanLimit:50,deliveryLimit:20,nowMs:now+64000}); expect(send).toHaveBeenCalledTimes(5)
      f.raw.prepare("UPDATE users SET balance_micros=6000000 WHERE id='clear-admin'").run()
      await scanSystemNotifications(f.env,{scanLimit:50,deliveryLimit:20,nowMs:now+64500})
      f.raw.prepare("UPDATE users SET balance_micros=1000000 WHERE id='clear-admin'").run()
      send.mockRejectedValueOnce(new Error('temporary failure'))
      await scanSystemNotifications(f.env,{scanLimit:50,deliveryLimit:20,nowMs:now+64600}); expect(send).toHaveBeenCalledTimes(6)
      expect((await call('PUT', {balance_low_notify_enabled:false}, 1)).status).toBe(200)
      await scanSystemNotifications(f.env,{scanLimit:50,deliveryLimit:20,nowMs:now+125000}); expect(send).toHaveBeenCalledTimes(6)
      expect(f.raw.prepare("SELECT COUNT(*) AS n FROM system_notification_deliveries WHERE status='pending'").get().n).toBe(0)
      f.raw.prepare("UPDATE system_notification_scan SET lease_id='another',lease_expires_at_ms=?").run(now+200000)
      await scanSystemNotifications(f.env,{scanLimit:50,deliveryLimit:20,nowMs:now+126000}); expect(send).toHaveBeenCalledTimes(6)
    } finally { f.raw.close() }
  })
  it('keeps worst configured recipient fanout and all quota dimensions below 50 D1 statements per default pass',async()=>{
    const f=await clearHarness(false),now=Date.now();f.env.SEND_EMAIL={send:vi.fn(async()=>undefined)};f.env.EMAIL_FROM_ADDRESS='notify@example.test'
    try{
      const config={balance_low_notify_enabled:true,balance_low_notify_threshold:5,balance_low_notify_recharge_url:'',subscription_expiry_notify_enabled:true,account_quota_notify_enabled:true,account_quota_notify_emails:Array.from({length:20},(_,i)=>({email:`operator${i}@example.test`,verified:true,disabled:false}))}
      f.raw.prepare("INSERT INTO system_notification_settings VALUES('global',?,1,?)").run(JSON.stringify(config),now)
      f.raw.prepare(`INSERT INTO "groups"(id,name,platform,group_type,created_at_ms,updated_at_ms) VALUES('budget-group','Budget','openai','subscription',?,?)`).run(now,now)
      f.raw.prepare(`INSERT INTO user_subscriptions(id,user_id,group_id,starts_at_ms,expires_at_ms,source_type,source_id,created_at_ms,updated_at_ms) VALUES('budget-sub','clear-admin','budget-group',?,?,'admin','test',?,?)`).run(now-1000,now+3*86400000,now,now)
      const extra:Record<string,unknown>={quota_limit:10,quota_daily_limit:10,quota_weekly_limit:10};for(const d of ['daily','weekly','total']){extra[`quota_notify_${d}_enabled`]=true;extra[`quota_notify_${d}_threshold`]=2;extra[`quota_notify_${d}_threshold_type`]='fixed'}
      f.raw.prepare(`INSERT INTO accounts(id,name,platform,credential_ref,ui_config_json,created_at_ms,updated_at_ms) VALUES('budget-account','Budget','openai','test',?,?,?)`).run(JSON.stringify({extra}),now,now)
      f.raw.prepare(`INSERT INTO usage_projection(event_id,request_id,user_id,account_id,model,amount_micros,occurred_at_ms,projected_at_ms) VALUES('budget-usage','budget-request','clear-admin','budget-account','test',3000000,?,?)`).run(now,now)
      let count=0;const database=f.env.DB;f.env.DB=new Proxy(database,{get(target,key){if(key==='prepare')return (sql:string)=>{count++;return target.prepare(sql)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
      await scanSystemNotifications(f.env,{nowMs:now});expect(count).toBeLessThanOrEqual(50)
      expect(f.raw.prepare('SELECT COUNT(*) AS n FROM system_notification_deliveries').get().n).toBe(62)
      count=0;await scanSystemNotifications(f.env,{nowMs:now+60000});expect(count).toBeLessThanOrEqual(50)
    }finally{f.raw.close()}
  })
  it('uses local quota reset boundaries and never treats invalid timezone as a scan-wide failure', () => {
    const now=Date.parse('2026-09-07T04:00:00Z')
    expect(quotaWindowStart(now,'daily',{quota_daily_reset_mode:'fixed',quota_reset_timezone:'Asia/Shanghai',quota_daily_reset_hour:8})).toBe(Date.parse('2026-09-07T00:00:00Z'))
    expect(quotaWindowStart(now,'daily',{quota_daily_reset_mode:'fixed',quota_reset_timezone:'bad/timezone'})).toBe(Date.parse('2026-09-07T00:00:00Z'))
  })
})
