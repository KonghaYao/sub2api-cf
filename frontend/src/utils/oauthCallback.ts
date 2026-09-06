import { isCloudflareWorkerContractActive } from '@/utils/adminCapabilities'

/**
 * The pending-account exchange is a legacy server flow. Worker callbacks return
 * their token or error in the URL fragment, so a callback without either is invalid.
 */
export function canResumeLegacyPendingOAuth(): boolean {
  return !isCloudflareWorkerContractActive()
}
