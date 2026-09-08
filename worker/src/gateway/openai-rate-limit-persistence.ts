import { saveAccountRuntimeObservation } from './account-runtime-observation'
import type { Env } from '../env'
import type { AccountCredential } from './types'
import { openAIRateLimitReset } from './openai-rate-limit-reset'

/** Only the credential/config snapshot that actually received 429 may be changed. */
export async function persistOpenAIRateLimit(env: Env, account: Pick<AccountCredential, 'account_id' | 'secret_id' | 'platform' | 'runtime_snapshot'>, response: Response): Promise<boolean> {
  const snapshot = account.runtime_snapshot
  if (response.status !== 429 || !['openai', 'codex'].includes(account.platform) || !snapshot) return false
  const ui = JSON.parse(snapshot.ui_config_json) as Record<string, unknown>
  if (!defaultAccountErrorPolicyAllowed(ui, response.status)) return false
  let reset = openAIRateLimitReset(response.headers, '')
  if (reset === null) reset = openAIRateLimitReset(response.headers, await boundedErrorBody(response))
  if (reset === null) return false
  const limitedAt = new Date().toISOString(), resetAt = new Date(reset).toISOString()
  return saveAccountRuntimeObservation(env, account, current => ({ ...current, rate_limited_at: limitedAt, rate_limit_reset_at: resetAt }), 'reset')

}

/** Cloning preserves the original error response for existing retry/error policy. */
export async function boundedErrorBody(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader()
  if (!reader) return ''
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const decoder = new TextDecoder(); let body = '', bytes = 0
        while (true) {
          const next = await reader.read()
          if (next.done) return body + decoder.decode()
          bytes += next.value.byteLength
          if (bytes > 64 * 1024) return ''
          body += decoder.decode(next.value, { stream: true })
        }
      })(),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve(''), 2000) }),
    ])
  } catch { return '' }
  finally {
    clearTimeout(timer)
    // Awaiting cancellation of a tee branch can deadlock until the original is read.
    void reader.cancel().catch(() => {})
  }
}

/** Original ShouldHandleErrorCode / pool-mode gates precede default runtime mutation. */
export function defaultAccountErrorPolicyAllowed(ui: Record<string, unknown>, status: number): boolean {
  const raw = ui.credentials
  const credentials = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  // Pre-projection accounts used API keys; original OAuth/setup-token types never use these API-key switches.
  const type = ui.type ?? 'apikey'
  const custom = type === 'apikey' && credentials.custom_error_codes_enabled === true
  if (custom) {
    const codes = Array.isArray(credentials.custom_error_codes)
      ? credentials.custom_error_codes.filter((code): code is number => typeof code === 'number' && Number.isFinite(code)).map(Math.trunc) : []
    return codes.length === 0 || codes.includes(status)
  }
  return !(['apikey', 'bedrock'].includes(String(type)) && credentials.pool_mode === true)
}
