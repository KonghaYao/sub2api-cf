import type { Env } from '../env'
import { readNotificationSettings, type NotificationSettings } from '../control/notification-settings'
import { deterministicUuid } from '../control/http'
import { deliverPlatformEmail, hasEmailDeliveryConfigured } from '../email/delivery'
import { readEmailTemplate, renderTemplate, templateHTMLToText } from '../email/templates'

const DAY = 86400000
interface ScanState { users_cursor: string; subscriptions_cursor: string; accounts_cursor: string }
interface User { id: string; email: string; display_name: string; balance_micros: number; enabled: number; threshold: number }
interface Subscription { id: string; user_id: string; email: string; display_name: string; group_name: string; expires_at_ms: number }
interface Account { id: string; name: string; platform: string; ui_config_json: string }

/** Every scheduled pass scans bounded pages. A database lease prevents duplicate concurrent senders. */
export async function scanSystemNotifications(env: Env, options: { nowMs?: number; scanLimit?: number; deliveryLimit?: number } = {}): Promise<void> {
  const now = options.nowMs ?? Date.now()
  const limit = Math.max(1, Math.min(100, options.scanLimit ?? 1))
  const settings = await readNotificationSettings(env)
  if (!(await hasEmailDeliveryConfigured(env))) return
  const lease = crypto.randomUUID()
  const claimed = await env.DB.prepare("UPDATE system_notification_scan SET lease_id=?,lease_expires_at_ms=? WHERE id='global' AND lease_expires_at_ms<=?").bind(lease, now + 5 * 60000, now).run()
  if (!claimed.meta.changes) return
  try {
    const cursors = await env.DB.prepare("SELECT users_cursor,subscriptions_cursor,accounts_cursor FROM system_notification_scan WHERE id='global'").first<ScanState>()
    if (!cursors) return
    const site = await env.DB.prepare("SELECT json_extract(public_json,'$.site_name') AS name FROM system_settings WHERE id='global'").first<{ name: string }>()
    const common = { site_name: site?.name || 'Sub2API' }
    if (settings.balance_low_notify_enabled) {
      const users = await env.DB.prepare(`SELECT u.id,u.email,u.display_name,u.balance_micros,
        COALESCE(p.balance_notify_enabled,1) AS enabled,COALESCE(p.balance_notify_threshold_micros,?) AS threshold
        FROM users u LEFT JOIN user_notification_preferences p ON p.user_id=u.id
        WHERE u.status='active' AND u.id>? ORDER BY u.id LIMIT ?`)
        .bind(Math.round(settings.balance_low_notify_threshold * 1000000), cursors.users_cursor, limit).all<User>()
      for (const user of users.results) {
        const recipients = await ownerRecipients(env, user.id, user.email)
        await condition(env, `balance:${user.id}`, 'balance.low', user.enabled === 1 && user.threshold > 0 && user.balance_micros < user.threshold,
          recipients, { ...common, user_id: user.id, recipient_name: user.display_name, current_balance: dollars(user.balance_micros), threshold: dollars(user.threshold), recharge_url: settings.balance_low_notify_recharge_url }, now)
      }
      await cursor(env, lease, 'users_cursor', users.results.length === limit ? users.results.at(-1)!.id : '')
    }
    if (settings.subscription_expiry_notify_enabled) {
      const subscriptions = await env.DB.prepare(`SELECT s.id,s.user_id,u.email,u.display_name,g.name AS group_name,s.expires_at_ms
        FROM user_subscriptions s JOIN users u ON u.id=s.user_id JOIN "groups" g ON g.id=s.group_id
        WHERE s.status='active' AND u.status='active' AND s.expires_at_ms>? AND s.id>? ORDER BY s.id LIMIT ?`)
        .bind(now, cursors.subscriptions_cursor, limit).all<Subscription>()
      for (const sub of subscriptions.results) {
        const days = Math.ceil((sub.expires_at_ms - now) / DAY)
        if (![7, 3, 1].includes(days)) continue
        await condition(env, `subscription:${sub.id}:${sub.expires_at_ms}:${days}`, 'subscription.expiry_reminder', true,
          [sub.email], { ...common, subscription_id: sub.id, recipient_name: sub.display_name, subscription_group: sub.group_name, expiry_time: new Date(sub.expires_at_ms).toISOString(), days_remaining: String(days) }, now)
      }
      await cursor(env, lease, 'subscriptions_cursor', subscriptions.results.length === limit ? subscriptions.results.at(-1)!.id : '')
    }
    if (settings.account_quota_notify_enabled) {
      const accounts = await env.DB.prepare('SELECT id,name,platform,ui_config_json FROM accounts WHERE enabled=1 AND id>? ORDER BY id LIMIT ?').bind(cursors.accounts_cursor, limit).all<Account>()
      const recipients = [...new Set(settings.account_quota_notify_emails.filter((entry) => !entry.disabled && entry.verified).map((entry) => entry.email))]
      for (const account of accounts.results) {
        const extra = (JSON.parse(account.ui_config_json) as { extra?: Record<string, unknown> }).extra ?? {}
        for (const dimension of ['daily', 'weekly', 'total'] as const) {
          if (extra[`quota_notify_${dimension}_enabled`] !== true) continue
          const threshold = finiteAmount(extra[`quota_notify_${dimension}_threshold`])
          const quota = finiteAmount(extra[dimension === 'total' ? 'quota_limit' : `quota_${dimension}_limit`])
          const effective = extra[`quota_notify_${dimension}_threshold_type`] === 'percentage' ? quota * threshold / 100 : threshold
          if (effective <= 0) continue
          const since = quotaWindowStart(now, dimension, extra)
          const usage = await env.DB.prepare(`SELECT COALESCE(SUM(COALESCE(account_cost_micros,account_stats_cost_micros,standard_cost_micros,amount_micros)),0) AS cost
            FROM usage_projection WHERE account_id=? AND occurred_at_ms>=? AND occurred_at_ms<=?`).bind(account.id, since, now).first<{ cost: number }>()
          const used = usage?.cost ?? 0
          await condition(env, `account:${account.id}:${dimension}`, 'account.quota_alert', used >= Math.round(effective * 1000000), recipients,
            { ...common, account_id: account.id, account_name: account.name, platform: account.platform, quota_dimension: `Gateway ${dimension} usage`, quota_used: dollars(used), quota_limit: String(quota), quota_remaining: String(Math.max(0, quota - used / 1000000)), quota_threshold: String(effective) }, now)
        }
      }
      await cursor(env, lease, 'accounts_cursor', accounts.results.length === limit ? accounts.results.at(-1)!.id : '')
    }
    await deliverPending(env, settings, now, Math.min(20, options.deliveryLimit ?? 1))
  } finally {
    await env.DB.prepare("UPDATE system_notification_scan SET lease_id=NULL,lease_expires_at_ms=0 WHERE id='global' AND lease_id=?").bind(lease).run()
  }
}
async function cursor(env: Env, lease: string, field: keyof ScanState, value: string): Promise<void> {
  await env.DB.prepare(`UPDATE system_notification_scan SET ${field}=? WHERE id='global' AND lease_id=?`).bind(value, lease).run()
}
async function ownerRecipients(env: Env, userId: string, primary: string): Promise<string[]> {
  const extra = await env.DB.prepare('SELECT email FROM user_notification_emails WHERE user_id=? AND disabled=0 AND verified_at_ms IS NOT NULL').bind(userId).all<{ email: string }>()
  return [...new Set([primary, ...extra.results.map((row) => row.email)])]
}
async function condition(env: Env, id: string, event: string, active: boolean, recipients: string[], variables: Record<string, string>, now: number): Promise<void> {
  const state = await env.DB.prepare(`INSERT INTO system_notification_conditions(id,active,generation,updated_at_ms) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET generation=system_notification_conditions.generation + CASE WHEN system_notification_conditions.active=0 AND excluded.active=1 THEN 1 ELSE 0 END,
      active=excluded.active,updated_at_ms=excluded.updated_at_ms RETURNING generation`).bind(id, active ? 1 : 0, active ? 1 : 0, now).first<{generation:number}>()
  if (!active) {
    await env.DB.prepare("DELETE FROM system_notification_deliveries WHERE condition_id=? AND status='pending'").bind(id).run()
    return
  }
  if (!recipients.length) return
  // D1 limits SQL variables as well as statements; JSON iteration keeps both bounded.
  const deliveries = await Promise.all(recipients.map(async recipient => ({
    id: await deterministicUuid('system-notification:v1', `${id}:${state!.generation}:${recipient.toLowerCase()}`),
    recipient, variables: { ...variables, recipient_email: recipient },
  })))
  await env.DB.prepare(`INSERT INTO system_notification_deliveries(id,condition_id,event,recipient,variables_json,status,created_at_ms)
    SELECT json_extract(value,'$.id'),?,?,json_extract(value,'$.recipient'),json_extract(value,'$.variables'),'pending',?
    FROM json_each(?) WHERE true ON CONFLICT(id) DO NOTHING`).bind(id,event,now,JSON.stringify(deliveries)).run()

}
async function deliverPending(env: Env, settings: NotificationSettings, now: number, limit: number): Promise<void> {
  const enabled = [settings.balance_low_notify_enabled ? 'balance.low' : '', settings.subscription_expiry_notify_enabled ? 'subscription.expiry_reminder' : '', settings.account_quota_notify_enabled ? 'account.quota_alert' : '']
  await env.DB.prepare("DELETE FROM system_notification_deliveries WHERE status='pending' AND event NOT IN(?,?,?)").bind(...enabled).run()
  const rows = await env.DB.prepare("SELECT id,event,recipient,variables_json,attempts FROM system_notification_deliveries WHERE status='pending' AND next_attempt_at_ms<=? ORDER BY created_at_ms,id LIMIT ?")
    .bind(now, limit).all<{ id: string; event: string; recipient: string; variables_json: string; attempts: number }>()
  for (const row of rows.results) {
    try {
      const template = await readEmailTemplate(env, row.event, 'en')
      const variables = JSON.parse(row.variables_json) as Record<string, string>
      if (!(await deliveryStillRelevant(env, row.event, row.recipient, variables, settings, now))) {
        await env.DB.prepare("DELETE FROM system_notification_deliveries WHERE id=? AND status='pending'").bind(row.id).run()
        continue
      }
      const rendered = renderTemplate(template, variables)
      await deliverPlatformEmail({ eventId: row.id, recipient: row.recipient, ...rendered, text: templateHTMLToText(rendered.html), compatibilityPayload: { recipient_email: row.recipient, purpose: row.event, ...rendered, text: templateHTMLToText(rendered.html), variables, locale: 'en' } }, env)
      await env.DB.prepare("UPDATE system_notification_deliveries SET status='sent',sent_at_ms=?,attempts=attempts+1 WHERE id=?").bind(now, row.id).run()
    } catch {
      await env.DB.prepare("UPDATE system_notification_deliveries SET attempts=attempts+1,next_attempt_at_ms=? WHERE id=?").bind(now + Math.min(3600000, 60000 * 2 ** Math.min(row.attempts, 6)), row.id).run()
    }
  }
}
async function deliveryStillRelevant(env: Env, event: string, recipient: string, variables: Record<string, string>, settings: NotificationSettings, now: number): Promise<boolean> {
  if (event === 'balance.low') {
    const row = await env.DB.prepare(`SELECT u.email,u.balance_micros,COALESCE(p.balance_notify_enabled,1) AS enabled,
      COALESCE(p.balance_notify_threshold_micros,?) AS threshold FROM users u LEFT JOIN user_notification_preferences p ON p.user_id=u.id
      WHERE u.id=? AND u.status='active'`).bind(Math.round(settings.balance_low_notify_threshold*1000000), variables.user_id).first<{ email: string; balance_micros: number; enabled: number; threshold: number }>()
    if (!row || row.enabled !== 1 || row.threshold <= 0 || row.balance_micros >= row.threshold) return false
    if (!(await ownerRecipients(env, variables.user_id, row.email)).includes(recipient)) return false
    variables.current_balance = dollars(row.balance_micros); variables.threshold = dollars(row.threshold)
    return true
  }
  if (event === 'subscription.expiry_reminder') {
    const row = await env.DB.prepare(`SELECT s.expires_at_ms,u.email FROM user_subscriptions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.status='active' AND u.status='active'`).bind(variables.subscription_id).first<{ expires_at_ms: number; email: string }>()
    return !!row && row.email === recipient && row.expires_at_ms === Date.parse(variables.expiry_time) && Math.ceil((row.expires_at_ms-now)/DAY) === Number(variables.days_remaining)
  }
  if (event === 'account.quota_alert') {
    if (!settings.account_quota_notify_emails.some((entry) => entry.email === recipient && entry.verified && !entry.disabled)) return false
    const row = await env.DB.prepare('SELECT enabled,ui_config_json FROM accounts WHERE id=?').bind(variables.account_id).first<{ enabled: number; ui_config_json: string }>()
    if (row?.enabled !== 1) return false
    const dimension = variables.quota_dimension.split(' ')[1] as 'daily' | 'weekly' | 'total'
    if (!['daily','weekly','total'].includes(dimension)) return false
    const extra = (JSON.parse(row.ui_config_json) as { extra?: Record<string, unknown> }).extra ?? {}
    if (extra[`quota_notify_${dimension}_enabled`] !== true) return false
    const threshold = finiteAmount(extra[`quota_notify_${dimension}_threshold`])
    const quota = finiteAmount(extra[dimension === 'total' ? 'quota_limit' : `quota_${dimension}_limit`])
    const effective = extra[`quota_notify_${dimension}_threshold_type`] === 'percentage' ? quota * threshold / 100 : threshold
    const usage = await env.DB.prepare(`SELECT COALESCE(SUM(COALESCE(account_cost_micros,account_stats_cost_micros,standard_cost_micros,amount_micros)),0) AS cost FROM usage_projection WHERE account_id=? AND occurred_at_ms>=? AND occurred_at_ms<=?`).bind(variables.account_id,quotaWindowStart(now,dimension,extra),now).first<{ cost: number }>()
    if (effective <= 0 || (usage?.cost ?? 0) < Math.round(effective * 1000000)) return false
    variables.quota_used = dollars(usage!.cost); variables.quota_limit = String(quota)
    variables.quota_remaining = String(Math.max(0,quota-usage!.cost/1000000)); variables.quota_threshold = String(effective)
    return true
  }
  return false
}
function dollars(value: number): string { return (value / 1000000).toFixed(6).replace(/\.?0+$/, '') || '0' }
function finiteAmount(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0 }

export function quotaWindowStart(now: number, dimension: 'daily' | 'weekly' | 'total', extra: Record<string, unknown>): number {
  if (dimension === 'total') return 0
  const duration = dimension === 'daily' ? DAY : 7 * DAY
  const saved = Date.parse(String(extra[`quota_${dimension}_start`] ?? ''))
  if (extra[`quota_${dimension}_reset_mode`] !== 'fixed') return Number.isFinite(saved) && saved <= now && now - saved < duration ? saved : now - duration
  let zone = typeof extra.quota_reset_timezone === 'string' ? extra.quota_reset_timezone : 'UTC'
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }) } catch { zone = 'UTC' }
  const hour = Math.min(23, Math.max(0, Number(extra[`quota_${dimension}_reset_hour`]) || 0))
  const parts = (time: number) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(time).map((part) => [part.type, part.value]))
  const local = parts(now)
  let target = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), hour)
  if (Number(local.hour) < hour) target -= DAY
  if (dimension === 'weekly') target -= ((new Date(target).getUTCDay() - (Number(extra.quota_weekly_reset_day) || 0) + 7) % 7) * DAY
  let candidate = target
  for (let iteration = 0; iteration < 3; iteration++) {
    const current = parts(candidate)
    const represented = Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day), Number(current.hour), Number(current.minute), Number(current.second))
    candidate += target - represented
  }
  return candidate
}
