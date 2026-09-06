import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { ensureBootstrapAdminPermissions } from './support/admin-session'
import { ensureWorkerStripe } from './support/payment'

const ADMIN_TOKEN = 'browser-e2e-admin-token-32-bytes-minimum'
const EMAIL = 'stripe-buyer@browser-e2e.test'
const PASSWORD = 'stripe buyer correct horse battery staple'
const GROUP_NAME = 'Browser E2E Stripe Subscribers'
const PLAN_NAME = 'Browser E2E Stripe Monthly'

async function expectData<T>(response: Awaited<ReturnType<APIRequestContext['fetch']>>): Promise<T> {
  const body = await response.json() as { code?: number; data?: T; error?: unknown }
  expect(response.status(), JSON.stringify(body)).toBeLessThan(500)
  expect(response.ok(), JSON.stringify(body)).toBe(true)
  expect(body.code).toBe(0)
  return body.data!
}

async function expectWorkerPage(page: Page, path: string): Promise<void> {
  const response = await page.goto(path)
  expect(response?.status()).toBeLessThan(500)
  await expect(page.locator('body')).not.toContainText('Route not migrated')
}

async function prepareStripeCheckout(request: APIRequestContext): Promise<{ planId: string }> {
  const setup = await expectData<{
    admin_session: string
    group_id: string
    user_id: string
  }>(await request.post('/api/v1/admin/bootstrap', {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    data: {
      user: {
        email: 'stripe-admin@browser-e2e.test',
        display_name: 'Browser Stripe Admin',
        balance_micros: 1_000_000,
      },
      group: { name: GROUP_NAME },
      account: {
        name: 'Browser Stripe Unused Upstream',
        base_url: 'https://upstream.browser-e2e.invalid/v1',
        api_key: 'upstream-browser-stripe-secret',
      },
      models: [{
        public_name: 'gpt-browser-stripe',
        input_micros_per_million: 1_000_000,
        output_micros_per_million: 2_000_000,
      }],
    },
  }))
  const adminSession = await ensureBootstrapAdminPermissions(
    request,
    ADMIN_TOKEN,
    setup,
    'browser-stripe-promote-admin-0001',
  )
  const adminHeaders = { authorization: `Bearer ${adminSession}` }

  await expectData(await request.put(`/api/v1/admin/groups/${setup.group_id}`, {
    headers: {
      ...adminHeaders,
      'idempotency-key': 'browser-stripe-subscription-group-0001',
      'if-match': '"0"',
    },
    data: {
      group_type: 'subscription',
      is_exclusive: false,
      daily_quota_micros: 5_000_000,
    },
  }))

  const settingsResponse = await request.get('/api/v1/admin/settings', { headers: adminHeaders })
  await expectData(settingsResponse)
  await expectData(await request.put('/api/v1/admin/settings', {
    headers: {
      ...adminHeaders,
      'idempotency-key': 'browser-stripe-enable-registration-0001',
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

  await ensureWorkerStripe(request, adminSession)

  const plan = await expectData<{ id: string }>(await request.post('/api/v1/admin/payment/plans', {
    headers: {
      ...adminHeaders,
      'idempotency-key': 'browser-stripe-plan-0001',
    },
    data: {
      group_id: setup.group_id,
      name: PLAN_NAME,
      description: 'Local Worker Stripe checkout proof',
      price: 12.34,
      currency: 'USD',
      validity_days: 30,
      daily_limit_usd: 5,
      for_sale: true,
      sort_order: 1,
    },
  }))
  return { planId: plan.id }
}

test('user creates and cancels a Stripe subscription order through the Worker UI', async ({ page, request }) => {
  const serverErrors: string[] = []
  page.on('response', (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`)
  })
  const setup = await prepareStripeCheckout(request)

  await expectWorkerPage(page, '/register')
  await page.locator('#email').fill(EMAIL)
  await page.locator('#password').fill(PASSWORD)
  const registrationResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/auth/register') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: /create account/i }).click()
  await expectData(await registrationResponse)
  await expect(page).toHaveURL(/\/dashboard$/)

  await expectWorkerPage(page, '/purchase')
  await expect(page.getByRole('heading', { name: PLAN_NAME })).toBeVisible()
  await page.getByRole('button', { name: 'Subscribe Now' }).click()
  await page.getByTestId('payment-method-grid').getByRole('button', { name: /Stripe/i }).click()

  const createResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/payment/orders') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: /Confirm Payment/ }).click()
  const order = await expectData<{
    order_id: string
    out_trade_no: string
    pay_url: string
    payment_type: string
    order_type: string
    plan_id: string
  }>(await createResponse)
  expect(order).toMatchObject({
    payment_type: 'stripe',
    order_type: 'subscription',
    plan_id: setup.planId,
  })
  expect(order.pay_url).toContain('/payment/result?stripe_checkout=')

  await expectWorkerPage(page, '/orders')
  await expect(page.getByText(`#${order.order_id}`, { exact: true })).toBeVisible()
  await expect(page.getByText(order.out_trade_no, { exact: true })).toBeVisible()
  await expect(page.getByText('Pending', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Cancel Order' }).click()
  const dialog = page.getByRole('dialog', { name: 'Cancel Order' })
  await expect(dialog).toBeVisible()
  const cancelResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/v1/payment/orders/${order.order_id}/cancel`
      && response.request().method() === 'POST'
  )
  await dialog.getByRole('button', { name: 'Cancel Order' }).click()
  const cancelled = await expectData<{ status: string; id: string }>(await cancelResponse)
  expect(cancelled).toMatchObject({ id: order.order_id, status: 'CANCELLED' })
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible()
  expect(serverErrors).toEqual([])
})
