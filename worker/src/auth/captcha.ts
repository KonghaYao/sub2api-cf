import type { Env } from '../env'
import { readSystemSettingSecret } from '../control/settings'
import type { CaptchaPublicSettings } from '../control/captcha-settings'
import { sha256Hex } from '../gateway/crypto'
import { GatewayError } from '../gateway/errors'

type Settings = Partial<CaptchaPublicSettings> & { turnstile_enabled?: boolean }
const encoder = new TextEncoder()
async function hmac(key: string | ArrayBuffer, text: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', imported, encoder.encode(text))
}
const hex = (value: ArrayBuffer) => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('')
function requiredProof(value: unknown, max = 16384): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new GatewayError(400, 'captcha_required', 'CAPTCHA verification is required')
  return value
}
function unavailable(): GatewayError { return new GatewayError(503, 'captcha_unavailable', 'CAPTCHA verification is unavailable', 'server_error') }
function invalid(): GatewayError { return new GatewayError(400, 'captcha_invalid', 'CAPTCHA verification failed') }

/** Protocol implementations follow the providers' official SDKs; endpoints are deployment-independent allowlists. */
export async function verifyCaptcha(request: Request, env: Env, settings: Settings, body: Record<string, unknown>): Promise<void> {
  const enabled = [settings.turnstile_enabled, settings.tencent_captcha_enabled, settings.aliyun_captcha_enabled].filter(value => value === true).length
  if (enabled === 0) return
  if (enabled > 1) throw new GatewayError(503, 'CAPTCHA_PROVIDER_CONFLICT', 'Only one CAPTCHA provider can be enabled', 'server_error')
  if (settings.turnstile_enabled) {
    const token = requiredProof(body.turnstile_token, 2048)
    const secret = env.TURNSTILE_SECRET_KEY ?? await readSystemSettingSecret(env, 'turnstile_secret_key')
    if (!secret) throw new GatewayError(503, 'turnstile_not_configured', 'Turnstile is not configured', 'server_error')
    const form = new URLSearchParams({ secret, response: token })
    if (request.headers.has('cf-connecting-ip')) form.set('remoteip', request.headers.get('cf-connecting-ip')!)
    const value = await fetchJSON('https://challenges.cloudflare.com/turnstile/v0/siteverify', { 'content-type': 'application/x-www-form-urlencoded' }, form.toString())
    if (value.success !== true) throw invalid()
  } else if (settings.tencent_captcha_enabled) {
    const ticket = requiredProof(body.tencent_captcha_ticket)
    const rand = requiredProof(body.tencent_captcha_randstr, 2048)
    const [secretID, secretKey, appSecret] = await Promise.all([
      readSystemSettingSecret(env, 'tencent_captcha_cloud_secret_id'), readSystemSettingSecret(env, 'tencent_captcha_cloud_secret_key'), readSystemSettingSecret(env, 'tencent_captcha_app_secret_key'),
    ])
    const appID = Number(settings.tencent_captcha_app_id)
    if (!secretID || !secretKey || !appSecret || !Number.isSafeInteger(appID) || appID <= 0) throw unavailable()
    const host = settings.tencent_captcha_region === 'intl' ? 'captcha.intl.tencentcloudapi.com' : 'captcha.tencentcloudapi.com'
    const payload = JSON.stringify({ CaptchaType: 9, Ticket: ticket, UserIp: request.headers.get('cf-connecting-ip') ?? '', Randstr: rand, CaptchaAppId: appID, AppSecretKey: appSecret })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const date = new Date(Number(timestamp) * 1000).toISOString().slice(0, 10)
    const contentType = 'application/json; charset=utf-8'
    const canonical = `POST\n/\n\ncontent-type:${contentType}\nhost:${host}\n\ncontent-type;host\n${await sha256Hex(payload)}`
    const scope = `${date}/captcha/tc3_request`
    const signingKey = await hmac(await hmac(await hmac(`TC3${secretKey}`, date), 'captcha'), 'tc3_request')
    const signature = hex(await hmac(signingKey, `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${await sha256Hex(canonical)}`))
    const result = await fetchJSON(`https://${host}/`, {
      'content-type': contentType, 'x-tc-action': 'DescribeCaptchaResult', 'x-tc-version': '2019-07-22', 'x-tc-timestamp': timestamp,
      authorization: `TC3-HMAC-SHA256 Credential=${secretID}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
    }, payload)
    const response = result.Response as Record<string, unknown> | undefined
    if (response?.Error) throw unavailable()
    if (response?.CaptchaCode !== 1) throw invalid()
  } else {
    const proof = requiredProof(body.turnstile_token)
    const secret = await readSystemSettingSecret(env, 'aliyun_captcha_access_key_secret')
    if (!secret || !settings.aliyun_captcha_access_key_id || !settings.aliyun_captcha_scene_id) throw unavailable()
    const host = settings.aliyun_captcha_region === 'sgp' ? 'captcha.ap-southeast-1.aliyuncs.com' : 'captcha.cn-shanghai.aliyuncs.com'
    const payload = new URLSearchParams({ CaptchaVerifyParam: proof, SceneId: settings.aliyun_captcha_scene_id }).toString()
    const hash = await sha256Hex(payload)
    const headers: Record<string, string> = {
      host, 'x-acs-action': 'VerifyIntelligentCaptcha', 'x-acs-version': '2023-03-05',
      'x-acs-date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), 'x-acs-signature-nonce': crypto.randomUUID(), 'x-acs-content-sha256': hash,
    }
    const keys = Object.keys(headers).sort()
    const signed = keys.join(';')
    const canonical = `POST\n/\n\n${keys.map(key => `${key}:${headers[key]}\n`).join('')}\n${signed}\n${hash}`
    headers.authorization = `ACS3-HMAC-SHA256 Credential=${settings.aliyun_captcha_access_key_id},SignedHeaders=${signed},Signature=${hex(await hmac(secret, `ACS3-HMAC-SHA256\n${await sha256Hex(canonical)}`))}`
    delete headers.host
    headers['content-type'] = 'application/x-www-form-urlencoded'
    const result = await fetchJSON(`https://${host}/`, headers, payload)
    if ((result.Result as Record<string, unknown> | undefined)?.VerifyResult !== true) throw invalid()
  }
}
async function fetchJSON(url: string, headers: Record<string, string>, body: string): Promise<Record<string, unknown>> {
  let response: Response
  try { response = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10000) }) } catch { throw unavailable() }
  if (!response.ok) throw unavailable()
  const value = await response.json().catch(() => null)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
  return value as Record<string, unknown>
}
