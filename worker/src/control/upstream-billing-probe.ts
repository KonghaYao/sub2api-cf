import type { Env } from '../env'
import { decryptCredential } from '../gateway/crypto'
import { GatewayError } from '../gateway/errors'
import { credentialAad, validateBaseUrl } from '../gateway/repository'
import { fetchAccountProxy } from '../gateway/proxy-fetch'
import { accountHeaderOverridesEligible, applyAccountCredentialHeaders } from '../gateway/account-header-overrides'
import { parseUpstreamBillingDeclaration, upstreamBillingSyncRate } from './upstream-billing-contract'

type Json = Record<string, unknown>
interface Account {
  id: string; enabled: number; platform: string; credential_kind: string; base_url: string; ui_config_json: string;
  config_version: number; credential_ref: string; key_version: number; nonce_b64: string; ciphertext_b64: string;
  proxy_version: number | null; billing_rate_multiplier_ppm: number
}
export interface BillingSnapshot {
  status: 'ok' | 'failed' | 'unsupported'; data?: Json; received_at?: string; fresh_until?: string;
  last_attempt_at: string; next_probe_at: string; failure_count?: number; http_status: number; last_error?: string;
  synced_rate_multiplier?: number
}
const platforms = new Set(['openai', 'anthropic', 'gemini', 'antigravity', 'grok', 'kimi', 'zhipu', 'deepseek'])
const official = ['anthropic.com', 'googleapis.com', 'x.ai', 'grok.com', 'openai.com', 'ollama.com', 'moonshot.cn', 'kimi.com', 'bigmodel.cn', 'deepseek.com']
const object = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}

/** Execute one observation. The caller owns scheduling and concurrency limits. */
export async function probeUpstreamBilling(env: Env, id: string, intervalMinutes = 30, scheduled = false): Promise<BillingSnapshot> {
  const row = await env.DB.prepare(`SELECT a.id,a.enabled,a.platform,a.credential_kind,a.base_url,a.ui_config_json,a.config_version,
    a.credential_ref,a.billing_rate_multiplier_ppm,s.key_version,s.nonce_b64,s.ciphertext_b64,p.control_version AS proxy_version
    FROM accounts a LEFT JOIN account_secrets s ON s.id=a.credential_ref AND s.account_id=a.id
    LEFT JOIN proxies p ON p.id=CAST(json_extract(a.ui_config_json,'$.proxy_id') AS TEXT) WHERE a.id=?`).bind(id).first<Account>()
  if (!row) throw new GatewayError(404, 'account_not_found', 'Account was not found')
  if (row.credential_kind !== 'api_key' || !platforms.has(row.platform)) throw new GatewayError(400, 'UPSTREAM_BILLING_PROBE_ACCOUNT_INVALID', 'Account is not a supported API-key account')
  const config = object(JSON.parse(row.ui_config_json)), extra = object(config.extra)
  const previous = object(extra.upstream_billing_probe)
  if (scheduled && (row.enabled !== 1 || extra.upstream_billing_probe_enabled !== true ||
    (typeof previous.next_probe_at === 'string' && Date.parse(previous.next_probe_at) > Date.now()))) {
    throw new GatewayError(409, 'UPSTREAM_BILLING_PROBE_NOT_DUE', 'Account is no longer due for a probe')
  }
  const proxy = config.proxy_id == null || String(config.proxy_id) === '0' ? undefined : String(config.proxy_id)
  const now = Date.now(), iso = (time: number) => new Date(time).toISOString()
  const interval = Math.max(5, Math.min(1440, intervalMinutes)) * 60_000
  let reason = '', status = 0, retryAfter = 0, data: Json | undefined
  let credential: Json = {}
  try {
    if (!env.CREDENTIALS_MASTER_KEY || !row.nonce_b64) throw new Error()
    credential = { ...await decryptCredential(row.nonce_b64, row.ciphertext_b64, env.CREDENTIALS_MASTER_KEY,
      credentialAad(env.ENVIRONMENT, row.id, row.credential_ref, row.key_version)) }
  } catch { reason = 'missing_api_key' }
  if (typeof credential.api_key !== 'string' || !credential.api_key) reason = 'missing_api_key'
  let url: URL | undefined
  if (!reason) {
    const base = row.base_url || (row.platform === 'openai' ? 'https://api.openai.com' : '')
    try {
      url = validateBaseUrl(base)
      const host = url.hostname.toLowerCase().replace(/\.$/, '')
      if (row.platform !== 'openai' && official.some(domain => host === domain || host.endsWith(`.${domain}`))) reason = 'unsupported'
      const path = url.pathname.replace(/\/+$/, '')
      url.pathname = path.endsWith('/sub2api/billing') ? path : path + (/\/v\d+(?:\.\d+|(?:alpha|beta|preview)[^/]*)?$/i.test(path) ? '/sub2api/billing' : '/v1/sub2api/billing')
    } catch { reason = row.platform !== 'openai' && !base ? 'unsupported' : 'invalid_base_url' }
  }
  if (!reason && proxy && row.proxy_version === null) reason = 'proxy_unavailable'
  if (!reason) {
    const signal = AbortSignal.timeout(10_000)
    const headers = new Headers({ accept: 'application/json', authorization: `Bearer ${credential.api_key}` })
    if (accountHeaderOverridesEligible(row.platform, 'api_key')) applyAccountCredentialHeaders(headers, credential)
    let response: Response | undefined
    try {
      const init: RequestInit = { method: 'GET', headers, redirect: 'manual', signal }
      response = proxy ? await fetchAccountProxy(env, proxy, url!, init, signal) : await fetch(url!, init)
      status = response.status
      const retry = response.headers.get('retry-after')?.trim() ?? ''
      retryAfter = /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - now) || 0
      if (!Number.isFinite(retryAfter)) retryAfter = 0
      if (!response.body) reason = 'empty_response'
      else {
        const reader = response.body.getReader(), chunks: Uint8Array[] = []
        let size = 0
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > 65536) { reason = 'response_too_large'; await reader.cancel(); break }
            chunks.push(chunk.value)
          }
        } catch { reason = 'response_read_failed' } finally { reader.releaseLock() }
        if (!reason) {
          if (status === 404 || status === 405) reason = 'unsupported'
          else if (!response.ok) reason = 'http_error'
          else {
            const bytes = new Uint8Array(size)
            let offset = 0
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
            try { data = parseUpstreamBillingDeclaration(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
            catch { reason = 'invalid_response' }
          }
        }
      }
    } catch { reason = 'request_failed' }
    finally { try { await response?.body?.cancel() } catch { /* Observation takes precedence. */ } }
  }
  const jitter = Math.min(interval / 5, 300_000)
  let delay = Math.max(Math.min(86_400_000, interval + Math.floor(Math.random() * (2 * jitter + 1)) - jitter), retryAfter)
  if (reason === 'unsupported' && delay < 86_400_000) delay = Math.min(86_400_000, delay * 8)
  // JS dates have a finite range even when an untrusted Retry-After does not.
  delay = Math.min(delay, 8.64e15 - now)
  const snapshot: BillingSnapshot = { status: reason ? reason === 'unsupported' ? 'unsupported' : 'failed' : 'ok',
    last_attempt_at: iso(now), next_probe_at: iso(now + delay), http_status: status }
  let rate: number | null = null
  if (reason) {
    snapshot.last_error = reason
    snapshot.failure_count = (Number.isSafeInteger(previous.failure_count) ? Number(previous.failure_count) : 0) + 1
    if (previous.data) snapshot.data = object(previous.data)
    if (typeof previous.received_at === 'string') snapshot.received_at = previous.received_at
    if (typeof previous.fresh_until === 'string') snapshot.fresh_until = previous.fresh_until
    else if (previous.status === 'ok' && snapshot.received_at && Number.isFinite(Date.parse(snapshot.received_at))) snapshot.fresh_until = iso(Date.parse(snapshot.received_at) + 2 * interval)
  } else {
    snapshot.data = data; snapshot.received_at = iso(now); snapshot.fresh_until = iso(now + 2 * interval)
    if (extra.upstream_billing_probe_enabled === true && extra.upstream_billing_rate_sync_enabled === true) rate = upstreamBillingSyncRate(data!)
    if (rate !== null) snapshot.synced_rate_multiplier = rate
  }
  const ratePpm = rate === null ? row.billing_rate_multiplier_ppm : Math.round(rate * 1_000_000)
  const changed = ratePpm !== row.billing_rate_multiplier_ppm ? 1 : 0
  const result = await env.DB.prepare(`UPDATE accounts SET ui_config_json=json_set(ui_config_json,'$.extra',
      json_set(CASE WHEN json_type(ui_config_json,'$.extra')='object' THEN json_extract(ui_config_json,'$.extra') ELSE '{}' END,
        '$.upstream_billing_probe',json(?))),billing_rate_multiplier_ppm=?,config_version=config_version+?,control_version=control_version+?,updated_at_ms=?
    WHERE id=? AND config_version=? AND ui_config_json=? AND credential_ref=?
      AND (SELECT key_version FROM account_secrets s WHERE s.id=accounts.credential_ref AND s.account_id=accounts.id) IS ?
      AND (? IS NULL OR (SELECT control_version FROM proxies WHERE id=?) IS ?) RETURNING id`)
    .bind(JSON.stringify(snapshot),ratePpm,changed,changed,now,id,row.config_version,row.ui_config_json,row.credential_ref,row.key_version,
      proxy ?? null,proxy ?? null,row.proxy_version).first<{ id: string }>()
  if (result?.id !== id) throw new GatewayError(409, 'UPSTREAM_BILLING_PROBE_IDENTITY_CHANGED', 'Account changed during upstream billing probe; retry the probe')
  return snapshot
}
