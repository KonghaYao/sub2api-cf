import { describe, expect, it } from 'vitest'

import {
  classifySyncImageProviderOutcome,
  decideSyncImageFailover,
  type SyncImageAttemptState,
  type SyncImageFailure,
} from '../../src/media/sync-failover'

describe('synchronous image semantic failover policy', () => {
  it('classifies a Responses content-filter incomplete event as a client policy refusal', () => {
    expect(classifySyncImageProviderOutcome({
      kind: 'response',
      httpStatus: 200,
      imageCount: 0,
      responseStatus: 'incomplete',
      incompleteReason: 'content_filter',
    })).toEqual({
      kind: 'failure',
      failure: {
        kind: 'content_policy',
        status: 400,
        code: 'content_policy_violation',
      },
    })
  })

  it.each([
    {
      name: 'a completed image is successful even when text metadata is present',
      input: {
        kind: 'response' as const, httpStatus: 200, imageCount: 1,
        responseStatus: 'completed' as const, textOutput: 'revised prompt',
      },
      expected: { kind: 'success' },
    },
    {
      name: 'plain text without an image is a request-scoped capability fallback',
      input: {
        kind: 'response' as const, httpStatus: 200, imageCount: 0,
        responseStatus: 'completed' as const, textOutput: 'Here is a polished image prompt.',
      },
      expected: {
        kind: 'failure',
        failure: { kind: 'text_fallback', status: 502, code: 'image_generation_unavailable' },
      },
    },
    {
      name: 'split Chinese safety text is a content-policy refusal',
      input: {
        kind: 'response' as const, httpStatus: 200, imageCount: 0,
        responseStatus: 'completed' as const, textOutput: '安全系统拒绝生成',
      },
      expected: {
        kind: 'failure',
        failure: { kind: 'content_policy', status: 400, code: 'content_policy_violation' },
      },
    },
    {
      name: 'English policy markers are classified case-insensitively',
      input: {
        kind: 'response' as const, httpStatus: 200, imageCount: 0,
        responseStatus: 'completed' as const, textOutput: 'Blocked by our Content Policy.',
      },
      expected: {
        kind: 'failure',
        failure: { kind: 'content_policy', status: 400, code: 'content_policy_violation' },
      },
    },
    {
      name: 'a structured unavailable frame is account capability evidence',
      input: {
        kind: 'response' as const, httpStatus: 200, imageCount: 0,
        error: { type: 'upstream_error', code: 'image_generation_unavailable', message: 'tool absent' },
      },
      expected: {
        kind: 'failure',
        failure: { kind: 'tool_unavailable', status: 502, code: 'image_generation_unavailable' },
      },
    },
    {
      name: 'completed without image or text is a probabilistic soft failure',
      input: {
        kind: 'response' as const, httpStatus: 200, imageCount: 0,
        responseStatus: 'completed' as const,
      },
      expected: {
        kind: 'failure',
        failure: { kind: 'completed_no_image', status: 502, code: 'IMAGE_PROVIDER_OUTPUT_MISSING' },
      },
    },
    {
      name: 'max-output incomplete remains a retryable upstream failure',
      input: {
        kind: 'response' as const, httpStatus: 200, imageCount: 0,
        responseStatus: 'incomplete' as const, incompleteReason: 'max_output_tokens',
      },
      expected: {
        kind: 'failure',
        failure: { kind: 'response_incomplete', status: 502, code: 'response_incomplete' },
      },
    },
    {
      name: 'HTTP 429 is retained as a rate-limit category',
      input: {
        kind: 'response' as const, httpStatus: 429, imageCount: 0,
        retryAfter: '1', error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
      },
      expected: {
        kind: 'failure',
        failure: { kind: 'rate_limited', status: 429, code: 'rate_limit_exceeded', retryAfter: '1' },
      },
    },
    {
      name: 'transport read failure is retryable without retaining its message',
      input: {
        kind: 'transport_error' as const,
        message: 'unexpected EOF at https://secret.example?token=sk-secret',
      },
      expected: {
        kind: 'failure',
        failure: { kind: 'transport_error', status: 502, code: 'IMAGE_UPSTREAM_TRANSPORT_ERROR' },
      },
    },
    {
      name: 'a semantic image user error carried by HTTP 200 is still a client error',
      input: {
        kind: 'response' as const, httpStatus: 200, imageCount: 0,
        responseStatus: 'failed' as const,
        error: { type: 'image_generation_user_error', code: 'invalid_value' },
      },
      expected: {
        kind: 'failure',
        failure: { kind: 'client_error', status: 400, code: 'IMAGE_UPSTREAM_CLIENT_ERROR' },
      },
    },
    {
      name: 'a structured moderation rejection is a content-policy client error',
      input: {
        kind: 'response' as const, httpStatus: 200, imageCount: 0,
        responseStatus: 'failed' as const,
        error: { type: 'image_generation_user_error', code: 'moderation_blocked' },
      },
      expected: {
        kind: 'failure',
        failure: { kind: 'content_policy', status: 400, code: 'content_policy_violation' },
      },
    },
    {
      name: 'a failed moderation service is not confused with a policy rejection',
      input: {
        kind: 'response' as const, httpStatus: 200, imageCount: 0,
        responseStatus: 'failed' as const,
        error: { type: 'server_error', code: 'server_error', message: 'moderation service unavailable' },
      },
      expected: {
        kind: 'failure',
        failure: { kind: 'upstream_error', status: 502, code: 'IMAGE_UPSTREAM_ERROR' },
      },
    },
    {
      name: 'a terminal error after a partial image is not misclassified as success',
      input: {
        kind: 'response' as const, httpStatus: 200, imageCount: 1,
        responseStatus: 'failed' as const,
        error: { type: 'server_error', code: 'server_error' },
      },
      expected: {
        kind: 'failure',
        failure: { kind: 'upstream_error', status: 502, code: 'IMAGE_UPSTREAM_ERROR' },
      },
    },
  ])('$name', ({ input, expected }) => {
    expect(classifySyncImageProviderOutcome(input)).toEqual(expected)
  })

  const initialAttempt: SyncImageAttemptState = {
    upstreamStarted: true,
    outputCommitted: false,
    clientDisconnected: false,
    sameAccountRetries: 0,
    accountSwitches: 0,
    remainingAccounts: 2,
    retryWindowElapsedMs: 0,
  }

  it.each([
    {
      name: 'content policy returns 400 without retry or cooldown',
      failure: { kind: 'content_policy', status: 400, code: 'content_policy_violation' } as SyncImageFailure,
      state: initialAttempt,
      expected: {
        action: 'return_client_error',
        cooldown: { scope: 'none' },
        settlePartial: false,
        exhausted: false,
        error: {
          status: 400, type: 'invalid_request_error', code: 'content_policy_violation',
          message: 'Image request was blocked by content policy',
        },
      },
    },
    {
      name: 'model text fallback switches account without cooling it',
      failure: { kind: 'text_fallback', status: 502, code: 'image_generation_unavailable' } as SyncImageFailure,
      state: initialAttempt,
      expected: {
        action: 'switch_account',
        cooldown: { scope: 'none' },
        settlePartial: false,
        exhausted: false,
        error: {
          status: 502, type: 'upstream_error', code: 'image_generation_unavailable',
          message: 'Upstream did not execute image generation',
        },
      },
    },
    {
      name: 'structured unavailable cools only this account image capability',
      failure: { kind: 'tool_unavailable', status: 502, code: 'image_generation_unavailable' } as SyncImageFailure,
      state: initialAttempt,
      expected: {
        action: 'switch_account',
        cooldown: {
          scope: 'current_account_image_generation', durationMs: 1_800_000,
          reason: 'image_generation_unavailable',
        },
        settlePartial: false,
        exhausted: false,
        error: {
          status: 502, type: 'upstream_error', code: 'image_generation_unavailable',
          message: 'Image generation is unavailable for the upstream account',
        },
      },
    },
    {
      name: 'completed without an image retries the same account first',
      failure: { kind: 'completed_no_image', status: 502, code: 'IMAGE_PROVIDER_OUTPUT_MISSING' } as SyncImageFailure,
      state: initialAttempt,
      expected: {
        action: 'retry_same_account',
        retryDelayMs: 500,
        cooldown: { scope: 'none' },
        settlePartial: false,
        exhausted: false,
        error: {
          status: 502, type: 'upstream_error', code: 'IMAGE_PROVIDER_OUTPUT_MISSING',
          message: 'Image provider returned no image',
        },
      },
    },
    {
      name: 'completed-no-image switches after its same-account retry budget',
      failure: { kind: 'completed_no_image', status: 502, code: 'IMAGE_PROVIDER_OUTPUT_MISSING' } as SyncImageFailure,
      state: { ...initialAttempt, sameAccountRetries: 3 },
      expected: {
        action: 'switch_account',
        cooldown: { scope: 'none' },
        settlePartial: false,
        exhausted: false,
        error: {
          status: 502, type: 'upstream_error', code: 'IMAGE_PROVIDER_OUTPUT_MISSING',
          message: 'Image provider returned no image',
        },
      },
    },
  ])('$name', ({ failure, state, expected }) => {
    expect(decideSyncImageFailover(failure, state)).toEqual(expected)
  })

  it.each([
    {
      name: '429 honors Retry-After while inside the same-account window',
      state: initialAttempt,
      retryAfter: '1',
      expectedDelayMs: 1_000,
    },
    {
      name: '429 caps an excessive Retry-After at eight seconds',
      state: initialAttempt,
      retryAfter: '999',
      expectedDelayMs: 8_000,
    },
    {
      name: '429 never sleeps past the remaining two-minute window',
      state: { ...initialAttempt, retryWindowElapsedMs: 119_500 },
      retryAfter: '30',
      expectedDelayMs: 500,
    },
  ])('$name', ({ state, retryAfter, expectedDelayMs }) => {
    expect(decideSyncImageFailover(
      { kind: 'rate_limited', status: 429, code: 'rate_limit_exceeded', retryAfter },
      state,
    )).toEqual({
      action: 'retry_same_account',
      retryDelayMs: expectedDelayMs,
      cooldown: { scope: 'none' },
      settlePartial: false,
      exhausted: false,
      error: {
        status: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded',
        message: 'Image provider rate limit exceeded', retryAfter,
      },
    })
  })

  it('switches and briefly cools the current account after the 429 window expires', () => {
    expect(decideSyncImageFailover(
      { kind: 'rate_limited', status: 429, code: 'rate_limit_exceeded', retryAfter: '1' },
      { ...initialAttempt, retryWindowElapsedMs: 120_000 },
    )).toEqual({
      action: 'switch_account',
      cooldown: { scope: 'current_account', durationMs: 5_000, reason: 'rate_limited' },
      settlePartial: false,
      exhausted: false,
      error: {
        status: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded',
        message: 'Image provider rate limit exceeded', retryAfter: '1',
      },
    })
  })

  it('does not switch accounts after partial output and asks the caller to settle it', () => {
    expect(decideSyncImageFailover(
      { kind: 'upstream_error', status: 502, code: 'IMAGE_UPSTREAM_ERROR' },
      { ...initialAttempt, outputCommitted: true },
    )).toEqual({
      action: 'return_client_error',
      cooldown: { scope: 'current_account', durationMs: 30_000, reason: 'upstream_failure' },
      settlePartial: true,
      exhausted: false,
      error: {
        status: 502, type: 'upstream_error', code: 'IMAGE_STREAM_INTERRUPTED',
        message: 'Image stream failed after partial output',
      },
    })
  })

  it.each([
    { upstreamStarted: false, outputCommitted: false },
    { upstreamStarted: true, outputCommitted: false },
    { upstreamStarted: true, outputCommitted: true },
  ])('does not fail over after disconnect ($upstreamStarted/$outputCommitted)', (state) => {
    expect(decideSyncImageFailover(
      { kind: 'transport_error', status: 502, code: 'IMAGE_UPSTREAM_TRANSPORT_ERROR' },
      { ...initialAttempt, ...state, clientDisconnected: true },
    )).toEqual({
      action: 'return_client_error',
      cooldown: { scope: 'none' },
      settlePartial: state.outputCommitted,
      exhausted: false,
      error: {
        status: 499, type: 'invalid_request_error', code: 'client_cancelled',
        message: state.upstreamStarted
          ? 'Client disconnected while image generation was running'
          : 'Client cancelled before image generation started',
      },
    })
  })

  it('returns a fixed safe error when account failover is exhausted', () => {
    const classified = classifySyncImageProviderOutcome({
      kind: 'response',
      httpStatus: 503,
      imageCount: 0,
      retryAfter: 'https://private.example/?token=sk-secret',
      error: {
        type: 'server_error',
        code: 'https://private.example/internal',
        message: 'prompt=draw-secret token=sk-secret https://private.example/',
      },
    })
    expect(classified.kind).toBe('failure')
    if (classified.kind !== 'failure') throw new Error('expected a failure')

    const result = decideSyncImageFailover(classified.failure, {
      ...initialAttempt,
      accountSwitches: 3,
      remainingAccounts: 0,
    })
    expect(result).toEqual({
      action: 'return_client_error',
      cooldown: { scope: 'current_account', durationMs: 30_000, reason: 'upstream_failure' },
      settlePartial: false,
      exhausted: true,
      error: {
        status: 502, type: 'upstream_error', code: 'IMAGE_UPSTREAM_RETRY_EXHAUSTED',
        message: 'Image generation failed after trying the available upstream accounts',
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/private\.example|draw-secret|sk-secret/)
  })
})
