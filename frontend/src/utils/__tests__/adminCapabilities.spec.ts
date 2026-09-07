import { describe, expect, it } from 'vitest'

import {
  sanitizeCloudflareAccountPayload,
  setCloudflareWorkerContractActive,
} from '@/utils/adminCapabilities'

describe('Cloudflare admin capabilities', () => {
  it('recursively strips proxy and TLS fingerprint fields from Worker payloads', () => {
    setCloudflareWorkerContractActive(true)

    expect(sanitizeCloudflareAccountPayload({
      name: 'primary',
      proxy_id: 42,
      extra: {
        enable_tls_fingerprint: true,
        tls_fingerprint_profile_id: 7,
        ja3: 'legacy',
        keep: true,
      },
    })).toEqual({ name: 'primary', extra: { keep: true } })
  })
})
