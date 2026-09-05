export interface SyncImageResponseOutcome {
  kind: 'response'
  httpStatus: number
  imageCount: number
  responseStatus?: 'completed' | 'incomplete' | 'failed'
  incompleteReason?: string
  textOutput?: string
  retryAfter?: string
  error?: {
    type?: string
    code?: string
    message?: string
    param?: string
  }
}

export interface SyncImageTransportErrorOutcome {
  kind: 'transport_error'
  message?: string
}

export type SyncImageProviderOutcome = SyncImageResponseOutcome | SyncImageTransportErrorOutcome

export interface SyncImageFailure {
  kind:
    | 'content_policy'
    | 'text_fallback'
    | 'tool_unavailable'
    | 'completed_no_image'
    | 'response_incomplete'
    | 'rate_limited'
    | 'client_error'
    | 'upstream_error'
    | 'transport_error'
  status: number
  code: string
  retryAfter?: string
  providerError?: {
    type: string
    code: string
    message: string
    param?: string
  }
}

export type SyncImageProviderClassification =
  | { kind: 'success' }
  | { kind: 'failure'; failure: SyncImageFailure }

export interface SyncImageAttemptState {
  upstreamStarted: boolean
  outputCommitted: boolean
  clientDisconnected: boolean
  sameAccountRetries: number
  accountSwitches: number
  /** Accounts not yet tried, excluding the current account. */
  remainingAccounts: number
  /** Time already spent in the current account's bounded 429 retry window. */
  retryWindowElapsedMs: number
}

export type SyncImageCooldown =
  | { scope: 'none' }
  | {
    scope: 'current_account'
    durationMs: number
    reason: 'rate_limited' | 'upstream_failure'
  }
  | {
    scope: 'current_account_image_generation'
    durationMs: number
    reason: 'image_generation_unavailable'
  }

export interface SyncImagePublicError {
  status: number
  type: string
  code: string
  message: string
  retryAfter?: string
  param?: string
}

export type SyncImageFailoverDecision = {
  action: 'return_client_error' | 'retry_same_account' | 'switch_account'
  cooldown: SyncImageCooldown
  /** True when already-emitted images must be billed before ending the stream. */
  settlePartial: boolean
  exhausted: boolean
  error: SyncImagePublicError
  retryDelayMs?: number
}

export interface SyncImageFailoverPolicy {
  maxSameAccountRetries: number
  maxAccountSwitches: number
  sameAccountRetryDelayMs: number
  maxRateLimitRetryDelayMs: number
  rateLimitRetryWindowMs: number
  transientCooldownMs: number
  exhaustedRateLimitCooldownMs: number
  toolUnavailableCooldownMs: number
}

export const DEFAULT_SYNC_IMAGE_FAILOVER_POLICY: Readonly<SyncImageFailoverPolicy> = {
  maxSameAccountRetries: 3,
  maxAccountSwitches: 3,
  sameAccountRetryDelayMs: 500,
  maxRateLimitRetryDelayMs: 8_000,
  rateLimitRetryWindowMs: 120_000,
  transientCooldownMs: 30_000,
  exhaustedRateLimitCooldownMs: 5_000,
  toolUnavailableCooldownMs: 1_800_000,
}

export function classifySyncImageProviderOutcome(
  outcome: SyncImageProviderOutcome,
): SyncImageProviderClassification {
  if (outcome.kind === 'transport_error') {
    return failure('transport_error', 502, 'IMAGE_UPSTREAM_TRANSPORT_ERROR')
  }

  const errorType = normalize(outcome.error?.type)
  const errorCode = normalize(outcome.error?.code)
  const errorMessage = normalize(outcome.error?.message)
  const incompleteReason = normalize(outcome.incompleteReason)

  if (
    isPolicySignal(errorType, errorCode, incompleteReason)
    || (errorType === 'image_generation_user_error' && isPolicySignal(errorMessage))
  ) {
    return {
      kind: 'failure',
      failure: { kind: 'content_policy', status: 400, code: 'content_policy_violation' },
    }
  }
  if (errorCode === 'image_generation_unavailable') {
    return failure('tool_unavailable', 502, 'image_generation_unavailable')
  }
  if (outcome.httpStatus === 429 || hasRateLimitSignal(errorType, errorCode)) {
    return failure('rate_limited', 429, 'rate_limit_exceeded', safeRetryAfter(outcome.retryAfter))
  }
  if (outcome.responseStatus === 'incomplete') {
    return failure('response_incomplete', 502, 'response_incomplete')
  }
  if (outcome.error !== undefined || outcome.responseStatus === 'failed' || outcome.httpStatus >= 400) {
    const clientStatus = semanticClientStatus(outcome.httpStatus, errorType, errorCode)
    if (clientStatus !== null) {
      const providerError = {
        type: outcome.error?.type?.trim() || 'invalid_request_error',
        code: outcome.error?.code?.trim() || 'IMAGE_UPSTREAM_CLIENT_ERROR',
        message: outcome.error?.message?.trim() || 'Image provider rejected the request',
        ...(outcome.error?.param?.trim() ? { param: outcome.error.param.trim() } : {}),
      }
      return failure('client_error', clientStatus, providerError.code, undefined, providerError)
    }
    return failure('upstream_error', 502, 'IMAGE_UPSTREAM_ERROR')
  }
  if (outcome.imageCount > 0) return { kind: 'success' }
  const text = outcome.textOutput?.trim() ?? ''
  if (text !== '') {
    if (isPolicySignal(normalize(text))) return failure('content_policy', 400, 'content_policy_violation')
    return failure('text_fallback', 502, 'image_generation_unavailable')
  }
  if (outcome.responseStatus === 'completed') {
    return failure('completed_no_image', 502, 'IMAGE_PROVIDER_OUTPUT_MISSING')
  }
  return failure('upstream_error', 502, 'IMAGE_UPSTREAM_ERROR')
}

export function decideSyncImageFailover(
  failure: SyncImageFailure,
  state: SyncImageAttemptState,
  policy: Readonly<SyncImageFailoverPolicy> = DEFAULT_SYNC_IMAGE_FAILOVER_POLICY,
): SyncImageFailoverDecision {
  const error = publicErrorFor(failure)
  if (state.clientDisconnected) {
    return decision('return_client_error', {
      status: 499,
      type: 'invalid_request_error',
      code: 'client_cancelled',
      message: state.upstreamStarted
        ? 'Client disconnected while image generation was running'
        : 'Client cancelled before image generation started',
    }, { settlePartial: state.outputCommitted })
  }

  const cooldown = cooldownFor(failure, policy)
  if (state.outputCommitted) {
    return decision('return_client_error', {
      status: 502,
      type: 'upstream_error',
      code: 'IMAGE_STREAM_INTERRUPTED',
      message: 'Image stream failed after partial output',
    }, { cooldown, settlePartial: true })
  }
  if (failure.kind === 'content_policy' || failure.kind === 'client_error') {
    return decision('return_client_error', error)
  }

  if (failure.kind === 'rate_limited') {
    const remainingWindowMs = Math.max(0, policy.rateLimitRetryWindowMs - state.retryWindowElapsedMs)
    if (remainingWindowMs > 0) {
      const requestedDelayMs = retryAfterMilliseconds(failure.retryAfter) ?? policy.sameAccountRetryDelayMs
      const retryDelayMs = Math.min(requestedDelayMs, policy.maxRateLimitRetryDelayMs, remainingWindowMs)
      if (retryDelayMs > 0) {
        return decision('retry_same_account', error, { retryDelayMs })
      }
    }
  }

  if (failure.kind === 'completed_no_image' && state.sameAccountRetries < policy.maxSameAccountRetries) {
    return decision('retry_same_account', error, {
      retryDelayMs: policy.sameAccountRetryDelayMs,
    })
  }

  if (canSwitchAccount(state, policy)) return decision('switch_account', error, { cooldown })
  return exhaustedDecision(cooldown)
}

function decision(
  action: SyncImageFailoverDecision['action'],
  error: SyncImagePublicError,
  options: {
    cooldown?: SyncImageCooldown
    exhausted?: boolean
    retryDelayMs?: number
    settlePartial?: boolean
  } = {},
): SyncImageFailoverDecision {
  return {
    action,
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    cooldown: options.cooldown ?? { scope: 'none' },
    settlePartial: options.settlePartial ?? false,
    exhausted: options.exhausted ?? false,
    error,
  }
}

function canSwitchAccount(
  state: SyncImageAttemptState,
  policy: Readonly<SyncImageFailoverPolicy>,
): boolean {
  return state.remainingAccounts > 0 && state.accountSwitches < policy.maxAccountSwitches
}

function cooldownFor(
  failure: SyncImageFailure,
  policy: Readonly<SyncImageFailoverPolicy>,
): SyncImageCooldown {
  if (failure.kind === 'tool_unavailable') {
    return {
      scope: 'current_account_image_generation',
      durationMs: policy.toolUnavailableCooldownMs,
      reason: 'image_generation_unavailable',
    }
  }
  if (failure.kind === 'rate_limited') {
    return {
      scope: 'current_account',
      durationMs: policy.exhaustedRateLimitCooldownMs,
      reason: 'rate_limited',
    }
  }
  if (
    failure.kind === 'upstream_error'
    || failure.kind === 'transport_error'
    || failure.kind === 'response_incomplete'
  ) {
    return {
      scope: 'current_account',
      durationMs: policy.transientCooldownMs,
      reason: 'upstream_failure',
    }
  }
  return { scope: 'none' }
}

function exhaustedDecision(cooldown: SyncImageCooldown): SyncImageFailoverDecision {
  return decision('return_client_error', {
    status: 502,
    type: 'upstream_error',
    code: 'IMAGE_UPSTREAM_RETRY_EXHAUSTED',
    message: 'Image generation failed after trying the available upstream accounts',
  }, { cooldown, exhausted: true })
}

function publicErrorFor(failure: SyncImageFailure): SyncImagePublicError {
  switch (failure.kind) {
    case 'content_policy':
      return {
        status: 400,
        type: 'invalid_request_error',
        code: 'content_policy_violation',
        message: 'Image request was blocked by content policy',
      }
    case 'text_fallback':
      return {
        status: 502,
        type: 'upstream_error',
        code: 'image_generation_unavailable',
        message: 'Upstream did not execute image generation',
      }
    case 'tool_unavailable':
      return {
        status: 502,
        type: 'upstream_error',
        code: 'image_generation_unavailable',
        message: 'Image generation is unavailable for the upstream account',
      }
    case 'completed_no_image':
      return {
        status: 502,
        type: 'upstream_error',
        code: 'IMAGE_PROVIDER_OUTPUT_MISSING',
        message: 'Image provider returned no image',
      }
    case 'response_incomplete':
      return {
        status: 502,
        type: 'upstream_error',
        code: 'response_incomplete',
        message: 'Image provider did not complete image generation',
      }
    case 'rate_limited':
      return {
        status: 429,
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        message: 'Image provider rate limit exceeded',
        ...(safeRetryAfter(failure.retryAfter) === undefined ? {} : { retryAfter: safeRetryAfter(failure.retryAfter) }),
      }
    case 'client_error':
      return failure.providerError === undefined
        ? {
            status: failure.status,
            type: 'invalid_request_error',
            code: 'IMAGE_UPSTREAM_CLIENT_ERROR',
            message: 'Image provider rejected the request',
          }
        : { status: failure.status, ...failure.providerError }
    case 'transport_error':
      return {
        status: 502,
        type: 'upstream_error',
        code: 'IMAGE_UPSTREAM_TRANSPORT_ERROR',
        message: 'Image provider connection failed',
      }
    case 'upstream_error':
      return {
        status: 502,
        type: 'upstream_error',
        code: 'IMAGE_UPSTREAM_ERROR',
        message: 'Image provider request failed',
      }
  }
}

function safeRetryAfter(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return /^\d{1,6}(?:\.\d{1,3})?$/.test(trimmed) ? trimmed : undefined
}

function retryAfterMilliseconds(value: string | undefined): number | null {
  const safe = safeRetryAfter(value)
  if (safe === undefined) return null
  const milliseconds = Number(safe) * 1_000
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null
}

function failure(
  kind: SyncImageFailure['kind'],
  status: number,
  code: string,
  retryAfter?: string,
  providerError?: SyncImageFailure['providerError'],
): SyncImageProviderClassification {
  return {
    kind: 'failure',
    failure: {
      kind,
      status,
      code,
      ...(retryAfter === undefined ? {} : { retryAfter }),
      ...(providerError === undefined ? {} : { providerError }),
    },
  }
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function hasRateLimitSignal(...values: string[]): boolean {
  return values.some((value) => value.includes('rate_limit'))
}

function semanticClientStatus(httpStatus: number, errorType: string, errorCode: string): number | null {
  if (httpStatus >= 400 && httpStatus < 500) return httpStatus
  if (errorType.includes('authentication') || errorCode === 'invalid_api_key' || errorCode === 'unauthorized') {
    return 401
  }
  if (errorType.includes('permission') || errorCode === 'forbidden') return 403
  if (errorType.includes('not_found') || errorCode.includes('not_found')) return 404
  if (errorType.includes('invalid_request') || errorType === 'image_generation_user_error') return 400
  return null
}

function isPolicySignal(...values: string[]): boolean {
  return values.some((value) => CONTENT_POLICY_MARKERS.some((marker) => value.includes(marker)))
}

const CONTENT_POLICY_MARKERS = [
  'content policy', 'content_policy', 'content filter', 'content_filter',
  'safety system', 'safety policy', 'safety violation', 'moderation', 'moderation_blocked',
  '安全系统', '安全策略', '安全政策', '内容政策', '内容审核', '违规内容', '不适合生成',
] as const
