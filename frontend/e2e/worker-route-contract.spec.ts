import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test'
import { ensureBootstrapAdminPermissions } from './support/admin-session'
import { ensureWorkerStripe } from './support/payment'

const ADMIN_TOKEN = 'browser-e2e-admin-token-32-bytes-minimum'

const PUBLIC_WORKER_ROUTES = [
  '/home',
  '/login',
  '/register',
  '/email-verify',
  '/auth/callback',
  '/auth/oauth/callback',
  '/auth/linuxdo/callback',
  '/auth/wechat/callback',
  '/auth/dingtalk/callback',
  '/auth/dingtalk/email-completion',
  '/auth/oidc/callback',
  '/forgot-password',
  '/reset-password',
  '/key-usage',
  '/legal/admin-compliance',
  '/model-plaza',
  '/payment/result',
  '/payment/stripe',
  '/payment/stripe-popup',
] as const

const USER_WORKER_ROUTES = [
  '/dashboard',
  '/keys',
  '/batch-image',
  '/usage',
  '/redeem',
  '/affiliate',
  '/available-channels',
  '/profile',
  '/subscriptions',
  '/purchase',
  '/orders',
] as const

interface PatrolFailures {
  pageErrors: Array<{ route: string; message: string }>
  requestFailures: Array<{ route: string; url: string; error: string }>
  apiFailures: Array<{ route: string; url: string; status: number; body: string }>
}

async function expectData<T>(response: Awaited<ReturnType<APIRequestContext['fetch']>>): Promise<T> {
  const body = await response.json() as { code: number; data: T; message?: string }
  expect(response.ok(), JSON.stringify(body)).toBe(true)
  expect(body.code).toBe(0)
  return body.data
}

async function enableWorkerPublicFeatures(request: APIRequestContext, suffix: string): Promise<string> {
  const bootstrap = await request.post('/api/v1/admin/bootstrap', {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    data: {
      user: {
        email: `route-admin-${suffix}@browser-e2e.test`,
        display_name: 'Route Patrol Admin',
        balance_micros: 1_000_000,
      },
      group: { name: `Route Patrol Group ${suffix}` },
      account: {
        name: `Route Patrol Upstream ${suffix}`,
        base_url: 'https://upstream.browser-e2e.invalid/v1',
        api_key: 'route-patrol-upstream-secret',
      },
      models: [{
        public_name: `route-patrol-model-${suffix}`,
        input_micros_per_million: 1_000_000,
        output_micros_per_million: 2_000_000,
      }],
    },
  })
  const setup = await expectData<{ admin_session: string; user_id: string }>(bootstrap)
  const adminSession = await ensureBootstrapAdminPermissions(
    request,
    ADMIN_TOKEN,
    setup,
    `route-patrol-promote-admin-${suffix}`,
  )
  const settingsResponse = await request.get('/api/v1/admin/settings', {
    headers: { authorization: `Bearer ${adminSession}` },
  })
  await expectData(settingsResponse)
  await expectData(await request.put('/api/v1/admin/settings', {
    headers: {
      authorization: `Bearer ${adminSession}`,
      'idempotency-key': `route-patrol-public-settings-${suffix}`,
      'if-match': settingsResponse.headers()['etag'] ?? '"0"',
    },
    data: {
      public: {
        site_name: 'Browser Route Patrol',
        registration_enabled: true,
        email_verification_enabled: false,
        turnstile_enabled: false,
        available_channels_enabled: true,
        model_plaza_enabled: true,
        model_plaza_require_auth: false,
        promo_code_enabled: true,
        invitation_code_enabled: false,
        affiliate_enabled: true,
      },
    },
  }))
  return adminSession
}

function installPatrol(page: Page): {
  failures: PatrolFailures
  inspectResponses: () => Promise<void>
  setRoute: (route: string) => void
} {
  let activeRoute = '(startup)'
  const failures: PatrolFailures = { pageErrors: [], requestFailures: [], apiFailures: [] }
  const responseInspections: Array<Promise<void>> = []
  page.on('pageerror', (error) => failures.pageErrors.push({ route: activeRoute, message: error.message }))
  page.on('requestfailed', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) {
      failures.requestFailures.push({
        route: activeRoute,
        url: url.pathname,
        error: request.failure()?.errorText ?? 'unknown request failure',
      })
    }
  })
  page.on('response', (response: Response) => {
    const url = new URL(response.url())
    if (!url.pathname.startsWith('/api/') || response.status() < 400) return
    const routeAtResponse = activeRoute
    responseInspections.push((async () => {
      const body = await response.text().catch(() => '')
      failures.apiFailures.push({
        route: routeAtResponse,
        url: url.pathname,
        status: response.status(),
        body: body.slice(0, 500),
      })
    })())
  })
  return {
    failures,
    setRoute: (route) => { activeRoute = route },
    inspectResponses: async () => { await Promise.all(responseInspections) },
  }
}

async function expectStableVuePage(page: Page, route: string): Promise<void> {
  const response = await page.goto(route, { waitUntil: 'domcontentloaded' })
  expect.soft(response?.status(), `${route} document status`).toBe(200)
  await expect.soft(page.locator('#app'), `${route} app root`).toBeVisible()
  await expect.soft(page.locator('#app'), `${route} rendered content`).not.toHaveText('', { timeout: 5_000 })
  await expect.soft(page.locator('body'), `${route} migration fallback`).not.toContainText('Route not migrated')
  expect.soft(await page.title(), `${route} document title`).not.toMatch(/^\s*$|404 Not Found/i)
}

test('every reachable public Worker route renders and unsupported payment routes land safely', async ({ page, request }) => {
  await enableWorkerPublicFeatures(request, 'public')
  const patrol = installPatrol(page)

  for (const route of PUBLIC_WORKER_ROUTES) {
    patrol.setRoute(route)
    await expectStableVuePage(page, route)
  }

  for (const route of ['/payment/airwallex', '/auth/wechat/payment/callback']) {
    patrol.setRoute(route)
    await page.goto(route, { waitUntil: 'domcontentloaded' })
    await expect.soft(page, `${route} Worker removal redirect`).toHaveURL(/\/payment\/result(?:\?|$)/)
  }

  await patrol.inspectResponses()
  const routeGaps = patrol.failures.apiFailures.filter((failure) =>
    failure.body.includes('Route not migrated to Cloudflare Workers yet')
  )
  expect(patrol.failures.pageErrors, JSON.stringify(patrol.failures, null, 2)).toEqual([])
  expect(patrol.failures.requestFailures, JSON.stringify(patrol.failures, null, 2)).toEqual([])
  expect(routeGaps, JSON.stringify(patrol.failures, null, 2)).toEqual([])
})

test('every reachable ordinary-user Worker route renders and legacy-only routes are removed', async ({ page, request }) => {
  const adminSession = await enableWorkerPublicFeatures(request, 'user')
  await ensureWorkerStripe(request, adminSession)
  const session = await expectData<{
    access_token: string
    refresh_token: string
    expires_in: number
    user: Record<string, unknown>
  }>(await request.post('/api/v1/auth/register', {
    data: {
      email: 'route-user@browser-e2e.test',
      password: 'route patrol correct horse battery staple',
    },
  }))
  await page.addInitScript((auth) => {
    localStorage.setItem('auth_token', auth.access_token)
    localStorage.setItem('refresh_token', auth.refresh_token)
    localStorage.setItem('token_expires_at', String(Date.now() + auth.expires_in * 1_000))
    localStorage.setItem('auth_user', JSON.stringify(auth.user))
  }, session)
  const patrol = installPatrol(page)

  for (const route of USER_WORKER_ROUTES) {
    patrol.setRoute(route)
    await expectStableVuePage(page, route)
    await expect.soft(page, `${route} must remain the active user route`).toHaveURL(new RegExp(`${route.replace('/', '\\/')}(?:\\?|$)`))
  }

  patrol.setRoute('/payment/qrcode')
  await page.goto('/payment/qrcode', { waitUntil: 'domcontentloaded' })
  await expect.soft(page, '/payment/qrcode Worker removal redirect').toHaveURL(/\/purchase(?:\?|$)/)

  patrol.setRoute('/monitor')
  await page.goto('/monitor', { waitUntil: 'domcontentloaded' })
  await expect.soft(page, '/monitor Worker removal redirect').toHaveURL(/\/dashboard(?:\?|$)/)

  await patrol.inspectResponses()
  const routeGaps = patrol.failures.apiFailures.filter((failure) =>
    failure.body.includes('Route not migrated to Cloudflare Workers yet')
  )
  expect(patrol.failures.pageErrors, JSON.stringify(patrol.failures, null, 2)).toEqual([])
  expect(patrol.failures.requestFailures, JSON.stringify(patrol.failures, null, 2)).toEqual([])
  expect(routeGaps, JSON.stringify(patrol.failures, null, 2)).toEqual([])
})
