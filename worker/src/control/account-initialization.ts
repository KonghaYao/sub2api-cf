import { applyOpenAIResponsesProbe } from './openai-responses-probe'
import type { Env, PlatformEvent } from '../env'
import { GatewayError } from '../gateway/errors'
import { applyOpenAIAccountPrivacy, type PrivacyAccount } from './account-privacy'

const EVENT = 'account.initialize.v1'
type InitializationEvent = PlatformEvent<{ account_id: string }>
export function isAccountInitializationEvent(value: unknown): value is InitializationEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as InitializationEvent
  return event.schema_version === 1 && [EVENT, 'account.initialize-privacy.v1'].includes(event.event_type) && typeof event.payload?.account_id === 'string'
    && event.aggregate_id === event.payload.account_id && event.event_id === `account-init:${event.payload.account_id}`
}
export function accountInitializationInsert(env: Env, accountId: string, now: number, kind = 'openai_privacy'): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO account_initialization_jobs(account_id,credential_key_version,created_at_ms,updated_at_ms,kind) VALUES(?,1,?,?,?)`).bind(accountId, now, now, kind)
}

/** Re-probing an edited account replaces the old lease inside the edit transaction. */
export function accountInitializationReset(env: Env, accountId: string, keyVersion: number, now: number): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO account_initialization_jobs(account_id,credential_key_version,created_at_ms,updated_at_ms,kind)
    VALUES(?,?,?,?,'openai_responses') ON CONFLICT(account_id) DO UPDATE SET
      credential_key_version=excluded.credential_key_version,kind=excluded.kind,status='pending',lease_token=NULL,lease_until_ms=0,
      next_dispatch_at_ms=0,attempts=0,result_mode=NULL,updated_at_ms=excluded.updated_at_ms`).bind(accountId,keyVersion,now,now)
}

/** Durable outbox: immediate delivery and Cron share the same bounded dispatcher. */
export async function dispatchAccountInitializations(env: Env, accountId?: string, now = Date.now()): Promise<void> {
  const rows = await env.DB.prepare(`SELECT account_id FROM account_initialization_jobs WHERE
    (status='pending' OR (status='running' AND lease_until_ms<=?)) AND next_dispatch_at_ms<=?
    ${accountId ? 'AND account_id=?' : ''} ORDER BY created_at_ms,account_id LIMIT 20`)
    .bind(now, now, ...(accountId ? [accountId] : [])).all<{ account_id: string }>()
  for (const row of rows.results) {
    const claimed = await env.DB.prepare(`UPDATE account_initialization_jobs SET next_dispatch_at_ms=?,updated_at_ms=?
      WHERE account_id=? AND next_dispatch_at_ms<=? AND (status='pending' OR (status='running' AND lease_until_ms<=?)) RETURNING account_id`)
      .bind(now + 60000, now, row.account_id, now, now).first()
    if (!claimed) continue
    try {
      await env.EVENTS_QUEUE.send({ schema_version: 1, event_id: `account-init:${row.account_id}`, event_type: EVENT,
        occurred_at_ms: now, aggregate_type: 'account', aggregate_id: row.account_id, payload: { account_id: row.account_id } })
    } catch { /* The committed task remains due for Cron; creation must not be reported as failed. */ }
  }
}

export async function consumeAccountInitialization(env: Env, event: InitializationEvent): Promise<void> {
  return initializeAccountNow(env, event.payload.account_id)
}

export async function initializeAccountNow(env: Env, accountId: string, advanceControlVersion = true): Promise<void> {
  const now = Date.now(), lease = crypto.randomUUID()
  const job = await env.DB.prepare(`UPDATE account_initialization_jobs SET status='running',lease_token=?,lease_until_ms=?,attempts=attempts+1,updated_at_ms=?
    WHERE account_id=? AND (status='pending' OR (status='running' AND lease_until_ms<=?)) RETURNING credential_key_version,kind`)
    .bind(lease, now + 120000, now, accountId, now).first<{ credential_key_version: number; kind: string }>()
  if (!job) return
  const finish = (status: string, mode: string | null) => env.DB.prepare(`UPDATE account_initialization_jobs SET status=?,result_mode=?,lease_token=NULL,lease_until_ms=0,updated_at_ms=?
    WHERE account_id=? AND lease_token=?`).bind(status, mode, Date.now(), accountId, lease).run()
  try {
    const account = await env.DB.prepare(`SELECT a.id,a.base_url,a.platform,a.credential_kind,a.credential_ref,a.config_version,a.control_version,a.ui_config_json,
      s.id AS secret_id,s.key_version,s.nonce_b64,s.ciphertext_b64 FROM accounts a JOIN account_secrets s ON s.id=a.credential_ref AND s.account_id=a.id WHERE a.id=?`)
      .bind(accountId).first<PrivacyAccount & { base_url: string }>()
    if (!account || account.platform !== 'openai' || account.credential_kind !== (job.kind === 'openai_responses' ? 'api_key' : 'oauth')) {
      await finish('superseded', null); return
    }
    const verdict = job.kind === 'openai_responses' ? await applyOpenAIResponsesProbe(env, account) : await applyOpenAIAccountPrivacy(env, account, advanceControlVersion, true)
    const mode = typeof verdict === 'string' ? verdict || 'not_applicable' : verdict === null ? 'unknown' : verdict ? 'responses_supported' : 'responses_unsupported'
    // Original Force records provider refusal/challenge as a result, not an infinite retry.
    await finish('completed', mode)
  } catch (error) {
    if (error instanceof GatewayError && error.status === 400) { await finish('failed', null); return }
    await env.DB.prepare(`UPDATE account_initialization_jobs SET status='pending',lease_token=NULL,lease_until_ms=0,next_dispatch_at_ms=?,updated_at_ms=?
      WHERE account_id=? AND lease_token=?`).bind(Date.now() + 1000, Date.now(), accountId, lease).run()
    throw error
  }
}
