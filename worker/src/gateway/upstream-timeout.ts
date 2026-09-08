import { GatewayError } from './errors'
import type { AccountFetcher } from '../proxy/account-fetch'
import type { ProviderPlatform } from './providers'

// Match backend/internal/config/config.go gateway defaults. Health probes retain
// their own short deadline; inference must allow upstream queueing and reasoning.
export function responseHeaderTimeout(platform: ProviderPlatform): number {
  if (platform === 'openai' || platform === 'codex') return 0
  return platform === 'grok' ? 120_000 : 600_000
}

export async function fetchWithHeaderTimeout(
  url: URL,
  init: RequestInit,
  clientSignal: AbortSignal,
  timeoutMs: number,
  upstreamFetch: AccountFetcher = fetch,
  keepAlive?: () => Promise<void>,
): Promise<Response> {
  const controller = new AbortController()
  const onClientAbort = () => controller.abort()
  if (clientSignal.aborted) controller.abort()
  else clientSignal.addEventListener('abort', onClientAbort, { once: true })
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  let stopped = false
  let renewalTimer: ReturnType<typeof setTimeout> | undefined
  let pendingRenewal: Promise<void> | undefined
  let renewalError: unknown
  const scheduleRenewal = () => {
    if (!keepAlive || stopped) return
    renewalTimer = setTimeout(() => {
      pendingRenewal = keepAlive().catch(error => {
        renewalError = error
        controller.abort()
      }).finally(scheduleRenewal)
    }, 20_000)
  }
  scheduleRenewal()
  try {
    if (controller.signal.aborted) throw new Error('aborted')
    const response = await upstreamFetch(url, { ...init, signal: controller.signal })
    stopped = true
    await pendingRenewal
    if (renewalError) {
      void response.body?.cancel().catch(() => undefined)
      throw renewalError
    }
    return response
  } catch (error) {
    if (renewalError) throw renewalError
    if (controller.signal.aborted) {
      if (clientSignal.aborted) {
        throw new GatewayError(499, 'client_cancelled', 'Client cancelled the request', 'invalid_request_error')
      }
      throw new GatewayError(504, 'upstream_timeout', 'Upstream did not respond in time', 'server_error')
    }
    if (error instanceof GatewayError) throw error
    throw new GatewayError(502, 'upstream_connection_error', 'Unable to connect to upstream', 'server_error')
  } finally {
    stopped = true
    if (renewalTimer !== undefined) clearTimeout(renewalTimer)
    await pendingRenewal
    if (timer !== undefined) clearTimeout(timer)
    clientSignal.removeEventListener('abort', onClientAbort)
  }
}

