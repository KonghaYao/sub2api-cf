import { GatewayError } from '../gateway/errors'
export const captchaPublicDefaults = {
  tencent_captcha_enabled: false, tencent_captcha_app_id: '', tencent_captcha_region: 'cn',
  aliyun_captcha_enabled: false, aliyun_captcha_access_key_id: '', aliyun_captcha_scene_id: '', aliyun_captcha_prefix: '', aliyun_captcha_region: 'cn',
}
export type CaptchaPublicSettings = typeof captchaPublicDefaults
export const CAPTCHA_SECRET_KEYS = ['tencent_captcha_app_secret_key', 'tencent_captcha_cloud_secret_id', 'tencent_captcha_cloud_secret_key', 'aliyun_captcha_access_key_secret'] as const
export function parseCaptchaSettings(input: Record<string, unknown>): Partial<CaptchaPublicSettings> {
  const result: Record<string, unknown> = {}
  for (const [key, fallback] of Object.entries(captchaPublicDefaults)) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== typeof fallback || (typeof input[key] === 'string' && input[key].length > 2048)) throw new GatewayError(400, `invalid_${key}`, `${key} is invalid`)
    result[key] = typeof input[key] === 'string' ? input[key].trim() : input[key]
  }
  if (result.tencent_captcha_region !== undefined && !['cn', 'intl'].includes(String(result.tencent_captcha_region))) throw new GatewayError(400, 'invalid_captcha_region', 'Tencent region must be cn or intl')
  if (result.aliyun_captcha_region !== undefined && !['cn', 'sgp'].includes(String(result.aliyun_captcha_region))) throw new GatewayError(400, 'invalid_captcha_region', 'Aliyun region must be cn or sgp')
  return result
}
