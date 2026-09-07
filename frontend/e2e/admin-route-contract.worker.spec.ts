import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type Response,
} from '@playwright/test'
import { ensureBootstrapAdminPermissions } from './support/admin-session'
import { ensureWorkerStripe } from './support/payment'

const ADMIN_TOKEN = 'browser-e2e-admin-token-32-bytes-minimum'
const ADMIN_EMAIL = 'admin-route-patrol@browser-e2e.test'
const ADMIN_PASSWORD = 'admin route patrol correct horse battery staple'
const ADMIN_COMPLIANCE_PHRASE = 'I have read, understood, and agree to the Sub2API Deployment and Operation Compliance Commitment'

/** Every leaf route exposed by the Worker-filtered administrator sidebar. */
const RETAINED_ADMIN_ROUTES = [
  '/admin/dashboard',
  '/admin/ops',
  '/admin/users',
  '/admin/groups',
  '/admin/channels/pricing',
  '/admin/subscriptions',
  '/admin/accounts',
  '/admin/announcements',
  '/admin/redeem',
  '/admin/promo-codes',
  '/admin/invitation-codes',
  '/admin/affiliates/invites',
  '/admin/affiliates/rebates',
  '/admin/affiliates/transfers',
  '/admin/orders/dashboard',
  '/admin/orders',
  '/admin/orders/plans',
  '/admin/usage',
  '/admin/audit-logs',
  '/admin/settings',
] as const

interface PatrolFailures {
  pageErrors: Array<{ route: string; message: string }>
  requestFailures: Array<{ route: string; method: string; url: string; error: string }>
  apiFailures: Array<{ route: string; method: string; url: string; status: number; body: string }>
}

async function responseData<T>(response: APIResponse): Promise<T> {
  const body = await response.json() as { code?: number; data?: T; error?: unknown }
  expect(response.ok(), `${response.status()} ${JSON.stringify(body)}`).toBe(true)
  expect(body.code, JSON.stringify(body)).toBe(0)
  expect(body.data, JSON.stringify(body)).toBeDefined()
  return body.data!
}

async function prepareAdministrator(request: APIRequestContext): Promise<{
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: Record<string, unknown>
  bootstrapGroupId: string
  bootstrapAccountId: string
}> {
  const bootstrap = await responseData<{
    admin_session: string
    user_id: string
    group_id: string
    account_id: string
  }>(await request.post('/api/v1/admin/bootstrap', {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    data: {
      user: {
        email: 'admin-route-bootstrap@browser-e2e.test',
        display_name: 'Admin Route Bootstrap',
        balance_micros: 1_000_000,
      },
      group: { name: 'Admin Route Patrol Group' },
      account: {
        name: 'Admin Route Patrol Upstream',
        base_url: 'https://upstream.browser-e2e.invalid/v1',
        api_key: 'admin-route-patrol-upstream-secret',
      },
      models: [{
        public_name: 'admin-route-patrol-model',
        input_micros_per_million: 1_000_000,
        output_micros_per_million: 2_000_000,
      }],
    },
  }))
  const bootstrapSession = await ensureBootstrapAdminPermissions(
    request,
    ADMIN_TOKEN,
    bootstrap,
    'admin-route-promote-bootstrap-0001',
  )
  const authorization = { authorization: `Bearer ${bootstrapSession}` }

  await responseData(await request.post('/api/v1/admin/compliance/accept', {
    headers: authorization,
    data: { phrase: ADMIN_COMPLIANCE_PHRASE, language: 'en' },
  }))

  const administrator = await responseData<{ id: string }>(await request.post('/api/v1/admin/users', {
    headers: {
      ...authorization,
      'idempotency-key': 'admin-route-create-login-admin-0001',
    },
    data: {
      email: ADMIN_EMAIL,
      display_name: 'Admin Route Patrol',
      role: 'admin',
      password: ADMIN_PASSWORD,
      balance_micros: 1_000_000,
      concurrency: 5,
      rpm_limit: 0,
    },
  }))
  await responseData(await request.put(
    `/api/v1/admin/rbac/users/${administrator.id}/roles/super_admin`,
    {
      headers: {
        ...authorization,
        'idempotency-key': 'admin-route-assign-super-admin-0001',
        'if-match': '"0"',
      },
    },
  ))

  const settingsResponse = await request.get('/api/v1/admin/settings', { headers: authorization })
  await responseData(settingsResponse)
  await responseData(await request.put('/api/v1/admin/settings', {
    headers: {
      ...authorization,
      'idempotency-key': 'admin-route-enable-features-0001',
      'if-match': settingsResponse.headers()['etag'] ?? '"0"',
    },
    data: {
      public: {
        site_name: 'Admin Route Patrol',
        registration_enabled: true,
        email_verification_enabled: false,
        turnstile_enabled: false,
        available_channels_enabled: true,
        model_plaza_enabled: true,
        model_plaza_require_auth: false,
        promo_code_enabled: true,
        invitation_code_enabled: true,
        affiliate_enabled: true,
      },
    },
  }))
  await ensureWorkerStripe(request, bootstrapSession)

  const login = await responseData<{
    access_token: string
    refresh_token: string
    expires_in: number
    user: Record<string, unknown>
  }>(await request.post('/api/v1/auth/login', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  }))
  expect(login.user).toMatchObject({ id: administrator.id, email: ADMIN_EMAIL, role: 'admin' })
  await responseData(await request.post('/api/v1/admin/compliance/accept', {
    headers: { authorization: `Bearer ${login.access_token}` },
    data: { phrase: ADMIN_COMPLIANCE_PHRASE, language: 'en' },
  }))
  return {
    accessToken: login.access_token,
    refreshToken: login.refresh_token,
    expiresIn: login.expires_in,
    user: login.user,
    bootstrapGroupId: bootstrap.group_id,
    bootstrapAccountId: bootstrap.account_id,
  }
}

function installPatrol(page: Page): {
  failures: PatrolFailures
  inspectResponses: () => Promise<void>
  setRoute: (route: string) => void
} {
  let activeRoute = '(startup)'
  const failures: PatrolFailures = { pageErrors: [], requestFailures: [], apiFailures: [] }
  const responseInspections: Array<Promise<void>> = []

  page.on('pageerror', (error) => {
    failures.pageErrors.push({ route: activeRoute, message: error.message })
  })
  page.on('requestfailed', (request) => {
    failures.requestFailures.push({
      route: activeRoute,
      method: request.method(),
      url: new URL(request.url()).pathname,
      error: request.failure()?.errorText ?? 'unknown request failure',
    })
  })
  page.on('response', (response: Response) => {
    const url = new URL(response.url())
    if (!url.pathname.startsWith('/api/') || response.status() < 400) return
    const routeAtResponse = activeRoute
    responseInspections.push((async () => {
      failures.apiFailures.push({
        route: routeAtResponse,
        method: response.request().method(),
        url: url.pathname,
        status: response.status(),
        body: (await response.text().catch(() => '')).slice(0, 500),
      })
    })())
  })

  return {
    failures,
    setRoute: (route) => { activeRoute = route },
    inspectResponses: async () => { await Promise.all(responseInspections) },
  }
}

async function expectStableAdminPage(page: Page, route: string): Promise<void> {
  const response = await page.goto(route, { waitUntil: 'domcontentloaded' })
  expect.soft(response?.status(), `${route} document status`).toBe(200)
  await expect.soft(page, `${route} must remain active`).toHaveURL(
    new RegExp(`${route.replaceAll('/', '\\/')}(?:\\?|$)`),
  )
  await expect.soft(page.locator('#app'), `${route} app root`).toBeVisible()
  await expect.soft(page.locator('#app'), `${route} rendered content`).not.toHaveText('', { timeout: 5_000 })
  await expect.soft(page.locator('body'), `${route} migration fallback`).not.toContainText('Route not migrated')
  expect.soft(await page.title(), `${route} document title`).not.toMatch(/^\s*$|404 Not Found/i)
  await page.waitForTimeout(500)
}

test('administrator pages render, scheduling persists and original operation audit works', async ({ page, request }, testInfo) => {
  test.setTimeout(90000)
  const session = await prepareAdministrator(request)
  await page.addInitScript((auth) => {
    if (window !== window.top) return
    localStorage.setItem('auth_token', auth.accessToken)
    localStorage.setItem('refresh_token', auth.refreshToken)
    localStorage.setItem('token_expires_at', String(Date.now() + auth.expiresIn * 1_000))
    localStorage.setItem('auth_user', JSON.stringify(auth.user))
  }, session)
  const patrol = installPatrol(page)

  patrol.setRoute('/admin')
  await page.goto('/admin', { waitUntil: 'domcontentloaded' })
  await expect.soft(page, '/admin home').toHaveURL(/\/admin\/dashboard(?:\?|$)/)

  for (const route of RETAINED_ADMIN_ROUTES) {
    patrol.setRoute(route)
    await expectStableAdminPage(page, route)
  }

  patrol.setRoute('/admin/accounts')
  await page.goto('/admin/accounts', { waitUntil: 'domcontentloaded' })
  const accountRow = page.locator('tr').filter({ hasText: 'Admin Route Patrol Upstream' })
  await expect(accountRow).toHaveCount(1)
  const toggle = accountRow.getByRole('switch')
  for (const value of [false, true]) {
    const updated = page.waitForResponse(response => response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === `/api/v1/admin/accounts/${session.bootstrapAccountId}`)
    await toggle.click()
    expect((await updated).status()).toBe(200)
    await expect(toggle).toHaveAttribute('aria-checked', String(value))
    const account = await responseData<{ enabled:boolean; schedulable:boolean }>(await request.get(`/api/v1/admin/accounts/${session.bootstrapAccountId}`, {
      headers:{authorization:`Bearer ${session.accessToken}`},
    }))
    expect(account).toMatchObject({enabled:true,schedulable:value})
  }
  patrol.setRoute('/admin/audit-logs')
  await page.goto('/admin/audit-logs', { waitUntil: 'domcontentloaded' })
  const search = page.locator('input').first()
  await search.fill(session.bootstrapAccountId)
  const filtered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/audit-logs' && new URL(response.url()).searchParams.get('q') === session.bootstrapAccountId)
  await search.press('Enter')
  expect((await filtered).status()).toBe(200)
  await expect(page.getByRole('button', {name:/Detail|详情/i}).first()).toBeVisible()
  await page.screenshot({path:testInfo.outputPath('admin-audit-original.png'),fullPage:true})
  const detail = page.waitForResponse(response => /\/api\/v1\/admin\/audit-logs\/[^/]+$/.test(new URL(response.url()).pathname))
  await page.getByRole('button', {name:/Detail|详情/i}).first().click()
  expect((await detail).status()).toBe(200)
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.waitForTimeout(500)
  await patrol.inspectResponses()
  expect(patrol.failures.pageErrors, JSON.stringify(patrol.failures, null, 2)).toEqual([])
  expect(patrol.failures.requestFailures, JSON.stringify(patrol.failures, null, 2)).toEqual([])
  expect(patrol.failures.apiFailures, JSON.stringify(patrol.failures, null, 2)).toEqual([])
})
