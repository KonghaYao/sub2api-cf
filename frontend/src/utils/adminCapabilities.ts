export const CLOUDFLARE_ADMIN_HOME = '/admin/accounts'

let cloudflareWorkerContractActive = true

const WORKER_UNSUPPORTED_ACCOUNT_FIELDS = new Set([
  'proxy_id',
  'enable_tls_fingerprint',
  'tls_fingerprint_profile_id',
  'tls_fingerprint',
  'utls',
  'ja3',
])

const CLOUDFLARE_ADMIN_PATHS = [
  '/admin/settings',
  '/admin/users',
  '/admin/groups',
  '/admin/channels/pricing',
  '/admin/accounts',
  '/admin/subscriptions',
  '/admin/redeem',
  '/admin/promo-codes',
  '/admin/invitation-codes',
  '/admin/affiliates',
  '/admin/audit-logs',
  '/admin/orders'
] as const

export function isCloudflareAdminPathSupported(path: string): boolean {
  return CLOUDFLARE_ADMIN_PATHS.some(
    (allowedPath) => path === allowedPath || path.startsWith(`${allowedPath}/`)
  )
}

export function filterCloudflareAdminNavigation<T extends { path: string; children?: T[] }>(
  items: T[]
): T[] {
  const visible: T[] = []

  for (const item of items) {
    const children = item.children
      ? filterCloudflareAdminNavigation(item.children)
      : undefined
    const supported = isCloudflareAdminPathSupported(item.path)

    if (!supported && (!children || children.length === 0)) continue
    visible.push(children ? { ...item, children } : item)
  }

  return visible
}

export function setCloudflareWorkerContractActive(active: boolean): void {
  cloudflareWorkerContractActive = active
}

export function isCloudflareWorkerContractActive(): boolean {
  return cloudflareWorkerContractActive
}

export function sanitizeCloudflareAccountPayload<T>(payload: T): T {
  if (!cloudflareWorkerContractActive || payload === null || typeof payload !== 'object') {
    return payload
  }
  if (Array.isArray(payload)) {
    return payload.map((value) => sanitizeCloudflareAccountPayload(value)) as T
  }

  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (WORKER_UNSUPPORTED_ACCOUNT_FIELDS.has(key.toLowerCase())) continue
    clean[key] = sanitizeCloudflareAccountPayload(value)
  }
  return clean as T
}

const WORKER_ACCOUNT_CREATE_FIELDS = new Set([
  'name',
  'platform',
  'protocol',
  'auth_scheme',
  'type',
  'base_url',
  'api_key',
  'enabled',
  'max_concurrency',
  'provider_config',
  'group_links',
  'model_capabilities',
])

const WORKER_ACCOUNT_UPDATE_FIELDS = new Set([
  'name',
  'base_url',
  'api_key',
  'enabled',
  'max_concurrency',
  'provider_config',
  'group_links',
  'model_capabilities',
  'expected_control_version',
])

function allowWorkerAccountFields<T>(payload: T, allowed: Set<string>): T {
  if (!cloudflareWorkerContractActive || payload === null || typeof payload !== 'object') {
    return payload
  }
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!allowed.has(key)) continue
    clean[key] = sanitizeCloudflareAccountPayload(value)
  }
  return clean as T
}

export function sanitizeCloudflareAccountCreatePayload<T>(payload: T): T {
  return allowWorkerAccountFields(payload, WORKER_ACCOUNT_CREATE_FIELDS)
}

export function sanitizeCloudflareAccountUpdatePayload<T>(payload: T): T {
  return allowWorkerAccountFields(payload, WORKER_ACCOUNT_UPDATE_FIELDS)
}
