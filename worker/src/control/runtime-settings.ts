import type { Context } from 'hono'
import type { Env } from '../env'
import { authenticateAdminSession } from './admin-auth'
import { controlError, controlSuccess, readJsonObject } from './http'
import { asGatewayError, GatewayError } from '../gateway/errors'

export interface RuntimeSettings {
  'overload-cooldown': { enabled: boolean; cooldown_minutes: number }
  'rate-limit-429-cooldown': { enabled: boolean; cooldown_seconds: number }
  'panel-rate-limit': { enabled: boolean; user_rpm: number; heavy_rpm: number; exempt_admin: boolean; public_ip_rpm: number }
  'stream-timeout': { enabled: boolean; action: 'none' | 'error' | 'temp_unsched'; temp_unsched_minutes: number; threshold_count: number; threshold_window_minutes: number }
  rectifier: { enabled: boolean; thinking_signature_enabled: boolean; thinking_budget_enabled: boolean; apikey_signature_enabled: boolean; apikey_signature_patterns: string[] }
  'beta-policy': { rules: BetaRule[] }
}
export interface BetaRule {
  beta_token: string; action: 'pass' | 'filter' | 'block'; scope: 'all' | 'oauth' | 'apikey' | 'bedrock'
  error_message?: string; model_whitelist?: string[]; fallback_action?: 'pass' | 'filter' | 'block'; fallback_error_message?: string
}
export type RuntimeSettingName = keyof RuntimeSettings
export const runtimeSettingNames: RuntimeSettingName[] = ['overload-cooldown', 'rate-limit-429-cooldown', 'panel-rate-limit', 'stream-timeout', 'rectifier', 'beta-policy']
export const runtimeDefaults: RuntimeSettings = {
  'overload-cooldown': { enabled: true, cooldown_minutes: 10 },
  'rate-limit-429-cooldown': { enabled: true, cooldown_seconds: 5 },
  'panel-rate-limit': { enabled: true, user_rpm: 240, heavy_rpm: 60, exempt_admin: true, public_ip_rpm: 300 },
  'stream-timeout': { enabled: false, action: 'temp_unsched', temp_unsched_minutes: 5, threshold_count: 3, threshold_window_minutes: 10 },
  rectifier: { enabled: true, thinking_signature_enabled: true, thinking_budget_enabled: true, apikey_signature_enabled: false, apikey_signature_patterns: [] },
  'beta-policy': { rules: [
    { beta_token: 'fast-mode-2026-02-01', action: 'filter', scope: 'all' },
    { beta_token: 'context-1m-2025-08-07', action: 'pass', scope: 'all', model_whitelist: ['claude-sonnet-5', 'claude-sonnet-5-*', 'claude-sonnet-5@*', 'us.anthropic.claude-sonnet-5*', 'eu.anthropic.claude-sonnet-5*', 'apac.anthropic.claude-sonnet-5*', 'jp.anthropic.claude-sonnet-5*', 'au.anthropic.claude-sonnet-5*', 'us-gov.anthropic.claude-sonnet-5*', 'global.anthropic.claude-sonnet-5*', 'anthropic.claude-sonnet-5*'], fallback_action: 'filter' },
  ] },
}

type Stored = { value_json: string; control_version: number }
export async function loadRuntimeSetting<K extends RuntimeSettingName>(env: Env, name: K): Promise<RuntimeSettings[K]> {
  const row = await env.DB.prepare('SELECT value_json,control_version FROM runtime_settings WHERE name=?').bind(name).first<Stored>()
  if (row === null) return structuredClone(runtimeDefaults[name])
  try { return validateRuntimeSetting(name, JSON.parse(row.value_json)) }
  catch { throw new GatewayError(503, 'invalid_runtime_settings', 'Runtime configuration is invalid', 'server_error') }
}

export function runtimeSettingHandlers(name: RuntimeSettingName) {
  return {
    get: async (context: Context<{ Bindings: Env }>) => {
      try {
        await authenticateAdminSession(context.req.raw, context.env)
        return controlSuccess(await loadRuntimeSetting(context.env, name))
      } catch (error) { return controlError(asGatewayError(error)) }
    },
    put: async (context: Context<{ Bindings: Env }>) => {
      try {
        const actor = await authenticateAdminSession(context.req.raw, context.env)
        const value = validateRuntimeSetting(name, await readJsonObject(context.req.raw, 32_768))
        const current = await context.env.DB.prepare('SELECT control_version FROM runtime_settings WHERE name=?').bind(name).first<{ control_version: number }>()
        const version = current?.control_version ?? 0
        const expected = context.req.header('if-match')
        if (expected !== undefined && expected !== `"${version}"`) throw new GatewayError(409, 'settings_version_conflict', 'Settings changed; reload and retry')
        const row = await context.env.DB.prepare(`INSERT INTO runtime_settings(name,value_json,control_version,updated_by,updated_at_ms) VALUES(?,?,1,?,?)
          ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json,control_version=runtime_settings.control_version+1,updated_by=excluded.updated_by,updated_at_ms=excluded.updated_at_ms
          WHERE runtime_settings.control_version=? RETURNING control_version`).bind(name, JSON.stringify(value), actor.user_id, Date.now(), version).first<{ control_version: number }>()
        if (row === null) throw new GatewayError(409, 'settings_version_conflict', 'Settings changed; reload and retry')
        return controlSuccess(value)
      } catch (error) { return controlError(asGatewayError(error)) }
    },
  }
}

function invalid(field: string): never { throw new GatewayError(400, 'invalid_runtime_settings', `${field} is invalid`) }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('settings'); return value as Record<string, unknown> }
function bool(value: unknown, field: string): boolean { if (typeof value !== 'boolean') invalid(field); return value }
function number(value: unknown, field: string, min: number, max: number): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(field); return Number(value) }
function text(value: unknown, field: string, max = 512): string { if (typeof value !== 'string' || value.length > max || /[\r\n\0]/.test(value)) invalid(field); return value }
function strings(value: unknown, field: string, max = 100): string[] { if (!Array.isArray(value) || value.length > max) invalid(field); return value.map(v => text(v,field).trim()).filter(v => v.length > 0) }
function enumeration<T extends string>(value: unknown, allowed: readonly T[], field: string): T { if (!allowed.includes(value as T)) invalid(field); return value as T }
export function validateRuntimeSetting<K extends RuntimeSettingName>(name: K, value: unknown): RuntimeSettings[K] {
  const body = object(value), allowed = Object.keys(runtimeDefaults[name])
  for (const field of Object.keys(body)) if (!allowed.includes(field)) invalid(field)
  let result: unknown
  if (name === 'overload-cooldown') result = { enabled: bool(body.enabled,'enabled'), cooldown_minutes: number(body.cooldown_minutes,'cooldown_minutes',1,120) }
  else if (name === 'rate-limit-429-cooldown') result = { enabled: bool(body.enabled,'enabled'), cooldown_seconds: number(body.cooldown_seconds,'cooldown_seconds',1,7200) }
  else if (name === 'panel-rate-limit') result = { enabled: bool(body.enabled,'enabled'), user_rpm: number(body.user_rpm,'user_rpm',0,100000), heavy_rpm: number(body.heavy_rpm,'heavy_rpm',0,100000), exempt_admin: bool(body.exempt_admin,'exempt_admin'), public_ip_rpm: number(body.public_ip_rpm,'public_ip_rpm',0,100000) }
  else if (name === 'stream-timeout') result = { enabled: bool(body.enabled,'enabled'), action: enumeration(body.action,['none','error','temp_unsched'],'action'), temp_unsched_minutes: number(body.temp_unsched_minutes,'temp_unsched_minutes',1,120), threshold_count: number(body.threshold_count,'threshold_count',1,10), threshold_window_minutes: number(body.threshold_window_minutes,'threshold_window_minutes',1,60) }
  else if (name === 'rectifier') result = { enabled: bool(body.enabled,'enabled'), thinking_signature_enabled: bool(body.thinking_signature_enabled,'thinking_signature_enabled'), thinking_budget_enabled: bool(body.thinking_budget_enabled,'thinking_budget_enabled'), apikey_signature_enabled: bool(body.apikey_signature_enabled,'apikey_signature_enabled'), apikey_signature_patterns: strings(body.apikey_signature_patterns,'apikey_signature_patterns') }
  else {
    if (!Array.isArray(body.rules) || body.rules.length > 100) invalid('rules')
    result = { rules: body.rules.map(value => {
      const rule = object(value)
      for (const key of Object.keys(rule)) if (!['beta_token','action','scope','error_message','model_whitelist','fallback_action','fallback_error_message'].includes(key)) invalid(key)
      const token = text(rule.beta_token,'beta_token',200)
      if (!/^[A-Za-z0-9._-]+$/.test(token)) invalid('beta_token')
      return { beta_token: token, action: enumeration(rule.action,['pass','filter','block'],'action'), scope: enumeration(rule.scope,['all','oauth','apikey','bedrock'],'scope'), ...(rule.error_message === undefined ? {} : { error_message: text(rule.error_message,'error_message') }), ...(rule.model_whitelist === undefined ? {} : { model_whitelist: strings(rule.model_whitelist,'model_whitelist') }), ...(rule.fallback_action === undefined ? {} : { fallback_action: enumeration(rule.fallback_action,['pass','filter','block'],'fallback_action') }), ...(rule.fallback_error_message === undefined ? {} : { fallback_error_message: text(rule.fallback_error_message,'fallback_error_message') }) }
    }) }
  }
  return result as RuntimeSettings[K]
}
