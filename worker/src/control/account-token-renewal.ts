import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'
import { refreshOAuthAccount } from './accounts'
import { controlIdempotency } from './idempotency'

/** Original default: refresh thirty minutes before expiry, check every five minutes.
 * Durable attempt timestamps throttle each account across overlapping cron runs.
 */
export async function renewDueAccountTokens(env: Env, now = Date.now()) {
  const candidates = await env.DB.prepare(`WITH candidates AS (
    SELECT a.id,a.control_version,s.key_version,
      CASE
        WHEN json_type(a.ui_config_json,'$.credentials.expires_at') IN ('integer','real')
          THEN CAST(json_extract(a.ui_config_json,'$.credentials.expires_at') AS REAL)
        WHEN CAST(json_extract(a.ui_config_json,'$.credentials.expires_at') AS TEXT) GLOB '[0-9]*'
          AND CAST(json_extract(a.ui_config_json,'$.credentials.expires_at') AS TEXT) NOT GLOB '*[^0-9]*'
          THEN CAST(json_extract(a.ui_config_json,'$.credentials.expires_at') AS REAL)
        ELSE unixepoch(json_extract(a.ui_config_json,'$.credentials.expires_at'),'subsec')
      END AS token_expiry,
      a.platform,a.ui_config_json,COALESCE(r.last_attempt_at_ms,0) AS last_attempt
    FROM accounts a JOIN account_secrets s ON s.id=a.credential_ref AND s.account_id=a.id
      LEFT JOIN account_oauth_refresh_state r ON r.account_id=a.id
    WHERE a.enabled=1 AND a.health_status<>'unhealthy'
      AND COALESCE(json_extract(a.ui_config_json,'$.schedulable'),1)=1
      AND ((a.platform='openai' AND a.credential_kind='oauth') OR
        (a.platform='anthropic' AND a.credential_kind IN ('oauth','setup_token')))
      AND json_extract(a.ui_config_json,'$.parent_account_id') IS NULL
      AND json_extract(a.ui_config_json,'$.credentials_status.has_refresh_token')=1
      AND COALESCE(r.lease_until_ms,0)<=?
      AND (COALESCE(r.next_attempt_at_ms,0)<=? OR r.credential_ref IS NOT a.credential_ref
        OR r.credential_key_version IS NOT s.key_version)
  ) SELECT id,control_version,key_version FROM candidates
    WHERE token_expiry<? OR (token_expiry IS NULL AND platform='openai'
      AND unixepoch(json_extract(ui_config_json,'$.rate_limit_reset_at'),'subsec')>?)
    ORDER BY last_attempt,id LIMIT 20`).bind(now, now, now / 1000 + 1800, now / 1000)
    .all<{ id: string; control_version: number; key_version: number }>()
  const result = { refreshed: 0, failed: 0, skipped: 0 }
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, candidates.results.length) }, async () => {
    while (cursor < candidates.results.length) {
      const account = candidates.results[cursor++]!
      try {
        const idempotency = await controlIdempotency('account.auto-token-refresh.v1',
          `${account.id}:${account.key_version}:${account.control_version}:${Math.floor(now / 300_000)}`,
          { account_id: account.id, expected_control_version: account.control_version })
        await refreshOAuthAccount(env, account.id, account.control_version, idempotency)
        result.refreshed++
      } catch (error) {
        if (error instanceof GatewayError && [404, 409, 412].includes(error.status)) result.skipped++
        else result.failed++
      }
    }
  }))
  return result
}
