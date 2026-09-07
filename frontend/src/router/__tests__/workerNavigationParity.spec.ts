import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const routerPath = resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts')
const routerSource = readFileSync(routerPath, 'utf8')

describe('Worker navigation parity with the original frontend', () => {
  it('keeps the original setup wizard instead of statically redirecting it', () => {
    expect(routerSource).toContain("component: () => import('@/views/setup/SetupWizardView.vue')")
    expect(routerSource).toContain("const BACKEND_MODE_ALLOWED_PATHS = ['/login', '/key-usage', '/setup'")
    expect(routerSource).toContain("if (to.path === '/setup')")
  })

  it('keeps /admin pointed at the original dashboard', () => {
    expect(routerSource).toMatch(/path: '\/admin',\s+redirect: '\/admin\/dashboard'/)
  })

  it.each([
    '/admin/dashboard',
    '/admin/channels/monitor',
    '/admin/plugins',
    '/admin/proxies',
    '/admin/risk-control',
    '/admin/prompt-audit',
    '/monitor',
    '/payment/airwallex',
    '/payment/qrcode',
    '/auth/wechat/payment/callback',
  ])('does not add a Worker-only redirect for %s', (path) => {
    expect(routerSource).not.toContain(`'${path}':`)
  })

  it('does not block declared admin routes through a Worker-only allowlist', () => {
    expect(routerSource).not.toContain('isCloudflareAdminPathSupported(to.path)')
    expect(routerSource).not.toContain('CLOUDFLARE_REMOVED_ROUTE_REDIRECTS')
  })
})
