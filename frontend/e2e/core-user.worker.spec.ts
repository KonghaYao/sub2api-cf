import { expect, test, type APIRequestContext } from '@playwright/test'
import { ensureBootstrapAdminPermissions } from './support/admin-session'

const ADMIN_TOKEN = 'browser-e2e-admin-token-32-bytes-minimum'
const EMAIL = 'alice@browser-e2e.test'
const PASSWORD = 'correct horse battery staple'

interface BootstrapState {
  adminSession: string
  groupId: string
}

async function expectData<T>(response: Awaited<ReturnType<APIRequestContext['fetch']>>): Promise<T> {
  const body = await response.json() as { code: number; data: T; message?: string }
  expect(response.ok(), JSON.stringify(body)).toBe(true)
  expect(body.code).toBe(0)
  return body.data
}

async function prepareFreshWorker(request: APIRequestContext): Promise<BootstrapState> {
  const bootstrap = await request.post('/api/v1/admin/bootstrap', {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    data: {
      user: {
        email: 'admin@browser-e2e.test',
        display_name: 'Browser E2E Admin',
        balance_micros: 1_000_000,
      },
      group: { name: 'Browser E2E Group' },
      account: {
        name: 'Unused Browser E2E Upstream',
        base_url: 'https://upstream.browser-e2e.invalid/v1',
        api_key: 'upstream-browser-e2e-secret',
        max_concurrency: 2,
      },
      api_key: { name: 'Bootstrap key' },
      models: [{
        public_name: 'gpt-browser-e2e',
        upstream_name: 'gpt-browser-e2e-upstream',
        endpoint: 'chat_completions',
        input_micros_per_million: 1_000_000,
        output_micros_per_million: 2_000_000,
        per_request_micros: 7,
        minimum_reservation_micros: 100,
      }],
    },
  })
  const setup = await expectData<{
    admin_session: string
    group_id: string
    user_id: string
  }>(bootstrap)
  const adminSession = await ensureBootstrapAdminPermissions(
    request,
    ADMIN_TOKEN,
    setup,
    'browser-e2e-promote-admin-0001',
  )

  await expectData(await request.put(`/api/v1/admin/groups/${setup.group_id}`, {
    headers: {
      authorization: `Bearer ${adminSession}`,
      'idempotency-key': 'browser-e2e-publish-group-0001',
      'if-match': '"0"',
    },
    data: { is_exclusive: false },
  }))

  const settingsResponse = await request.get('/api/v1/admin/settings', {
    headers: { authorization: `Bearer ${adminSession}` },
  })
  await expectData(settingsResponse)
  await expectData(await request.put('/api/v1/admin/settings', {
    headers: {
      authorization: `Bearer ${adminSession}`,
      'idempotency-key': 'browser-e2e-enable-registration-0001',
      'if-match': settingsResponse.headers()['etag'] ?? '"0"',
    },
    data: {
      public: {
        site_name: 'Browser E2E',
        registration_enabled: true,
        email_verification_enabled: false,
        turnstile_enabled: false,
        promo_code_enabled: false,
        invitation_code_enabled: false,
        affiliate_enabled: false,
      },
    },
  }))

  return { adminSession, groupId: setup.group_id }
}

test('user registers, logs in, completes the API-key lifecycle and gateway billing, and persists an R2 avatar', async ({ page, request }) => {
  const setup = await prepareFreshWorker(request)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])

  await page.goto('/register')
  await page.locator('#email').fill(EMAIL)
  await page.locator('#password').fill(PASSWORD)
  const registrationResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/auth/register') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: /create account/i }).click()
  const registration = await expectData<{
    user: { id: string }
  }>(await registrationResponse)
  await expect(page).toHaveURL(/\/dashboard$/)

  await page.evaluate(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  await page.goto('/login')
  await expect(page).toHaveURL(/\/login$/)
  await page.locator('#email').fill(EMAIL)
  await page.locator('#password').fill(PASSWORD)
  const loginResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: /^sign in$/i }).click()
  const login = await expectData<{ access_token: string }>(await loginResponse)
  await expect(page).toHaveURL(/\/dashboard$/)

  const funded = await request.post(`/api/v1/admin/users/${registration.user.id}/balance`, {
    headers: {
      authorization: `Bearer ${setup.adminSession}`,
      'idempotency-key': 'browser-e2e-fund-user-0001',
    },
    data: { amount_delta_micros: 1_000_000 },
  })
  await expectData(funded)

  await expect.poll(async () => {
    const response = await request.get('/api/v1/auth/me', {
      headers: { authorization: `Bearer ${login.access_token}` },
    })
    const profile = await expectData<{ balance: number }>(response)
    return profile.balance
  }).toBe(1)

  await page.goto('/keys')
  await page.locator('[data-tour="keys-create-btn"]').click()
  await page.locator('[data-tour="key-form-name"]').fill('Browser-created key')
  await page.locator('[data-tour="key-form-group"] button[aria-haspopup="true"]').click()
  await page.getByRole('option', { name: /Browser E2E Group/ }).click()
  const createResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/v1/keys' && response.request().method() === 'POST'
  )
  await page.locator('[data-tour="key-form-submit"]').click()
  const created = await expectData<{ id: string; key: string }>(await createResponse)
  const createdKeyRow = page.locator('tr').filter({ hasText: 'Browser-created key' })
  await expect(createdKeyRow).toHaveCount(1)
  await createdKeyRow.getByTitle(/copy to clipboard/i).click()
  const apiKey = await page.evaluate(() => navigator.clipboard.readText())
  expect(apiKey).toMatch(/^sk-sub2api-[A-Za-z0-9_-]{48}$/)
  expect(apiKey).toBe(created.key)

  const completion = await page.evaluate(async ({ key }) => {
    const response = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-browser-e2e',
        messages: [{ role: 'user', content: 'Say browser-gateway-ok.' }],
        max_tokens: 16,
        stream: false,
      }),
    })
    return { status: response.status, body: await response.json() }
  }, { key: apiKey })
  expect(completion).toMatchObject({
    status: 200,
    body: {
      model: 'gpt-browser-e2e',
      choices: [{ message: { content: 'browser-gateway-ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  })

  await expect(page.getByText('Browser-created key', { exact: true })).toBeVisible()

  await expect.poll(async () => page.evaluate(async ({ token }) => {
    const response = await fetch('/api/v1/usage?limit=20', {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = await response.json() as {
      data?: { items?: Array<{ model?: string; requested_model?: string }> }
    }
    return body.data?.items?.some((item) =>
      item.requested_model === 'gpt-browser-e2e' || item.model === 'gpt-browser-e2e'
    ) ?? false
  }, { token: login.access_token })).toBe(true)

  await page.goto('/usage')
  await expect(page.getByText('gpt-browser-e2e', { exact: true }).first()).toBeVisible()

  await page.goto('/profile')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  await page.getByTestId('profile-avatar-file-input').setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: png,
  })
  await page.getByTestId('profile-avatar-save').click()
  const avatar = page.getByTestId('profile-avatar-preview')
  await expect(avatar).toHaveAttribute('src', /\/api\/v1\/user\/avatar\/.+\?v=\d+$/)
  const avatarUrl = await avatar.getAttribute('src')
  expect(avatarUrl).not.toBeNull()
  const avatarResponse = await request.get(avatarUrl!)
  expect(avatarResponse.status()).toBe(200)
  expect(avatarResponse.headers()['content-type']).toBe('image/png')

  await page.reload()
  await expect(page.getByTestId('profile-avatar-preview')).toHaveAttribute('src', avatarUrl!)

  await page.goto('/keys')
  await expect(createdKeyRow).toHaveCount(1)
  await createdKeyRow.getByRole('button', { name: /^delete$/i }).click()
  const deleteDialog = page.getByRole('dialog').filter({ hasText: /Browser-created key/ })
  await expect(deleteDialog).toBeVisible()
  const deleteResponse = page.waitForResponse((response) =>
    response.url().includes('/api/v1/keys/') && response.request().method() === 'DELETE'
  )
  const refreshedList = page.waitForResponse((response) =>
    response.url().includes('/api/v1/keys?') && response.request().method() === 'GET'
  )
  await deleteDialog.getByRole('button', { name: /^delete$/i }).click()
  const revoked = await expectData<{ id: string; status: string }>(await deleteResponse)
  expect(revoked.status).toBe('inactive')
  await expectData(await refreshedList)
  await expect(createdKeyRow).toHaveCount(0)
  const rejected = await request.post('/v1/chat/completions', {
    headers: { authorization: `Bearer ${apiKey}` },
    data: { model: 'gpt-browser-e2e', messages: [{ role: 'user', content: 'This key was deleted.' }], max_tokens: 16 },
  })
  expect(rejected.status()).toBe(401)
})
