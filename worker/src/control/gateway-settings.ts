import { antigravityDefaults, parseAntigravitySettings } from '../gateway/providers/antigravity'
import { grokDefaults, parseGrokSettings } from './grok-settings'
import { accountSchedulingDefaults, parseAccountSchedulingThresholds } from './account-scheduling-settings'
import { codexCLIOnlyDefaults, parseCodexCLIOnlyPatch } from './codex-cli-policy'
import { providerForwardingDefaults, parseProviderForwardingSettings, normalizeProviderForwardingSettings } from './provider-forwarding-settings'
import { securityDefaults, parseSecuritySettings, normalizeSecuritySettings } from './gateway-security-settings'
import { fastPolicyDefaults, normalizeOpenAIFastPolicy } from './openai-fast-policy'
import { opsFeatureDefaults, parseOpsFeaturePatch, normalizeOpsFeature } from './ops-feature-settings'
import { schedulerDefaults, parseSchedulerSettingsPatch, normalizeSchedulerSettings } from './advanced-scheduler-settings'
import type { Env } from '../env'
import { GatewayError } from '../gateway/errors'

export const gatewayDefaults = {
  ...antigravityDefaults,
  ...grokDefaults,
  ...codexCLIOnlyDefaults,
  ...schedulerDefaults,
  ...accountSchedulingDefaults,
  ...providerForwardingDefaults,
  ...securityDefaults,
  ...fastPolicyDefaults,
  ...opsFeatureDefaults,
  enable_model_fallback: false,
  fallback_model_anthropic: '',
  fallback_model_openai: '',
  fallback_model_gemini: '',
  min_claude_code_version: '',
  max_claude_code_version: '',
  min_codex_version: '',
  max_codex_version: '',
  enable_metadata_passthrough: true,
  enable_anthropic_cache_ttl_1h_injection: false,
  rewrite_message_cache_control: false,
}
export type GatewaySettings = typeof gatewayDefaults
export function parseGatewaySettingsPatch(value: unknown, allowReadonly = false): Partial<GatewaySettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('gateway')
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!(key in gatewayDefaults)) throw invalid(key)
    if (key in antigravityDefaults) { Object.assign(result, parseAntigravitySettings({ [key]: item })); continue }
    if (key in grokDefaults) { Object.assign(result, parseGrokSettings({[key]:item})); continue }
    if (key in codexCLIOnlyDefaults) { Object.assign(result, parseCodexCLIOnlyPatch({ [key]: item })); continue }
    if (key === 'account_scheduling_thresholds') { result[key] = parseAccountSchedulingThresholds(item); continue }
    if (key === 'openai_fast_policy_settings') { result[key] = normalizeOpenAIFastPolicy(item); continue }
    if (key in securityDefaults) { Object.assign(result, parseSecuritySettings({ [key]: item })); continue }
    if (key in providerForwardingDefaults) { Object.assign(result, parseProviderForwardingSettings({ [key]: item }, allowReadonly)); continue }
    if (key in schedulerDefaults) { Object.assign(result, parseSchedulerSettingsPatch({ [key]: item })); continue }
    if (key in opsFeatureDefaults) { Object.assign(result, parseOpsFeaturePatch({ [key]: item })); continue }
    const expected = gatewayDefaults[key as keyof GatewaySettings]
    if (typeof item !== typeof expected) throw invalid(key)
    if (typeof item === 'string' && item.length > (key === 'identity_patch_prompt' ? 32768 : 256)) throw invalid(key)
    if (key.endsWith('_version') && typeof item === 'string' && item !== '' && !/^\d+\.\d+\.\d+$/.test(item)) throw invalid(key)
    result[key] = item
  }
  return result
}
export function normalizeGatewaySettings(value: unknown): GatewaySettings {
  const output = { ...gatewayDefaults, ...parseGatewaySettingsPatch(value ?? {}, true) }
  for (const client of ['claude_code', 'codex'] as const) {
    const min = output[`min_${client}_version`], max = output[`max_${client}_version`]
    if (min && max && compareVersion(min, max) > 0) throw invalid(`max_${client}_version`)
  }
  Object.assign(output, normalizeSchedulerSettings(Object.fromEntries(Object.entries(output).filter(([key]) => key in schedulerDefaults))))
  Object.assign(output, normalizeOpsFeature(Object.fromEntries(Object.entries(output).filter(([key]) => key in opsFeatureDefaults))))
  Object.assign(output, normalizeSecuritySettings(Object.fromEntries(Object.entries(output).filter(([key]) => key in securityDefaults))))
  Object.assign(output, normalizeProviderForwardingSettings(Object.fromEntries(Object.entries(output).filter(([key]) => key in providerForwardingDefaults))))
  return output
}
export async function loadGatewaySettings(env: Env): Promise<GatewaySettings> {
  const row = await env.DB.prepare("SELECT gateway_json FROM system_settings WHERE id='global'").first<{ gateway_json: string }>()
  return normalizeGatewaySettings(row ? JSON.parse(row.gateway_json) : {})
}
function invalid(field: string): GatewayError { return new GatewayError(400, 'invalid_settings', `Invalid gateway setting: ${field}`) }
function compareVersion(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}
export function enforceGatewayClientVersion(settings: GatewaySettings, userAgent: string): void {
  for (const [client, expression] of [['claude_code', /(?:claude-cli|claude-code)\/(\d+\.\d+\.\d+)/i], ['codex', /(?:codex_cli_rs|codex-cli|codex)\/(\d+\.\d+\.\d+)/i]] as const) {
    const match = expression.exec(userAgent)
    if (!match) continue
    const min = settings[`min_${client}_version`], max = settings[`max_${client}_version`]
    if ((min && compareVersion(match[1], min) < 0) || (max && compareVersion(match[1], max) > 0)) {
      throw new GatewayError(400, 'unsupported_client_version', 'Client version is outside the configured supported range')
    }
  }
}
export function applyGatewayBodySettings(settings: GatewaySettings, body: Record<string, unknown>, provider: string): Record<string, unknown> {
  const output = structuredClone(body)
  if (!settings.enable_metadata_passthrough) delete output.metadata
  if (provider !== 'anthropic') return output
  if (settings.rewrite_message_cache_control && Array.isArray(output.messages)) {
    const messages = output.messages as Array<Record<string, unknown>>
    for (const message of messages) if (Array.isArray(message.content)) {
      for (const block of message.content) if (block && typeof block === 'object') delete block.cache_control
    }
    const inject = (message: Record<string, unknown> | undefined): void => {
      if (!message) return
      if (typeof message.content === 'string') message.content = [{ type: 'text', text: message.content }]
      if (!Array.isArray(message.content) || message.content.length === 0) return
      const block = message.content[message.content.length - 1]
      if (block && typeof block === 'object') block.cache_control = { type: 'ephemeral', ttl: '5m' }
    }
    inject(messages[messages.length - 1])
    if (messages.length >= 4) inject(messages.filter(message => message.role === 'user').at(-2))
  }
  return output
}
