import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'
import { openAIOAuthHttp } from './openai-oauth-http'

/** Original repository/claude_oauth_service.go RefreshToken contract. */
export async function refreshAnthropicOAuthToken(env: Env, refreshToken: string, proxyId: unknown) {
  let response
  try {
    response = await openAIOAuthHttp(env, 'https://platform.claude.com/v1/oauth/token', {
      method: 'POST', headers: { accept: 'application/json, text/plain, */*',
        'content-type': 'application/json', 'user-agent': 'axios/1.13.6' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken,
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' }),
    }, proxyId != null && String(proxyId) !== '0' ? String(proxyId) : null)
  } catch (error) {
    const code = error instanceof GatewayError ? error.code : ''
    if (code === 'OPENAI_OAUTH_TIMEOUT') throw new GatewayError(504, 'oauth_refresh_timeout', 'Claude OAuth token refresh timed out')
    if (code === 'OPENAI_OAUTH_INVALID_RESPONSE') throw invalidTokens()
    throw new GatewayError(502, 'oauth_refresh_transport_failed', 'Claude OAuth token refresh could not reach the provider')
  }
  if (response.status < 200 || response.status >= 300) throw new GatewayError(
    response.status >= 500 ? 502 : 401,
    response.status >= 500 ? 'oauth_refresh_upstream_error' : 'oauth_refresh_rejected',
    'Claude OAuth token refresh was rejected by the provider')
  let value
  try { value = JSON.parse(response.text) } catch { throw invalidTokens() }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validToken(value.access_token)) throw invalidTokens()
  if (value.refresh_token != null && value.refresh_token !== '' && !validToken(value.refresh_token)) throw invalidTokens()
  if (!Number.isSafeInteger(value.expires_in) || value.expires_in < 0 || value.expires_in > 31_536_000) throw invalidTokens()
  for (const key of ['token_type', 'scope']) if (value[key] != null && typeof value[key] !== 'string') throw invalidTokens()
  return { access_token: value.access_token as string, refresh_token: value.refresh_token as string | undefined,
    expires_in: value.expires_in as number, expires_at: Math.floor(Date.now() / 1000) + value.expires_in,
    token_type: typeof value.token_type === 'string' ? value.token_type : '',
    scope: typeof value.scope === 'string' ? value.scope : '' }
}
function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 65536 && !/[\u0000-\u0020\u007f]/.test(value)
}
function invalidTokens() { return new GatewayError(502, 'oauth_refresh_invalid_response', 'Claude OAuth token refresh returned invalid token data') }
