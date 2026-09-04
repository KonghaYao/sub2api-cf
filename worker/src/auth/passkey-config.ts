import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'

export interface ResolvedPasskeyConfiguration {
  enabled: boolean
  rpId: string
  rpOrigins: string[]
  rpDisplayName: string
}

export interface PasskeyDeploymentConfiguration {
  configured: boolean
  rpId: string
  rpOrigins: string[]
}

interface PublicPasskeySettings {
  passkey_enabled?: boolean
}

/** Resolve WebAuthn from deployment-owned values, never from an untrusted request host. */
export async function resolvePasskeyConfiguration(
  env: Env,
): Promise<ResolvedPasskeyConfiguration> {
  let settings: PublicPasskeySettings
  try {
    settings = await env.CONFIG_KV.get<PublicPasskeySettings>(
      `${env.ENVIRONMENT}:public-settings:v1`,
      'json',
    ) ?? {}
  } catch {
    throw new GatewayError(
      503,
      'settings_unavailable',
      'Passkey settings are unavailable',
      'server_error',
    )
  }
  const deployment = parsePasskeyDeploymentConfiguration(env)
  if (settings.passkey_enabled !== true) {
    return deployment ?? disabledConfiguration()
  }
  if (deployment === null) {
    throw new GatewayError(
      503,
      'passkey_not_configured',
      'Passkey relying-party settings are invalid or incomplete',
      'server_error',
    )
  }
  return { ...deployment, enabled: true }
}

/** Used by the public settings projection to hide a switch that cannot work safely. */
export function isPasskeyDeploymentConfigured(env: Env): boolean {
  return parsePasskeyDeploymentConfiguration(env) !== null
}

/** Safe admin projection of deployment-owned RP values; no secrets are involved. */
export function passkeyDeploymentConfiguration(env: Env): PasskeyDeploymentConfiguration {
  const deployment = parsePasskeyDeploymentConfiguration(env)
  return deployment === null
    ? { configured: false, rpId: '', rpOrigins: [] }
    : { configured: true, rpId: deployment.rpId, rpOrigins: [...deployment.rpOrigins] }
}

function parsePasskeyDeploymentConfiguration(
  env: Env,
): ResolvedPasskeyConfiguration | null {
  const rpId = env.WEBAUTHN_RP_ID?.trim().toLowerCase() ?? ''
  if (!validRpId(rpId)) return null
  const rpOrigins = parseOrigins(env.WEBAUTHN_RP_ORIGINS)
  if (rpOrigins === null || rpOrigins.length === 0) return null
  if (rpOrigins.some((origin) => !originMatchesRpId(origin, rpId))) return null
  const displayName = env.WEBAUTHN_RP_NAME?.trim() || 'Sub2API'
  if (displayName.length > 128) return null
  return {
    enabled: false,
    rpId,
    rpOrigins,
    rpDisplayName: displayName,
  }
}

function parseOrigins(value: string | undefined): string[] | null {
  if (!value) return null
  let parsed: unknown
  try {
    parsed = value.trim().startsWith('[')
      ? JSON.parse(value)
      : value.split(',').map((entry) => entry.trim())
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) return null
  const origins: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string' || entry.length > 2_048) return null
    let url: URL
    try {
      url = new URL(entry)
    } catch {
      return null
    }
    const isLocalHttp = url.protocol === 'http:' && url.hostname === 'localhost'
    if (
      (url.protocol !== 'https:' && !isLocalHttp) ||
      url.username !== '' || url.password !== '' ||
      url.pathname !== '/' || url.search !== '' || url.hash !== ''
    ) return null
    if (!origins.includes(url.origin)) origins.push(url.origin)
  }
  return origins
}

function validRpId(value: string): boolean {
  if (value === 'localhost') return true
  if (value.length === 0 || value.length > 253 || value.includes('..')) return false
  const labels = value.split('.')
  if (labels.length < 2) return false
  return labels.every((label) => (
    label.length > 0 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))
}

function originMatchesRpId(origin: string, rpId: string): boolean {
  const hostname = new URL(origin).hostname.toLowerCase()
  return hostname === rpId || (rpId !== 'localhost' && hostname.endsWith(`.${rpId}`))
}

function disabledConfiguration(): ResolvedPasskeyConfiguration {
  return {
    enabled: false,
    rpId: 'invalid.local',
    rpOrigins: [],
    rpDisplayName: 'Sub2API',
  }
}
