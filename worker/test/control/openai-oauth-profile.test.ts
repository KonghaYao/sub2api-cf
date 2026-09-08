import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { enrichOpenAITokenInfo, openAITokenInfo, selectChatGPTAccount } from '../../src/control/openai-oauth-profile'
import { openAIOAuthHttp, requestOpenAITokens } from '../../src/control/openai-oauth-http'

const jwt = (claims: unknown) => `header.${btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(claims))))}.signature`
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe('original OpenAI OAuth profile semantics', () => {
  it('decodes UTF-8 profile metadata and selects the default organization without treating JWT metadata as authorization', () => {
    expect(openAITokenInfo({ access_token: 'access', id_token: jwt({ email: '用户@example.test', 'https://api.openai.com/auth': {
      chatgpt_account_id: 'personal', chatgpt_user_id: 'user', chatgpt_plan_type: 'plus', organizations: [{ id: 'first' }, { id: 'default', is_default: true }],
    } }), expires_in: 3600 }, 'client', 1000)).toMatchObject({ email: '用户@example.test', organization_id: 'default', plan_type: 'plus', expires_at: 3601 })
  })
  it('ignores expired ID-token claims after the original two-minute tolerance', () => {
    const tokens = { access_token: 'access', id_token: jwt({ exp: 100, email: 'old@example.test' }) }
    expect(openAITokenInfo(tokens, 'client', 220000).email).toBe('old@example.test')
    expect(openAITokenInfo(tokens, 'client', 221000).email).toBeUndefined()
    expect(openAITokenInfo({ access_token: 'access', id_token: 'malformed' }, 'client').access_token).toBe('access')
  })
  it('selects active org, then default, paid, or any account and ignores disabled/expired workspaces', () => {
    const data = { accounts: {
      dead: { account: { plan_type: 'team', is_default: true, status: 'deactivated' } },
      expired: { account: { plan_type: 'team' }, entitlement: { expires_at: '2000-01-01T00:00:00Z' } },
      free: { account: { plan_type: 'free', is_default: true } },
      paid: { account: { plan_type: 'plus', account_id: 'personal-paid' } },
    } }
    expect(selectChatGPTAccount(data, 'paid')).toMatchObject({ plan: 'plus', id: 'personal-paid' })
    expect(selectChatGPTAccount(data, 'dead')).toMatchObject({ plan: 'free', id: 'free' })
    data.accounts.free.account.is_default = false
    expect(selectChatGPTAccount(data, '')).toMatchObject({ plan: 'plus' })
  })
  it.each([false, true])('keeps the ID-token personal plan and fetches matching personal subscription expiry when accounts/check selects a workspace (failure=%s)', async fail => {
    const info = openAITokenInfo({ access_token: 'access', id_token: jwt({ 'https://api.openai.com/auth': {
      chatgpt_account_id: 'personal', chatgpt_plan_type: 'pro', organizations: [{ id: 'workspace' }],
    } }) }, 'client')
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/accounts/check/')) return Response.json({ accounts: { workspace: {
        account: { account_id: 'workspace', plan_type: 'self_serve_business_usage_based' }, entitlement: { expires_at: '2099-06-01T00:00:00Z' },
      } } })
      if (url.includes('/subscriptions?')) {
        expect(new URL(url).searchParams.get('account_id')).toBe('personal')
        return fail ? new Response('', { status: 503 }) : Response.json({ active_until: '2099-01-01T00:00:00Z' })
      }
      return new Response('Just a moment cloudflare', { status: 403 })
    })
    vi.stubGlobal('fetch', fetcher)
    await enrichOpenAITokenInfo({} as Env, info, null)
    expect(info.plan_type).toBe('pro')
    expect(info.subscription_expires_at).toBe(fail ? undefined : '2099-01-01T00:00:00Z')
    expect(info.privacy_mode).toBe('training_set_cf_blocked')
  })
  it('preserves token success when all best-effort metadata and privacy requests fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('private transport data') }))
    const info = openAITokenInfo({ access_token: 'access', refresh_token: 'refresh' }, 'client')
    await enrichOpenAITokenInfo({} as Env, info, null)
    expect(info).toMatchObject({ access_token: 'access', refresh_token: 'refresh', privacy_mode: 'training_set_failed' })
    expect(info.plan_type).toBeUndefined()
  })
})

describe('OAuth HTTP resource and error boundaries', () => {
  it.each([{ access_token: '' }, { access_token: 'bad\ntoken' }, { access_token: 'access', expires_in: -1 }, { access_token: 'access', expires_in: 1.5 }])('rejects malformed successful tokens %j', async value => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(value)))
    await expect(requestOpenAITokens({} as Env, new URLSearchParams({ grant_type: 'authorization_code' }), null)).rejects.toMatchObject({ code: 'OPENAI_OAUTH_INVALID_RESPONSE' })
  })
  it('bounds response bytes even when no content-length is supplied', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1))))
    await expect(openAIOAuthHttp({} as Env, 'https://auth.openai.com/oauth/token', {}, null)).rejects.toMatchObject({ code: 'OPENAI_OAUTH_INVALID_RESPONSE' })
  })
  it.each(['fetch', 'body'])('bounds a stalled %s even when the transport ignores AbortSignal', async phase => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(() => phase === 'fetch' ? new Promise<Response>(() => {})
      : Promise.resolve(new Response(new ReadableStream({ cancel })))))
    const pending = openAIOAuthHttp({} as Env, 'https://auth.openai.com/oauth/token', {}, null, 100)
    const checked = expect(pending).rejects.toMatchObject({ status: 504, code: 'OPENAI_OAUTH_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(101); await checked
    if (phase === 'body') expect(cancel).toHaveBeenCalledOnce()
  })
})
