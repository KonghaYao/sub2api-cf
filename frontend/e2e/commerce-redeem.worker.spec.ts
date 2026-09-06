import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { ensureBootstrapAdminPermissions } from './support/admin-session'

const ADMIN_TOKEN = 'browser-e2e-admin-token-32-bytes-minimum'
const EMAIL = 'commerce-user@browser-e2e.test'
const PASSWORD = 'commerce correct horse battery staple'
const GROUP_NAME = 'Browser E2E 30-Day Subscription'

async function expectData<T>(response: Awaited<ReturnType<APIRequestContext['fetch']>>): Promise<T> {
  const body = await response.json() as { code: number; data: T; message?: string }
  expect(response.status(), JSON.stringify(body)).toBeLessThan(500)
  expect(response.ok(), JSON.stringify(body)).toBe(true)
  expect(body.code).toBe(0)
  return body.data
}

async function expectWorkerPage(page: Page, path: string): Promise<void> {
  const response = await page.goto(path)
  expect(response?.status()).toBeLessThan(500)
  await expect(page.locator('body')).not.toContainText('Route not migrated')
}

async function prepareSubscriptionCode(request: APIRequestContext): Promise<{
  code: string
  groupId: string
}> {
  const bootstrap = await request.post('/api/v1/admin/bootstrap', {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    data: {
      user: {
        email: 'commerce-admin@browser-e2e.test',
        display_name: 'Browser Commerce Admin',
        balance_micros: 1_000_000,
      },
      group: { name: GROUP_NAME },
      account: {
        name: 'Browser Commerce Upstream',
        base_url: 'https://upstream.browser-e2e.invalid/v1',
        api_key: 'upstream-browser-commerce-secret',
        max_concurrency: 2,
      },
      models: [{
        public_name: 'gpt-browser-commerce',
        upstream_name: 'gpt-browser-commerce-upstream',
        endpoint: 'chat_completions',
        input_micros_per_million: 1_000_000,
        output_micros_per_million: 2_000_000,
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
    'browser-commerce-promote-admin-0001',
  )

  await expectData(await request.put(`/api/v1/admin/groups/${setup.group_id}`, {
    headers: {
      authorization: `Bearer ${adminSession}`,
      'idempotency-key': 'browser-commerce-subscription-group-0001',
      'if-match': '"0"',
    },
    data: {
      group_type: 'subscription',
      is_exclusive: false,
      daily_quota_micros: 5_000_000,
    },
  }))

  const settingsResponse = await request.get('/api/v1/admin/settings', {
    headers: { authorization: `Bearer ${adminSession}` },
  })
  await expectData(settingsResponse)
  await expectData(await request.put('/api/v1/admin/settings', {
    headers: {
      authorization: `Bearer ${adminSession}`,
      'idempotency-key': 'browser-commerce-enable-registration-0001',
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

  const generated = await expectData<Array<{
    code: string
    type: string
    group_id: string
    validity_days: number
  }>>(await request.post('/api/v1/admin/redeem-codes/generate', {
    headers: {
      authorization: `Bearer ${adminSession}`,
      'idempotency-key': 'browser-commerce-generate-subscription-code-0001',
    },
    data: {
      count: 1,
      type: 'subscription',
      value_micros: 0,
      group_id: setup.group_id,
      validity_days: 30,
      notes: 'Browser E2E commercial slice',
    },
  }))
  expect(generated).toHaveLength(1)
  expect(generated[0]).toMatchObject({
    type: 'subscription',
    group_id: setup.group_id,
    validity_days: 30,
  })
  expect(generated[0]?.code).toMatch(/^[A-Z0-9-]+$/)

  return {
    code: generated[0]!.code,
    groupId: setup.group_id,
  }
}

test('user redeems an administrator-created subscription code and sees the entitlement', async ({ page, request }) => {
  const serverErrors: string[] = []
  page.on('response', (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`)
  })
  const setup = await prepareSubscriptionCode(request)

  await expectWorkerPage(page, '/register')
  await page.locator('#email').fill(EMAIL)
  await page.locator('#password').fill(PASSWORD)
  const registrationResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/auth/register') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: /create account/i }).click()
  const registration = await expectData<{ access_token: string }>(await registrationResponse)
  await expect(page).toHaveURL(/\/dashboard$/)

  await expectWorkerPage(page, '/redeem')
  await page.locator('#code').fill(setup.code)
  const redeemResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/redeem') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: /^redeem code$/i }).click()
  const redemption = await expectData<{
    type: string
    value: number
    subscription_id: string
  }>(await redeemResponse)
  expect(redemption).toMatchObject({ type: 'subscription', value: 30 })
  expect(redemption.subscription_id).toMatch(/^[0-9a-f-]{36}$/i)
  await expect(page.getByText('Code Redeemed Successfully!', { exact: true })).toBeVisible()
  await expect(page.getByText('Subscription Assigned', { exact: true }).first()).toBeVisible()

  await expectWorkerPage(page, '/subscriptions')
  await expect(page.getByText(GROUP_NAME, { exact: true })).toBeVisible()
  await expect(page.getByText('Active', { exact: true })).toBeVisible()

  const publicSubscriptions = await page.evaluate(async ({ token }) => {
    const response = await fetch('/api/v1/subscriptions', {
      headers: { authorization: `Bearer ${token}` },
    })
    return { status: response.status, body: await response.json() }
  }, { token: registration.access_token })
  expect(publicSubscriptions).toMatchObject({
    status: 200,
    body: {
      code: 0,
      data: [expect.objectContaining({
        id: redemption.subscription_id,
        group_id: setup.groupId,
        status: 'active',
        group: expect.objectContaining({
          name: GROUP_NAME,
          subscription_type: 'subscription',
          daily_limit_usd: 5,
        }),
      })],
    },
  })
  expect(serverErrors).toEqual([])
})
