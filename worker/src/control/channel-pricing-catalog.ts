import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { authenticateAdminSession } from './admin-auth'
import { controlError, controlSuccess } from './http'

type ControlBindings = { Bindings: Env }
type CatalogProvider =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'xai'
  | 'moonshot'
  | 'zhipu'
  | 'deepseek'

interface CatalogPrice {
  model: string
  provider: CatalogProvider
  /** Integer micro-USD per one million tokens. */
  input: number
  output: number
  cacheWrite?: number
  cacheWrite1h?: number
  cacheRead?: number
  imageInput?: number
  imageOutput?: number
}

const MAX_MODEL_LENGTH = 256
const MAX_PLATFORM_LENGTH = 32
const PER_TOKEN_DIVISOR = 1_000_000_000_000

// The catalog is deliberately a small last-known-good seed. It powers admin
// form helpers only; gateway billing remains authoritative in D1.
const SEED = [
  price('claude-3-5-haiku', 'anthropic', 1_000_000, 5_000_000, 1_250_000, 100_000),
  price('claude-3-5-sonnet', 'anthropic', 3_000_000, 15_000_000, 3_750_000, 300_000),
  price('claude-fable-5-1', 'anthropic', 10_000_000, 50_000_000, 12_500_000, 250_000, 20_000_000),
  price('claude-opus-4.5', 'anthropic', 5_000_000, 25_000_000, 6_250_000, 500_000),
  price('claude-sonnet-4', 'anthropic', 3_000_000, 15_000_000, 3_750_000, 300_000),
  price('gpt-5.2', 'openai', 1_750_000, 14_000_000, 1_750_000, 175_000),
  price('gpt-5.4', 'openai', 2_500_000, 15_000_000, 2_500_000, 250_000),
  price('gpt-5.6-luna', 'openai', 200_000, 1_200_000, 250_000, 20_000),
  price('gpt-5.6-sol', 'openai', 5_000_000, 30_000_000, 6_250_000, 500_000),
  price('gpt-5.6-terra', 'openai', 2_000_000, 12_000_000, 2_500_000, 200_000),
  price('gemini-3.1-pro', 'gemini', 2_000_000, 12_000_000, 2_000_000, 200_000),
  price('gemini-3.6-flash', 'gemini', 1_500_000, 7_500_000, 0, 150_000),
  price('grok-4.5', 'xai', 2_000_000, 6_000_000, 0, 300_000),
  price('grok-4.6', 'xai', 2_000_000, 6_000_000, 0, 500_000),
  price('kimi-k2.6', 'moonshot', 950_000, 4_000_000, 0, 150_000),
  price('kimi-k3', 'moonshot', 3_000_000, 15_000_000, 0, 300_000),
  price('glm-4.7', 'zhipu', 600_000, 2_200_000, 0, 110_000),
  price('glm-5.2', 'zhipu', 1_400_000, 4_400_000, 0, 260_000),
  price('deepseek-v4-flash', 'deepseek', 220_000, 660_000, 0, 7_000),
  price('deepseek-v4-pro', 'deepseek', 660_000, 1_980_000, 0, 22_000),
] as const satisfies readonly CatalogPrice[]

const BY_MODEL = new Map<string, CatalogPrice>(SEED.map((entry) => [entry.model, entry]))
const MODELS_BY_PROVIDER = buildProviderIndex(SEED)

const PLATFORM_PROVIDERS: Readonly<Record<string, CatalogProvider>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'gemini',
  antigravity: 'anthropic',
  grok: 'xai',
  kimi: 'moonshot',
  zhipu: 'zhipu',
  deepseek: 'deepseek',
}

export async function getAdminChannelModelPricing(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const model = requiredQuery(context.req.query('model'), 'model', MAX_MODEL_LENGTH)
    const found = BY_MODEL.get(normalizeModel(model))
    if (found === undefined) return controlSuccess({ found: false })
    return controlSuccess(publicPrice(found))
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

export async function listAdminChannelPricingModels(
  context: Context<ControlBindings>,
): Promise<Response> {
  try {
    await authenticateAdminSession(context.req.raw, context.env)
    const platform = requiredQuery(
      context.req.query('platform'),
      'platform',
      MAX_PLATFORM_LENGTH,
    ).toLowerCase()
    const provider = PLATFORM_PROVIDERS[platform]
    if (provider === undefined) {
      throw new GatewayError(
        400,
        'UNSUPPORTED_PLATFORM',
        `unsupported platform: ${platform}`,
        'invalid_request_error',
        undefined,
        'platform',
      )
    }
    return controlSuccess({ models: MODELS_BY_PROVIDER.get(provider) ?? [] })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

function price(
  model: string,
  provider: CatalogProvider,
  input: number,
  output: number,
  cacheWrite: number,
  cacheRead: number,
  cacheWrite1h?: number,
): CatalogPrice {
  return { model, provider, input, output, cacheWrite, cacheRead, cacheWrite1h }
}

function buildProviderIndex(entries: readonly CatalogPrice[]): Map<CatalogProvider, string[]> {
  const grouped = new Map<CatalogProvider, Set<string>>()
  for (const entry of entries) {
    const names = grouped.get(entry.provider) ?? new Set<string>()
    names.add(entry.model)
    grouped.set(entry.provider, names)
  }
  return new Map(
    [...grouped].map(([provider, names]) => [provider, [...names].sort()]),
  )
}

function normalizeModel(model: string): string {
  const lower = model.trim().toLowerCase().replace(/^\/+/, '')
  const marker = '/models/'
  const markerIndex = lower.lastIndexOf(marker)
  if (markerIndex >= 0) return lower.slice(markerIndex + marker.length)
  return lower.startsWith('models/') ? lower.slice('models/'.length) : lower
}

function requiredQuery(raw: string | undefined, name: string, maximum: number): string {
  const value = raw?.trim() ?? ''
  if (value === '') {
    throw new GatewayError(
      400,
      'MISSING_PARAMETER',
      `${name} parameter is required`,
      'invalid_request_error',
      undefined,
      name,
    )
  }
  if (value.length > maximum) {
    throw new GatewayError(
      400,
      'INVALID_PARAMETER',
      `${name} must not exceed ${maximum} characters`,
      'invalid_request_error',
      undefined,
      name,
    )
  }
  return value
}

function publicPrice(value: CatalogPrice): Record<string, number | boolean | null> {
  return {
    found: true,
    input_price: perToken(value.input),
    output_price: perToken(value.output),
    cache_write_price: perToken(value.cacheWrite ?? 0),
    cache_write_1h_price: value.cacheWrite1h === undefined ? null : perToken(value.cacheWrite1h),
    cache_read_price: perToken(value.cacheRead ?? 0),
    image_input_price: perToken(value.imageInput ?? 0),
    image_output_price: perToken(value.imageOutput ?? 0),
  }
}

function perToken(microsPerMillion: number): number {
  return microsPerMillion / PER_TOKEN_DIVISOR
}
