import { GatewayError } from './errors'

const MAX_RULES_PER_LIST = 64
const MAX_RULE_LENGTH = 64

interface ParsedIp {
  family: 4 | 6
  value: bigint
}

interface ParsedRule extends ParsedIp {
  prefix: number
  canonical: string
}

export function normalizeIpPolicyList(value: unknown, field: 'ip_whitelist' | 'ip_blacklist'): string[] {
  if (!Array.isArray(value) || value.length > MAX_RULES_PER_LIST) throw invalidPolicy(field)
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_RULE_LENGTH) {
      throw invalidPolicy(field)
    }
    const rule = parseRule(item.trim())
    if (rule === null) throw invalidPolicy(field)
    if (!seen.has(rule.canonical)) {
      seen.add(rule.canonical)
      normalized.push(rule.canonical)
    }
  }
  return normalized
}

export function parseStoredIpPolicy(
  value: string,
  field: 'ip_allowlist_json' | 'ip_denylist_json',
): ParsedRule[] {
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw invalidStoredPolicy(field)
  }
  if (!Array.isArray(decoded) || decoded.length > MAX_RULES_PER_LIST) throw invalidStoredPolicy(field)
  return decoded.map((item) => {
    if (typeof item !== 'string') throw invalidStoredPolicy(field)
    const rule = parseRule(item)
    if (rule === null || rule.canonical !== item) throw invalidStoredPolicy(field)
    return rule
  })
}

export function isSourceIpAllowed(
  sourceIp: string | null,
  allowlist: ParsedRule[],
  denylist: ParsedRule[],
): boolean {
  if (sourceIp === null) return false
  const parsed = parseAddress(sourceIp.trim())
  if (parsed === null) return false
  if (denylist.some((rule) => matches(parsed, rule))) return false
  return allowlist.length === 0 || allowlist.some((rule) => matches(parsed, rule))
}

/**
 * Cloudflare's edge-populated header is the sole production authority. The
 * explicit test header exists only in local/test environments and is never a
 * fallback for a malformed Cloudflare header.
 */
export function trustedSourceIp(request: Request, environment: string | undefined): string | null {
  const edgeValue = request.headers.get('cf-connecting-ip')
  if (edgeValue !== null) return parseAddress(edgeValue.trim()) === null ? null : edgeValue.trim()

  if (!['test', 'development', 'local'].includes((environment ?? '').trim().toLowerCase())) {
    return null
  }
  const controlled = request.headers.get('x-sub2api-test-client-ip')
  return controlled !== null && parseAddress(controlled.trim()) !== null ? controlled.trim() : null
}

function matches(address: ParsedIp, rule: ParsedRule): boolean {
  if (address.family !== rule.family) return false
  const bits = address.family === 4 ? 32 : 128
  const shift = BigInt(bits - rule.prefix)
  return (address.value >> shift) === (rule.value >> shift)
}

function parseRule(input: string): ParsedRule | null {
  if (input === '') return null
  const slash = input.indexOf('/')
  if (slash !== -1 && slash !== input.lastIndexOf('/')) return null
  const addressPart = slash === -1 ? input : input.slice(0, slash)
  const address = parseAddress(addressPart)
  if (address === null) return null
  const bits = address.family === 4 ? 32 : 128
  let prefix = bits
  if (slash !== -1) {
    const rawPrefix = input.slice(slash + 1)
    if (!/^(?:0|[1-9]\d*)$/.test(rawPrefix)) return null
    prefix = Number(rawPrefix)
    if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > bits) return null
  }
  const shift = BigInt(bits - prefix)
  const network = (address.value >> shift) << shift
  const formatted = address.family === 4 ? formatIpv4(network) : formatIpv6(network)
  return {
    ...address,
    value: network,
    prefix,
    canonical: slash === -1 ? formatted : `${formatted}/${prefix}`,
  }
}

function parseAddress(input: string): ParsedIp | null {
  const ipv4 = parseIpv4(input)
  if (ipv4 !== null) return { family: 4, value: ipv4 }
  const ipv6 = parseIpv6(input)
  return ipv6 === null ? null : { family: 6, value: ipv6 }
}

function parseIpv4(input: string): bigint | null {
  const parts = input.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    if (part.length > 1 && part.startsWith('0')) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

function parseIpv6(input: string): bigint | null {
  if (input === '' || input.includes('%')) return null
  let expandedInput = input.toLowerCase()
  if (expandedInput.includes('.')) {
    const separator = expandedInput.lastIndexOf(':')
    if (separator < 0) return null
    const ipv4 = parseIpv4(expandedInput.slice(separator + 1))
    if (ipv4 === null) return null
    expandedInput = `${expandedInput.slice(0, separator)}:${Number(ipv4 >> 16n).toString(16)}:${Number(ipv4 & 0xffffn).toString(16)}`
  }
  if (!/^[0-9a-f:]+$/.test(expandedInput)) return null
  const double = expandedInput.indexOf('::')
  if (double !== -1 && double !== expandedInput.lastIndexOf('::')) return null
  if (double === -1 && (expandedInput.startsWith(':') || expandedInput.endsWith(':'))) return null
  const left = (double === -1 ? expandedInput : expandedInput.slice(0, double))
    .split(':').filter(Boolean)
  const right = (double === -1 ? '' : expandedInput.slice(double + 2))
    .split(':').filter(Boolean)
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
  if (double === -1 && (left.length !== 8 || expandedInput.includes('::'))) return null
  if (double !== -1 && left.length + right.length >= 8) return null
  const groups = double === -1
    ? left
    : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  if (groups.length !== 8) return null
  let value = 0n
  for (const group of groups) value = (value << 16n) | BigInt(`0x${group}`)
  return value
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.')
}

function formatIpv6(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16))
  let bestStart = -1
  let bestLength = 0
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== '0') {
      index += 1
      continue
    }
    let end = index + 1
    while (end < groups.length && groups[end] === '0') end += 1
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index
      bestLength = end - index
    }
    index = end
  }
  if (bestStart === -1) return groups.join(':')
  const left = groups.slice(0, bestStart).join(':')
  const right = groups.slice(bestStart + bestLength).join(':')
  if (left === '' && right === '') return '::'
  if (left === '') return `::${right}`
  if (right === '') return `${left}::`
  return `${left}::${right}`
}

function invalidPolicy(field: string): GatewayError {
  return new GatewayError(
    400,
    `invalid_${field}`,
    `${field} must contain at most ${MAX_RULES_PER_LIST} valid IPv4/IPv6 addresses or CIDRs`,
  )
}

function invalidStoredPolicy(field: string): GatewayError {
  return new GatewayError(500, 'invalid_api_key_ip_policy', `${field} is invalid`, 'server_error')
}
