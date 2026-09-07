let cloudflareWorkerContractActive = true

const WORKER_UNSUPPORTED_ACCOUNT_FIELDS = new Set([
  'proxy_id',
  'enable_tls_fingerprint',
  'tls_fingerprint_profile_id',
  'tls_fingerprint',
  'utls',
  'ja3',
])

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
  'rate_multiplier',
  'provider_config',
  'subscription_plan',
  'group_links',
  'model_capabilities',
])

const WORKER_ACCOUNT_UPDATE_FIELDS = new Set([
  'name',
  'base_url',
  'api_key',
  'enabled',
  'max_concurrency',
  'rate_multiplier',
  'provider_config',
  'subscription_plan',
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

/** These Worker providers currently accept existing tokens; authorization and refresh require an external OAuth client. */
export function requiresImportedOAuthToken(platform: string | undefined): boolean {
  return cloudflareWorkerContractActive && (platform === 'antigravity' || platform === 'grok')
}
