import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type Response,
  type Request,
} from '@playwright/test'
import { ensureBootstrapAdminPermissions } from './support/admin-session'
import { ensureWorkerStripe } from './support/payment'

const ADMIN_TOKEN = 'browser-e2e-admin-token-32-bytes-minimum'
const ADMIN_EMAIL = 'admin-route-patrol@browser-e2e.test'
const ADMIN_PASSWORD = 'admin route patrol correct horse battery staple'
const ADMIN_COMPLIANCE_PHRASE = 'I have read, understood, and agree to the Sub2API Deployment and Operation Compliance Commitment'

/** Original administrator routes: missing backends must fail the patrol, never hide the page. */
const RETAINED_ADMIN_ROUTES = [
  '/admin/dashboard',
  '/admin/ops',
  '/admin/plugins',
  '/admin/proxies',
  '/admin/channels/monitor',
  '/admin/risk-control',
  '/admin/prompt-audit',
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
  const requestRoutes = new WeakMap<Request, string>()
  page.on('request', request => { requestRoutes.set(request, activeRoute) })

  page.on('pageerror', (error) => {
    failures.pageErrors.push({ route: activeRoute, message: error.message })
  })
  page.on('requestfailed', (request) => {
    failures.requestFailures.push({
      route: requestRoutes.get(request) ?? activeRoute,
      method: request.method(),
      url: new URL(request.url()).pathname,
      error: request.failure()?.errorText ?? 'unknown request failure',
    })
  })
  page.on('response', (response: Response) => {
    const url = new URL(response.url())
    if (!url.pathname.startsWith('/api/') || response.status() < 400) return
    const routeAtResponse = requestRoutes.get(response.request()) ?? activeRoute
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

let sharedSession: Awaited<ReturnType<typeof prepareAdministrator>>
test.beforeAll(async ({ request }) => {
  sharedSession = await prepareAdministrator(request)
})

test('original proxy bulk controls import across Worker chunks and delete selected records', async ({ page }) => {
  const session = sharedSession
  await page.addInitScript((auth) => {
    localStorage.setItem('auth_token', auth.accessToken)
    localStorage.setItem('refresh_token', auth.refreshToken)
    localStorage.setItem('token_expires_at', String(Date.now() + auth.expiresIn * 1000))
    localStorage.setItem('auth_user', JSON.stringify(auth.user))
    localStorage.setItem(`admin_guide_${auth.user.id}_admin_v4_interactive`, 'true')
  }, session)
  await page.goto('/admin/proxies')
  await page.getByRole('button', { name: /^(Create Proxy|创建代理)$/ }).first().click()
  await page.getByRole('button', { name: /^(Quick Add|快速添加|批量添加)$/ }).click()
  await page.locator('textarea').fill(Array.from({ length: 7 }, (_, i) => `socks5h://bulk-proxy.browser-e2e.invalid:${1000 + i}`).join('\n'))
  await page.getByRole('button', { name: /Import 7 proxies|导入.*7/ }).click()
  const rows = page.locator('tr').filter({ hasText: 'bulk-proxy.browser-e2e.invalid' })
  await expect(rows).toHaveCount(7)
  for (let i = 0; i < 7; i++) await rows.nth(i).locator('input[type="checkbox"]').check()
  await page.locator('button[title="Delete"], button[title="删除"]').click()
  const deleted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/proxies/batch-delete')
  await page.getByRole('dialog').getByRole('button', { name: /^(Delete|删除)$/ }).click()
  const result = await deleted
  expect(result.status(), await result.text()).toBe(200)
  expect((await result.json()).data.deleted_ids).toHaveLength(7)
  await expect(rows).toHaveCount(0)
})

test('original proxy inventory creates and edits encrypted proxy records', async ({ page, request }) => {
  const session = sharedSession
  await page.addInitScript((auth) => {
    localStorage.setItem('auth_token', auth.accessToken)
    localStorage.setItem('refresh_token', auth.refreshToken)
    localStorage.setItem('token_expires_at', String(Date.now() + auth.expiresIn * 1000))
    localStorage.setItem('auth_user', JSON.stringify(auth.user))
    localStorage.setItem(`admin_guide_${auth.user.id}_admin_v4_interactive`, 'true')
  }, session)
  const inventory = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/proxies')
  await page.goto('/admin/proxies')
  expect((await inventory).status()).toBe(200)
  await page.getByRole('button', { name: /^(Create Proxy|创建代理)$/ }).first().click()
  const form = page.locator('#create-proxy-form')
  await expect(form).toBeVisible()
  await form.locator('input[type="text"]').nth(0).fill('Browser Proxy')
  await form.locator('input[type="text"]').nth(1).fill('proxy.browser-e2e.invalid')
  await form.locator('input[type="number"]').first().fill('1080')
  await form.locator('input[type="password"]').fill('browser-proxy-secret')
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/admin/proxies')
  await page.locator('button[form="create-proxy-form"]').click()
  const response = await created
  expect(response.status(), await response.text()).toBe(201)
  const proxy = (await response.json()).data
  await expect(form).toBeHidden()
  const row = page.locator('tr').filter({ hasText: 'Browser Proxy' })
  await expect(row).toHaveCount(1)
  await row.getByRole('button', { name: /^(Edit|编辑)$/ }).click()
  const edit = page.locator('#edit-proxy-form')
  await expect(edit).toBeVisible()
  await edit.locator('input[type="text"]').first().fill('Browser Proxy Edited')
  const changed = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/v1/admin/proxies/${proxy.id}`)
  await page.locator('button[form="edit-proxy-form"]').click()
  expect((await changed).status()).toBe(200)
  await expect(edit).toBeHidden()
  const directory = await responseData<Array<{ id: string; name: string }>>(await request.get('/api/v1/admin/proxies/all?with_count=true', {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))
  expect(directory).toContainEqual(expect.objectContaining({ id: proxy.id, name: 'Browser Proxy Edited', account_count: 0 }))
  await responseData(await request.post('/api/v1/admin/accounts', {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-proxy-linked-account' },
    data: { name: 'Proxy Linked Account', platform: 'openai', type: 'apikey', concurrency: 1, proxy_id: proxy.id,
      credentials: { base_url: 'https://upstream.browser-e2e.invalid/v1', api_key: 'linked-account-secret' } },
  }))
  await page.reload()
  const linked = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/admin/proxies/${proxy.id}/accounts`)
  await page.locator('tr').filter({ hasText: 'Browser Proxy Edited' }).getByRole('button', { name: /1/ }).click()
  expect((await linked).status()).toBe(200)
  await expect(page.getByText('Proxy Linked Account', { exact: true })).toBeVisible()
  await page.goto('/admin/accounts')
  await page.getByRole('button', { name: /^(More Actions|更多操作)$/ }).click()
  await page.getByRole('button', { name: /^(Proxy|代理)$/ }).click()
  await expect(page.locator('tr').filter({ hasText: 'Proxy Linked Account' })).toContainText('Browser Proxy Edited')
})

test('original account controls toggle scheduling twice and save group changes with opaque IDs', async ({ page, request }) => {
  test.setTimeout(90_000)
  const session = sharedSession
  await page.addInitScript((auth) => {
    localStorage.setItem('auth_token', auth.accessToken)
    localStorage.setItem('refresh_token', auth.refreshToken)
    localStorage.setItem('token_expires_at', String(Date.now() + auth.expiresIn * 1000))
    localStorage.setItem('auth_user', JSON.stringify(auth.user))
    localStorage.setItem(`admin_guide_${auth.user.id}_admin_v4_interactive`, 'true')
  }, session)
  const replacement = await responseData<{ id: string }>(await request.post('/api/v1/admin/groups', {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'account-core-replacement-group' },
    data: { name: 'Account Core Replacement Group', platform: 'openai' },
  }))
  const statsResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/accounts/today-stats/batch')
  await page.goto('/admin/accounts')
  expect((await statsResponse).status()).toBe(200)
  const row = page.locator('tr').filter({ hasText: 'Admin Route Patrol Upstream' })
  await expect(row).toHaveCount(1)
  for (const next of [false, true]) {
    const response = page.waitForResponse(response => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/admin/accounts/${session.bootstrapAccountId}/schedulable`)
    await row.getByRole('button', { name: /Scheduling (enabled|disabled)|调度已(开启|关闭)/ }).click()
    const changed = await response
    expect(changed.status()).toBe(200)
    expect((await changed.json()).data).toMatchObject({ enabled: true, status: 'active', schedulable: next })
    await expect(row.getByRole('button', { name: next ? /Scheduling enabled|调度已开启/ : /Scheduling disabled|调度已关闭/ })).toBeVisible()
  }
  await row.getByRole('button', { name: /编辑|Edit/i }).click()
  const form = page.locator('#edit-account-form')
  await expect(form).toBeVisible()
  const synced = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === `/api/v1/admin/accounts/${session.bootstrapAccountId}/models/sync-upstream`)
  await form.getByRole('button', { name: /Sync upstream supported models|同步上游支持的模型/i }).click()
  const syncResponse = await synced
  expect(syncResponse.status(), await syncResponse.text()).toBe(200)
  expect((await syncResponse.json()).data.models).toContain('gpt-browser-e2e-upstream')

  await form.locator(`input[value="${session.bootstrapGroupId}"]`).uncheck()
  await form.locator(`input[value="${replacement.id}"]`).check()
  expect(await form.evaluate(element => Array.from(element.querySelectorAll('input, select, textarea'))
    .filter(input => !(input as HTMLInputElement).checkValidity())
    .map(input => ({ type: input.getAttribute('type'), tour: input.getAttribute('data-tour'),
      message: (input as HTMLInputElement).validationMessage }))), 'Original form must remain valid with Worker defaults').toEqual([])
  const updated = page.waitForResponse(response => response.request().method() === 'PUT' &&
    new URL(response.url()).pathname === `/api/v1/admin/accounts/${session.bootstrapAccountId}`)
  await page.locator('button[form="edit-account-form"]').click()
  const response = await updated
  expect(response.status(), await response.text()).toBe(200)
  await expect(form).toBeHidden()
  const account = await responseData<{ group_links: Array<{ group_id: string }>; schedulable: boolean; extra: Record<string, unknown>; credentials: Record<string, unknown> }>(
    await request.get(`/api/v1/admin/accounts/${session.bootstrapAccountId}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
  expect(account.group_links).toEqual([expect.objectContaining({ group_id: replacement.id })])
  expect(account.schedulable).toBe(true)
  expect(account.credentials.model_mapping).toMatchObject({ 'gpt-browser-e2e-upstream': 'gpt-browser-e2e-upstream' })
  expect(account.extra.upstream_model_metadata).toMatchObject({ models: {
    'gpt-browser-e2e-upstream': { reasoning: false, context_window: 128000 },
  } })
  const directory = await responseData<Array<{ id: string }>>(await request.get(
    `/api/v1/admin/accounts/${session.bootstrapAccountId}/models`, { headers: { authorization: `Bearer ${session.accessToken}` } }))
  expect(directory.map(model => model.id)).toContain('gpt-browser-e2e-upstream')
  await row.locator('input[type="checkbox"]').check()
  await page.getByRole('button', { name: /^(Bulk Edit|批量编辑)$/ }).click()
  const bulkForm = page.locator('#bulk-edit-account-form')
  await expect(bulkForm).toBeVisible()
  await bulkForm.locator('#bulk-edit-concurrency-enabled').check()
  await bulkForm.locator('#bulk-edit-concurrency').fill('7')
  await bulkForm.locator('#bulk-edit-priority-enabled').check()
  await bulkForm.locator('#bulk-edit-priority').fill('81')
  const bulkResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/v1/admin/accounts/bulk-update')
  await page.locator('button[form="bulk-edit-account-form"]').click()
  const bulkResult = await bulkResponse
  expect(bulkResult.status(), await bulkResult.text()).toBe(200)
  expect((await bulkResult.json()).data).toMatchObject({ success: 1, failed: 0 })
  await expect(bulkForm).toBeHidden()
  const edited = await responseData<Record<string, unknown>>(await request.get(
    `/api/v1/admin/accounts/${session.bootstrapAccountId}`, { headers: { authorization: `Bearer ${session.accessToken}` } }))
  expect(edited).toMatchObject({ max_concurrency: 7, priority: 81, schedulable: true, group_links: [{ group_id: replacement.id, priority: 81 }] })
  await page.getByRole('button', { name: /^(Create Account|创建账号)$/ }).click()
  const createForm = page.locator('#create-account-form')
  await expect(createForm).toBeVisible()
  await createForm.locator('[data-tour="account-form-name"]').fill('Browser Created Account')
  await createForm.locator('[data-tour="account-form-platform"]').getByRole('button', { name: 'OpenAI', exact: true }).click()
  await createForm.locator('[data-tour="account-form-type"]').getByRole('button', { name: /API Key/ }).click()
  await createForm.getByPlaceholder('https://api.openai.com', { exact: true }).fill('https://upstream.browser-e2e.invalid/v1')
  await createForm.locator('input[type="password"]').fill('browser-create-api-key')
  await createForm.locator(`input[value="${session.bootstrapGroupId}"]`).check()
  const previewResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/v1/admin/accounts/models/sync-upstream-preview')
  await createForm.getByRole('button', { name: /Sync upstream supported models|同步上游支持的模型/i }).click()
  expect((await previewResponse).status()).toBe(200)
  expect(await createForm.evaluate(element => (element as HTMLFormElement).checkValidity())).toBe(true)
  const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/v1/admin/accounts')
  await page.locator('button[form="create-account-form"]').click()
  const createdResult = await createdResponse
  expect(createdResult.status(), await createdResult.text()).toBe(201)
  const createdAccount = (await createdResult.json()).data
  expect(createdAccount).toMatchObject({ name: 'Browser Created Account', platform: 'openai',
    group_links: [{ group_id: session.bootstrapGroupId }], credentials: { model_mapping: { 'gpt-browser-e2e-upstream': 'gpt-browser-e2e-upstream' } } })
  expect(JSON.stringify(createdAccount)).not.toContain('browser-create-api-key')
  await expect(createForm).toBeHidden()
  await expect(page.locator('tr').filter({ hasText: 'Browser Created Account' })).toHaveCount(1)
  // The original create form supplies no Worker-only model_capabilities rows.
  expect(createdAccount.model_capabilities).toEqual([])
  await expect.poll(async () => {
    const observed = await responseData<{ extra?: { openai_responses_supported?: boolean } }>(await request.get(`/api/v1/admin/accounts/${createdAccount.id}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    return observed.extra?.openai_responses_supported
  }, { timeout: 20000 }).toBe(true)
  const initialAccountEdit = await responseData<{ config_version: number }>(await request.put(`/api/v1/admin/accounts/${createdAccount.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': '"0"' },
    data: { credentials: { model_mapping: { 'admin-route-patrol-model': 'gpt-browser-e2e-upstream' },
      header_override_enabled: true, header_overrides: { 'x-browser-account-route': 'saved-route' } } },
  }))
  await expect.poll(async () => {
    const observed = await responseData<{ config_version: number; control_version: number }>(await request.get(`/api/v1/admin/accounts/${createdAccount.id}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    expect(observed.control_version).toBe(1)
    return observed.config_version
  }, { timeout: 20000 }).toBeGreaterThan(initialAccountEdit.config_version)
  const gatewayKey = await responseData<{ api_key: string }>(await request.post(`/api/v1/admin/users/${session.user.id}/api-keys`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-created-account-gateway-key' },
    data: { name: 'Created account gateway proof', group_id: session.bootstrapGroupId },
  }))
  const gatewayHeaders = { authorization: `Bearer ${gatewayKey.api_key}` }
  const catalogResponse = await request.get('/v1/models', { headers: gatewayHeaders })
  expect(catalogResponse.status(), await catalogResponse.text()).toBe(200)
  expect((await catalogResponse.json()).data.map((model: { id: string }) => model.id)).toContain('admin-route-patrol-model')
  const forwarded = await request.post('/v1/chat/completions', { headers: gatewayHeaders,
    data: { model: 'admin-route-patrol-model', stream: false, messages: [{ role: 'user', content: 'Say browser-gateway-ok.' }] },
  })
  expect(forwarded.status(), await forwarded.text()).toBe(200)
  expect(await forwarded.json()).toMatchObject({ model: 'admin-route-patrol-model', choices: [{ message: { content: 'browser-gateway-ok' } }] })
  for (const required of [true, false]) {
    const privacyGroup = await responseData<{ control_version: number }>(await request.get(`/api/v1/admin/groups/${session.bootstrapGroupId}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    await responseData(await request.put(`/api/v1/admin/groups/${session.bootstrapGroupId}`, {
      headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${privacyGroup.control_version}"`, 'idempotency-key': `browser-group-privacy-${required}` },
      data: { require_privacy_set: required },
    }))
    const privacyForward = await request.post('/v1/chat/completions', { headers: gatewayHeaders,
      data: { model: 'admin-route-patrol-model', stream: false, messages: [{ role: 'user', content: 'Say browser-gateway-ok.' }] },
    })
    expect(privacyForward.status(), await privacyForward.text()).toBe(required ? 503 : 200)
  }
  const expiryUpdate = await responseData<{ control_version: number }>(await request.put(`/api/v1/admin/accounts/${createdAccount.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': '"1"' },
    data: { expires_at: 1, auto_pause_on_expired: true },
  }))
  const expiredCall = await request.post('/v1/chat/completions', {
    headers: gatewayHeaders,
    data: { model: 'admin-route-patrol-model', stream: false, messages: [{ role: 'user', content: 'Say browser-gateway-ok.' }] },
  })
  expect(expiredCall.status(), await expiredCall.text()).toBe(503)
  await responseData(await request.put(`/api/v1/admin/accounts/${createdAccount.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${expiryUpdate.control_version}"` },
    data: { expires_at: 0 },
  }))
  const restoredCall = await request.post('/v1/chat/completions', {
    headers: gatewayHeaders,
    data: { model: 'admin-route-patrol-model', stream: false, messages: [{ role: 'user', content: 'Say browser-gateway-ok.' }] },
  })
  expect(restoredCall.status(), await restoredCall.text()).toBe(200)
  const enabledProbe = await request.put(`/api/v1/admin/accounts/${createdAccount.id}/upstream-billing-probe`, {
    headers: { authorization: `Bearer ${session.accessToken}` }, data: { enabled: true },
  })
  expect(enabledProbe.status(), await enabledProbe.text()).toBe(200)

  await page.reload()
  const billingResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === `/api/v1/admin/accounts/${createdAccount.id}/upstream-billing-probe`)
  const billingRow = page.locator('tr').filter({ hasText: 'Browser Created Account' })
  await billingRow.locator('[data-testid="upstream-billing-probe"]').click()
  const billingResult = await billingResponse
  expect(billingResult.status(), await billingResult.text()).toBe(200)
  expect((await billingResult.json()).data).toMatchObject({ account_id: createdAccount.id, snapshot: { status: 'ok' } })
  await expect(billingRow).toContainText('1.25x')

  await billingRow.locator('td').last().getByRole('button').last().click()
  await page.getByRole('button', { name: /^(Test Connection|测试连接)$/ }).click()
  const diagnosticDialog = page.getByRole('dialog').filter({ hasText: /Test Account Connection|测试账号连接/ })
  await diagnosticDialog.getByRole('button', { name: /^(Start Test|开始测试)$/ }).click()
  await expect(diagnosticDialog).toContainText('browser-diagnostic-ok')
  await expect(diagnosticDialog.getByRole('button', { name: /^(Retry|重试)$/ })).toBeEnabled()
  await diagnosticDialog.getByRole('button', { name: /^(Close|关闭)$/ }).click()

  const currentDiagnosticAccount = await responseData<{ control_version: number }>(await request.get(`/api/v1/admin/accounts/${createdAccount.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))
  await responseData(await request.put(`/api/v1/admin/accounts/${createdAccount.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${currentDiagnosticAccount.control_version}"` },
    data: { extra: { openai_responses_mode: 'force_chat_completions' } },
  }))
  await page.reload()
  await billingRow.locator('td').last().getByRole('button').last().click()
  await page.getByRole('button', { name: /^(Test Connection|测试连接)$/ }).click()
  await diagnosticDialog.getByRole('button', { name: /^(Start Test|开始测试)$/ }).click()
  await expect(diagnosticDialog).toContainText('browser-chat-diagnostic-ok')
  await expect(diagnosticDialog.getByRole('button', { name: /^(Retry|重试)$/ })).toBeEnabled()
  await diagnosticDialog.getByRole('button', { name: /^(Close|关闭)$/ }).click()

  const oauthGatewayGroup = await responseData<{ id: string }>(await request.post('/api/v1/admin/groups', {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-oauth-gateway-group' },
    data: { name: 'Browser OAuth Gateway', platform: 'openai' },
  }))
  const bootstrapModels = await responseData<Array<{ model_id: string; public_name: string }>>(await request.get(`/api/v1/admin/groups/${session.bootstrapGroupId}/models`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))
  const oauthModelId = bootstrapModels.find(model => model.public_name === 'admin-route-patrol-model')!.model_id
  const oauthModelLink = await responseData<{ control_version: number }>(await request.put(`/api/v1/admin/groups/${oauthGatewayGroup.id}/models/${oauthModelId}`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-oauth-model-link', 'if-match': '"0"' },
    data: { enabled: true },
  }))
  await responseData(await request.post(`/api/v1/admin/groups/${oauthGatewayGroup.id}/models/${oauthModelId}/prices`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-oauth-model-price', 'if-match': `"${oauthModelLink.control_version}"` },
    data: { input_micros_per_million: 1_000_000, output_micros_per_million: 2_000_000 },
  }))
  const createdOAuth = await responseData<{ id: string }>(await request.post('/api/v1/admin/accounts', {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-oauth-diagnostic-create' },
    data: { name: 'Browser OAuth Diagnostic', platform: 'openai', type: 'oauth', credential_kind: 'oauth',
      base_url: 'https://api.openai.com', api_key: 'browser-oauth-legacy-token', group_ids: [oauthGatewayGroup.id],
      credentials: { access_token: 'browser-oauth-access-token', chatgpt_account_id: 'browser-oauth-upstream-account',
        model_mapping: { 'admin-route-patrol-model': 'gpt-5.3-high' } },
    },
  }))
  await page.reload()
  const oauthRow = page.locator('tr').filter({ hasText: 'Browser OAuth Diagnostic' })
  await oauthRow.locator('td').last().getByRole('button').last().click()
  await page.getByRole('button', { name: /^(Test Connection|测试连接)$/ }).click()
  await diagnosticDialog.getByRole('button', { name: /^(Start Test|开始测试)$/ }).click()
  await expect(diagnosticDialog).toContainText('browser-oauth-diagnostic-ok')
  await expect(diagnosticDialog.getByRole('button', { name: /^(Retry|重试)$/ })).toBeEnabled()
  await diagnosticDialog.getByRole('button', { name: /^(Close|关闭)$/ }).click()

  const oauthGatewayKey = await responseData<{ api_key: string }>(await request.post(`/api/v1/admin/users/${session.user.id}/api-keys`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-oauth-gateway-key' },
    data: { name: 'OAuth forwarding proof', group_id: oauthGatewayGroup.id },
  }))
  for (const endpoint of ['responses', 'chat/completions']) {
    for (const stream of [false, true]) {
      const forwardedOAuth = await request.post(`/v1/${endpoint}`, {
        headers: { authorization: `Bearer ${oauthGatewayKey.api_key}` },
        data: { model: 'admin-route-patrol-model', stream, ...(endpoint === 'responses'
          ? { input: 'Hello OAuth gateway' } : { messages: [{ role: 'user', content: 'Hello OAuth gateway' }] }) },
      })
      const output = await forwardedOAuth.text()
      expect(forwardedOAuth.status(), output).toBe(200)
      expect(output).toContain('browser-oauth-diagnostic-ok')
      expect(output).toContain('admin-route-patrol-model')
      if (!stream) expect(JSON.parse(output).object).toBe(endpoint === 'responses' ? 'response' : 'chat.completion')
    }
  }

  const claudeGroup = await responseData<{ id: string }>(await request.post('/api/v1/admin/groups', {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-claude-create-group' },
    data: { name: 'Browser Claude Group', platform: 'anthropic' },
  }))
  await page.reload()
  await page.getByRole('button', { name: /^(Create Account|创建账号)$/ }).click()
  await createForm.locator('[data-tour="account-form-name"]').fill('Browser Created Claude')
  await createForm.locator('[data-tour="account-form-platform"]').getByRole('button', { name: 'Anthropic', exact: true }).click()
  await createForm.locator('[data-tour="account-form-type"]').getByRole('button', { name: /Claude Console/ }).click()
  await createForm.locator('input[type="password"]').fill('browser-claude-api-key')
  await createForm.locator(`input[value="${claudeGroup.id}"]`).check()
  const mixedCheck = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/accounts/check-mixed-channel')
  const claudeCreated = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/admin/accounts')
  await page.locator('button[form="create-account-form"]').click()
  const check = await mixedCheck
  expect(check.status(), await check.text()).toBe(200)
  expect((await check.json()).data.has_risk).toBe(false)
  const claudeResult = await claudeCreated
  expect(claudeResult.status(), await claudeResult.text()).toBe(201)
  const createdClaude = (await claudeResult.json()).data
  expect(createdClaude).toMatchObject({ platform: 'anthropic', group_links: [{ group_id: claudeGroup.id }] })
  await expect(createForm).toBeHidden()
  await responseData(await request.put(`/api/v1/admin/accounts/${createdClaude.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${createdClaude.control_version}"` },
    data: { credentials: { model_mapping: { 'claude-public-diagnostic': 'claude-sonnet-4-6' } },
      extra: { anthropic_apikey_auth_scheme: 'authorization_bearer' } },
  }))
  await page.reload()
  const claudeRow = page.locator('tr').filter({ hasText: 'Browser Created Claude' })
  await claudeRow.locator('td').last().getByRole('button').last().click()
  await page.getByRole('button', { name: /^(Test Connection|测试连接)$/ }).click()
  await diagnosticDialog.getByRole('button', { name: /^(Start Test|开始测试)$/ }).click()
  await expect(diagnosticDialog).toContainText('browser-claude-diagnostic-ok')
  await expect(diagnosticDialog.getByRole('button', { name: /^(Retry|重试)$/ })).toBeEnabled()
  await diagnosticDialog.getByRole('button', { name: /^(Close|关闭)$/ }).click()

  const geminiGroup = await responseData<{ id: string }>(await request.post('/api/v1/admin/groups', {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-gemini-create-group' },
    data: { name: 'Browser Gemini Group', platform: 'gemini' },
  }))
  await page.reload()
  await page.getByRole('button', { name: /^(Create Account|创建账号)$/ }).click()
  await createForm.locator('[data-tour="account-form-name"]').fill('Browser Created Gemini')
  await createForm.locator('[data-tour="account-form-platform"]').getByRole('button', { name: 'Gemini', exact: true }).click()
  await createForm.getByRole('button', { name: /API Key \(AI Studio\)/ }).click()
  await createForm.locator('input[type="password"]').fill('browser-gemini-api-key')
  await createForm.locator(`input[value="${geminiGroup.id}"]`).check()
  const geminiCreated = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/admin/accounts')
  await page.locator('button[form="create-account-form"]').click()
  const geminiResult = await geminiCreated
  expect(geminiResult.status(), await geminiResult.text()).toBe(201)
  const createdGemini = (await geminiResult.json()).data
  await expect(createForm).toBeHidden()
  let geminiVersion = createdGemini.control_version
  for (const model of ['gemini-2.5-flash', 'gemini-3.1-flash-image-preview']) {
    const updated = await responseData<{ control_version: number }>(await request.put(`/api/v1/admin/accounts/${createdGemini.id}`, {
      headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${geminiVersion}"` },
      data: { credentials: { model_mapping: { [model]: model } } },
    }))
    geminiVersion = updated.control_version
    await page.reload()
    const geminiRow = page.locator('tr').filter({ hasText: 'Browser Created Gemini' })
    await geminiRow.locator('td').last().getByRole('button').last().click()
    await page.getByRole('button', { name: /^(Test Connection|测试连接)$/ }).click()
    await diagnosticDialog.getByRole('button', { name: /^(Start Test|开始测试)$/ }).click()
    await expect(diagnosticDialog).toContainText('browser-gemini-diagnostic-ok')
    if (model.includes('image')) {
      const preview = diagnosticDialog.locator('img[src^="data:image/png;base64,"]').first()
      await expect(preview).toBeVisible()
      await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)
    }
    await expect(diagnosticDialog.getByRole('button', { name: /^(Retry|重试)$/ })).toBeEnabled()
    await diagnosticDialog.getByRole('button', { name: /^(Close|关闭)$/ }).click()
  }
  for (const [accountId, name] of [[createdAccount.id, 'Browser Created Account'], [createdOAuth.id, 'Browser OAuth Diagnostic']]) {
    const current = await responseData<{ control_version: number }>(await request.get(`/api/v1/admin/accounts/${accountId}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    await responseData(await request.put(`/api/v1/admin/accounts/${accountId}`, {
      headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${current.control_version}"` },
      data: { credentials: { model_mapping: { 'gpt-image-2': 'gpt-image-2' } } },
    }))
    await page.reload()
    const imageRow = page.locator('tr').filter({ hasText: name })
    await imageRow.locator('td').last().getByRole('button').last().click()
    await page.getByRole('button', { name: /^(Test Connection|测试连接)$/ }).click()
    await diagnosticDialog.getByRole('button', { name: /^(Start Test|开始测试)$/ }).click()
    await expect(diagnosticDialog).toContainText('browser-openai-image-ok')
    const preview = diagnosticDialog.locator('img[src^="data:image/png;base64,"]').first()
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)
    await expect(diagnosticDialog.getByRole('button', { name: /^(Retry|重试)$/ })).toBeEnabled()
    await diagnosticDialog.getByRole('button', { name: /^(Close|关闭)$/ }).click()
    const compactCurrent = await responseData<{ control_version: number }>(await request.get(`/api/v1/admin/accounts/${accountId}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    await responseData(await request.put(`/api/v1/admin/accounts/${accountId}`, {
      headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${compactCurrent.control_version}"` },
      data: { credentials: { model_mapping: { 'gpt-5.3-high': 'gpt-5.3-high' } } },
    }))
    await page.reload()
    await imageRow.locator('td').last().getByRole('button').last().click()
    await page.getByRole('button', { name: /^(Test Connection|测试连接)$/ }).click()
    await diagnosticDialog.locator('button.select-trigger').filter({ hasText: /Default request|常规请求/ }).click()
    await page.getByRole('option', { name: /Compact probe|Compact 探测/ }).click()
    await diagnosticDialog.getByRole('button', { name: /^(Start Test|开始测试)$/ }).click()
    await expect(diagnosticDialog).toContainText('Compact probe succeeded (native remote compaction v2)')
    await expect(diagnosticDialog.getByRole('button', { name: /^(Retry|重试)$/ })).toBeEnabled()
    const probed = await responseData<{ extra: Record<string, unknown> }>(await request.get(`/api/v1/admin/accounts/${accountId}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    expect(probed.extra).toMatchObject({ openai_compact_supported: true, openai_compact_last_status: 200, openai_compact_last_error: '' })
    await diagnosticDialog.getByRole('button', { name: /^(Close|关闭)$/ }).click()

    const authCurrent = await responseData<{ control_version: number }>(await request.get(`/api/v1/admin/accounts/${accountId}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    await responseData(await request.put(`/api/v1/admin/accounts/${accountId}`, {
      headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${authCurrent.control_version}"` },
      data: { credentials: { model_mapping: { 'gpt-auth-failure': 'gpt-auth-failure' } } },
    }))
    await page.reload()
    await imageRow.locator('td').last().getByRole('button').last().click()
    await page.getByRole('button', { name: /^(Test Connection|测试连接)$/ }).click()
    await diagnosticDialog.locator('button.select-trigger').filter({ hasText: /Default request|常规请求/ }).click()
    await page.getByRole('option', { name: /Compact probe|Compact 探测/ }).click()
    await diagnosticDialog.getByRole('button', { name: /^(Start Test|开始测试)$/ }).click()
    await expect(diagnosticDialog).toContainText('Compact probe returned HTTP 401')
    await expect(diagnosticDialog.getByRole('button', { name: /^(Retry|重试)$/ })).toBeEnabled()
    await diagnosticDialog.getByRole('button', { name: /^(Close|关闭)$/ }).click()
    await page.reload()
    await imageRow.locator('[class~="group/error"] svg').hover()
    await expect(imageRow.getByText('Authentication failed (401)', { exact: true })).toBeVisible()
    await imageRow.locator('td').last().getByRole('button').last().click()
    const recoveredStateResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/admin/accounts/${accountId}/recover-state`)
    await page.getByRole('button', { name: /^(Recover State|恢复状态)$/ }).click()
    const recoveredState = await recoveredStateResponse
    expect(recoveredState.status(), await recoveredState.text()).toBe(200)
    expect((await recoveredState.json()).data).toMatchObject({ status: 'active', error_message: '' })
    await expect(imageRow.locator('[class~="group/error"]')).toHaveCount(0)


    const limitedCurrent = await responseData<{ control_version: number }>(await request.get(`/api/v1/admin/accounts/${accountId}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    await responseData(await request.put(`/api/v1/admin/accounts/${accountId}`, {
      headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${limitedCurrent.control_version}"` },
      data: { credentials: { model_mapping: { 'gpt-rate-limit': 'gpt-rate-limit' } } },
    }))
    await page.reload()
    await imageRow.locator('td').last().getByRole('button').last().click()
    await page.getByRole('button', { name: /^(Test Connection|测试连接)$/ }).click()
    await diagnosticDialog.locator('button.select-trigger').filter({ hasText: /Default request|常规请求/ }).click()
    await page.getByRole('option', { name: /Compact probe|Compact 探测/ }).click()
    await diagnosticDialog.getByRole('button', { name: /^(Start Test|开始测试)$/ }).click()
    await expect(diagnosticDialog).toContainText('Compact probe returned HTTP 429')
    await expect(diagnosticDialog.getByRole('button', { name: /^(Retry|重试)$/ })).toBeEnabled()
    await diagnosticDialog.getByRole('button', { name: /^(Close|关闭)$/ }).click()
    await page.reload()
    await expect(imageRow.getByText('429', { exact: true })).toBeVisible()
    const limited = await responseData<{ items: Array<{ id: string }> }>(await request.get('/api/v1/admin/accounts?status=rate_limited', {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    expect(limited.items.map(item => item.id)).toContain(accountId)
    await responseData(await request.post(`/api/v1/admin/accounts/${accountId}/clear-rate-limit`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    await page.reload()
    await expect(imageRow.getByText('429', { exact: true })).toHaveCount(0)

  }

  const gatewayRateCurrent = await responseData<{ control_version: number }>(await request.get(`/api/v1/admin/accounts/${createdOAuth.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))
  await responseData(await request.put(`/api/v1/admin/accounts/${createdOAuth.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${gatewayRateCurrent.control_version}"` },
    data: { credentials: { model_mapping: { 'admin-route-patrol-model': 'gpt-5.3-high' } } },
  }))
  const limitedGateway = await request.post('/v1/responses', {
    headers: { authorization: `Bearer ${oauthGatewayKey.api_key}` },
    data: { model: 'admin-route-patrol-model', input: 'browser-gateway-rate-limit', stream: false },
  })
  expect(limitedGateway.status(), await limitedGateway.text()).toBe(429)
  const gatewayRateAccount = await responseData<{ rate_limit_reset_at: string }>(await request.get(`/api/v1/admin/accounts/${createdOAuth.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))
  expect(Date.parse(gatewayRateAccount.rate_limit_reset_at)).toBeGreaterThan(Date.now())
  const gatewayRetry = () => request.post('/v1/responses', {
    headers: { authorization: `Bearer ${oauthGatewayKey.api_key}` },
    data: { model: 'admin-route-patrol-model', input: 'Hello OAuth gateway', stream: false },
  })
  const blocked = await gatewayRetry()
  expect(blocked.status(), await blocked.text()).toBe(503)
  await responseData(await request.post(`/api/v1/admin/accounts/${createdOAuth.id}/clear-rate-limit`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))
  const recovered = await gatewayRetry()
  expect(recovered.status(), await recovered.text()).toBe(200)

  const quotaCurrent = await responseData<{ control_version: number }>(await request.get(`/api/v1/admin/accounts/${createdAccount.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))
  await responseData(await request.put(`/api/v1/admin/accounts/${createdAccount.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${quotaCurrent.control_version}"` },
    data: { credentials: { model_mapping: { 'admin-route-patrol-model': 'gpt-browser-e2e-upstream' } }, extra: { quota_limit: 100, quota_used: 25, quota_daily_limit: 50, quota_weekly_limit: 80, quota_daily_used: 5, quota_weekly_used: 10 } },
  }))
  await page.reload()
  const quotaRow = page.locator('tr').filter({ hasText: 'Browser Created Account' })
  await quotaRow.locator('td').last().getByRole('button').last().click()
  const quotaResetResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === `/api/v1/admin/accounts/${createdAccount.id}/reset-quota`)
  await page.getByRole('button', { name: /^(Reset Quota|重置配额)$/ }).click()
  const quotaReset = await quotaResetResponse
  expect(quotaReset.status(), await quotaReset.text()).toBe(200)
  expect((await quotaReset.json()).data).toMatchObject({ quota_limit: 100, quota_used: 0, quota_daily_used: 0, quota_weekly_used: 0 })
  const quotaForward = await request.post('/v1/chat/completions', { headers: gatewayHeaders,
    data: { model: 'admin-route-patrol-model', stream: false, messages: [{ role: 'user', content: 'Say browser-gateway-ok.' }] },
  })
  expect(quotaForward.status(), await quotaForward.text()).toBe(200)
  await expect.poll(async () => {
    const quota = await responseData<{ quota_used: number; quota_daily_used: number; quota_weekly_used: number }>(await request.get(`/api/v1/admin/accounts/${createdAccount.id}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    return quota.quota_used > 0 && quota.quota_daily_used === quota.quota_used && quota.quota_weekly_used === quota.quota_used
  }).toBe(true)

  // Exercise the production save endpoint, then require the next gateway call
  // to use the new token. The interactive OAuth exchange is a separate journey.
  const reauthorized = await responseData<{ credentials: Record<string, unknown>; extra: Record<string, unknown> }>(
    await request.post(`/api/v1/admin/accounts/${createdOAuth.id}/apply-oauth-credentials`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
      data: { type: 'oauth', credentials: { access_token: 'browser-oauth-reauthorized-token',
        chatgpt_account_id: 'browser-oauth-upstream-account', model_mapping: { 'admin-route-patrol-model': 'gpt-5.3-high' } },
        extra: { email: 'reauthorized@example.test' } },
    }))
  expect(reauthorized.extra.email).toBe('reauthorized@example.test')
  expect(JSON.stringify(reauthorized)).not.toContain('browser-oauth-reauthorized-token')
  const afterReauth = await request.post('/v1/responses', {
    headers: { authorization: `Bearer ${oauthGatewayKey.api_key}` },
    data: { model: 'admin-route-patrol-model', input: 'browser-after-reauth', stream: false },
  })
  const afterReauthBody = await afterReauth.text()
  expect(afterReauth.status(), afterReauthBody).toBe(200)
  expect(afterReauthBody).toContain('browser-oauth-diagnostic-ok')

  await page.reload()
  await oauthRow.locator('td').last().getByRole('button').last().click()
  await page.getByRole('button', { name: /^(Re-Authorize|重新授权)$/ }).click()
  const reauthDialog = page.getByRole('dialog')
  await reauthDialog.getByRole('button', { name: /^(Generate Auth URL|生成授权链接|生成授权 URL)$/ }).click()
  const authLink = reauthDialog.locator('input[readonly]')
  await expect(authLink).toHaveValue(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/)
  const authURL = new URL(await authLink.inputValue())
  await reauthDialog.locator('textarea').fill(`http://localhost:1455/auth/callback?code=browser-ui-oauth-code&state=${authURL.searchParams.get('state')}`)
  const uiSave = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === `/api/v1/admin/accounts/${createdOAuth.id}/apply-oauth-credentials`)
  await reauthDialog.getByRole('button', { name: /^(Complete Authorization|完成授权)$/ }).click()
  const uiSaved = await uiSave
  expect(uiSaved.status(), await uiSaved.text()).toBe(200)
  expect((await uiSaved.json()).data).toMatchObject({ type: 'oauth', credentials: { email: 'oauth-ui@example.test',
    chatgpt_account_id: 'browser-oauth-upstream-account', plan_type: 'pro' }, extra: { privacy_mode: 'training_off' } })
  expect(await uiSaved.text()).not.toContain('browser-oauth-ui-token')
  await expect(reauthDialog).toBeHidden()
  await oauthRow.locator('td').last().getByRole('button').last().click()
  await page.getByRole('button', { name: /^(Test Connection|测试连接)$/ }).click()
  await diagnosticDialog.getByRole('button', { name: /^(Start Test|开始测试)$/ }).click()
  await expect(diagnosticDialog).toContainText('browser-oauth-diagnostic-ok')
  await expect(diagnosticDialog.getByRole('button', { name: /^(Retry|重试)$/ })).toBeEnabled()
  await diagnosticDialog.getByRole('button', { name: /^(Close|关闭)$/ }).click()

  await page.getByRole('button', { name: /^(Create Account|创建账号)$/ }).click()
  await createForm.locator('[data-tour="account-form-name"]').fill('Browser OAuth Created From RT')
  await createForm.locator('[data-tour="account-form-platform"]').getByRole('button', { name: 'OpenAI', exact: true }).click()
  await createForm.locator('[data-tour="account-form-type"]').getByRole('button').first().click()
  await createForm.locator(`input[value="${oauthGatewayGroup.id}"]`).check()
  await page.locator('button[form="create-account-form"]').click()
  const oauthCreateDialog = page.getByRole('dialog')
  await oauthCreateDialog.locator('input[value="refresh_token"]').check()
  await oauthCreateDialog.locator('textarea').fill('browser-ui-create-refresh')
  const oauthCreateResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/v1/admin/accounts')
  await oauthCreateDialog.getByRole('button', { name: /^(Validate & Create Account|验证并创建账号)$/ }).click()
  const oauthCreateResult = await oauthCreateResponse
  expect(oauthCreateResult.status(), await oauthCreateResult.text()).toBe(201)
  expect((await oauthCreateResult.json()).data).toMatchObject({ type: 'oauth', name: 'Browser OAuth Created From RT',
    group_links: [{ group_id: oauthGatewayGroup.id }], credentials: { chatgpt_account_id: 'browser-oauth-upstream-account' } })
  const createPayload = oauthCreateResult.request().postDataJSON()
  expect(createPayload.api_key).toBeUndefined(); expect(createPayload.base_url).toBeUndefined()
  expect(createPayload.credentials.api_key).toBeUndefined()
  await expect(oauthCreateDialog).toBeHidden()
  await expect(page.locator('tr').filter({ hasText: 'Browser OAuth Created From RT' })).toHaveCount(1)

  const savedOAuthRow = page.locator('tr').filter({ hasText: 'Browser OAuth Created From RT' })
  const savedOAuthAccount = (await oauthCreateResult.json()).data
  expect(savedOAuthAccount.extra.privacy_mode).toBe('training_off')
  expect(savedOAuthAccount.control_version).toBe(0)
  const savedOAuthID = savedOAuthAccount.id
  await savedOAuthRow.locator('td').last().getByRole('button').last().click()
  const refreshResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === `/api/v1/admin/accounts/${savedOAuthID}/refresh`)
  await page.getByRole('button', { name: /^(Refresh Token|刷新Token|刷新 Token|刷新令牌)$/ }).click()
  const refreshedAccount = await refreshResponse
  expect(refreshedAccount.status(), await refreshedAccount.text()).toBe(200)
  expect((await refreshedAccount.json()).data).toMatchObject({ credentials: { email: 'oauth-refreshed@example.test', plan_type: 'plus' }, extra: { privacy_mode: 'training_off' } })
  expect(await refreshedAccount.text()).not.toContain('browser-oauth-ui-refreshed-token')
  await savedOAuthRow.locator('td').last().getByRole('button').last().click()
  await page.getByRole('button', { name: /^(Test Connection|测试连接)$/ }).click()
  await diagnosticDialog.getByRole('button', { name: /^(Start Test|开始测试)$/ }).click()
  await expect(diagnosticDialog).toContainText('browser-oauth-diagnostic-ok')
  await diagnosticDialog.getByRole('button', { name: /^(Close|关闭)$/ }).click()

  await expect(diagnosticDialog).toBeHidden()
  await savedOAuthRow.scrollIntoViewIfNeeded()
  await savedOAuthRow.locator('td').last().getByRole('button').last().click()
  const privacyResponse = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === `/api/v1/admin/accounts/${savedOAuthID}/set-privacy`)
  await page.getByRole('button', { name: /^(Set Privacy|设置隐私)$/ }).click()
  const privacyResult = await privacyResponse
  expect(privacyResult.status(), await privacyResult.text()).toBe(200)
  expect((await privacyResult.json()).data.extra.privacy_mode).toBe('training_off')
  expect(await privacyResult.text()).not.toContain('browser-oauth-ui-refreshed-token')

  expect(await responseData(await request.get(`/api/v1/admin/accounts/${savedOAuthID}/temp-unschedulable`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))).toEqual({ active: false })
  expect(await responseData(await request.delete(`/api/v1/admin/accounts/${savedOAuthID}/temp-unschedulable`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))).toEqual({ message: 'Temp unschedulable cleared successfully' })
  const tempStateList = await request.get('/api/v1/admin/accounts?status=temp_unschedulable', {
    headers: { authorization: `Bearer ${session.accessToken}` },
  })
  expect(tempStateList.status(), await tempStateList.text()).toBe(200)

  const beforeRule = await responseData<{ control_version: number }>(await request.get(`/api/v1/admin/accounts/${createdAccount.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))
  await responseData(await request.put(`/api/v1/admin/accounts/${createdAccount.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${beforeRule.control_version}"` },
    data: { credentials: { temp_unschedulable_enabled: true,
      temp_unschedulable_rules: [{ error_code: 400, keywords: ['maintenance'], duration_minutes: 2, description: 'Browser model maintenance' }] } },
  }))
  const triggerRule = await request.post('/v1/chat/completions', { headers: gatewayHeaders,
    data: { model: 'admin-route-patrol-model', stream: false, messages: [{ role: 'user', content: 'browser-temp-rule' }] },
  })
  expect(triggerRule.status()).toBeGreaterThanOrEqual(400)
  const triggeredRuleAccount = await responseData<{ extra: { model_rate_limits: Record<string, { reason: string }> }; temp_unschedulable_until?: string | null }>(
    await request.get(`/api/v1/admin/accounts/${createdAccount.id}`, { headers: { authorization: `Bearer ${session.accessToken}` } }))
  expect(triggeredRuleAccount.temp_unschedulable_until ?? null).toBeNull()
  expect(JSON.parse(triggeredRuleAccount.extra.model_rate_limits['gpt-browser-e2e-upstream']!.reason)).toMatchObject({ status_code: 400, matched_keyword: 'maintenance' })
  const blockedModel = await request.post('/v1/chat/completions', { headers: gatewayHeaders,
    data: { model: 'admin-route-patrol-model', stream: false, messages: [{ role: 'user', content: 'Say browser-gateway-ok.' }] },
  })
  expect(blockedModel.status()).toBe(503)
  await responseData(await request.post(`/api/v1/admin/accounts/${createdAccount.id}/recover-state`, { headers: { authorization: `Bearer ${session.accessToken}` } }))
  const afterRecovery = await request.post('/v1/chat/completions', { headers: gatewayHeaders,
    data: { model: 'admin-route-patrol-model', stream: false, messages: [{ role: 'user', content: 'Say browser-gateway-ok.' }] },
  })
  expect(afterRecovery.status(), await afterRecovery.text()).toBe(200)

  for (const policy of ['pool', 'custom-skip', 'custom-match']) {
    for (let retry = 0; retry < 3; retry++) {
      const current = await responseData<{ control_version: number }>(await request.get(`/api/v1/admin/accounts/${createdAccount.id}`, {
        headers: { authorization: `Bearer ${session.accessToken}` },
      }))
      const configured = await request.put(`/api/v1/admin/accounts/${createdAccount.id}`, {
        headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${current.control_version}"` },
        data: { credentials: { pool_mode: policy === 'pool', custom_error_codes_enabled: policy !== 'pool', custom_error_codes: policy === 'custom-match' ? [429] : [503] } },
      })
      if (configured.status() === 412 && retry < 2) continue
      await responseData(configured)
      break
    }
    const rejected = await request.post('/v1/chat/completions', { headers: gatewayHeaders,
      data: { model: 'admin-route-patrol-model', stream: false, messages: [{ role: 'user', content: 'browser-policy-429' }] },
    })
    expect(rejected.status()).toBeGreaterThanOrEqual(400)
    const observed = await responseData<{ rate_limit_reset_at?: string | null; extra: Record<string, unknown> }>(await request.get(`/api/v1/admin/accounts/${createdAccount.id}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    if (policy === 'custom-match') expect(Date.parse(observed.rate_limit_reset_at!)).toBeGreaterThan(Date.now())
    else expect(observed.rate_limit_reset_at ?? null).toBeNull()
    await responseData(await request.post(`/api/v1/admin/accounts/${createdAccount.id}/recover-state`, { headers: { authorization: `Bearer ${session.accessToken}` } }))
  }

  const exclusiveGroups: string[] = []
  for (const name of ['Browser Exclusive Old', 'Browser Exclusive New']) {
    const group = await responseData<{ id: string }>(await request.post('/api/v1/admin/groups', {
      headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': name },
      data: { name, platform: 'openai', is_exclusive: true, group_type: 'standard' },
    }))
    exclusiveGroups.push(group.id)
  }
  const replacementKey = await responseData<{ id: string }>(await request.post(`/api/v1/admin/users/${session.user.id}/api-keys`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-user-group-migration-key' },
    data: { name: 'User Group Migration Key', group_id: exclusiveGroups[0] },
  }))
  expect(await responseData(await request.post(`/api/v1/admin/users/${session.user.id}/replace-group`, {
    headers: { authorization: `Bearer ${session.accessToken}` }, data: { old_group_id: exclusiveGroups[0], new_group_id: exclusiveGroups[1] },
  }))).toMatchObject({ migrated_keys: 1 })
  const migratedUserKeys = await responseData<{ items: Array<{ id: string; group_id: string }> }>(await request.get(`/api/v1/admin/users/${session.user.id}/api-keys`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))
  expect(migratedUserKeys.items.find(key => key.id === replacementKey.id)).toMatchObject({ group_id: exclusiveGroups[1] })
  const importRequest = {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-codex-session-import' },
    data: { name: 'Browser Codex Import', content: JSON.stringify({ access_token: 'browser-import-access', refresh_token: 'browser-import-refresh', email: 'browser-import@test.local' }), group_ids: [session.bootstrapGroupId] },
  }
  const imported = await responseData<{ created: number; items: Array<{ account_id: string }> }>(await request.post('/api/v1/admin/accounts/import/codex-session', importRequest))
  expect(imported).toMatchObject({ created: 1, failed: 0, updated: 0 })
  expect(await responseData(await request.post('/api/v1/admin/accounts/import/codex-session', importRequest))).toEqual(imported)
  const importedAccount = await responseData(await request.get(`/api/v1/admin/accounts/${imported.items[0]!.account_id}`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))
  expect(importedAccount).toMatchObject({ name: 'Browser Codex Import', type: 'oauth', platform: 'openai' })
  const agentImport = await responseData<{ items: Array<{ account_id: string }> }>(await request.post('/api/v1/admin/accounts/import/codex-session', {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-agent-identity-import' },
    data: { name: 'Browser Agent Identity', content: JSON.stringify({ auth_mode: 'agentIdentity', agent_runtime_id: 'browser-agent-runtime',
      agent_private_key: 'MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f', account_id: 'browser-agent-workspace', chatgpt_user_id: 'browser-agent-user', task_id: 'browser-agent-task' }) },
  }))
  expect(agentImport).toMatchObject({ created: 1, failed: 0 })
  const agentAccount = await responseData(await request.get(`/api/v1/admin/accounts/${agentImport.items[0]!.account_id}`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))
  expect(agentAccount).toMatchObject({ credentials: { auth_mode: 'agentIdentity', task_id: 'browser-agent-task' }, credentials_status: { has_api_key: false, has_agent_private_key: true } })
  expect(JSON.stringify(agentAccount)).not.toContain('MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f')
  const scheduledPlan = await responseData<{ id: number }>(await request.post('/api/v1/admin/scheduled-test-plans', {
    headers: { authorization: `Bearer ${session.accessToken}` },
    data: { account_id: createdAccount.id, model_id: 'admin-route-patrol-model', cron_expression: '*/30 * * * *', enabled: false, max_results: 3, auto_recover: true },
  }))
  const scheduledPlans = await responseData<Array<{ id: number; account_id: string }>>(await request.get(`/api/v1/admin/accounts/${createdAccount.id}/scheduled-test-plans`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))
  expect(scheduledPlans).toEqual(expect.arrayContaining([expect.objectContaining({ id: scheduledPlan.id, account_id: createdAccount.id, enabled: false, max_results: 3, auto_recover: true })]))
  const changedPlan = await responseData(await request.put(`/api/v1/admin/scheduled-test-plans/${scheduledPlan.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}` }, data: { cron_expression: 'TZ=Asia/Shanghai 0 9 * * *', auto_recover: false },
  }))
  expect(changedPlan).toMatchObject({ cron_expression: 'TZ=Asia/Shanghai 0 9 * * *', auto_recover: false })
  expect(await responseData(await request.get(`/api/v1/admin/scheduled-test-plans/${scheduledPlan.id}/results`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))).toEqual([])
  expect(await responseData(await request.delete(`/api/v1/admin/scheduled-test-plans/${scheduledPlan.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  }))).toMatchObject({ message: 'deleted' })
  const supplierUsage = await responseData(await request.get(`/api/v1/admin/accounts/${savedOAuthID}/usage?force=true`, {
    headers: { authorization: `Bearer ${session.accessToken}` } }))
  expect(supplierUsage).toMatchObject({ five_hour: { utilization: 25, window_stats: { requests: expect.any(Number) } }, seven_day: { utilization: 50 } })
  const batchSupplierUsage = await responseData(await request.post('/api/v1/admin/accounts/usage/batch', {
    headers: { authorization: `Bearer ${session.accessToken}` }, data: { account_ids: [savedOAuthID, 'missing-usage-account', savedOAuthID] } }))
  expect(batchSupplierUsage).toMatchObject({ usage: { [savedOAuthID]: { five_hour: { utilization: 25 } } }, errors: { 'missing-usage-account': 'Account not found' } })
  const claudeUsageAccount = await responseData<{ id: string }>(await request.post('/api/v1/admin/accounts', {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-claude-active-usage' },
    data: { name: 'Browser Claude OAuth Usage', platform: 'anthropic', type: 'oauth',
      credentials: { access_token: 'browser-claude-old-token', refresh_token: 'browser-claude-refresh-token' } } }))
  const claudeRefresh = await responseData(await request.post(`/api/v1/admin/accounts/${claudeUsageAccount.id}/refresh`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-claude-refresh', 'if-match': '"0"' }, data: {},
  }))
  expect(claudeRefresh).toMatchObject({ control_version: 1, credential_key_version: 2, credentials: { scope: 'user:inference' } })
  for (const source of ['active', 'passive']) {
    const usage = await responseData(await request.get(`/api/v1/admin/accounts/${claudeUsageAccount.id}/usage?source=${source}`, {
      headers: { authorization: `Bearer ${session.accessToken}` } }))
    expect(usage).toMatchObject({ five_hour: { utilization: 35 }, seven_day: { utilization: 65 } })
  }
  const batchFields = await responseData<{ success: number; failed: number; success_ids: string[]; results: Array<{ account_id: string; success: boolean }> }>(
    await request.post('/api/v1/admin/accounts/batch-update-credentials', {
      headers: { authorization: `Bearer ${session.accessToken}` },
      data: { account_ids: [createdAccount.id, savedOAuthID], field: 'org_uuid', value: 'browser-batch-org' },
    }))
  expect(batchFields).toMatchObject({ success: 2, failed: 0, success_ids: [createdAccount.id, savedOAuthID] })
  for (const id of batchFields.success_ids) {
    const updated = await responseData<{ credentials: { org_uuid: string } }>(await request.get(`/api/v1/admin/accounts/${id}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }))
    expect(updated.credentials.org_uuid).toBe('browser-batch-org')
  }
  const afterBatchField = await request.post('/v1/chat/completions', { headers: gatewayHeaders,
    data: { model: 'admin-route-patrol-model', stream: false, messages: [{ role: 'user', content: 'Say browser-gateway-ok.' }] },
  })
  expect(afterBatchField.status(), await afterBatchField.text()).toBe(200)

  const batchInput = { accounts: [{ name: 'Browser Batch Created', platform: 'openai', type: 'apikey',
    credentials: { api_key: 'browser-create-api-key', base_url: 'https://upstream.browser-e2e.invalid/v1' } },
    { name: 'Browser Batch Rejected', platform: 'openai', type: 'apikey', credentials: {} },
    { name: 'Browser Batch OAuth Privacy', platform: 'openai', type: 'oauth', credentials: { access_token: 'browser-oauth-ui-refreshed-token' } }] }
  const batchRequest = () => request.post('/api/v1/admin/accounts/batch', { headers: {
    authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-original-batch-create' }, data: batchInput })
  const batchCreated = await responseData<{ success: number; failed: number; results: Array<{ name: string; id?: string; success: boolean }> }>(await batchRequest())
  expect(batchCreated).toMatchObject({ success: 2, failed: 1, results: [
    { name: 'Browser Batch Created', id: expect.any(String), success: true }, { name: 'Browser Batch Rejected', success: false },
    { name: 'Browser Batch OAuth Privacy', id: expect.any(String), success: true }] })
  expect(await responseData(await batchRequest())).toEqual(batchCreated)
  await expect.poll(async () => {
    const account = await responseData<{ extra?: { privacy_mode?: string } }>(await request.get(`/api/v1/admin/accounts/${batchCreated.results[2]!.id}`, { headers: { authorization: `Bearer ${session.accessToken}` } }))
    return account.extra?.privacy_mode
  }, { timeout: 20000 }).toBe('training_off')
  await expect.poll(async () => {
    const account = await responseData<{ extra?: { openai_responses_supported?: boolean } }>(await request.get(`/api/v1/admin/accounts/${batchCreated.results[0]!.id}`, { headers: { authorization: `Bearer ${session.accessToken}` } }))
    return account.extra?.openai_responses_supported
  }, { timeout: 20000 }).toBe(true)
  const beforeProtocol = await responseData<{ control_version: number; extra: Record<string, unknown> }>(
    await request.get(`/api/v1/admin/accounts/${createdAccount.id}`, { headers: { authorization: `Bearer ${session.accessToken}` } }))
  await responseData(await request.put(`/api/v1/admin/accounts/${createdAccount.id}`, {
    headers: { authorization: `Bearer ${session.accessToken}`, 'if-match': `"${beforeProtocol.control_version}"` },
    data: { extra: { ...beforeProtocol.extra, openai_responses_mode: 'force_chat_completions' } } }))
  const convertedResponses = await request.post('/v1/responses', { headers: gatewayHeaders,
    data: { model: 'admin-route-patrol-model', stream: false, input: 'Say browser-gateway-ok.' } })
  expect(convertedResponses.status(), await convertedResponses.text()).toBe(200)
  expect(await convertedResponses.json()).toMatchObject({ object: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'browser-gateway-ok' }] }] })
  await responseData(await request.post('/api/v1/admin/accounts', {
    headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': 'browser-mixed-protocol-account' },
    data: { name: 'Browser Mixed Responses Priority', platform: 'openai', type: 'apikey', priority: 0,
      group_ids: [session.bootstrapGroupId], credentials: { api_key: 'browser-mixed-key', base_url: 'https://mixed.browser-e2e.invalid/v1' },
      extra: { openai_responses_mode: 'force_responses' } } }))
  const mixed = await request.post('/v1/responses', { headers: gatewayHeaders,
    data: { model: 'admin-route-patrol-model', stream: false, input: 'Say browser-mixed-failover-ok.' } })
  expect(mixed.status(), await mixed.text()).toBe(200)
  expect(await mixed.json()).toMatchObject({ output: [{ content: [{ text: 'browser-mixed-failover-ok' }] }] })
  await page.reload()
  await expect(page.locator('tr').filter({ hasText: 'Browser Batch Created' })).toHaveCount(1)
  await expect(page.locator('tr').filter({ hasText: 'Browser Batch Rejected' })).toHaveCount(0)

})

test('every original administrator route renders without failing API requests', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const session = sharedSession
  await page.addInitScript((auth) => {
    localStorage.setItem('auth_token', auth.accessToken)
    localStorage.setItem('refresh_token', auth.refreshToken)
    localStorage.setItem('token_expires_at', String(Date.now() + auth.expiresIn * 1_000))
    localStorage.setItem('auth_user', JSON.stringify(auth.user))
    localStorage.setItem(`admin_guide_${auth.user.id}_admin_v4_interactive`, 'true')
  }, session)
  const patrol = installPatrol(page)

  patrol.setRoute('/admin')
  await page.goto('/admin', { waitUntil: 'domcontentloaded' })
  await expect.soft(page, '/admin Worker home').toHaveURL(/\/admin\/dashboard(?:\?|$)/)

  for (const route of RETAINED_ADMIN_ROUTES) {
    patrol.setRoute(route)
    await expectStableAdminPage(page, route)
  }

  await page.waitForTimeout(500)
  await patrol.inspectResponses()
  await testInfo.attach('admin-api-failures', { body: JSON.stringify(patrol.failures, null, 2), contentType: 'application/json' })
  expect(patrol.failures.pageErrors, JSON.stringify(patrol.failures, null, 2)).toEqual([])
  expect(patrol.failures.requestFailures, JSON.stringify(patrol.failures, null, 2)).toEqual([])
  expect(patrol.failures.apiFailures, JSON.stringify(patrol.failures, null, 2)).toEqual([])
})
