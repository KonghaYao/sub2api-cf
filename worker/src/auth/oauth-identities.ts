import type { Context } from 'hono'
import { Hono } from 'hono'

import type { Env } from '../env'
import { controlError, controlSuccess, readJsonObject } from '../control/http'
import { decryptCredential, encryptCredential, randomToken, sha256Hex } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import {
  commercialRegistrationInsertSql,
  mapCommercialRegistrationWriteError,
  normalizeCommercialCode,
  prepareCommercialRegistration,
} from '../commercial/registration'
import { initialPlatformQuotaStatements } from '../user/platform-quotas'
import {
  authenticateUserRequest,
  issueOAuthUserSession,
  prepareOAuthUserSession,
  publicUser,
  type UserRow,
} from './handler'

type OAuthBindings = { Bindings: Env }
type OAuthContext = Context<OAuthBindings>

const FLOW_TTL_MS = 10 * 60 * 1_000
const BIND_TICKET_TTL_MS = 10 * 60 * 1_000
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1_024
const PROVIDER_TIMEOUT_MS = 15_000
const BROWSER_COOKIE = 'sub2api_oauth_browser'
const BIND_TICKET_COOKIE = 'sub2api_oauth_bind'
const providers = ['github', 'google', 'linuxdo', 'dingtalk', 'wechat', 'oidc'] as const

export const OAUTH_ACTIVE_FLOW_LIMITS = {
  global: 1_000,
  browser: 8,
} as const

const OAUTH_STATE_CLEANUP_BATCH = 500

export type OAuthIdentityProvider = typeof providers[number]
type OAuthAdapter = 'standard' | 'github' | 'dingtalk' | 'wechat' | 'oidc'

export interface OAuthStateCleanupResult {
  flowsDeleted: number
  bindTicketsDeleted: number
}

/** Bounded cron cleanup; expired state is never needed for replay validation. */
export async function cleanupExpiredOAuthState(
  env: Env,
  now = Date.now(),
  batchSize = OAUTH_STATE_CLEANUP_BATCH,
): Promise<OAuthStateCleanupResult> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
    throw new GatewayError(500, 'invalid_cleanup_batch', 'OAuth cleanup batch is invalid', 'server_error')
  }
  const flows = await env.DB.prepare(
      `DELETE FROM oauth_flows
        WHERE id IN (
          SELECT id FROM oauth_flows
           WHERE expires_at_ms <= ?
           ORDER BY expires_at_ms, id
           LIMIT ?
        )`,
    ).bind(now, batchSize).run()
  const bindTickets = await env.DB.prepare(
      `DELETE FROM oauth_bind_tickets
        WHERE id IN (
          SELECT id FROM oauth_bind_tickets
           WHERE expires_at_ms <= ?
           ORDER BY expires_at_ms, id
           LIMIT ?
        )`,
    ).bind(now, batchSize).run()
  return {
    flowsDeleted: flows.meta.changes,
    bindTicketsDeleted: bindTickets.meta.changes,
  }
}

interface OAuthProviderRow {
  provider: OAuthIdentityProvider
  adapter: OAuthAdapter
  enabled: number
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  emails_endpoint: string | null
  jwks_endpoint: string | null
  client_id: string
  secret_key_version: number | null
  secret_nonce_b64: string | null
  secret_ciphertext_b64: string | null
  scopes_json: string
  allowed_hosts_json: string
  frontend_callback_path: string
  pkce_enabled: number
}

interface OAuthProviderConfig extends Omit<OAuthProviderRow, 'enabled' | 'scopes_json' | 'allowed_hosts_json' | 'pkce_enabled'> {
  scopes: string[]
  allowedHosts: Set<string>
  pkceEnabled: boolean
}

interface CreatedFlow {
  authorizeUrl: string
  browserToken: string
}

interface ClaimedFlowRow {
  id: string
  provider: OAuthIdentityProvider
  intent: 'login' | 'link'
  target_user_id: string | null
  target_session_id: string | null
  target_auth_version: number | null
  verifier_key_version: number | null
  verifier_nonce_b64: string | null
  verifier_ciphertext_b64: string | null
  nonce_hash: string | null
  commercial_key_version: number | null
  commercial_nonce_b64: string | null
  commercial_ciphertext_b64: string | null
  redirect_to: string
}

interface ProviderToken {
  accessToken: string
  tokenType: string
  idToken: string | null
  openId: string | null
}

interface ProviderProfile {
  subject: string
  email: string | null
  emailVerified: boolean
  displayName: string
  avatarUrl: string | null
  issuer: string | null
  metadata: Record<string, unknown>
}

interface AuthIdentityRow {
  id: string
  user_id: string
  provider: OAuthIdentityProvider
  provider_key: string
  provider_subject: string
  issuer: string | null
  metadata_json: string
  verified_at_ms: number | null
  created_at_ms: number
}

/** Mounts the complete identity surface without coupling it to the root app. */
export function registerOAuthIdentityRoutes(app: Hono<OAuthBindings>): void {
  app.post('/api/v1/auth/oauth/bind-token', prepareOAuthBindTicket)
  app.get('/api/v1/auth/oauth/:provider/bind/start', startOAuthLink)
  app.post('/api/v1/auth/oauth/:provider/bind/start', startOAuthLink)
  app.get('/api/v1/auth/oauth/:provider/start', startOAuthLogin)
  app.post('/api/v1/auth/oauth/:provider/start', startOAuthLogin)
  app.get('/api/v1/auth/oauth/:provider/callback', finishOAuthCallback)
  app.get('/api/v1/user/auth-identities', listOAuthIdentities)
  app.post('/api/v1/user/auth-identities/bind/start', startOAuthLinkFromJson)
  app.delete('/api/v1/user/account-bindings/:provider', unlinkOAuthIdentity)
}

async function startOAuthLogin(context: OAuthContext): Promise<Response> {
  try {
    const config = await requireProvider(context.env, context.req.param('provider'))
    const redirectTo = safeRedirect(context.req.query('redirect'), '/dashboard')
    const flow = await createOAuthFlow(context, config, 'login', redirectTo, null)
    return oauthStartResponse(context, flow)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function prepareOAuthBindTicket(context: OAuthContext): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const token = randomToken()
    const now = Date.now()
    await context.env.DB.prepare(
      `INSERT INTO oauth_bind_tickets (
         id, token_hash, user_id, session_id, auth_version,
         expires_at_ms, consumed_at_ms, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      crypto.randomUUID(),
      await sha256Hex(token),
      user.id,
      user.session_id,
      user.auth_version,
      now + BIND_TICKET_TTL_MS,
      now,
    ).run()
    const response = controlSuccess({ ready: true })
    setCookie(response, BIND_TICKET_COOKIE, token, context.req.url, BIND_TICKET_TTL_MS)
    return response
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function startOAuthLink(context: OAuthContext): Promise<Response> {
  try {
    const config = await requireProvider(context.env, context.req.param('provider'))
    const target = await claimBindTarget(context)
    const redirectTo = safeRedirect(context.req.query('redirect'), '/profile')
    const flow = await createOAuthFlow(context, config, 'link', redirectTo, target)
    const response = oauthStartResponse(context, flow)
    clearCookie(response, BIND_TICKET_COOKIE, context.req.url)
    return response
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function startOAuthLinkFromJson(context: OAuthContext): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const body = await readJsonObject(context.req.raw)
    const config = await requireProvider(context.env, body.provider)
    const redirectTo = safeRedirect(
      typeof body.redirect_to === 'string' ? body.redirect_to : undefined,
      '/profile',
    )
    const flow = await createOAuthFlow(context, config, 'link', redirectTo, {
      userId: user.id,
      sessionId: user.session_id,
      authVersion: user.auth_version,
    })
    const response = controlSuccess({
      provider: config.provider,
      authorize_url: flow.authorizeUrl,
      method: 'GET',
      use_browser_redirect: true,
    })
    setCookie(response, BROWSER_COOKIE, flow.browserToken, context.req.url, FLOW_TTL_MS)
    return response
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function finishOAuthCallback(context: OAuthContext): Promise<Response> {
  let config: OAuthProviderConfig
  try {
    config = await requireProvider(context.env, context.req.param('provider'))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
  try {
    const state = requiredShortText(context.req.query('state'), 'invalid_state', 512)
    const browserToken = readCookie(context.req.raw, BROWSER_COOKIE)
    if (browserToken === null) throw invalidState()
    const flow = await claimOAuthFlow(context.env, config.provider, state, browserToken)
    if (flow.intent === 'link') await requireLiveLinkTarget(context.env, flow)

    const providerError = context.req.query('error')?.trim()
    if (providerError) {
      throw new GatewayError(400, 'provider_error', 'OAuth provider denied the request')
    }
    const code = requiredShortText(context.req.query('code'), 'missing_code', 4_096)
    const verifier = await readFlowVerifier(context.env, flow)
    const callbackUri = callbackUrl(context.env, config.provider)
    const token = await exchangeCode(context.env, config, code, callbackUri, verifier)
    const profile = await fetchProviderProfile(context.env, config, token, flow)
    const response = flow.intent === 'link'
      ? await completeIdentityLink(context, config, flow, profile)
      : await completeIdentityLogin(context, config, flow, profile)
    clearCookie(response, BROWSER_COOKIE, context.req.url)
    return response
  } catch (error) {
    const normalized = asGatewayError(error)
    const response = oauthErrorRedirect(config.frontend_callback_path, normalized.code)
    clearCookie(response, BROWSER_COOKIE, context.req.url)
    return response
  }
}

async function listOAuthIdentities(context: OAuthContext): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const projection = await identityProjection(context.env, user)
    return controlSuccess(projection)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function unlinkOAuthIdentity(context: OAuthContext): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const provider = parseProvider(context.req.param('provider'))
    const identities = await loadUserIdentities(context.env, user.id)
    const selected = identities.filter((identity) => identity.provider === provider)
    if (selected.length === 0) {
      return controlSuccess(await projectOAuthIdentityBindings(
        context.env,
        user,
        publicUser(user),
      ))
    }
    const anotherMethod = user.password_credential !== null ||
      identities.some((identity) => identity.provider !== provider)
    if (!anotherMethod) {
      throw new GatewayError(
        409,
        'IDENTITY_UNBIND_LAST_METHOD',
        'Bind another sign-in method before unbinding this provider',
      )
    }
    const now = Date.now()
    const operationId = crypto.randomUUID()
    const results = await context.env.DB.batch([
      context.env.DB.prepare(
        `INSERT INTO auth_audit_events (
           id, user_id, event_type, outcome, email_hash, ip_hash,
           session_id, metadata_json, occurred_at_ms
         )
         SELECT ?, ?, 'auth.identity.unlink', 'succeeded', NULL, NULL, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM users u
             WHERE u.id = ? AND u.auth_version = ?
               AND EXISTS (
                 SELECT 1 FROM auth_identities selected
                  WHERE selected.user_id = u.id AND selected.provider = ?
               )
               AND (
                 u.password_credential IS NOT NULL
                 OR EXISTS (
                   SELECT 1 FROM auth_identities alternate
                    WHERE alternate.user_id = u.id AND alternate.provider <> ?
                 )
               )
          )
         RETURNING id`,
      ).bind(
        operationId,
        user.id,
        user.session_id,
        JSON.stringify({ provider }),
        now,
        user.id,
        user.auth_version,
        provider,
        provider,
      ),
      context.env.DB.prepare(
        `DELETE FROM auth_identities
          WHERE user_id = ? AND provider = ?
            AND EXISTS (SELECT 1 FROM auth_audit_events WHERE id = ?)
            AND EXISTS (
              SELECT 1 FROM users u
               WHERE u.id = auth_identities.user_id AND u.auth_version = ?
                 AND (
                   u.password_credential IS NOT NULL
                   OR EXISTS (
                     SELECT 1 FROM auth_identities alternate
                      WHERE alternate.user_id = u.id AND alternate.provider <> ?
                   )
                 )
            )
         RETURNING id`,
      ).bind(user.id, provider, operationId, user.auth_version, provider),
      context.env.DB.prepare(
        `UPDATE users
            SET auth_version = auth_version + 1, updated_at_ms = ?
          WHERE id = ? AND auth_version = ?
            AND EXISTS (SELECT 1 FROM auth_audit_events WHERE id = ?)
         RETURNING id`,
      ).bind(now, user.id, user.auth_version, operationId),
      context.env.DB.prepare(
        `UPDATE user_sessions
            SET revoked_at_ms = ?, revoke_reason = 'oauth_identity_unlinked'
          WHERE user_id = ? AND revoked_at_ms IS NULL
            AND EXISTS (SELECT 1 FROM auth_audit_events WHERE id = ?)`,
      ).bind(now, user.id, operationId),
    ])
    if (results[0]?.results.length !== 1) {
      const remaining = await loadUserIdentities(context.env, user.id)
      if (remaining.some((identity) => identity.provider === provider)) {
        throw new GatewayError(
          409,
          'IDENTITY_UNBIND_LAST_METHOD',
          'Bind another sign-in method before unbinding this provider',
        )
      }
      const currentUser = await findUser(context.env, user.id)
      if (currentUser === null) throw new GatewayError(401, 'invalid_session', 'Session is invalid')
      return controlSuccess(await projectOAuthIdentityBindings(
        context.env,
        currentUser,
        publicUser(currentUser),
      ))
    }
    const updatedUser = { ...user, auth_version: user.auth_version + 1, updated_at_ms: now }
    return controlSuccess(await projectOAuthIdentityBindings(
      context.env,
      updatedUser,
      publicUser(updatedUser),
    ))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** Adds frontend-compatible binding summaries without exposing provider subjects. */
export async function projectOAuthIdentityBindings(
  env: Env,
  user: UserRow,
  base: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const projection = await identityProjection(env, user)
  const bindings = projection.auth_bindings
  return {
    ...base,
    email_bound: user.password_credential !== null,
    github_bound: bindings.github.bound,
    google_bound: bindings.google.bound,
    linuxdo_bound: bindings.linuxdo.bound,
    dingtalk_bound: bindings.dingtalk.bound,
    wechat_bound: bindings.wechat.bound,
    oidc_bound: bindings.oidc.bound,
    auth_bindings: bindings,
    identity_bindings: bindings,
  }
}

async function createOAuthFlow(
  context: OAuthContext,
  config: OAuthProviderConfig,
  intent: 'login' | 'link',
  redirectTo: string,
  target: { userId: string; sessionId: string; authVersion: number } | null,
): Promise<CreatedFlow> {
  const state = randomToken()
  const existingBrowserToken = readCookie(context.req.raw, BROWSER_COOKIE)
  const browserToken = existingBrowserToken !== null && /^[A-Za-z0-9_-]{43}$/.test(existingBrowserToken)
    ? existingBrowserToken
    : randomToken()
  const verifier = config.pkceEnabled ? randomToken(48) : null
  const nonce = config.adapter === 'oidc' ? randomToken() : null
  const id = crypto.randomUUID()
  const keyVersion = verifier === null ? null : 1
  const encrypted = verifier === null
    ? null
    : await encryptCredential(
      { api_key: verifier },
      requireMasterKey(context.env),
      flowVerifierAad(context.env, id, 1),
    )
  const commercialPayload = intent === 'login' ? oauthCommercialPayload(context) : null
  const encryptedCommercial = commercialPayload === null
    ? null
    : await encryptCredential(
      { api_key: JSON.stringify(commercialPayload) },
      requireMasterKey(context.env),
      flowCommercialAad(context.env, id, 1),
    )
  const now = Date.now()
  const browserTokenHash = await sha256Hex(browserToken)
  const inserted = await context.env.DB.prepare(
    `INSERT INTO oauth_flows (
       id, provider, intent, state_hash, browser_token_hash,
       target_user_id, target_session_id, target_auth_version,
       verifier_key_version, verifier_nonce_b64, verifier_ciphertext_b64,
       nonce_hash, commercial_key_version, commercial_nonce_b64,
       commercial_ciphertext_b64, redirect_to, expires_at_ms,
       consumed_at_ms, created_at_ms
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
      WHERE (
        SELECT COUNT(*) FROM oauth_flows
         WHERE consumed_at_ms IS NULL AND expires_at_ms > ?
      ) < ?
        AND (
          SELECT COUNT(*) FROM oauth_flows
           WHERE browser_token_hash = ?
             AND consumed_at_ms IS NULL AND expires_at_ms > ?
        ) < ?
     RETURNING id`,
  ).bind(
    id,
    config.provider,
    intent,
    await sha256Hex(state),
    browserTokenHash,
    target?.userId ?? null,
    target?.sessionId ?? null,
    target?.authVersion ?? null,
    keyVersion,
    encrypted?.nonce_b64 ?? null,
    encrypted?.ciphertext_b64 ?? null,
    nonce === null ? null : await sha256Hex(nonce),
    encryptedCommercial === null ? null : 1,
    encryptedCommercial?.nonce_b64 ?? null,
    encryptedCommercial?.ciphertext_b64 ?? null,
    redirectTo,
    now + FLOW_TTL_MS,
    now,
    now,
    OAUTH_ACTIVE_FLOW_LIMITS.global,
    browserTokenHash,
    now,
    OAUTH_ACTIVE_FLOW_LIMITS.browser,
  ).all<{ id: string }>()
  if (inserted.results.length !== 1) {
    throw new GatewayError(
      429,
      'oauth_flow_capacity_exceeded',
      'Too many active OAuth sessions; finish an existing sign-in or try again later',
      'rate_limit_error',
    )
  }

  const authorize = new URL(config.authorization_endpoint)
  authorize.searchParams.set('response_type', 'code')
  if (config.adapter === 'wechat') authorize.searchParams.set('appid', config.client_id)
  else authorize.searchParams.set('client_id', config.client_id)
  authorize.searchParams.set('redirect_uri', callbackUrl(context.env, config.provider))
  authorize.searchParams.set('state', state)
  if (config.scopes.length > 0) authorize.searchParams.set('scope', config.scopes.join(' '))
  if (verifier !== null) {
    authorize.searchParams.set('code_challenge', await pkceChallenge(verifier))
    authorize.searchParams.set('code_challenge_method', 'S256')
  }
  if (nonce !== null) authorize.searchParams.set('nonce', nonce)
  if (config.adapter === 'dingtalk') authorize.searchParams.set('prompt', 'consent')
  if (config.adapter === 'wechat') authorize.hash = 'wechat_redirect'
  return { authorizeUrl: authorize.toString(), browserToken }
}

function oauthStartResponse(context: OAuthContext, flow: CreatedFlow): Response {
  const response = context.req.method === 'POST'
    ? controlSuccess({ authorize_url: flow.authorizeUrl })
    : new Response(null, { status: 302, headers: { location: flow.authorizeUrl, 'cache-control': 'no-store' } })
  setCookie(response, BROWSER_COOKIE, flow.browserToken, context.req.url, FLOW_TTL_MS)
  return response
}

async function claimBindTarget(context: OAuthContext): Promise<{
  userId: string
  sessionId: string
  authVersion: number
}> {
  const token = readCookie(context.req.raw, BIND_TICKET_COOKIE)
  if (token === null) {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    return { userId: user.id, sessionId: user.session_id, authVersion: user.auth_version }
  }
  const now = Date.now()
  const row = await context.env.DB.prepare(
    `UPDATE oauth_bind_tickets
        SET consumed_at_ms = ?
      WHERE token_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?
        AND EXISTS (
          SELECT 1 FROM user_sessions s JOIN users u ON u.id = s.user_id
           WHERE s.id = oauth_bind_tickets.session_id
             AND s.user_id = oauth_bind_tickets.user_id
             AND s.auth_version = oauth_bind_tickets.auth_version
             AND s.revoked_at_ms IS NULL AND s.access_expires_at_ms > ?
             AND u.status = 'active' AND u.auth_version = oauth_bind_tickets.auth_version
        )
      RETURNING user_id, session_id, auth_version`,
  ).bind(now, await sha256Hex(token), now, now).first<{
    user_id: string
    session_id: string
    auth_version: number
  }>()
  if (row === null) {
    throw new GatewayError(401, 'invalid_oauth_bind_ticket', 'OAuth binding session is invalid', 'authentication_error')
  }
  return { userId: row.user_id, sessionId: row.session_id, authVersion: row.auth_version }
}

async function claimOAuthFlow(
  env: Env,
  provider: OAuthIdentityProvider,
  state: string,
  browserToken: string,
): Promise<ClaimedFlowRow> {
  const now = Date.now()
  const row = await env.DB.prepare(
    `UPDATE oauth_flows
        SET consumed_at_ms = ?
      WHERE provider = ? AND state_hash = ? AND browser_token_hash = ?
        AND consumed_at_ms IS NULL AND expires_at_ms > ?
      RETURNING id, provider, intent, target_user_id, target_session_id,
                target_auth_version, verifier_key_version, verifier_nonce_b64,
                verifier_ciphertext_b64, nonce_hash, commercial_key_version,
                commercial_nonce_b64, commercial_ciphertext_b64, redirect_to`,
  ).bind(
    now,
    provider,
    await sha256Hex(state),
    await sha256Hex(browserToken),
    now,
  ).first<ClaimedFlowRow>()
  if (row === null) throw invalidState()
  return row
}

async function requireLiveLinkTarget(env: Env, flow: ClaimedFlowRow): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT 1 AS valid
       FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.user_id = ? AND s.auth_version = ?
        AND s.revoked_at_ms IS NULL AND s.access_expires_at_ms > ?
        AND u.status = 'active' AND u.auth_version = ?
      LIMIT 1`,
  ).bind(
    flow.target_session_id,
    flow.target_user_id,
    flow.target_auth_version,
    Date.now(),
    flow.target_auth_version,
  ).first<{ valid: number }>()
  if (row === null) {
    throw new GatewayError(401, 'invalid_oauth_bind_session', 'OAuth binding session is no longer valid', 'authentication_error')
  }
}

async function readFlowVerifier(env: Env, flow: ClaimedFlowRow): Promise<string | null> {
  if (flow.verifier_key_version === null) return null
  if (flow.verifier_nonce_b64 === null || flow.verifier_ciphertext_b64 === null) {
    throw new GatewayError(503, 'oauth_flow_unavailable', 'OAuth flow is unavailable', 'server_error')
  }
  const value = await decryptCredential(
    flow.verifier_nonce_b64,
    flow.verifier_ciphertext_b64,
    requireMasterKey(env),
    flowVerifierAad(env, flow.id, flow.verifier_key_version),
  )
  return value.api_key
}

async function readFlowCommercialRegistration(
  env: Env,
  flow: ClaimedFlowRow,
): Promise<Record<string, unknown>> {
  if (flow.commercial_key_version === null) return {}
  if (flow.commercial_nonce_b64 === null || flow.commercial_ciphertext_b64 === null) {
    throw new GatewayError(503, 'oauth_flow_unavailable', 'OAuth flow is unavailable', 'server_error')
  }
  const value = await decryptCredential(
    flow.commercial_nonce_b64,
    flow.commercial_ciphertext_b64,
    requireMasterKey(env),
    flowCommercialAad(env, flow.id, flow.commercial_key_version),
  )
  try {
    const payload: unknown = JSON.parse(value.api_key)
    if (!isObject(payload)) throw new Error('invalid commercial payload')
    const allowed = new Set(['promo_code', 'invitation_code', 'aff_code'])
    if (
      Object.keys(payload).some((key) => !allowed.has(key)) ||
      Object.values(payload).some((entry) => typeof entry !== 'string')
    ) throw new Error('invalid commercial payload')
    return payload
  } catch {
    throw new GatewayError(503, 'oauth_flow_unavailable', 'OAuth flow is unavailable', 'server_error')
  }
}

async function exchangeCode(
  env: Env,
  config: OAuthProviderConfig,
  code: string,
  redirectUri: string,
  verifier: string | null,
): Promise<ProviderToken> {
  const clientSecret = await readProviderSecret(env, config)
  if (config.adapter === 'dingtalk') {
    if (clientSecret === null) throw invalidProvider()
    const response = await providerFetch(env, config.token_endpoint, config, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: config.client_id,
        clientSecret,
        code,
        grantType: 'authorization_code',
      }),
    })
    if (!response.ok) throw providerUnavailable('oauth_token_exchange_failed')
    return tokenFromPayload(await readProviderPayload(response))
  }
  if (config.adapter === 'wechat') {
    if (clientSecret === null) throw invalidProvider()
    const endpoint = new URL(config.token_endpoint)
    endpoint.searchParams.set('appid', config.client_id)
    endpoint.searchParams.set('secret', clientSecret)
    endpoint.searchParams.set('code', code)
    endpoint.searchParams.set('grant_type', 'authorization_code')
    const response = await providerFetch(env, endpoint.toString(), config, {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw providerUnavailable('oauth_token_exchange_failed')
    return tokenFromPayload(await readProviderPayload(response))
  }
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.client_id,
    code,
    redirect_uri: redirectUri,
  })
  if (clientSecret !== null) form.set('client_secret', clientSecret)
  if (verifier !== null) form.set('code_verifier', verifier)
  const response = await providerFetch(env, config.token_endpoint, config, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  })
  if (!response.ok) throw providerUnavailable('oauth_token_exchange_failed')
  return tokenFromPayload(await readProviderPayload(response))
}

function tokenFromPayload(parsed: Record<string, unknown>): ProviderToken {
  const accessToken = stringField(parsed, 'access_token', 'accessToken')
  const idToken = optionalStringField(parsed, 'id_token', 'idToken')
  if (accessToken === '' && idToken === null) throw providerUnavailable('oauth_token_exchange_failed')
  return {
    accessToken,
    tokenType: optionalStringField(parsed, 'token_type', 'tokenType') ?? 'Bearer',
    idToken,
    openId: optionalStringField(parsed, 'openid', 'openId'),
  }
}

async function fetchProviderProfile(
  env: Env,
  config: OAuthProviderConfig,
  token: ProviderToken,
  flow: ClaimedFlowRow,
): Promise<ProviderProfile> {
  if (config.adapter === 'oidc') {
    return fetchOidcProfile(env, config, token, flow)
  }
  if (token.accessToken === '') throw providerUnavailable('oauth_userinfo_failed')
  if (config.adapter === 'dingtalk') {
    const response = await providerFetch(env, config.userinfo_endpoint, config, {
      headers: { accept: 'application/json', 'x-acs-dingtalk-access-token': token.accessToken },
    })
    if (!response.ok) throw providerUnavailable('oauth_userinfo_failed')
    return dingtalkProfile(config, await readProviderPayload(response))
  }
  if (config.adapter === 'wechat') {
    if (token.openId === null) throw providerUnavailable('oauth_userinfo_invalid')
    const endpoint = new URL(config.userinfo_endpoint)
    endpoint.searchParams.set('access_token', token.accessToken)
    endpoint.searchParams.set('openid', token.openId)
    endpoint.searchParams.set('lang', 'zh_CN')
    const response = await providerFetch(env, endpoint.toString(), config, {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw providerUnavailable('oauth_userinfo_failed')
    return wechatProfile(config, token, await readProviderPayload(response))
  }
  const userResponse = await providerFetch(env, config.userinfo_endpoint, config, {
    headers: { accept: 'application/json', authorization: `Bearer ${token.accessToken}` },
  })
  if (!userResponse.ok) throw providerUnavailable('oauth_userinfo_failed')
  const user = await readProviderPayload(userResponse)
  if (config.adapter === 'github') return githubProfile(env, config, token, user)
  return standardProfile(config, user)
}

async function githubProfile(
  env: Env,
  config: OAuthProviderConfig,
  token: ProviderToken,
  user: Record<string, unknown>,
): Promise<ProviderProfile> {
  const subject = stringField(user, 'id')
  if (subject === '') throw providerUnavailable('oauth_userinfo_invalid')
  if (config.emails_endpoint === null) throw providerUnavailable('oauth_verified_email_missing')
  const response = await providerFetch(env, config.emails_endpoint, config, {
    headers: { accept: 'application/json', authorization: `Bearer ${token.accessToken}` },
  })
  if (!response.ok) throw providerUnavailable('oauth_userinfo_failed')
  const payload = await readProviderPayloadValue(response)
  if (!Array.isArray(payload)) throw providerUnavailable('oauth_verified_email_missing')
  const verified = payload
    .filter(isObject)
    .filter((entry) => entry.verified === true && typeof entry.email === 'string')
  const selected = verified.find((entry) => entry.primary === true) ?? verified[0]
  if (selected === undefined) throw providerUnavailable('oauth_verified_email_missing')
  const displayName = optionalStringField(user, 'name') ?? optionalStringField(user, 'login') ?? ''
  return {
    subject,
    email: normalizeEmail(String(selected.email)),
    emailVerified: true,
    displayName,
    avatarUrl: optionalStringField(user, 'avatar_url'),
    issuer: null,
    metadata: {
      display_name: displayName,
      login: optionalStringField(user, 'login'),
      avatar_url: optionalStringField(user, 'avatar_url'),
    },
  }
}

function standardProfile(config: OAuthProviderConfig, user: Record<string, unknown>): ProviderProfile {
  const subject = stringField(user, 'sub', 'id', 'unionid', 'unionId')
  if (subject === '') throw providerUnavailable('oauth_userinfo_invalid')
  const email = optionalStringField(user, 'email')
  const displayName = optionalStringField(user, 'name', 'display_name', 'username', 'nickname', 'nick') ?? ''
  return {
    subject,
    email: email === null ? null : normalizeEmail(email),
    // LinuxDo's retained userinfo contract does not prove mailbox ownership.
    // Existing linked subjects may sign in, but the email must never bootstrap an account.
    emailVerified: config.provider !== 'linuxdo' &&
      (user.email_verified === true || user.verified_email === true),
    displayName,
    avatarUrl: optionalStringField(user, 'picture', 'avatar_url', 'avatar_url_template', 'headimgurl'),
    issuer: null,
    metadata: { display_name: displayName },
  }
}

function dingtalkProfile(config: OAuthProviderConfig, user: Record<string, unknown>): ProviderProfile {
  const subject = stringField(user, 'unionId')
  if (subject === '') throw providerUnavailable('oauth_userinfo_invalid')
  const email = optionalStringField(user, 'email')
  const displayName = optionalStringField(user, 'nick', 'name') ?? ''
  return {
    subject,
    email: email === null ? null : normalizeEmail(email),
    // The public DingTalk user endpoint does not assert email ownership.
    emailVerified: false,
    displayName,
    avatarUrl: optionalStringField(user, 'avatarUrl'),
    issuer: null,
    metadata: { display_name: displayName, avatar_url: optionalStringField(user, 'avatarUrl') },
  }
}

function wechatProfile(
  _config: OAuthProviderConfig,
  token: ProviderToken,
  user: Record<string, unknown>,
): ProviderProfile {
  const subject = stringField(user, 'unionid', 'unionId') || token.openId || stringField(user, 'openid')
  if (subject === '') throw providerUnavailable('oauth_userinfo_invalid')
  const displayName = optionalStringField(user, 'nickname') ?? ''
  return {
    subject,
    email: null,
    emailVerified: false,
    displayName,
    avatarUrl: optionalStringField(user, 'headimgurl'),
    issuer: null,
    metadata: {
      display_name: displayName,
      avatar_url: optionalStringField(user, 'headimgurl'),
      openid: token.openId,
    },
  }
}

async function fetchOidcProfile(
  env: Env,
  config: OAuthProviderConfig,
  token: ProviderToken,
  flow: ClaimedFlowRow,
): Promise<ProviderProfile> {
  if (token.idToken === null || config.jwks_endpoint === null || flow.nonce_hash === null) {
    throw invalidOidcToken()
  }
  const parsed = parseJwt(token.idToken)
  if (parsed.header.alg !== 'RS256' || typeof parsed.header.kid !== 'string' || parsed.header.kid === '') {
    throw invalidOidcToken()
  }
  const jwksResponse = await providerFetch(env, config.jwks_endpoint, config, {
    headers: { accept: 'application/json' },
  })
  if (!jwksResponse.ok) throw providerUnavailable('oidc_jwks_failed')
  const jwks = await readProviderPayload(jwksResponse)
  if (!Array.isArray(jwks.keys)) throw invalidOidcToken()
  const jwk = jwks.keys
    .filter(isObject)
    .find((key) => key.kid === parsed.header.kid &&
      (key.alg === undefined || key.alg === 'RS256') &&
      (key.use === undefined || key.use === 'sig'))
  if (jwk === undefined || jwk.kty !== 'RSA') throw invalidOidcToken()
  let publicKey: CryptoKey
  try {
    publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  } catch {
    throw invalidOidcToken()
  }
  const signatureValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    parsed.signature as Uint8Array<ArrayBuffer>,
    new TextEncoder().encode(parsed.signingInput),
  ).catch(() => false)
  if (!signatureValid) throw invalidOidcToken()

  const claims = parsed.payload
  const nowSeconds = Math.floor(Date.now() / 1_000)
  const audience = claims.aud
  const audienceValid = audience === config.client_id ||
    Array.isArray(audience) && audience.includes(config.client_id)
  const authorizedPartyValid = !Array.isArray(audience) || audience.length <= 1 ||
    claims.azp === config.client_id
  if (
    claims.iss !== config.issuer || !audienceValid || !authorizedPartyValid ||
    typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds ||
    typeof claims.nbf === 'number' && claims.nbf > nowSeconds + 60 ||
    typeof claims.iat === 'number' && claims.iat > nowSeconds + 60 ||
    typeof claims.nonce !== 'string' || await sha256Hex(claims.nonce) !== flow.nonce_hash ||
    stringField(claims, 'sub') === ''
  ) throw invalidOidcToken()

  if (token.accessToken === '') throw providerUnavailable('oauth_userinfo_failed')
  const userResponse = await providerFetch(env, config.userinfo_endpoint, config, {
    headers: { accept: 'application/json', authorization: `Bearer ${token.accessToken}` },
  })
  if (!userResponse.ok) throw providerUnavailable('oauth_userinfo_failed')
  const userinfo = await readProviderPayload(userResponse)
  const subject = stringField(claims, 'sub')
  if (stringField(userinfo, 'sub') !== subject) throw invalidOidcToken()
  const merged = { ...claims, ...userinfo }
  const email = optionalStringField(merged, 'email')
  const displayName = optionalStringField(merged, 'name', 'preferred_username') ?? ''
  return {
    subject,
    email: email === null ? null : normalizeEmail(email),
    emailVerified: merged.email_verified === true,
    displayName,
    avatarUrl: optionalStringField(merged, 'picture'),
    issuer: config.issuer,
    metadata: {
      display_name: displayName,
      avatar_url: optionalStringField(merged, 'picture'),
    },
  }
}

async function completeIdentityLogin(
  context: OAuthContext,
  config: OAuthProviderConfig,
  flow: ClaimedFlowRow,
  profile: ProviderProfile,
): Promise<Response> {
  assertSafeProfile(profile)
  const providerKey = providerKeyFor(config, profile)
  const identity = await findIdentity(context.env, config.provider, providerKey, profile.subject)
  if (identity === null) {
    return registerIdentityLogin(context, config, flow, profile, providerKey)
  }
  const user = await findUser(context.env, identity.user_id)
  if (user === null || user.status !== 'active') {
    throw new GatewayError(403, 'user_disabled', 'User account is disabled', 'permission_error')
  }
  const now = Date.now()
  await context.env.DB.prepare(
    `UPDATE auth_identities
        SET metadata_json = ?, issuer = ?, verified_at_ms = ?, last_login_at_ms = ?, updated_at_ms = ?
      WHERE id = ? AND user_id = ?`,
  ).bind(
    JSON.stringify(profile.metadata),
    profile.issuer,
    profile.emailVerified ? now : identity.verified_at_ms,
    now,
    now,
    identity.id,
    user.id,
  ).run()
  const payload = await issueOAuthUserSession(
    context.env,
    user,
    context.req.header('user-agent') ?? '',
  )
  return oauthLoginRedirect(config.frontend_callback_path, flow.redirect_to, payload)
}

async function registerIdentityLogin(
  context: OAuthContext,
  config: OAuthProviderConfig,
  flow: ClaimedFlowRow,
  profile: ProviderProfile,
  providerKey: string,
): Promise<Response> {
  if (!profile.emailVerified || profile.email === null) {
    throw new GatewayError(
      409,
      'oauth_registration_requires_verified_email',
      'A verified provider email is required to create an account',
    )
  }
  const existingEmail = await findUserByEmail(context.env, profile.email)
  if (existingEmail !== null) {
    throw new GatewayError(
      409,
      'oauth_account_binding_required',
      'Sign in to the existing account before binding this identity',
    )
  }
  if (!await oauthRegistrationEnabled(context.env)) {
    throw new GatewayError(403, 'registration_disabled', 'Registration is disabled', 'permission_error')
  }

  const now = Date.now()
  const commercialBody = await readFlowCommercialRegistration(context.env, flow)
  const user: UserRow = {
    id: crypto.randomUUID(),
    email: profile.email,
    display_name: (profile.displayName || profile.email.slice(0, profile.email.indexOf('@'))).slice(0, 128),
    role: 'user',
    status: 'active',
    balance_micros: 0,
    concurrency: 5,
    rpm_limit: 0,
    state_version: 0,
    auth_version: 1,
    password_credential: null,
    email_verified_at_ms: now,
    password_changed_at_ms: null,
    last_login_at_ms: null,
    avatar_object_key: null,
    avatar_content_type: null,
    avatar_updated_at_ms: null,
    created_at_ms: now,
    updated_at_ms: now,
  }
  const commercial = await prepareCommercialRegistration(
    context.env,
    commercialBody,
    user.id,
    now,
  )
  user.balance_micros = commercial.bonusMicros
  const prepared = await prepareOAuthUserSession(
    context.env,
    user,
    context.req.header('user-agent') ?? '',
  )
  try {
    await context.env.DB.batch([
      ...(commercial.claimStatement === undefined ? [] : [commercial.claimStatement]),
      context.env.DB.prepare(commercialRegistrationInsertSql(commercial.active)).bind(
        user.id,
        user.email,
        user.display_name,
        ...(commercial.active ? [user.balance_micros] : []),
        now,
        now,
        null,
        null,
        null,
        now,
        ...(commercial.active ? [user.id] : []),
      ),
      context.env.DB.prepare(
        `INSERT INTO auth_identities (
           id, user_id, provider, provider_key, provider_subject, issuer,
           metadata_json, verified_at_ms, last_login_at_ms, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        user.id,
        config.provider,
        providerKey,
        profile.subject,
        profile.issuer,
        JSON.stringify(profile.metadata),
        now,
        now,
        now,
        now,
      ),
      ...initialPlatformQuotaStatements(context.env, user.id, now),
      ...commercial.afterUserStatements,
      ...prepared.statements,
      auditInsert(context.env, user.id, prepared.sessionId, 'auth.identity.register', config.provider, now),
    ])
  } catch (error) {
    if (/UNIQUE constraint failed: (?:users\.(?:email|canonical_email_inbox)|auth_identities|index 'uq_users_canonical_email_inbox')/i.test(errorMessage(error))) {
      throw new GatewayError(
        409,
        'oauth_account_binding_required',
        'Sign in to the existing account before binding this identity',
      )
    }
    const commercialError = mapCommercialRegistrationWriteError(error)
    if (commercialError !== null) throw commercialError
    throw error
  }
  return oauthLoginRedirect(config.frontend_callback_path, flow.redirect_to, prepared.payload)
}

async function completeIdentityLink(
  context: OAuthContext,
  config: OAuthProviderConfig,
  flow: ClaimedFlowRow,
  profile: ProviderProfile,
): Promise<Response> {
  assertSafeProfile(profile)
  const userId = flow.target_user_id!
  const providerKey = providerKeyFor(config, profile)
  const existing = await findIdentity(context.env, config.provider, providerKey, profile.subject)
  if (existing !== null && existing.user_id !== userId) {
    throw new GatewayError(409, 'ownership_conflict', 'OAuth identity belongs to another user')
  }
  const now = Date.now()
  if (existing === null) {
    const identityId = crypto.randomUUID()
    try {
      const results = await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO auth_identities (
             id, user_id, provider, provider_key, provider_subject, issuer,
             metadata_json, verified_at_ms, last_login_at_ms, created_at_ms, updated_at_ms
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM user_sessions s JOIN users u ON u.id = s.user_id
               WHERE s.id = ? AND s.user_id = ? AND s.auth_version = ?
                 AND s.revoked_at_ms IS NULL AND s.access_expires_at_ms > ?
                 AND u.status = 'active' AND u.auth_version = ?
            )
           RETURNING id`,
        ).bind(
          identityId,
          userId,
          config.provider,
          providerKey,
          profile.subject,
          profile.issuer,
          JSON.stringify(profile.metadata),
          profile.emailVerified ? now : null,
          now,
          now,
          flow.target_session_id,
          userId,
          flow.target_auth_version,
          now,
          flow.target_auth_version,
        ),
        auditInsertIfIdentityExists(
          context.env,
          identityId,
          userId,
          flow.target_session_id,
          'auth.identity.link',
          config.provider,
          now,
        ),
      ])
      if (results[0]?.results.length !== 1) {
        throw new GatewayError(
          401,
          'invalid_oauth_bind_session',
          'OAuth binding session is no longer valid',
          'authentication_error',
        )
      }
    } catch (error) {
      if (/UNIQUE constraint failed: auth_identities/i.test(errorMessage(error))) {
        throw new GatewayError(409, 'ownership_conflict', 'OAuth identity belongs to another user')
      }
      throw error
    }
  }
  const separator = flow.redirect_to.includes('?') ? '&' : '?'
  return new Response(null, {
    status: 302,
    headers: {
      location: `${flow.redirect_to}${separator}oauth_bound=${encodeURIComponent(config.provider)}`,
      'cache-control': 'no-store',
    },
  })
}

async function identityProjection(env: Env, user: UserRow): Promise<{
  items: Record<string, unknown>[]
  total: number
  auth_bindings: Record<OAuthIdentityProvider | 'email', Record<string, unknown>>
  identity_bindings: Record<OAuthIdentityProvider | 'email', Record<string, unknown>>
}> {
  const identities = await loadUserIdentities(env, user.id)
  const enabled = await enabledProviders(env)
  const hasPassword = user.password_credential !== null
  const bindings = {} as Record<OAuthIdentityProvider | 'email', Record<string, unknown>>
  bindings.email = {
    provider: 'email',
    bound: hasPassword,
    bound_count: hasPassword ? 1 : 0,
    can_bind: !hasPassword,
    can_unbind: false,
    verified_at: user.email_verified_at_ms === null
      ? null
      : new Date(user.email_verified_at_ms).toISOString(),
  }
  for (const provider of providers) {
    const selected = identities.filter((identity) => identity.provider === provider)
    const primary = selected[0]
    const canUnbind = primary !== undefined && (
      hasPassword || identities.some((identity) => identity.provider !== provider)
    )
    bindings[provider] = {
      provider,
      bound: primary !== undefined,
      bound_count: selected.length,
      can_bind: primary === undefined && enabled.has(provider),
      can_unbind: canUnbind,
      ...(primary === undefined ? {} : publicIdentity(primary)),
    }
  }
  const items = identities.map((identity) => ({
    provider: identity.provider,
    ...publicIdentity(identity),
    can_unbind: bindings[identity.provider].can_unbind,
  }))
  return { items, total: items.length, auth_bindings: bindings, identity_bindings: bindings }
}

async function loadUserIdentities(env: Env, userId: string): Promise<AuthIdentityRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, user_id, provider, provider_key, provider_subject, issuer,
            metadata_json, verified_at_ms, created_at_ms
       FROM auth_identities WHERE user_id = ?
      ORDER BY provider ASC, created_at_ms ASC, id ASC`,
  ).bind(userId).all<AuthIdentityRow>()
  return rows.results
}

function publicIdentity(identity: AuthIdentityRow): Record<string, unknown> {
  const metadata = parseJsonObject(identity.metadata_json)
  return {
    provider_key: identity.provider_key,
    issuer: identity.issuer,
    display_name: optionalStringField(metadata, 'display_name', 'name', 'username'),
    subject_hint: maskSubject(identity.provider_subject),
    verified_at: identity.verified_at_ms === null
      ? null
      : new Date(identity.verified_at_ms).toISOString(),
  }
}

async function enabledProviders(env: Env): Promise<Set<OAuthIdentityProvider>> {
  const rows = await env.DB.prepare(
    'SELECT provider FROM oauth_providers WHERE enabled = 1 ORDER BY provider',
  ).all<{ provider: OAuthIdentityProvider }>()
  return new Set(rows.results.map((row) => row.provider))
}

async function findIdentity(
  env: Env,
  provider: OAuthIdentityProvider,
  providerKey: string,
  subject: string,
): Promise<AuthIdentityRow | null> {
  return env.DB.prepare(
    `SELECT id, user_id, provider, provider_key, provider_subject, issuer,
            metadata_json, verified_at_ms, created_at_ms
       FROM auth_identities
      WHERE provider = ? AND provider_key = ? AND provider_subject = ? LIMIT 1`,
  ).bind(provider, providerKey, subject).first<AuthIdentityRow>()
}

async function findUser(env: Env, userId: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, display_name, role, status, balance_micros, concurrency, rpm_limit,
            state_version, auth_version, password_credential,
            email_verified_at_ms, password_changed_at_ms, last_login_at_ms,
            avatar_object_key, avatar_content_type, avatar_updated_at_ms,
            created_at_ms, updated_at_ms
       FROM users WHERE id = ? LIMIT 1`,
  ).bind(userId).first<UserRow>()
}

async function findUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, display_name, role, status, balance_micros, concurrency, rpm_limit,
            state_version, auth_version, password_credential,
            email_verified_at_ms, password_changed_at_ms, last_login_at_ms,
            avatar_object_key, avatar_content_type, avatar_updated_at_ms,
            created_at_ms, updated_at_ms
       FROM users WHERE email = ? LIMIT 1`,
  ).bind(email).first<UserRow>()
}

async function oauthRegistrationEnabled(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT public_json FROM system_settings WHERE id = 'global' LIMIT 1`,
  ).first<{ public_json: string }>()
  return row !== null && parseJsonObject(row.public_json).registration_enabled === true
}

async function requireProvider(env: Env, value: unknown): Promise<OAuthProviderConfig> {
  const provider = parseProvider(value)
  const row = await env.DB.prepare(
    `SELECT provider, adapter, enabled, issuer, authorization_endpoint,
            token_endpoint, userinfo_endpoint, emails_endpoint, jwks_endpoint,
            client_id, secret_key_version, secret_nonce_b64, secret_ciphertext_b64,
            scopes_json, allowed_hosts_json, frontend_callback_path, pkce_enabled
       FROM oauth_providers WHERE provider = ? LIMIT 1`,
  ).bind(provider).first<OAuthProviderRow>()
  if (row === null || row.enabled !== 1) {
    throw new GatewayError(404, 'oauth_disabled', 'OAuth provider is disabled')
  }
  return validateProvider(env, row)
}

function validateProvider(env: Env, row: OAuthProviderRow): OAuthProviderConfig {
  const hosts = parseStringArray(row.allowed_hosts_json, 'oauth_provider_invalid')
    .map((host) => host.toLowerCase())
  if (hosts.length === 0 || hosts.some((host) => !validConfiguredHost(host, env))) {
    throw invalidProvider()
  }
  const allowedHosts = new Set(hosts)
  for (const endpoint of [
    row.authorization_endpoint,
    row.token_endpoint,
    row.userinfo_endpoint,
    row.emails_endpoint,
    row.jwks_endpoint,
  ]) {
    if (endpoint !== null) validateExternalUrl(endpoint, allowedHosts, env)
  }
  if (row.adapter === 'oidc') validateExternalUrl(row.issuer, allowedHosts, env)
  if (row.enabled !== 1 || row.pkce_enabled !== 0 && row.pkce_enabled !== 1) throw invalidProvider()
  if (safeRedirect(row.frontend_callback_path, '') === '') throw invalidProvider()
  return {
    ...row,
    scopes: parseStringArray(row.scopes_json, 'oauth_provider_invalid'),
    allowedHosts,
    pkceEnabled: row.pkce_enabled === 1,
  }
}

function validateExternalUrl(value: string, allowedHosts: Set<string>, env: Env): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidProvider()
  }
  const host = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.port !== '' || url.hash !== '' || !allowedHosts.has(host) ||
    !validConfiguredHost(host, env)
  ) throw invalidProvider()
  return url
}

function validConfiguredHost(host: string, env: Env): boolean {
  if (
    host === '' || host === 'localhost' || !host.includes('.') || host.includes(':') ||
    /^\d+(?:\.\d+){3}$/.test(host)
  ) {
    return false
  }
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false
  if (host.endsWith('.test') && env.ENVIRONMENT !== 'test') return false
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)
}

async function readProviderSecret(env: Env, config: OAuthProviderConfig): Promise<string | null> {
  if (config.secret_key_version === null) return null
  if (config.secret_nonce_b64 === null || config.secret_ciphertext_b64 === null) throw invalidProvider()
  const credential = await decryptCredential(
    config.secret_nonce_b64,
    config.secret_ciphertext_b64,
    requireMasterKey(env),
    providerSecretAad(env, config.provider, config.secret_key_version),
  )
  return credential.api_key
}

async function providerFetch(
  env: Env,
  url: string,
  config: OAuthProviderConfig,
  init: RequestInit = {},
): Promise<Response> {
  validateExternalUrl(url, config.allowedHosts, env)
  try {
    return await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    })
  } catch {
    throw providerUnavailable('oauth_provider_unavailable')
  }
}

async function readProviderPayload(response: Response): Promise<Record<string, unknown>> {
  const value = await readProviderPayloadValue(response)
  if (!isObject(value)) throw providerUnavailable('oauth_provider_response_invalid')
  return value
}

async function readProviderPayloadValue(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESPONSE_BYTES) {
    throw providerUnavailable('oauth_provider_response_too_large')
  }
  const text = await readBoundedProviderText(response)
  try {
    return JSON.parse(text)
  } catch {
    const values = new URLSearchParams(text)
    return Object.fromEntries(values.entries())
  }
}

async function readBoundedProviderText(response: Response): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      total += value.byteLength
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // The size violation remains the public error even if upstream cancellation fails.
        }
        throw providerUnavailable('oauth_provider_response_too_large')
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

function oauthLoginRedirect(
  frontendPath: string,
  redirectTo: string,
  payload: Record<string, unknown>,
): Response {
  const fragment = new URLSearchParams()
  for (const key of ['access_token', 'refresh_token', 'token_type', 'expires_in'] as const) {
    const value = payload[key]
    if (typeof value === 'string' || typeof value === 'number') fragment.set(key, String(value))
  }
  fragment.set('redirect', safeRedirect(redirectTo, '/dashboard'))
  return new Response(null, {
    status: 302,
    headers: { location: `${frontendPath}#${fragment.toString()}`, 'cache-control': 'no-store' },
  })
}

function oauthErrorRedirect(frontendPath: string, code: string): Response {
  const fragment = new URLSearchParams({ error: code, error_description: oauthErrorDescription(code) })
  return new Response(null, {
    status: 302,
    headers: { location: `${frontendPath}#${fragment.toString()}`, 'cache-control': 'no-store' },
  })
}

function oauthErrorDescription(code: string): string {
  switch (code) {
    case 'invalid_state': return 'OAuth session is invalid or expired'
    case 'ownership_conflict': return 'OAuth identity is already linked to another account'
    case 'oauth_identity_not_linked': return 'OAuth identity is not linked to an account'
    case 'oauth_account_binding_required': return 'Sign in to the existing account before binding this identity'
    case 'oauth_registration_requires_verified_email': return 'A verified provider email is required'
    case 'registration_disabled': return 'Registration is disabled'
    default: return 'OAuth sign-in could not be completed'
  }
}

function callbackUrl(env: Env, provider: OAuthIdentityProvider): string {
  if (typeof env.PUBLIC_ORIGIN !== 'string' || env.PUBLIC_ORIGIN.trim() === '') {
    throw new GatewayError(503, 'oauth_not_configured', 'OAuth public origin is not configured', 'server_error')
  }
  let source: URL
  try {
    source = new URL(env.PUBLIC_ORIGIN)
  } catch {
    throw new GatewayError(503, 'oauth_not_configured', 'OAuth public origin is not configured', 'server_error')
  }
  const localDevelopment = ['test', 'development', 'local'].includes(env.ENVIRONMENT) &&
    (source.hostname === 'localhost' || source.hostname === '127.0.0.1')
  if (
    source.username !== '' || source.password !== '' || source.search !== '' || source.hash !== '' ||
    source.pathname !== '/' || (source.protocol !== 'https:' && !(localDevelopment && source.protocol === 'http:'))
  ) {
    throw new GatewayError(503, 'oauth_not_configured', 'OAuth public origin is not configured', 'server_error')
  }
  source.pathname = `/api/v1/auth/oauth/${provider}/callback`
  return source.toString()
}

function setCookie(response: Response, name: string, value: string, requestUrl: string, ttlMs: number): void {
  const secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : ''
  response.headers.append(
    'set-cookie',
    `${name}=${value}; Path=/api/v1/auth/oauth; Max-Age=${Math.floor(ttlMs / 1_000)}; HttpOnly; SameSite=Lax${secure}`,
  )
}

function clearCookie(response: Response, name: string, requestUrl: string): void {
  const secure = new URL(requestUrl).protocol === 'https:' ? '; Secure' : ''
  response.headers.append(
    'set-cookie',
    `${name}=; Path=/api/v1/auth/oauth; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
  )
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie') ?? ''
  for (const entry of raw.split(';')) {
    const separator = entry.indexOf('=')
    if (separator < 0) continue
    if (entry.slice(0, separator).trim() === name) {
      const value = entry.slice(separator + 1).trim()
      return value === '' ? null : value
    }
  }
  return null
}

function parseProvider(value: unknown): OAuthIdentityProvider {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!providers.includes(normalized as OAuthIdentityProvider)) {
    throw new GatewayError(400, 'invalid_oauth_provider', 'OAuth provider is invalid')
  }
  return normalized as OAuthIdentityProvider
}

function providerKeyFor(config: OAuthProviderConfig, profile: ProviderProfile): string {
  return config.adapter === 'oidc' ? profile.issuer ?? config.issuer : config.issuer
}

function assertSafeProfile(profile: ProviderProfile): void {
  if (
    profile.subject.length > 1_024 || profile.issuer !== null && profile.issuer.length > 2_048 ||
    JSON.stringify(profile.metadata).length > 16_384
  ) throw providerUnavailable('oauth_userinfo_invalid')
}

function safeRedirect(value: string | undefined, fallback: string): string {
  if (
    value === undefined || value === '' || value.length > 2_048 ||
    !value.startsWith('/') || value.startsWith('//') || value.includes('://') ||
    value.includes('\r') || value.includes('\n') || value.includes('\\')
  ) return fallback
  return value
}

function oauthCommercialPayload(context: OAuthContext): Record<string, string> | null {
  const payload: Record<string, string> = {}
  const inputs = [
    ['promo_code', 'promotion'],
    ['invitation_code', 'invitation'],
    ['aff_code', 'affiliate'],
  ] as const
  for (const [key, kind] of inputs) {
    const value = context.req.query(key)?.trim()
    if (value === undefined || value === '') continue
    payload[key] = normalizeCommercialCode(value, kind)
  }
  return Object.keys(payload).length === 0 ? null : payload
}

function requiredShortText(value: string | undefined, code: string, max: number): string {
  const normalized = value?.trim() ?? ''
  if (normalized === '' || normalized.length > max) {
    throw new GatewayError(400, code, 'OAuth callback parameter is invalid')
  }
  return normalized
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return String(candidate)
  }
  return ''
}

function optionalStringField(value: Record<string, unknown>, ...keys: string[]): string | null {
  const result = stringField(value, ...keys)
  return result === '' ? null : result
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw providerUnavailable('oauth_verified_email_missing')
  }
  return email
}

function parseStringArray(value: string, code: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || item.trim() === '')) {
      throw new Error('invalid array')
    }
    return parsed.map((item) => item.trim())
  } catch {
    throw new GatewayError(503, code, 'OAuth provider configuration is invalid', 'server_error')
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parseJwt(value: string): {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  signature: Uint8Array
  signingInput: string
} {
  const segments = value.split('.')
  if (segments.length !== 3 || segments.some((segment) => segment === '' || !/^[A-Za-z0-9_-]+$/.test(segment))) {
    throw invalidOidcToken()
  }
  try {
    const header: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(segments[0])))
    const payload: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(segments[1])))
    if (!isObject(header) || !isObject(payload)) throw invalidOidcToken()
    return {
      header,
      payload,
      signature: base64UrlBytes(segments[2]),
      signingInput: `${segments[0]}.${segments[1]}`,
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error
    throw invalidOidcToken()
  }
}

function base64UrlBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function maskSubject(subject: string): string {
  if (subject.length <= 8) return `${subject.slice(0, 2)}***`
  return `${subject.slice(0, 4)}…${subject.slice(-4)}`
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function auditInsert(
  env: Env,
  userId: string,
  sessionId: string | null,
  eventType: string,
  provider: OAuthIdentityProvider,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO auth_audit_events (
       id, user_id, event_type, outcome, email_hash, ip_hash,
       session_id, metadata_json, occurred_at_ms
     ) VALUES (?, ?, ?, 'succeeded', NULL, NULL, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), userId, eventType, sessionId, JSON.stringify({ provider }), now)
}

function auditInsertIfIdentityExists(
  env: Env,
  identityId: string,
  userId: string,
  sessionId: string | null,
  eventType: string,
  provider: OAuthIdentityProvider,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO auth_audit_events (
       id, user_id, event_type, outcome, email_hash, ip_hash,
       session_id, metadata_json, occurred_at_ms
     )
     SELECT ?, ?, ?, 'succeeded', NULL, NULL, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM auth_identities WHERE id = ? AND user_id = ?
      )`,
  ).bind(
    crypto.randomUUID(),
    userId,
    eventType,
    sessionId,
    JSON.stringify({ provider }),
    now,
    identityId,
    userId,
  )
}

function requireMasterKey(env: Env): string {
  if (!env.CREDENTIALS_MASTER_KEY || new TextEncoder().encode(env.CREDENTIALS_MASTER_KEY).byteLength < 32) {
    throw new GatewayError(503, 'oauth_not_configured', 'OAuth encryption is not configured', 'server_error')
  }
  return env.CREDENTIALS_MASTER_KEY
}

function providerSecretAad(env: Env, provider: OAuthIdentityProvider, keyVersion: number): string {
  return `oauth-provider-secret/${env.ENVIRONMENT}/${provider}/${keyVersion}`
}

function flowVerifierAad(env: Env, flowId: string, keyVersion: number): string {
  return `oauth-flow-verifier/${env.ENVIRONMENT}/${flowId}/${keyVersion}`
}

function flowCommercialAad(env: Env, flowId: string, keyVersion: number): string {
  return `oauth-flow-commercial/${env.ENVIRONMENT}/${flowId}/${keyVersion}`
}

function invalidState(): GatewayError {
  return new GatewayError(400, 'invalid_state', 'OAuth session is invalid or expired')
}

function invalidProvider(): GatewayError {
  return new GatewayError(503, 'oauth_provider_invalid', 'OAuth provider configuration is invalid', 'server_error')
}

function providerUnavailable(code: string): GatewayError {
  return new GatewayError(502, code, 'OAuth provider response is invalid', 'server_error')
}

function invalidOidcToken(): GatewayError {
  return new GatewayError(400, 'oidc_token_invalid', 'OIDC token validation failed', 'authentication_error')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
