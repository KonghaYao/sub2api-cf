import { describe, expect, it } from 'vitest'
import { codexModelsResponse } from '../../src/gateway/codex-models'
import type { ModelRoute } from '../../src/gateway/types'

function route(publicName: string): ModelRoute {
  return {
    config_revision: 1,
    platform: 'openai',
    model_id: `model-${publicName}`,
    public_name: publicName,
    upstream_name: publicName,
    endpoint: 'both',
    embeddings: 0,
    price_id: 'price-1',
    price_version: 1,
    input_micros_per_million: 1,
    output_micros_per_million: 1,
    cache_read_micros_per_million: 1,
    per_request_micros: 0,
    minimum_reservation_micros: 1,
    group_rate_multiplier_ppm: 1_000_000,
    user_rate_multiplier_ppm: null,
    rate_multiplier_ppm: 1_000_000,
    max_output_tokens: 8_192,
    default_max_output_tokens: 4_096,
  }
}

async function models(response: Response): Promise<Array<Record<string, any>>> {
  return (await response.json() as { models: Array<Record<string, any>> }).models
}

describe('legacy Codex model manifest contract', () => {
  it('uses conservative capabilities for an unknown custom model', async () => {
    const response = await codexModelsResponse(
      new Request('https://worker.test/backend-api/codex/models'),
      [route('company-coding-model')],
    )
    const [model] = await models(response)

    expect(model).toMatchObject({
      slug: 'company-coding-model',
      display_name: 'company-coding-model',
      default_reasoning_level: 'none',
      supported_reasoning_levels: [{ effort: 'none', description: 'No additional reasoning' }],
      supports_parallel_tool_calls: false,
      supports_reasoning_summary_parameter: true,
      default_reasoning_summary: 'auto',
      truncation_policy: { mode: 'bytes', limit: 10_000 },
      context_window: 272_000,
      max_context_window: 272_000,
      input_modalities: ['text'],
      service_tiers: [],
    })
  })

  it('advertises the known GPT-5.6 reasoning levels and priority tier', async () => {
    const [model] = await models(await codexModelsResponse(
      new Request('https://worker.test/backend-api/codex/models'),
      [route('provider/gpt-5.6-sol')],
    ))

    expect(model).toMatchObject({
      slug: 'provider/gpt-5.6-sol',
      display_name: 'GPT-5.6 Sol',
      description: 'OpenAI GPT coding model routed through Sub2API.',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
        { effort: 'max' },
        { effort: 'ultra' },
      ],
      supports_parallel_tool_calls: true,
      default_reasoning_summary: 'none',
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      max_context_window: 872_000,
      service_tiers: [{
        id: 'priority',
        name: 'Fast',
        description: 'Priority processing for lower latency.',
      }],
      default_service_tier: null,
    })
  })

  it('does not collapse generic GPT-5 or Grok reasoning metadata to fallback values', async () => {
    const payload = await models(await codexModelsResponse(
      new Request('https://worker.test/backend-api/codex/models'),
      [route('gpt-5.4-mini'), route('gpt-5.6'), route('grok-4.6')],
    ))

    expect(payload[0]).toMatchObject({
      display_name: 'GPT-5.4 Mini',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
      ],
    })
    expect(payload[1]).toMatchObject({
      display_name: 'GPT-5.6',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
        { effort: 'max' },
      ],
    })
    expect(payload[2]).toMatchObject({
      display_name: 'Grok 4.6',
      description: 'Grok coding and reasoning model routed through Sub2API.',
      default_reasoning_level: 'high',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'xhigh' },
      ],
    })
  })

  it('keeps non-fast model tiers empty and omits dedicated media models', async () => {
    const response = await codexModelsResponse(
      new Request('https://worker.test/backend-api/codex/models'),
      [
        route('gpt-4o'),
        route('gpt-image-1'),
        route('openai/gpt-image-2'),
        route('gemini-2.5-flash-image'),
        route('google/models/gemini-3-pro-image'),
        route('grok-imagine-1'),
        route('xai/grok-imagine-video'),
        route('company-model'),
      ],
    )
    const payload = await models(response)

    expect(payload.map((model) => model.slug)).toEqual(['gpt-4o', 'company-model'])
    expect(payload.every((model) => Array.isArray(model.service_tiers) && model.service_tiers.length === 0)).toBe(true)
  })

  it('computes cache validation from the final filtered manifest body', async () => {
    const request = new Request('https://worker.test/backend-api/codex/models')
    const first = await codexModelsResponse(request, [route('gpt-5.6-sol'), route('gpt-image-1')])
    const etag = first.headers.get('etag')
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/)

    const cached = await codexModelsResponse(new Request(request.url, {
      headers: { 'if-none-match': `"old", W/${etag}` },
    }), [route('gpt-5.6-sol'), route('gpt-image-1')])
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe('')
  })
})
