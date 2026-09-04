import { describe, expect, it } from 'vitest'

import {
  filterCloudflareAdminNavigation,
  isCloudflareAdminPathSupported,
  sanitizeCloudflareAccountPayload,
  setCloudflareWorkerContractActive,
} from '@/utils/adminCapabilities'

describe('Cloudflare admin capabilities', () => {
  it.each([
    '/admin/settings',
    '/admin/users/42',
    '/admin/groups',
    '/admin/accounts',
    '/admin/subscriptions',
    '/admin/redeem',
    '/admin/orders/plans',
    '/admin/audit-logs/control/event-1',
  ])('allows migrated route %s', (path) => {
    expect(isCloudflareAdminPathSupported(path)).toBe(true)
  })

  it.each([
    '/admin/dashboard',
    '/admin/ops',
    '/admin/channels/monitor',
    '/admin/proxies',
    '/admin/plugins',
    '/admin/announcements',
    '/admin/promo-codes',
    '/admin/usage',
    '/admin/new-host-feature',
  ])('denies unsupported or unknown route %s', (path) => {
    expect(isCloudflareAdminPathSupported(path)).toBe(false)
  })

  it('removes unsupported leaves while retaining a supported child group', () => {
    const items = [
      { path: '/admin/dashboard' },
      {
        path: '/admin/orders-menu',
        children: [
          { path: '/admin/orders' },
          { path: '/admin/usage' },
        ],
      },
    ]

    expect(filterCloudflareAdminNavigation(items)).toEqual([
      {
        path: '/admin/orders-menu',
        children: [{ path: '/admin/orders' }],
      },
    ])
  })

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
