import type { Context } from 'hono'
import { authenticateUserRequest } from '../auth/handler'
import { controlError, controlSuccess } from '../control/http'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from './errors'

type Bindings = { Bindings: Env }

interface PlazaRow {
  group_id: string
  group_name: string
  group_description: string | null
  group_platform: string
  group_type: 'standard' | 'subscription'
  group_rate_multiplier_ppm: number
  user_rate_multiplier_ppm: number | null
  is_exclusive: number
  public_name: string
  model_platform: string
  input_micros_per_million: number
  output_micros_per_million: number
  cache_read_micros_per_million: number
  per_request_micros: number
}

interface PlazaSettings {
  enabled: boolean
  requireAuth: boolean
  description: string
}

/** Public/optional-session model catalog. Never selects account or credential fields. */
export async function getModelPlaza(context: Context<Bindings>): Promise<Response> {
  try {
    const settings = await readPlazaSettings(context.env)
    if (!settings.enabled) {
      throw new GatewayError(404, 'model_plaza_disabled', 'Model plaza is not enabled')
    }
    const authorization = context.req.raw.headers.get('authorization')
    const user = authorization === null
      ? null
      : await authenticateUserRequest(context.req.raw, context.env)
    if (settings.requireAuth && user === null) {
      throw new GatewayError(401, 'authentication_required', 'Authentication required', 'authentication_error')
    }
    const now = Date.now()
    const rows = await context.env.DB.prepare(
      `SELECT g.id AS group_id, g.name AS group_name,
              g.description AS group_description, g.platform AS group_platform,
              g.group_type, g.rate_multiplier_ppm AS group_rate_multiplier_ppm,
              rate.rate_multiplier_ppm AS user_rate_multiplier_ppm,
              g.is_exclusive,
              m.public_name, m.platform AS model_platform,
              p.input_micros_per_million, p.output_micros_per_million,
              p.cache_read_micros_per_million, p.per_request_micros
         FROM "groups" g
         JOIN group_models gm ON gm.group_id = g.id
         JOIN models m ON m.id = gm.model_id
         JOIN model_prices p ON p.group_id = g.id AND p.model_id = m.id AND p.active = 1
         LEFT JOIN user_group_rate_overrides rate
           ON rate.group_id = g.id AND rate.user_id = ?
        WHERE g.enabled = 1 AND gm.enabled = 1 AND m.enabled = 1
          AND (g.catalog_mode = 'all_routable' OR gm.catalog_visible = 1)
          AND (
            g.is_exclusive = 0
            OR (? <> '' AND EXISTS (
              SELECT 1 FROM user_group_permissions permission
               WHERE permission.user_id = ? AND permission.group_id = g.id
            ))
            OR (? <> '' AND EXISTS (
              SELECT 1 FROM user_subscriptions subscription
               WHERE subscription.user_id = ? AND subscription.group_id = g.id
                 AND subscription.status = 'active'
                 AND subscription.starts_at_ms <= ? AND subscription.expires_at_ms > ?
            ))
          )
          AND EXISTS (
            SELECT 1
              FROM account_groups ag
              JOIN accounts a ON a.id = ag.account_id
              JOIN account_models am ON am.account_id = a.id AND am.model_id = m.id
             WHERE ag.group_id = g.id AND a.enabled = 1
               AND a.health_status <> 'unhealthy' AND a.base_url IS NOT NULL
               AND a.platform = m.platform
               AND (m.platform = g.platform OR g.platform = 'composite')
               AND (
                 (m.endpoint = 'chat_completions' AND (am.chat_completions = 1 OR
                   (a.platform IN ('openai', 'codex') AND am.responses = 1)))
                 OR (m.endpoint = 'responses' AND (am.responses = 1 OR
                   (a.platform = 'openai' AND am.chat_completions = 1)))
                 OR (m.endpoint = 'both' AND (am.chat_completions = 1 OR am.responses = 1))
                 OR (m.embeddings = 1 AND am.embeddings = 1)
               )
          )
        ORDER BY g.rate_multiplier_ppm ASC, lower(g.name) ASC,
                 gm.sort_order ASC, m.public_name ASC`,
    ).bind(
      user?.id ?? '',
      user?.id ?? '', user?.id ?? '',
      user?.id ?? '', user?.id ?? '', now, now,
    ).all<PlazaRow>()

    return controlSuccess({
      description: settings.description,
      groups: groupRows(rows.results),
    })
  } catch (error) {
    return controlError(asGatewayError(error))
  }
}

async function readPlazaSettings(env: Env): Promise<PlazaSettings> {
  const row = await env.DB.prepare(
    `SELECT public_json FROM system_settings WHERE id = 'global'`,
  ).first<{ public_json: string }>()
  if (row === null) return { enabled: false, requireAuth: true, description: '' }
  let value: unknown
  try { value = JSON.parse(row.public_json) } catch {
    return { enabled: false, requireAuth: true, description: '' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { enabled: false, requireAuth: true, description: '' }
  }
  const settings = value as Record<string, unknown>
  if (
    typeof settings.model_plaza_enabled !== 'boolean' ||
    typeof settings.model_plaza_require_auth !== 'boolean' ||
    typeof settings.model_plaza_description !== 'string'
  ) return { enabled: false, requireAuth: true, description: '' }
  return {
    enabled: settings.model_plaza_enabled,
    requireAuth: settings.model_plaza_require_auth,
    description: settings.model_plaza_description,
  }
}

function groupRows(rows: PlazaRow[]): Record<string, unknown>[] {
  const groups = new Map<string, { data: Record<string, unknown>; models: Record<string, unknown>[] }>()
  for (const row of rows) {
    let group = groups.get(row.group_id)
    if (group === undefined) {
      const userRate = validPpm(row.user_rate_multiplier_ppm)
      group = {
        data: {
          id: row.group_id,
          name: row.group_name,
          description: row.group_description ?? '',
          platform: row.group_platform,
          subscription_type: row.group_type,
          rate_multiplier: ppm(row.group_rate_multiplier_ppm),
          ...(userRate === null ? {} : { user_rate_multiplier: ppm(userRate) }),
          peak_rate_enabled: false,
          peak_start: '',
          peak_end: '',
          peak_rate_multiplier: 1,
          is_exclusive: row.is_exclusive === 1,
          image_rate_independent: false,
          image_rate_multiplier: 1,
          long_context_pricing_enabled: false,
        },
        models: [],
      }
      groups.set(row.group_id, group)
    }
    const effectivePpm = validPpm(row.user_rate_multiplier_ppm) ?? validPpm(row.group_rate_multiplier_ppm) ?? 1_000_000
    group.models.push({
      name: row.public_name,
      platform: row.model_platform,
      pricing: pricing(row, effectivePpm),
      official_pricing: null,
    })
  }
  return Array.from(groups.values(), (group) => ({ ...group.data, models: group.models }))
}

function pricing(row: PlazaRow, multiplierPpm: number): Record<string, unknown> {
  const perToken = (microsPerMillion: number) => (microsPerMillion / 1_000_000_000_000) * ppm(multiplierPpm)
  const perRequest = (micros: number) => (micros / 1_000_000) * ppm(multiplierPpm)
  const billingMode = row.per_request_micros > 0 &&
    row.input_micros_per_million === 0 && row.output_micros_per_million === 0
    ? 'per_request'
    : 'token'
  return {
    billing_mode: billingMode,
    input_price: perToken(row.input_micros_per_million),
    output_price: perToken(row.output_micros_per_million),
    cache_write_price: null,
    cache_read_price: perToken(row.cache_read_micros_per_million),
    image_input_price: null,
    image_output_price: null,
    per_request_price: row.per_request_micros === 0 ? null : perRequest(row.per_request_micros),
    intervals: [],
  }
}

function validPpm(value: number | null): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value : null
}

function ppm(value: number): number { return value / 1_000_000 }
