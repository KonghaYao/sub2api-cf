import type { Context } from 'hono'

import { authenticateUserRequest } from '../auth/handler'
import type { Env } from '../env'
import { decryptCredential, encryptCredential } from '../gateway/crypto'
import { asGatewayError, GatewayError } from '../gateway/errors'
import {
  controlIdempotency,
  controlIdempotencyInsert,
  findControlIdempotency,
  parseIdempotentResponse,
} from '../control/idempotency'
import {
  controlError,
  controlSuccess,
  deterministicUuid,
  readJsonObject,
  requireExpectedControlVersion,
  requireIdempotencyKey,
} from '../control/http'

type PaymentBindings = { Bindings: Env }

interface PaymentConfigRow {
  load_balance_strategy: 'round_robin' | 'least_amount'
  cancel_rate_limit_enabled: number
  cancel_rate_limit_max: number
  cancel_rate_limit_window: number
  cancel_rate_limit_unit: 'minute' | 'hour' | 'day'
  cancel_rate_limit_window_mode: 'rolling' | 'fixed'

  schema_version: number
  enabled: number
  enabled_payment_types_json: string
  min_amount_micros: number
  max_amount_micros: number
  daily_limit_micros: number
  order_timeout_minutes: number
  max_pending_orders: number
  balance_disabled: number
  balance_recharge_multiplier_ppm: number
  subscription_usd_to_cny_rate_ppm: number
  recharge_fee_ppm: number
  product_name_prefix: string
  product_name_suffix: string
  help_url: string
  help_text: string
  version: number
  created_at_ms: number
  updated_at_ms: number
}

export interface PaymentProviderRow {
  id: string
  schema_version: number
  provider_key: string
  provider_type: string
  display_name: string
  config_ciphertext: string
  config_nonce: string
  config_key_id: string
  enabled: number
  version: number
  created_at_ms: number
  updated_at_ms: number
}

export interface StripeProviderCredential {
  api_key: string
  webhook_secret: string
  publishable_key: string
  supported_types: string[]
  payment_mode: string
  limits: string
  refund_enabled: boolean
  allow_user_refund: boolean
}

export interface ActiveStripeProvider {
  id: string
  provider_key: string
  provider_type: 'stripe'
  display_name: string
  version: number
  secret_key: string
  webhook_secret: string
  publishable_key: string
  supported_types: string[]
  payment_mode: string
  limits: Record<string, StripeMethodLimits>
  refund_enabled: boolean
  allow_user_refund: boolean
}

interface StripeMethodLimits {
  singleMin?: number
  singleMax?: number
  dailyLimit?: number
}

interface PublicPlanRow {
  id: string
  group_id: string
  name: string
  description: string
  validity_days: number
  price_micros: number
  currency: string
  daily_quota_micros: number | null
  weekly_quota_micros: number | null
  monthly_quota_micros: number | null
  enabled: number
  sort_order: number
  group_name: string
  group_platform: string
  group_rate_multiplier_ppm: number
}

const PROVIDER_COLUMNS = `id, schema_version, provider_key, provider_type, display_name,
  config_ciphertext, config_nonce, config_key_id, enabled, version, created_at_ms, updated_at_ms`
const PROVIDER_KEY_ID = 'primary'

export async function getPaymentConfig(context: Context<PaymentBindings>): Promise<Response> {
  try {
    await authenticateUserRequest(context.req.raw, context.env)
    const row = await requirePaymentConfigRow(context.env)
    const configuredTypes = configuredPaymentTypes(row)
    const stripe = row.enabled === 1 && configuredTypes.includes('stripe')
      ? await stripePublicState(context.env)
      : { enabledTypes: [], publishableKey: '' }
    const effectiveTypes = stripe.enabledTypes.filter((type) => configuredTypes.includes(type))
    return controlSuccess(publicPaymentConfig(row, effectiveTypes, stripe.publishableKey))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** Effective public capability: the global switch alone never advertises an unusable checkout. */
export async function isPaymentEnabled(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT EXISTS(
       SELECT 1
         FROM payment_config config
         JOIN payment_provider_instances provider
           ON provider.provider_type = 'stripe' AND provider.enabled = 1
        WHERE config.id = 'global' AND config.enabled = 1
          AND config.enabled_payment_types_json = '["stripe"]'
     ) AS enabled`,
  ).first<{ enabled: number }>()
  return row?.enabled === 1
}

export async function getPaymentLimits(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const config = await requirePaymentConfigRow(context.env)
    return controlSuccess(await paymentLimits(context.env, user.id, config))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getPaymentCheckoutInfo(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const user = await authenticateUserRequest(context.req.raw, context.env)
    const config = await requirePaymentConfigRow(context.env)
    const [limits, plans] = await Promise.all([
      paymentLimits(context.env, user.id, config),
      listPublicPlans(context.env),
    ])
    let publishableKey = ''
    if (config.enabled === 1 && configuredPaymentTypes(config).includes('stripe')) {
      publishableKey = (await requireActiveStripeProvider(context.env)).publishable_key
    }
    return controlSuccess({
      ...limits,
      plans,
      // Balance top-ups are deliberately unavailable until balance-order
      // creation and fulfillment ship as one complete financial workflow.
      balance_disabled: true,
      balance_recharge_multiplier: config.balance_recharge_multiplier_ppm / 1_000_000,
      subscription_usd_to_cny_rate: config.subscription_usd_to_cny_rate_ppm / 1_000_000,
      recharge_fee_rate: config.recharge_fee_ppm / 10_000,
      help_text: config.help_text,
      help_image_url: config.help_url,
      stripe_publishable_key: publishableKey,
      alipay_force_qrcode: false,
      alipay_mobile_precreate_deep_link: false,
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function getAdminPaymentConfig(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const row = await requirePaymentConfigRow(context.env)
    const stripe = await stripePublicState(context.env)
    return paymentConfigResponse(
      {
        ...publicPaymentConfig(row, configuredPaymentTypes(row), stripe.publishableKey),
        balance_disabled_configured: row.balance_disabled === 1,
        balance_checkout_available: false,
        order_timeout_minutes_configured: row.order_timeout_minutes,
        version: row.version,
        control_version: row.version,
        created_at_ms: row.created_at_ms,
        updated_at_ms: row.updated_at_ms,
      },
      row.version,
    )
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updatePaymentConfig(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const expected = requirePaymentVersion(context.req.raw, body)
    const patch = parsePaymentConfigPatch(body)
    const idempotency = await controlIdempotency(
      'admin.payment-config.update.v1',
      idempotencyKey,
      { expected, patch },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      const replay = parseIdempotentResponse<Record<string, unknown>>(previous, 'payment_config')
      return paymentConfigResponse(replay, expected + 1)
    }

    const current = await requirePaymentConfigRow(context.env)
    assertVersion(current.version, expected, 'payment_config')
    const next = { ...current, ...patch, version: expected + 1, updated_at_ms: Date.now() }
    if (next.max_amount_micros !== 0 && next.max_amount_micros < next.min_amount_micros) {
      throw new GatewayError(400, 'invalid_payment_amount_range', 'max_amount must be zero or at least min_amount')
    }
    const stripe = await stripePublicState(context.env)
    const response = {
      ...publicPaymentConfig(next, configuredPaymentTypes(next), stripe.publishableKey),
      balance_disabled_configured: next.balance_disabled === 1,
      balance_checkout_available: false,
      order_timeout_minutes_configured: next.order_timeout_minutes,
      version: next.version,
      control_version: next.version,
      created_at_ms: next.created_at_ms,
      updated_at_ms: next.updated_at_ms,
    }
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE payment_config SET
             enabled = ?, enabled_payment_types_json = ?,
             min_amount_micros = ?, max_amount_micros = ?,
             daily_limit_micros = ?, order_timeout_minutes = ?, max_pending_orders = ?,
             balance_disabled = ?, balance_recharge_multiplier_ppm = ?,
             subscription_usd_to_cny_rate_ppm = ?, recharge_fee_ppm = ?,
             product_name_prefix = ?, product_name_suffix = ?, help_url = ?, help_text = ?,
             load_balance_strategy = ?, cancel_rate_limit_enabled = ?, cancel_rate_limit_max = ?, cancel_rate_limit_window = ?, cancel_rate_limit_unit = ?, cancel_rate_limit_window_mode = ?,
             version = CASE WHEN version = ? THEN ? ELSE -1 END, updated_at_ms = ?
           WHERE id = 'global'`,
        ).bind(
          next.enabled,
          next.enabled_payment_types_json,
          next.min_amount_micros,
          next.max_amount_micros,
          next.daily_limit_micros,
          next.order_timeout_minutes,
          next.max_pending_orders,
          next.balance_disabled,
          next.balance_recharge_multiplier_ppm,
          next.subscription_usd_to_cny_rate_ppm,
          next.recharge_fee_ppm,
          next.product_name_prefix,
          next.product_name_suffix,
          next.help_url,
          next.help_text,
          next.load_balance_strategy,
          next.cancel_rate_limit_enabled,
          next.cancel_rate_limit_max,
          next.cancel_rate_limit_window,
          next.cancel_rate_limit_unit,
          next.cancel_rate_limit_window_mode,
          expected,
          expected + 1,
          next.updated_at_ms,
        ),
        controlIdempotencyInsert(context.env, idempotency, 'payment_config', 'global', response, next.updated_at_ms),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        const replay = parseIdempotentResponse<Record<string, unknown>>(recovered, 'payment_config')
        return paymentConfigResponse(replay, expected + 1)
      }
      if (providerErrorMessage(error).includes('version')) throw versionConflict('payment_config')
      throw error
    }
    return paymentConfigResponse(response, next.version)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export const updateAdminPaymentConfig = updatePaymentConfig

export async function listPaymentProviders(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const providers = await context.env.DB.prepare(
      `SELECT ${PROVIDER_COLUMNS} FROM payment_provider_instances ORDER BY created_at_ms ASC, id ASC`,
    ).all<PaymentProviderRow>()
    const response = await Promise.all(
      providers.results.map(async (row) => providerResponse(row, await decryptPaymentProviderConfig(context.env, row))),
    )
    return controlSuccess(response)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function createPaymentProvider(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const input = parseCreateProvider(await readJsonObject(context.req.raw))
    const idempotency = await controlIdempotency(
      'admin.payment-providers.create.v1',
      idempotencyKey,
      input,
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      return controlSuccess(parseIdempotentResponse(previous, 'payment_provider'))
    }

    const id = await deterministicUuid('admin.payment-providers.create.v1', idempotencyKey)
    const now = Date.now()
    const version = 0
    const credential = input.credential
    const encrypted = await encryptCredential(
      credential,
      requirePaymentMasterKey(context.env),
      paymentProviderCredentialAad(context.env.ENVIRONMENT, id, PROVIDER_KEY_ID, version),
    )
    const row: PaymentProviderRow = {
      id,
      schema_version: 1,
      provider_key: 'stripe',
      provider_type: 'stripe',
      display_name: input.name,
      config_ciphertext: encrypted.ciphertext_b64,
      config_nonce: encrypted.nonce_b64,
      config_key_id: PROVIDER_KEY_ID,
      enabled: input.enabled ? 1 : 0,
      version,
      created_at_ms: now,
      updated_at_ms: now,
    }
    const response = providerResponse(row, credential)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO payment_provider_instances (
             id, provider_key, provider_type, display_name,
             config_ciphertext, config_nonce, config_key_id, enabled,
             version, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          row.id,
          row.provider_key,
          row.provider_type,
          row.display_name,
          row.config_ciphertext,
          row.config_nonce,
          row.config_key_id,
          row.enabled,
          row.version,
          row.created_at_ms,
          row.updated_at_ms,
        ),
        controlIdempotencyInsert(context.env, idempotency, 'payment_provider', id, response, now),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return controlSuccess(parseIdempotentResponse(recovered, 'payment_provider'))
      }
      throw mapProviderWriteError(error)
    }
    return controlSuccess(response, 201)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function updatePaymentProvider(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const id = requireProviderId(context.req.param('id'))
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const body = await readJsonObject(context.req.raw)
    const expected = requirePaymentVersion(context.req.raw, body)
    const idempotency = await controlIdempotency(
      'admin.payment-providers.update.v1',
      idempotencyKey,
      { id, expected, body },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      return providerMutationResponse(
        parseIdempotentResponse(previous, 'payment_provider'),
        expected + 1,
      )
    }

    const current = await requireProviderRow(context.env, id)
    assertVersion(current.version, expected, 'payment_provider')
    const currentCredential = await decryptPaymentProviderConfig(context.env, current)
    const nextValues = parseProviderUpdate(body, current, currentCredential)
    if (
      (nextValues.credential.api_key !== currentCredential.api_key ||
        nextValues.credential.webhook_secret !== currentCredential.webhook_secret) &&
      (await providerOrderCount(context.env, id)) > 0
    ) {
      throw new GatewayError(
        409,
        'payment_provider_identity_in_use',
        'Provider identity credentials cannot change after an order exists',
      )
    }
    assertRunnableProvider(nextValues.enabled, nextValues.credential)

    const version = expected + 1
    const updatedAt = Date.now()
    const encrypted = await encryptCredential(
      nextValues.credential,
      requirePaymentMasterKey(context.env),
      paymentProviderCredentialAad(context.env.ENVIRONMENT, id, current.config_key_id, version),
    )
    const next: PaymentProviderRow = {
      ...current,
      display_name: nextValues.name,
      enabled: nextValues.enabled ? 1 : 0,
      config_ciphertext: encrypted.ciphertext_b64,
      config_nonce: encrypted.nonce_b64,
      version,
      updated_at_ms: updatedAt,
    }
    const response = providerResponse(next, nextValues.credential)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE payment_provider_instances SET
             display_name = ?, enabled = ?, config_ciphertext = ?, config_nonce = ?,
             version = CASE WHEN version = ? THEN ? ELSE -1 END, updated_at_ms = ?
           WHERE id = ?`,
        ).bind(
          next.display_name,
          next.enabled,
          next.config_ciphertext,
          next.config_nonce,
          expected,
          version,
          updatedAt,
          id,
        ),
        controlIdempotencyInsert(context.env, idempotency, 'payment_provider', id, response, updatedAt),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return providerMutationResponse(
          parseIdempotentResponse(recovered, 'payment_provider'),
          version,
        )
      }
      if (providerErrorMessage(error).includes('version')) throw versionConflict('payment_provider')
      throw mapProviderWriteError(error)
    }
    return providerMutationResponse(response, version)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

/** DELETE is intentionally a versioned soft-disable; provider rows and keys remain for order history. */
export async function deletePaymentProvider(context: Context<PaymentBindings>): Promise<Response> {
  try {
    const id = requireProviderId(context.req.param('id'))
    const idempotencyKey = requireIdempotencyKey(context.req.raw)
    const body = await readOptionalJson(context.req.raw)
    const expected = requirePaymentVersion(context.req.raw, body)
    const idempotency = await controlIdempotency(
      'admin.payment-providers.disable.v1',
      idempotencyKey,
      { id, expected },
    )
    const previous = await findControlIdempotency(context.env, idempotency)
    if (previous !== null) {
      return providerMutationResponse(
        parseIdempotentResponse(previous, 'payment_provider'),
        expected + 1,
      )
    }

    const current = await requireProviderRow(context.env, id)
    assertVersion(current.version, expected, 'payment_provider')
    if ((await providerOpenOrderCount(context.env, id)) > 0) {
      throw new GatewayError(
        409,
        'payment_provider_orders_in_progress',
        'Payment provider cannot be disabled while orders are in progress',
      )
    }
    const credential = await decryptPaymentProviderConfig(context.env, current)
    const version = expected + 1
    const updatedAt = Date.now()
    const encrypted = await encryptCredential(
      credential,
      requirePaymentMasterKey(context.env),
      paymentProviderCredentialAad(context.env.ENVIRONMENT, id, current.config_key_id, version),
    )
    const next: PaymentProviderRow = {
      ...current,
      enabled: 0,
      version,
      updated_at_ms: updatedAt,
      config_ciphertext: encrypted.ciphertext_b64,
      config_nonce: encrypted.nonce_b64,
    }
    const response = providerResponse(next, credential)
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `UPDATE payment_provider_instances SET enabled = 0,
             config_ciphertext = ?, config_nonce = ?,
             version = CASE WHEN version = ? THEN ? ELSE -1 END, updated_at_ms = ?
           WHERE id = ?`,
        ).bind(next.config_ciphertext, next.config_nonce, expected, version, updatedAt, id),
        controlIdempotencyInsert(context.env, idempotency, 'payment_provider', id, response, updatedAt),
      ])
    } catch (error) {
      const recovered = await findControlIdempotency(context.env, idempotency)
      if (recovered !== null) {
        return providerMutationResponse(
          parseIdempotentResponse(recovered, 'payment_provider'),
          version,
        )
      }
      if (providerErrorMessage(error).includes('version')) throw versionConflict('payment_provider')
      throw mapProviderWriteError(error)
    }
    return providerMutationResponse(response, version)
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export function paymentProviderCredentialAad(
  environment: string,
  providerId: string,
  keyId: string,
  version: number,
): string {
  return `sub2api/payment-provider/v1/${environment}/${providerId}/${keyId}/${version}`
}

export async function decryptPaymentProviderConfig(
  env: Env,
  row: PaymentProviderRow,
): Promise<StripeProviderCredential> {
  if (
    row.schema_version !== 1 ||
    row.provider_type !== 'stripe' ||
    !Number.isSafeInteger(row.version) ||
    row.version < 0
  ) {
    throw invalidProviderRecord()
  }
  const decrypted = await decryptCredential(
    row.config_nonce,
    row.config_ciphertext,
    requirePaymentMasterKey(env),
    paymentProviderCredentialAad(env.ENVIRONMENT, row.id, row.config_key_id, row.version),
  )
  const value = decrypted as unknown as Record<string, unknown>
  if (typeof value.api_key !== 'string' || value.api_key.length === 0) {
    throw invalidProviderRecord()
  }
  const normalized: StripeProviderCredential = {
    api_key: value.api_key,
    webhook_secret: typeof value.webhook_secret === 'string' ? value.webhook_secret : '',
    publishable_key: typeof value.publishable_key === 'string' ? value.publishable_key : '',
    supported_types: isStringArray(value.supported_types) ? value.supported_types : ['stripe'],
    payment_mode: typeof value.payment_mode === 'string' ? value.payment_mode : 'redirect',
    limits: typeof value.limits === 'string' ? value.limits : '',
    refund_enabled: typeof value.refund_enabled === 'boolean' ? value.refund_enabled : false,
    allow_user_refund:
      value.refund_enabled === true && value.allow_user_refund === true,
  }
  parseLimits(normalized.limits)
  return normalized
}

export async function requireActiveStripeProvider(
  env: Env,
  providerId?: string,
  selectForOrder = false,
): Promise<ActiveStripeProvider> {
  if (providerId === undefined && selectForOrder) {
    const strategy = await env.DB.prepare("SELECT load_balance_strategy FROM payment_config WHERE id='global'").first<{ load_balance_strategy: string }>()
    if (strategy?.load_balance_strategy === 'least_amount') {
      const selected = await env.DB.prepare(`SELECT p.id FROM payment_provider_instances p WHERE p.enabled=1 AND p.provider_type='stripe' ORDER BY (SELECT COALESCE(SUM(o.pay_amount_micros),0) FROM payment_orders o WHERE o.provider_instance_id=p.id AND o.created_at_ms>=? AND o.status NOT IN ('CANCELLED','EXPIRED','FAILED')) ASC,p.created_at_ms,p.id LIMIT 1`).bind(Math.floor(Date.now()/86400000)*86400000).first<{ id: string }>()
      providerId = selected?.id
    } else {
      const providers = (await env.DB.prepare("SELECT id FROM payment_provider_instances WHERE enabled=1 AND provider_type='stripe' ORDER BY created_at_ms,id").all<{ id: string }>()).results
      if (providers.length) {
        const selected = await env.DB.prepare("UPDATE payment_config SET selection_cursor=(selection_cursor+1)%2147483647 WHERE id='global' RETURNING selection_cursor").first<{ selection_cursor: number }>()
        providerId = providers[Math.max(0,(selected?.selection_cursor ?? 1)-1)%providers.length].id
      }
    }
  }
  const row = providerId === undefined
    ? await env.DB.prepare(
        `SELECT ${PROVIDER_COLUMNS} FROM payment_provider_instances
          WHERE enabled = 1 AND provider_type = 'stripe'
          ORDER BY created_at_ms ASC, id ASC LIMIT 1`,
      ).first<PaymentProviderRow>()
    : await env.DB.prepare(
        `SELECT ${PROVIDER_COLUMNS} FROM payment_provider_instances
          WHERE id = ? AND enabled = 1 AND provider_type = 'stripe'`,
      ).bind(providerId).first<PaymentProviderRow>()
  if (row === null) {
    throw new GatewayError(503, 'stripe_provider_unavailable', 'Stripe payment provider is unavailable', 'server_error')
  }
  const credential = await decryptPaymentProviderConfig(env, row)
  if (credential.webhook_secret.length === 0) {
    throw new GatewayError(503, 'stripe_provider_unavailable', 'Stripe payment provider is unavailable', 'server_error')
  }
  return {
    id: row.id,
    provider_key: row.provider_key,
    provider_type: 'stripe',
    display_name: row.display_name,
    version: row.version,
    secret_key: credential.api_key,
    webhook_secret: credential.webhook_secret,
    publishable_key: credential.publishable_key,
    supported_types: credential.supported_types,
    payment_mode: credential.payment_mode,
    limits: parseLimits(credential.limits),
    refund_enabled: credential.refund_enabled,
    allow_user_refund: credential.allow_user_refund,
  }
}

/**
 * Resolve the immutable provider identity captured by an existing order.
 * Historical verification, webhook, and refund flows must keep working after
 * the provider is disabled for new checkouts.
 */
export async function requireStripeProviderForExistingOrder(
  env: Env,
  providerId: string,
): Promise<ActiveStripeProvider> {
  const row = await requireProviderRow(env, requireProviderId(providerId))
  const credential = await decryptPaymentProviderConfig(env, row)
  if (credential.webhook_secret.length === 0) {
    throw new GatewayError(503, 'stripe_provider_unavailable', 'Stripe payment provider is unavailable', 'server_error')
  }
  return {
    id: row.id,
    provider_key: row.provider_key,
    provider_type: 'stripe',
    display_name: row.display_name,
    version: row.version,
    secret_key: credential.api_key,
    webhook_secret: credential.webhook_secret,
    publishable_key: credential.publishable_key,
    supported_types: credential.supported_types,
    payment_mode: credential.payment_mode,
    limits: parseLimits(credential.limits),
    refund_enabled: credential.refund_enabled,
    allow_user_refund: credential.allow_user_refund,
  }
}

async function requirePaymentConfigRow(env: Env): Promise<PaymentConfigRow> {
  const row = await env.DB.prepare(
    `SELECT schema_version, enabled, min_amount_micros, max_amount_micros,
            enabled_payment_types_json,
            daily_limit_micros, order_timeout_minutes, max_pending_orders,
            balance_disabled, balance_recharge_multiplier_ppm,
            subscription_usd_to_cny_rate_ppm, recharge_fee_ppm,
            product_name_prefix, product_name_suffix, help_url, help_text,
            load_balance_strategy, cancel_rate_limit_enabled, cancel_rate_limit_max, cancel_rate_limit_window, cancel_rate_limit_unit, cancel_rate_limit_window_mode,
            version, created_at_ms, updated_at_ms
       FROM payment_config WHERE id = 'global'`,
  ).first<PaymentConfigRow>()
  if (row === null) {
    throw new GatewayError(503, 'payment_config_unavailable', 'Payment configuration is unavailable', 'server_error')
  }
  return row
}

async function stripePublicState(env: Env): Promise<{ enabledTypes: string[]; publishableKey: string }> {
  const row = await env.DB.prepare(
    `SELECT ${PROVIDER_COLUMNS} FROM payment_provider_instances
      WHERE enabled = 1 AND provider_type = 'stripe'
      ORDER BY created_at_ms ASC, id ASC LIMIT 1`,
  ).first<PaymentProviderRow>()
  if (row === null) return { enabledTypes: [], publishableKey: '' }
  const credential = await decryptPaymentProviderConfig(env, row)
  return { enabledTypes: ['stripe'], publishableKey: credential.publishable_key }
}

async function paymentLimits(
  env: Env,
  userId: string,
  config: PaymentConfigRow,
): Promise<{
  methods: Record<string, Record<string, unknown>>
  global_min: number
  global_max: number
}> {
  if (config.enabled !== 1 || !configuredPaymentTypes(config).includes('stripe')) {
    return { methods: {}, global_min: 0, global_max: 0 }
  }
  const provider = await requireActiveStripeProvider(env)
  const configured = provider.limits.stripe ?? {}
  const singleMin = configured.singleMin ?? config.min_amount_micros / 1_000_000
  const singleMax = configured.singleMax ?? config.max_amount_micros / 1_000_000
  const dailyLimit = configured.dailyLimit ?? config.daily_limit_micros / 1_000_000
  const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000
  const daily = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_micros), 0) AS used_micros
       FROM payment_orders
      WHERE user_id = ? AND created_at_ms >= ?
        AND status NOT IN ('FAILED', 'CANCELLED', 'EXPIRED')`,
  ).bind(userId, dayStart).first<{ used_micros: number }>()
  const dailyUsed = (daily?.used_micros ?? 0) / 1_000_000
  const dailyRemaining = dailyLimit === 0 ? 0 : Math.max(0, dailyLimit - dailyUsed)
  return {
    methods: {
      stripe: {
        currency: 'USD',
        display_name: provider.display_name,
        daily_limit: dailyLimit,
        daily_used: dailyUsed,
        daily_remaining: dailyRemaining,
        single_min: singleMin,
        single_max: singleMax,
        fee_rate: config.recharge_fee_ppm / 10_000,
        available: dailyLimit === 0 || dailyRemaining > 0,
      },
    },
    global_min: singleMin,
    global_max: singleMax,
  }
}

async function listPublicPlans(env: Env): Promise<Record<string, unknown>[]> {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.group_id, p.name, p.description, p.validity_days,
            p.price_micros, p.currency, p.daily_quota_micros,
            p.weekly_quota_micros, p.monthly_quota_micros,
            p.enabled, p.sort_order, g.name AS group_name,
            g.platform AS group_platform,
            g.rate_multiplier_ppm AS group_rate_multiplier_ppm
       FROM subscription_plans p
       JOIN "groups" g ON g.id = p.group_id
      WHERE p.enabled = 1 AND g.enabled = 1 AND g.group_type = 'subscription'
        AND p.currency = 'USD'
      ORDER BY p.sort_order ASC, p.id ASC`,
  ).all<PublicPlanRow>()
  return rows.results.map((row) => ({
    id: row.id,
    group_id: row.group_id,
    group_name: row.group_name,
    group_platform: row.group_platform,
    rate_multiplier: row.group_rate_multiplier_ppm / 1_000_000,
    name: row.name,
    description: row.description,
    price: row.price_micros / 1_000_000,
    price_micros: row.price_micros,
    currency: row.currency,
    validity_days: row.validity_days,
    validity_unit: 'days',
    daily_limit_usd: nullableMicros(row.daily_quota_micros),
    weekly_limit_usd: nullableMicros(row.weekly_quota_micros),
    monthly_limit_usd: nullableMicros(row.monthly_quota_micros),
    daily_quota_micros: row.daily_quota_micros,
    weekly_quota_micros: row.weekly_quota_micros,
    monthly_quota_micros: row.monthly_quota_micros,
    features: [],
    for_sale: true,
    enabled: true,
    status: 'active',
    sort_order: row.sort_order,
  }))
}

function nullableMicros(value: number | null): number | null {
  return value === null ? null : value / 1_000_000
}

function publicPaymentConfig(
  row: PaymentConfigRow,
  enabledTypes: string[],
  stripePublishableKey: string,
) {
  return {
    payment_enabled: row.enabled === 1,
    enabled: row.enabled === 1,
    min_amount: row.min_amount_micros / 1_000_000,
    max_amount: row.max_amount_micros / 1_000_000,
    daily_limit: row.daily_limit_micros / 1_000_000,
    order_timeout_minutes: Math.max(row.order_timeout_minutes, 30),
    max_pending_orders: row.max_pending_orders,
    enabled_payment_types: enabledTypes,
    // Effective capability, intentionally independent of the stored legacy
    // preference so an old `false` value cannot expose a broken top-up UI.
    balance_disabled: true,
    balance_recharge_multiplier: row.balance_recharge_multiplier_ppm / 1_000_000,
    subscription_usd_to_cny_rate: row.subscription_usd_to_cny_rate_ppm / 1_000_000,
    recharge_fee_rate: row.recharge_fee_ppm / 10_000,
    load_balance_strategy: row.load_balance_strategy,
    cancel_rate_limit_enabled: row.cancel_rate_limit_enabled === 1,
    cancel_rate_limit_max: row.cancel_rate_limit_max,
    cancel_rate_limit_window: row.cancel_rate_limit_window,
    cancel_rate_limit_unit: row.cancel_rate_limit_unit,
    cancel_rate_limit_window_mode: row.cancel_rate_limit_window_mode,
    product_name_prefix: row.product_name_prefix,
    product_name_suffix: row.product_name_suffix,
    help_image_url: row.help_url,
    help_text: row.help_text,
    stripe_publishable_key: stripePublishableKey,
  }
}

function configuredPaymentTypes(row: Pick<PaymentConfigRow, 'enabled_payment_types_json'>): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.enabled_payment_types_json)
  } catch {
    throw new GatewayError(
      503,
      'payment_config_invalid',
      'Stored payment method selection is invalid',
      'server_error',
    )
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => item === 'stripe')) {
    throw new GatewayError(
      503,
      'payment_config_invalid',
      'Stored payment method selection is invalid',
      'server_error',
    )
  }
  return [...new Set(parsed)]
}

function paymentConfigResponse(data: unknown, version: number): Response {
  const response = controlSuccess(data)
  response.headers.set('etag', `"${version}"`)
  return response
}

function parsePaymentConfigPatch(body: Record<string, unknown>): Partial<PaymentConfigRow> {
  const patch: Partial<PaymentConfigRow> = {}
  assignBooleanInteger(body, 'enabled', patch, 'enabled')
  assignBooleanInteger(body, 'balance_disabled', patch, 'balance_disabled')
  assignMajorMicros(body, 'min_amount', 'min_amount_micros', patch, 'min_amount_micros')
  assignMajorMicros(body, 'max_amount', 'max_amount_micros', patch, 'max_amount_micros')
  assignMajorMicros(body, 'daily_limit', 'daily_limit_micros', patch, 'daily_limit_micros')
  assignInteger(body, 'order_timeout_minutes', patch, 'order_timeout_minutes', 1, 1_440)
  assignInteger(body, 'max_pending_orders', patch, 'max_pending_orders', 1, 100)
  assignMultiplierPpm(
    body,
    'balance_recharge_multiplier',
    'balance_recharge_multiplier_ppm',
    patch,
    'balance_recharge_multiplier_ppm',
    false,
  )
  assignMultiplierPpm(
    body,
    'subscription_usd_to_cny_rate',
    'subscription_usd_to_cny_rate_ppm',
    patch,
    'subscription_usd_to_cny_rate_ppm',
    true,
  )
  if (body.recharge_fee_ppm !== undefined) {
    assignInteger(body, 'recharge_fee_ppm', patch, 'recharge_fee_ppm', 0, 1_000_000)
  } else if (body.recharge_fee_rate !== undefined) {
    const value = requireFiniteNumber(body.recharge_fee_rate, 'recharge_fee_rate', 0, 100)
    patch.recharge_fee_ppm = exactScaledInteger(value, 10_000, 'recharge_fee_rate')
  }
  assignText(body, 'product_name_prefix', patch, 'product_name_prefix', 500)
  assignText(body, 'product_name_suffix', patch, 'product_name_suffix', 500)
  assignText(body, 'help_image_url', patch, 'help_url', 2_048)
  assignText(body, 'help_text', patch, 'help_text', 10_000)

  if (body.enabled_payment_types !== undefined) {
    const types = parseSupportedTypes(body.enabled_payment_types)
    if (types.some((type) => type !== 'stripe')) {
      throw new GatewayError(400, 'unsupported_payment_type', 'Only Stripe payment is supported')
    }
    patch.enabled_payment_types_json = JSON.stringify(types)
  }
  assignBooleanInteger(body, 'cancel_rate_limit_enabled', patch, 'cancel_rate_limit_enabled')
  assignInteger(body, 'cancel_rate_limit_max', patch, 'cancel_rate_limit_max', 1, 10000)
  assignInteger(body, 'cancel_rate_limit_window', patch, 'cancel_rate_limit_window', 1, 10000)
  for (const [field, allowed] of [['load_balance_strategy', ['round_robin', 'least_amount']], ['cancel_rate_limit_unit', ['minute', 'hour', 'day']], ['cancel_rate_limit_window_mode', ['rolling', 'fixed']]] as const) {
    if (body[field] === undefined) continue
    const value = typeof body[field] === 'string' ? body[field].replace(/-/g, '_') : ''
    if (!(allowed as readonly string[]).includes(value)) throw new GatewayError(400, `invalid_${field}`, `Invalid ${field}`)
    Object.assign(patch, { [field]: value })
  }
  if (Object.keys(patch).length === 0) {
    throw new GatewayError(400, 'payment_config_patch_required', 'At least one payment setting is required')
  }
  const min = patch.min_amount_micros
  const max = patch.max_amount_micros
  if (min !== undefined && max !== undefined && max !== 0 && max < min) {
    throw new GatewayError(400, 'invalid_payment_amount_range', 'max_amount must be zero or at least min_amount')
  }
  return patch
}

function assignBooleanInteger<K extends keyof PaymentConfigRow>(
  body: Record<string, unknown>,
  input: string,
  patch: Partial<PaymentConfigRow>,
  output: K,
): void {
  const value = optionalBoolean(body[input], input)
  if (value !== undefined) patch[output] = (value ? 1 : 0) as PaymentConfigRow[K]
}

function assignMajorMicros<K extends keyof PaymentConfigRow>(
  body: Record<string, unknown>,
  legacy: string,
  micros: string,
  patch: Partial<PaymentConfigRow>,
  output: K,
): void {
  if (body[micros] !== undefined) {
    const value = requireSafeIntegerValue(body[micros], micros, 0, Number.MAX_SAFE_INTEGER)
    patch[output] = value as PaymentConfigRow[K]
  } else if (body[legacy] !== undefined) {
    const value = requireFiniteNumber(body[legacy], legacy, 0, Number.MAX_SAFE_INTEGER / 1_000_000)
    patch[output] = exactScaledInteger(value, 1_000_000, legacy) as PaymentConfigRow[K]
  }
}

function assignMultiplierPpm<K extends keyof PaymentConfigRow>(
  body: Record<string, unknown>,
  legacy: string,
  ppm: string,
  patch: Partial<PaymentConfigRow>,
  output: K,
  allowZero: boolean,
): void {
  if (body[ppm] !== undefined) {
    const value = requireSafeIntegerValue(body[ppm], ppm, allowZero ? 0 : 1, Number.MAX_SAFE_INTEGER)
    patch[output] = value as PaymentConfigRow[K]
  } else if (body[legacy] !== undefined) {
    const value = requireFiniteNumber(
      body[legacy],
      legacy,
      allowZero ? 0 : Number.EPSILON,
      Number.MAX_SAFE_INTEGER / 1_000_000,
    )
    patch[output] = exactScaledInteger(value, 1_000_000, legacy) as PaymentConfigRow[K]
  }
}

function assignInteger<K extends keyof PaymentConfigRow>(
  body: Record<string, unknown>,
  input: string,
  patch: Partial<PaymentConfigRow>,
  output: K,
  minimum: number,
  maximum: number,
): void {
  if (body[input] === undefined) return
  patch[output] = requireSafeIntegerValue(body[input], input, minimum, maximum) as PaymentConfigRow[K]
}

function assignText<K extends keyof PaymentConfigRow>(
  body: Record<string, unknown>,
  input: string,
  patch: Partial<PaymentConfigRow>,
  output: K,
  maximum: number,
): void {
  if (body[input] === undefined) return
  const value = optionalTrimmedString(body[input], input, maximum)
  patch[output] = (value ?? '') as PaymentConfigRow[K]
}

function requireFiniteNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new GatewayError(400, `invalid_${field}`, `${field} is outside the supported range`)
  }
  return value
}

function requireSafeIntegerValue(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a safe integer`)
  }
  return value as number
}

function exactScaledInteger(value: number, scale: number, field: string): number {
  const scaled = value * scale
  const rounded = Math.round(scaled)
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-7) {
    throw new GatewayError(400, `invalid_${field}`, `${field} has too many decimal places`)
  }
  return rounded
}

function assertVersion(actual: number, expected: number, resource: string): void {
  if (actual !== expected) throw versionConflict(resource)
  if (expected >= Number.MAX_SAFE_INTEGER) {
    throw new GatewayError(409, `${resource}_version_exhausted`, 'Resource version is exhausted')
  }
}

function versionConflict(resource: string): GatewayError {
  return new GatewayError(412, `${resource}_version_conflict`, 'Resource changed; reload and retry')
}

function parseCreateProvider(body: Record<string, unknown>): {
  name: string
  enabled: boolean
  credential: StripeProviderCredential
} {
  const providerKey = body.provider_key ?? body.provider_type
  if (providerKey !== 'stripe') {
    throw new GatewayError(400, 'unsupported_payment_provider', 'Only Stripe payment providers are supported')
  }
  const name = requiredTrimmedString(body.name ?? body.display_name, 'name', 200)
  const config = requireObject(body.config, 'config')
  const secretKey = requiredTrimmedString(config.secret_key ?? config.secretKey, 'secret_key', 4_096)
  const webhookSecret = optionalTrimmedString(
    config.webhook_secret ?? config.webhookSecret,
    'webhook_secret',
    4_096,
  ) ?? ''
  const publishableKey = optionalTrimmedString(
    config.publishable_key ?? config.publishableKey,
    'publishable_key',
    4_096,
  ) ?? ''
  const supportedTypes = parseSupportedTypes(body.supported_types)
  const paymentMode = optionalTrimmedString(body.payment_mode, 'payment_mode', 32) ?? 'redirect'
  const limits = parseLimitsInput(body.limits)
  const refundEnabled = optionalBoolean(body.refund_enabled, 'refund_enabled') ?? false
  const allowUserRefund = refundEnabled && (optionalBoolean(body.allow_user_refund, 'allow_user_refund') ?? false)
  const result = {
    name,
    enabled: optionalBoolean(body.enabled, 'enabled') ?? true,
    credential: {
      api_key: secretKey,
      webhook_secret: webhookSecret,
      publishable_key: publishableKey,
      supported_types: supportedTypes,
      payment_mode: paymentMode,
      limits,
      refund_enabled: refundEnabled,
      allow_user_refund: allowUserRefund,
    },
  }
  assertRunnableProvider(result.enabled, result.credential)
  return result
}

function parseProviderUpdate(
  body: Record<string, unknown>,
  current: PaymentProviderRow,
  credential: StripeProviderCredential,
): { name: string; enabled: boolean; credential: StripeProviderCredential } {
  if (body.provider_key !== undefined && body.provider_key !== 'stripe') {
    throw new GatewayError(400, 'unsupported_payment_provider', 'Only Stripe payment providers are supported')
  }
  if (body.provider_type !== undefined && body.provider_type !== 'stripe') {
    throw new GatewayError(400, 'unsupported_payment_provider', 'Only Stripe payment providers are supported')
  }
  const config = body.config === undefined ? undefined : requireObject(body.config, 'config')
  const nextApiKey = preservedSecret(config, ['secret_key', 'secretKey'], credential.api_key, 'secret_key')
  const nextWebhookSecret = preservedSecret(
    config,
    ['webhook_secret', 'webhookSecret'],
    credential.webhook_secret,
    'webhook_secret',
  )
  const nextPublishableKey = config === undefined
    ? credential.publishable_key
    : optionalConfigValue(config, ['publishable_key', 'publishableKey'], 'publishable_key')
      ?? credential.publishable_key
  const refundEnabled = optionalBoolean(body.refund_enabled, 'refund_enabled') ?? credential.refund_enabled
  const allowUserRefund = refundEnabled && (
    optionalBoolean(body.allow_user_refund, 'allow_user_refund') ?? credential.allow_user_refund
  )
  return {
    name: body.name === undefined && body.display_name === undefined
      ? current.display_name
      : requiredTrimmedString(body.name ?? body.display_name, 'name', 200),
    enabled: optionalBoolean(body.enabled, 'enabled') ?? current.enabled === 1,
    credential: {
      api_key: nextApiKey,
      webhook_secret: nextWebhookSecret,
      publishable_key: nextPublishableKey,
      supported_types: body.supported_types === undefined
        ? credential.supported_types
        : parseSupportedTypes(body.supported_types),
      payment_mode: body.payment_mode === undefined
        ? credential.payment_mode
        : optionalTrimmedString(body.payment_mode, 'payment_mode', 32) ?? '',
      limits: body.limits === undefined ? credential.limits : parseLimitsInput(body.limits),
      refund_enabled: refundEnabled,
      allow_user_refund: allowUserRefund,
    },
  }
}

function providerResponse(row: PaymentProviderRow, credential: StripeProviderCredential) {
  const config = {
    secret_key_configured: credential.api_key.length > 0,
    webhook_secret_configured: credential.webhook_secret.length > 0,
    publishable_key: credential.publishable_key,
    // Compatibility with the existing provider editor; this value is public.
    publishableKey: credential.publishable_key,
  }
  return {
    id: row.id,
    provider_key: row.provider_key,
    provider_type: row.provider_type,
    name: row.display_name,
    display_name: row.display_name,
    config,
    supported_types: credential.supported_types,
    enabled: row.enabled === 1,
    payment_mode: credential.payment_mode,
    limits: credential.limits,
    refund_enabled: credential.refund_enabled,
    allow_user_refund: credential.allow_user_refund,
    sort_order: 0,
    version: row.version,
    control_version: row.version,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  }
}

function providerMutationResponse(data: unknown, version: number): Response {
  const response = controlSuccess(data)
  response.headers.set('etag', `"${version}"`)
  return response
}

async function requireProviderRow(env: Env, id: string): Promise<PaymentProviderRow> {
  const row = await env.DB.prepare(
    `SELECT ${PROVIDER_COLUMNS} FROM payment_provider_instances WHERE id = ?`,
  ).bind(id).first<PaymentProviderRow>()
  if (row === null) {
    throw new GatewayError(404, 'payment_provider_not_found', 'Payment provider was not found')
  }
  return row
}

async function providerOrderCount(env: Env, id: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM payment_orders WHERE provider_instance_id = ?`,
  ).bind(id).first<{ count: number }>()
  return row?.count ?? 0
}

async function providerOpenOrderCount(env: Env, id: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM payment_orders
      WHERE provider_instance_id = ?
        AND status IN (
          'PENDING', 'PAID', 'RECHARGING',
          'REFUND_REQUESTED', 'REFUNDING', 'REFUND_PENDING'
        )`,
  ).bind(id).first<{ count: number }>()
  return row?.count ?? 0
}

function requireProviderId(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new GatewayError(400, 'invalid_payment_provider_id', 'Payment provider id is invalid')
  }
  return value
}

function requirePaymentVersion(request: Request, body: Record<string, unknown>): number {
  if (
    body.expected_version !== undefined &&
    body.expected_control_version !== undefined &&
    body.expected_version !== body.expected_control_version
  ) {
    throw new GatewayError(400, 'control_version_mismatch', 'Expected version fields disagree')
  }
  const aliased = body.expected_control_version !== undefined || body.expected_version === undefined
    ? body
    : { ...body, expected_control_version: body.expected_version }
  return requireExpectedControlVersion(request, aliased)
}

function preservedSecret(
  config: Record<string, unknown> | undefined,
  keys: string[],
  current: string,
  field: string,
): string {
  if (config === undefined) return current
  const next = optionalConfigValue(config, keys, field)
  return next === undefined || next === '' ? current : next
}

function optionalConfigValue(
  config: Record<string, unknown>,
  keys: string[],
  field: string,
): string | undefined {
  const present = keys.find((key) => config[key] !== undefined)
  if (present === undefined) return undefined
  return optionalTrimmedString(config[present], field, 4_096)
}

function assertRunnableProvider(enabled: boolean, credential: StripeProviderCredential): void {
  if (enabled && (credential.api_key.length === 0 || credential.webhook_secret.length === 0)) {
    throw new GatewayError(
      400,
      'stripe_provider_credentials_required',
      'Enabled Stripe providers require secret_key and webhook_secret',
    )
  }
}

function requirePaymentMasterKey(env: Env): string {
  const key = env.CREDENTIALS_MASTER_KEY
  if (!key || key.length < 32) {
    throw new GatewayError(
      503,
      'payment_encryption_not_configured',
      'Payment provider encryption is not configured',
      'server_error',
    )
  }
  return key
}

function requiredTrimmedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a non-empty string`)
  }
  return value.trim()
}

function optionalTrimmedString(
  value: unknown,
  field: string,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length > maximum) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a string`)
  }
  return value.trim()
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a boolean`)
  }
  return value
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(400, `invalid_${field}`, `${field} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function parseSupportedTypes(value: unknown): string[] {
  if (value === undefined || value === null) return ['stripe']
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && /^[a-z0-9_-]{1,32}$/.test(item))) {
    throw new GatewayError(400, 'invalid_supported_types', 'supported_types must contain valid method names')
  }
  return [...new Set(value)]
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function parseLimitsInput(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'object' && !Array.isArray(value)) {
    value = JSON.stringify(value)
  }
  if (typeof value !== 'string' || value.length > 20_000) {
    throw new GatewayError(400, 'invalid_limits', 'limits must be a JSON object')
  }
  parseLimits(value)
  return value
}

function parseLimits(value: string): Record<string, StripeMethodLimits> {
  if (value === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new GatewayError(400, 'invalid_limits', 'limits must be a JSON object')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayError(400, 'invalid_limits', 'limits must be a JSON object')
  }
  for (const limits of Object.values(parsed as Record<string, unknown>)) {
    if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
      throw new GatewayError(400, 'invalid_limits', 'limits must contain numeric method limits')
    }
    for (const [key, amount] of Object.entries(limits as Record<string, unknown>)) {
      if (!['singleMin', 'singleMax', 'dailyLimit'].includes(key) || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        throw new GatewayError(400, 'invalid_limits', 'limits must contain non-negative numeric method limits')
      }
    }
  }
  return parsed as Record<string, StripeMethodLimits>
}

function invalidProviderRecord(): GatewayError {
  return new GatewayError(503, 'invalid_payment_provider', 'Payment provider configuration is invalid', 'server_error')
}

function mapProviderWriteError(error: unknown): unknown {
  if (error instanceof GatewayError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('UNIQUE constraint')) {
    return new GatewayError(409, 'payment_provider_conflict', 'A payment provider with this key already exists')
  }
  return error
}

function providerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readOptionalJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new GatewayError(400, 'invalid_json', 'Request body must be a JSON object')
  }
}
