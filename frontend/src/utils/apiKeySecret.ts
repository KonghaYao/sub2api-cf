import type { ApiKey } from '@/types'

export type ApiKeyWithPlaintext = ApiKey & { key: string }

/**
 * API key list/detail responses only expose key_prefix. The full plaintext key is
 * present on create responses (and on compatible legacy deployments) only.
 */
export function hasPlaintextApiKey(key: ApiKey): key is ApiKeyWithPlaintext {
  return typeof key.key === 'string' && key.key.length > 0
}
