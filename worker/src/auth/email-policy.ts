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
