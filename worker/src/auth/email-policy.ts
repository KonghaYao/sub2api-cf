import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'

const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const MAX_SUFFIXES = 100

export function normalizeRegistrationEmailSuffixWhitelist(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SUFFIXES) throw invalidWhitelist()
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') throw invalidWhitelist()
    let suffix = item.trim().toLowerCase()
    if (suffix === '') continue
    if (suffix.startsWith('*.')) {
      const domain = suffix.slice(2)
      if (!DOMAIN_PATTERN.test(domain)) throw invalidWhitelist()
      suffix = `*.${domain}`
    } else {
      const domain = suffix.startsWith('@') ? suffix.slice(1) : suffix
      if (!DOMAIN_PATTERN.test(domain)) throw invalidWhitelist()
      suffix = `@${domain}`
    }
    if (!seen.has(suffix)) {
      seen.add(suffix)
      normalized.push(suffix)
    }
  }
  return normalized
}

export function requireRegistrationEmailSuffixAllowed(
  email: string,
  whitelist: readonly string[] | undefined,
): void {
  if (whitelist === undefined || whitelist.length === 0) return
  const at = email.lastIndexOf('@')
  const domain = at < 1 ? '' : email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, '')
  const allowed = domain !== '' && whitelist.some((rawSuffix) => {
    const suffix = rawSuffix.trim().toLowerCase()
    if (suffix.startsWith('@')) return domain === suffix.slice(1)
    if (!suffix.startsWith('*.')) return false
    const base = suffix.slice(2)
    return domain === base || domain.endsWith(`.${base}`)
  })
  if (!allowed) {
    throw new GatewayError(
      400,
      'EMAIL_SUFFIX_NOT_ALLOWED',
      'Email domain is not allowed for registration',
    )
  }
}

function invalidWhitelist(): GatewayError {
  return new GatewayError(
    400,
    'invalid_registration_email_suffix_whitelist',
    'registration_email_suffix_whitelist is invalid',
  )
}

export interface RegistrationEmailPolicy {
  registration_email_suffix_whitelist?: string[]
  registration_email_domain_quota_enabled?: boolean
}

/** Returns an exact domain only when the one-account exception applies. */
export async function checkRegistrationEmailPolicy(env: Env, email: string, settings: RegistrationEmailPolicy): Promise<string | null> {
  try {
    requireRegistrationEmailSuffixAllowed(email, settings.registration_email_suffix_whitelist)
    return null
  } catch (error) {
    if (!(error instanceof GatewayError) || error.code !== 'EMAIL_SUFFIX_NOT_ALLOWED' || settings.registration_email_domain_quota_enabled !== true) throw error
  }
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
  const existing = await env.DB.prepare(`SELECT id FROM users WHERE lower(substr(email, instr(email, '@') + 1)) = ? LIMIT 1`).bind(domain).first()
  if (existing !== null) throw registrationDomainQuotaError()
  return domain
}

/** Must be in the same D1 batch as the user INSERT: the trigger closes the read/write race. */
export function registrationDomainGuard(env: Env, domain: string | null): D1PreparedStatement[] {
  return domain === null ? [] : [env.DB.prepare('INSERT OR REPLACE INTO registration_domain_checks (domain) VALUES (?)').bind(domain)]
}

export function registrationDomainQuotaError(): GatewayError {
  return new GatewayError(400, 'EMAIL_DOMAIN_QUOTA_EXCEEDED', 'This email domain has reached its registration quota')
}
