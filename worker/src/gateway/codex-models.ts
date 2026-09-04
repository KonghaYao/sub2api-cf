import { sha256Hex } from './crypto'
import type { ModelRoute } from './types'

interface ReasoningLevel {
  effort: string
  description: string
}

export async function codexModelsResponse(
  request: Request,
  routes: ModelRoute[],
): Promise<Response> {
  const body = JSON.stringify({
    models: routes
      .filter((route) => !isDedicatedMediaModel(route.public_name))
      .map((route) => descriptor(route.public_name)),
  })
  const etag = `"${await sha256Hex(body)}"`
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-cache',
    etag,
  })
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(body, { headers })
}

function descriptor(slug: string) {
  const name = canonicalModelName(slug)
  const efforts = reasoningEfforts(slug)
  const defaultEffort = defaultReasoningEffort(slug, efforts)
  const openAiReasoningModel = name.startsWith('gpt-5')
  const knownToolModel = isKnownToolModel(name)
  return {
    slug,
    display_name: displayName(slug),
    description: modelDescription(name),
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: 50,
    supported_reasoning_levels: efforts.map((effort) => ({
      effort,
      description: reasoningDescription(effort),
    }) satisfies ReasoningLevel),
    default_reasoning_level: defaultEffort,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: openAiReasoningModel ? 'none' : 'auto',
    support_verbosity: openAiReasoningModel,
    default_verbosity: openAiReasoningModel ? 'low' : null,
    supports_parallel_tool_calls: knownToolModel,
    input_modalities: ['text'],
    context_window: contextWindow(slug),
    max_context_window: contextWindow(slug),
    truncation_policy: { mode: openAiReasoningModel ? 'tokens' : 'bytes', limit: 10_000 },
    model_messages: {
      instructions_template: 'You are a coding agent. Follow the user instructions and use tools when needed.',
      instructions_variables: null,
      approvals: null,
      collaboration_modes: null,
      auto_review: null,
      permissions: null,
      multi_agent: null,
      token_budget: null,
      guardian_v2: null,
    },
    service_tiers: supportsPriorityServiceTier(name)
      ? [{
          id: 'priority',
          name: 'Fast',
          description: 'Priority processing for lower latency.',
        }]
      : [],
    additional_speed_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    apply_patch_tool_type: null,
    auto_compact_token_limit: null,
    comp_hash: null,
    auto_review_model_override: null,
    model_specialty: null,
    tool_mode: null,
    multi_agent_version: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_image_detail_original: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    experimental_supported_tools: [],
  }
}

function isKnownToolModel(name: string): boolean {
  return name.startsWith('gpt-') ||
    name.startsWith('claude-') ||
    name.startsWith('deepseek-') ||
    name.startsWith('grok-')
}

function supportsPriorityServiceTier(name: string): boolean {
  return /^gpt-5\.(?:4|5|6)(?:$|-)/.test(name)
}

function isDedicatedMediaModel(slug: string): boolean {
  const name = canonicalModelName(slug)
  return name.startsWith('gpt-image') ||
    /^gemini-(?:2\.5-flash|3\.1-flash|3-pro)-image(?:$|-)/.test(name) ||
    name.startsWith('grok-imagine') ||
    name.startsWith('grok-image') ||
    name.startsWith('grok-video')
}

function reasoningEfforts(slug: string): string[] {
  const name = canonicalModelName(slug)
  if (name.includes('non-reasoning')) return ['none']
  if (name.startsWith('gpt-5')) {
    const levels = ['low', 'medium', 'high', 'xhigh']
    if (name.startsWith('gpt-5.6')) levels.push('max')
    if (name === 'gpt-5.6-sol' || name === 'gpt-5.6-terra') levels.push('ultra')
    return levels
  }
  if (name.startsWith('claude-opus-5')) return ['low', 'medium', 'high', 'xhigh', 'max']
  if (name.startsWith('claude-') && !name.includes('haiku')) return ['low', 'medium', 'high', 'max']
  if (name.startsWith('deepseek-')) return ['low', 'high', 'max']
  if (name.startsWith('grok-4.6')) return ['low', 'medium', 'high', 'xhigh']
  if (name.startsWith('grok-4.5')) return ['low', 'medium', 'high']
  return ['none']
}

function defaultReasoningEffort(slug: string, efforts: string[]): string {
  const name = canonicalModelName(slug)
  if (name === 'gpt-5.6-sol') return 'low'
  if (name.startsWith('deepseek-') || name.startsWith('grok-')) {
    if (efforts.includes('high')) return 'high'
  }
  if (efforts.includes('medium')) return 'medium'
  if (efforts.includes('high')) return 'high'
  return efforts[0]
}

function reasoningDescription(effort: string): string {
  const descriptions: Record<string, string> = {
    none: 'No additional reasoning',
    low: 'Fast responses with lighter reasoning',
    medium: 'Balanced reasoning depth and latency',
    high: 'Greater reasoning depth for coding and agent tasks',
    xhigh: 'Very high reasoning depth for difficult tasks',
    max: 'Maximum reasoning depth for complex tasks',
    ultra: 'Extended reasoning for the most demanding tasks',
  }
  return descriptions[effort] ?? effort
}

function contextWindow(slug: string): number {
  const name = canonicalModelName(slug)
  if (name.startsWith('deepseek-v4')) return 1_000_000
  if (name.startsWith('grok-4.6')) return 500_000
  if (name.startsWith('gpt-5.6')) return 872_000
  return 272_000
}

function canonicalModelName(slug: string): string {
  const value = slug.trim().replace(/^models\//, '')
  return value.slice(value.lastIndexOf('/') + 1).toLowerCase()
}

function displayName(slug: string): string {
  const name = canonicalModelName(slug)
  if (!/^(?:gpt-\d|claude-(?:opus|sonnet|haiku)|deepseek-v\d|grok-\d)/.test(name)) return slug
  if (name.startsWith('gpt-')) {
    return `GPT-${name.slice('gpt-'.length).split('-').map(titlePart).join(' ')}`
  }
  return name.split('-').map((part) => {
    if (part === 'claude') return 'Claude'
    if (part === 'deepseek') return 'DeepSeek'
    if (part === 'grok') return 'Grok'
    return titlePart(part)
  }).join(' ')
}

function titlePart(part: string): string {
  return part.length === 0 ? part : `${part[0].toUpperCase()}${part.slice(1)}`
}

function modelDescription(name: string): string {
  if (name.startsWith('gpt-')) return 'OpenAI GPT coding model routed through Sub2API.'
  if (name.startsWith('claude-')) return 'Claude coding and reasoning model routed through Sub2API.'
  if (name.startsWith('deepseek-')) return 'DeepSeek coding and reasoning model routed through Sub2API.'
  if (name.startsWith('grok-')) return 'Grok coding and reasoning model routed through Sub2API.'
  return 'Custom model routed through Sub2API.'
}

function etagMatches(raw: string | null, current: string): boolean {
  if (raw === null) return false
  return raw.split(',').some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, '')
    return normalized === '*' || normalized === current
  })
}
