import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'

export async function claimAccountOAuthRefresh(env: Env, accountId: string, expectedControlVersion: number): Promise<string> {
  const now = Date.now(), token = crypto.randomUUID()
  const claimed = await env.DB.prepare(`INSERT INTO account_oauth_refresh_state
    (account_id,lease_token,lease_until_ms,last_attempt_at_ms,credential_ref,credential_key_version)
    SELECT a.id,?,?,?,a.credential_ref,s.key_version FROM accounts a
      JOIN account_secrets s ON s.id=a.credential_ref AND s.account_id=a.id WHERE a.id=? AND a.control_version=?
    ON CONFLICT(account_id) DO UPDATE SET lease_token=excluded.lease_token,
      lease_until_ms=excluded.lease_until_ms,last_attempt_at_ms=excluded.last_attempt_at_ms,
      credential_ref=excluded.credential_ref,credential_key_version=excluded.credential_key_version
    WHERE account_oauth_refresh_state.lease_until_ms<=?
    RETURNING account_id`).bind(token, now + 120_000, now, accountId, expectedControlVersion, now).first()
  if (!claimed) {
    const account = await env.DB.prepare('SELECT control_version FROM accounts WHERE id=?').bind(accountId)
      .first<{ control_version: number }>()
    if (!account) throw new GatewayError(404, 'account_not_found', 'Account not found')
    if (account.control_version !== expectedControlVersion) throw new GatewayError(412, 'account_version_conflict', 'Account changed; reload it and retry')
    throw new GatewayError(409, 'oauth_refresh_in_progress', 'Account token refresh is already in progress')
  }
  return token
}

export async function releaseAccountOAuthRefresh(env: Env, accountId: string, token: string, errorCode: string | null) {
  await env.DB.prepare(`UPDATE account_oauth_refresh_state SET lease_token=NULL,lease_until_ms=0,
    next_attempt_at_ms=?,last_error_code=? WHERE account_id=? AND lease_token=?`)
    .bind(Date.now() + 300_000, errorCode, accountId, token).run()
}

/** A lost/expired lease must roll back the entire credential transaction. */
export function accountOAuthRefreshLeaseGuard(env: Env, accountId: string, token: string, nextKeyVersion: number) {
  return env.DB.prepare(`UPDATE account_oauth_refresh_state SET lease_until_ms=
    CASE WHEN lease_token=? AND lease_until_ms>? THEN lease_until_ms ELSE -1 END,
    credential_key_version=? WHERE account_id=?`)
    .bind(token, Date.now(), nextKeyVersion, accountId)
}
