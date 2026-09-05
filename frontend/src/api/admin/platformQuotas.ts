import { apiClient } from '../client'

export type PlatformQuotaPlatform = 'anthropic' | 'openai' | 'gemini' | 'antigravity' | 'grok'

export interface PlatformQuotaDefaultLimits {
  daily_limit_usd: number | null
  weekly_limit_usd: number | null
  monthly_limit_usd: number | null
}

export type PlatformQuotaDefaultsMap = Record<PlatformQuotaPlatform, PlatformQuotaDefaultLimits>

export interface PlatformQuotaDefaultsResponse {
  schema_version: 1
  control_version: number
  platform_quotas: PlatformQuotaDefaultsMap
  updated_at_ms: number
}

export async function getPlatformQuotaDefaults(): Promise<PlatformQuotaDefaultsResponse> {
  const { data } = await apiClient.get<PlatformQuotaDefaultsResponse>(
    '/admin/platform-quota-defaults',
  )
  return data
}

export async function updatePlatformQuotaDefaults(
  platformQuotas: PlatformQuotaDefaultsMap,
  expectedControlVersion: number,
): Promise<PlatformQuotaDefaultsResponse> {
  if (!Number.isSafeInteger(expectedControlVersion) || expectedControlVersion < 0) {
    throw Object.assign(new Error('Reload platform quota defaults before changing them.'), {
      code: 'platform_quota_control_version_required',
    })
  }
  const requestId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const { data } = await apiClient.put<PlatformQuotaDefaultsResponse>(
    '/admin/platform-quota-defaults',
    { platform_quotas: platformQuotas },
    { headers: {
      'Idempotency-Key': `admin-platform-quota-defaults-${requestId}`,
      'If-Match': `"${expectedControlVersion}"`,
    } },
  )
  return data
}

export const platformQuotasAPI = {
  getDefaults: getPlatformQuotaDefaults,
  updateDefaults: updatePlatformQuotaDefaults,
}

export default platformQuotasAPI
