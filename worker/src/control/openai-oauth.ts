import type { Context } from 'hono'
import type { Env } from '../env'
import { constantTimeEqual, decryptCredential, encryptCredential, sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { authenticateAdminSession } from './admin-auth'
import { controlError, controlSuccess, readOptionalJsonObject, readJsonObject, requireString } from './http'
import { OPENAI_OAUTH_CLIENT_ID, requestOpenAITokens } from './openai-oauth-http'
import { enrichOpenAITokenInfo, openAITokenInfo } from './openai-oauth-profile'

type C = Context<{ Bindings: Env }>
interface Session {
  id: string; user_id: string; state_hash: string; nonce_b64: string; ciphertext_b64: string
  client_id: string; redirect_uri: string; proxy_id: string | null; expires_at_ms: number
  lease_token: string | null; lease_expires_at_ms: number
}
const DEFAULT_REDIRECT = 'http://localhost:1455/auth/callback'
const SESSION_TTL = 30 * 60 * 1000

export async function generateOpenAIAuthURL(c: C): Promise<Response> {
  try {
    const actor = await authenticateAdminSession(c.req.raw, c.env)
    const body = await readOptionalJsonObject(c.req.raw, 16 * 1024)
    const proxyId = await validateProxy(c.env, body.proxy_id)
    const redirect = redirectURI(body.redirect_uri) || DEFAULT_REDIRECT
    const state = randomHex(32); const verifier = randomHex(64); const id = randomHex(16)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const encrypted = await encryptCredential({ api_key: verifier }, masterKey(c.env), aad(c.env, id, actor.user_id))
    const now = Date.now()
    await c.env.DB.batch([
      // Expiry is enforced on reads too; cleanup is bounded independently of load.
      c.env.DB.prepare('DELETE FROM account_oauth_sessions WHERE id IN (SELECT id FROM account_oauth_sessions WHERE expires_at_ms <= ? LIMIT 100)').bind(now),
      c.env.DB.prepare(`INSERT INTO account_oauth_sessions(id,user_id,state_hash,nonce_b64,ciphertext_b64,client_id,
        redirect_uri,proxy_id,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, actor.user_id, await sha256Hex(state), encrypted.nonce_b64, encrypted.ciphertext_b64,
          OPENAI_OAUTH_CLIENT_ID, redirect, proxyId, now, now + SESSION_TTL),
    ])
    const url = new URL('https://auth.openai.com/oauth/authorize')
    url.search = new URLSearchParams({ response_type: 'code', client_id: OPENAI_OAUTH_CLIENT_ID, redirect_uri: redirect,
      scope: 'openid profile email offline_access', state, code_challenge: challenge, code_challenge_method: 'S256',
      id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true' }).toString()
    return noStore(controlSuccess({ auth_url: url.href, session_id: id }))
  } catch (error) { return noStore(controlError(asGatewayError(error))) }
}

export async function exchangeOpenAIAuthCode(c: C): Promise<Response> {
  let claimed: { id: string; lease: string } | undefined
  try {
    const actor = await authenticateAdminSession(c.req.raw, c.env)
    const body = await readJsonObject(c.req.raw, 128 * 1024)
    const id = requireString(body, 'session_id', 128)
    const code = requireString(body, 'code', 65536)
    const state = requireString(body, 'state', 256)
    const session = await c.env.DB.prepare('SELECT * FROM account_oauth_sessions WHERE id = ? AND user_id = ? AND expires_at_ms > ?')
      .bind(id, actor.user_id, Date.now()).first<Session>()
    if (!session) throw new GatewayError(400, 'OPENAI_OAUTH_SESSION_NOT_FOUND', 'Session not found or expired')
    if (!constantTimeEqual(await sha256Hex(state), session.state_hash)) throw new GatewayError(400, 'OPENAI_OAUTH_INVALID_STATE', 'Invalid OAuth state')
    const proxyId = await validateProxy(c.env, body.proxy_id == null ? session.proxy_id : body.proxy_id)
    const redirect = redirectURI(body.redirect_uri) || session.redirect_uri
    const verifier = await decryptCredential(session.nonce_b64, session.ciphertext_b64, masterKey(c.env), aad(c.env, id, actor.user_id))
    const lease = crypto.randomUUID(); const now = Date.now()
    const acquired = await c.env.DB.prepare(`UPDATE account_oauth_sessions SET lease_token = ?, lease_expires_at_ms = ?
      WHERE id = ? AND user_id = ? AND expires_at_ms > ? AND lease_expires_at_ms <= ? RETURNING id`)
      .bind(lease, now + 120_000, id, actor.user_id, now, now).first()
    if (!acquired) throw new GatewayError(409, 'OPENAI_OAUTH_EXCHANGE_IN_PROGRESS', 'This OAuth session is already being exchanged; wait before retrying')
    claimed = { id, lease }
    const tokens = await requestOpenAITokens(c.env, new URLSearchParams({ grant_type: 'authorization_code',
      client_id: session.client_id, code, redirect_uri: redirect, code_verifier: verifier.api_key }), proxyId)
    await c.env.DB.prepare('DELETE FROM account_oauth_sessions WHERE id = ? AND lease_token = ?').bind(id, lease).run()
    claimed = undefined
    const info = openAITokenInfo(tokens, session.client_id)
    await enrichOpenAITokenInfo(c.env, info, proxyId)
    return noStore(controlSuccess(info))
  } catch (error) {
    if (claimed) {
      try { await c.env.DB.prepare('UPDATE account_oauth_sessions SET lease_token = NULL, lease_expires_at_ms = 0 WHERE id = ? AND lease_token = ?')
        .bind(claimed.id, claimed.lease).run() } catch { /* Existing lease expires; never mask the token exchange failure. */ }
    }
    return noStore(controlError(asGatewayError(error)))
  }
}

export async function refreshOpenAIAuthToken(c: C): Promise<Response> {
  try {
    const body = await readJsonObject(c.req.raw, 128 * 1024)
    const refresh = requireString({ refresh_token: typeof body.refresh_token === 'string' && body.refresh_token.trim() ? body.refresh_token : body.rt }, 'refresh_token', 65536)
    const clientId = body.client_id == null || body.client_id === '' ? OPENAI_OAUTH_CLIENT_ID : requireString(body, 'client_id', 256)
    const proxyId = await validateProxy(c.env, body.proxy_id)
    const tokens = await requestOpenAITokens(c.env, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh,
      client_id: clientId, scope: 'openid profile email' }), proxyId)
    const info = openAITokenInfo(tokens, clientId)
    await enrichOpenAITokenInfo(c.env, info, proxyId)
    return noStore(controlSuccess(info))
  } catch (error) { return noStore(controlError(asGatewayError(error))) }
}

async function validateProxy(env: Env, value: unknown): Promise<string | null> {
  if (value == null || value === 0 || value === '0') return null
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length > 128 || !String(value).trim()) {
    throw new GatewayError(400, 'OPENAI_OAUTH_PROXY_NOT_FOUND', 'Invalid proxy ID')
  }
  const row = await env.DB.prepare("SELECT id FROM proxies WHERE id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > unixepoch('subsec'))")
    .bind(String(value)).first()
  if (!row) throw new GatewayError(400, 'OPENAI_OAUTH_PROXY_NOT_FOUND', 'Selected proxy is missing, inactive or expired')
  return String(value)
}
function redirectURI(value: unknown): string {
  if (value == null || value === '') return ''
  const input = requireString({ redirect_uri: value }, 'redirect_uri', 2048)
  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('invalid redirect')
  } catch { throw new GatewayError(400, 'invalid_redirect_uri', 'redirect_uri must be an HTTP or HTTPS callback URL') }
  return input
}
function randomHex(bytes: number) { return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), value => value.toString(16).padStart(2, '0')).join('') }
function aad(env: Env, id: string, owner: string) { return `account-oauth-session:v1:${env.ENVIRONMENT}:${owner}:${id}` }
function masterKey(env: Env) {
  if (!env.CREDENTIALS_MASTER_KEY || env.CREDENTIALS_MASTER_KEY.length < 32) throw new GatewayError(503, 'credential_secret_not_configured', 'Credential encryption secret is not configured')
  return env.CREDENTIALS_MASTER_KEY
}
function noStore(response: Response): Response { response.headers.set('cache-control', 'no-store'); return response }
