import type { APIRequestContext, APIResponse } from '@playwright/test'

export const WORKER_STRIPE_SECRET_KEY = 'sk_test_browser_e2e_checkout'
export const WORKER_STRIPE_WEBHOOK_SECRET = 'whsec_browser_e2e_checkout'
export const WORKER_STRIPE_PUBLISHABLE_KEY = 'pk_test_browser_e2e_checkout'
export const WORKER_STRIPE_DISPLAY_NAME = 'Browser E2E Stripe'

interface WorkerPaymentConfig {
  enabled: boolean
  min_amount: number
  max_amount: number
  daily_limit: number
  order_timeout_minutes: number
  max_pending_orders: number
  balance_disabled: boolean
  recharge_fee_rate: number
  product_name_prefix: string
  product_name_suffix: string
}

async function responseData<T>(response: APIResponse): Promise<T> {
  const body = await response.json() as { code?: number; data?: T; error?: unknown }
  if (!response.ok() || body.code !== 0 || body.data === undefined) {
    throw new Error(`Browser E2E payment setup failed (${response.status()}): ${JSON.stringify(body)}`)
  }
  return body.data
}

const expectedConfig: WorkerPaymentConfig = {
  enabled: true,
  min_amount: 1,
  max_amount: 100,
  daily_limit: 500,
  order_timeout_minutes: 30,
  max_pending_orders: 5,
  balance_disabled: true,
  recharge_fee_rate: 0,
  product_name_prefix: 'Browser:',
  product_name_suffix: ':subscription',
}

function hasExpectedConfig(config: WorkerPaymentConfig): boolean {
  return Object.entries(expectedConfig).every(([key, value]) =>
    config[key as keyof WorkerPaymentConfig] === value
  )
}

/** Ensure every browser spec shares one deterministic active Stripe boundary. */
export async function ensureWorkerStripe(
  request: APIRequestContext,
  adminSession: string,
): Promise<void> {
  const authorization = `Bearer ${adminSession}`
  await responseData(await request.post('/api/v1/admin/payment/providers', {
    headers: {
      authorization,
      'idempotency-key': 'browser-e2e-stripe-provider-0001',
    },
    data: {
      provider_key: 'stripe',
      name: WORKER_STRIPE_DISPLAY_NAME,
      enabled: true,
      supported_types: ['stripe'],
      payment_mode: 'redirect',
      limits: { stripe: { singleMin: 1, singleMax: 100, dailyLimit: 500 } },
      config: {
        secret_key: WORKER_STRIPE_SECRET_KEY,
        webhook_secret: WORKER_STRIPE_WEBHOOK_SECRET,
        publishable_key: WORKER_STRIPE_PUBLISHABLE_KEY,
      },
    },
  }))

  const configResponse = await request.get('/api/v1/admin/payment/config', {
    headers: { authorization },
  })
  const config = await responseData<WorkerPaymentConfig>(configResponse)
  if (hasExpectedConfig(config)) return

  const controlVersion = configResponse.headers()['etag']?.replaceAll('"', '') ?? '0'
  await responseData(await request.put('/api/v1/admin/payment/config', {
    headers: {
      authorization,
      'idempotency-key': `browser-e2e-stripe-config-${controlVersion}`,
      'if-match': `"${controlVersion}"`,
    },
    data: expectedConfig,
  }))
}
