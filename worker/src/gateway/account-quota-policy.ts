import { accountQuotaProjection } from '../control/account-quota-projection'

/** Original IsQuotaExceeded: any live configured dimension can block dispatch. */
export function accountQuotaExceeded(raw: string | undefined, credentialKind: string, now = Date.now()): boolean {
  const ui = raw ? JSON.parse(raw) as Record<string, unknown> : {}
  if (credentialKind !== 'api_key' && ui.type !== 'bedrock') return false
  const extra = ui.extra && typeof ui.extra === 'object' && !Array.isArray(ui.extra) ? ui.extra as Record<string, unknown> : {}
  const quota = accountQuotaProjection(extra, now)
  return ['quota', 'quota_daily', 'quota_weekly'].some(prefix => {
    const limit = quota[`${prefix}_limit`], used = quota[`${prefix}_used`]
    return typeof limit === 'number' && limit > 0 && typeof used === 'number' && used >= limit
  })
}
