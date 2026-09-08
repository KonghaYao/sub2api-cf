import { GatewayError } from '../gateway/errors'
import { CodexImportNumber } from './codex-import-content'

/** Original codexUnixTime uses milliseconds only above 10^12. */
export function parseCodexImportTime(value: unknown): number | null {
  if (typeof value === 'string') {
    value=value.trim()
    const calendar=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value as string)
    if (calendar) {
      const [,year,month,day,hour,minute,second]=calendar.map(Number)
      const days=new Date(Date.UTC(year!<100?year!+400:year!,month!,0)).getUTCDate()
      if (month!<1 || month!>12 || day!<1 || day!>days || hour!>23 || minute!>59 || second!>59) return null
      const time=Date.parse(value as string)
      return Number.isFinite(time) ? time : null
    }
    if (!/^[+-]?\d+$/.test(value as string)) return null
  } else if (value instanceof CodexImportNumber) value=value.text
  else if (typeof value !== 'number') return null
  const numeric=Number(value)
  if (!Number.isFinite(numeric)) return null
  const integer=Math.trunc(numeric)
  if (!Number.isSafeInteger(integer)) return null
  const milliseconds=integer>1_000_000_000_000 ? integer : integer*1000
  return Number.isSafeInteger(milliseconds) && Math.abs(milliseconds)<=8.64e15 ? milliseconds : null
}

export interface CodexImportExpiry {
  accountExpiresAt: number | null
  credentialExpiresAt: number | null
  autoPauseOnExpired: boolean | undefined
  warnings: string[]
}
/** Keep renewable OAuth credential expiry independent from administrator expiry. */
export function resolveCodexImportExpiry(request: { expiresAt?: number; autoPauseOnExpired?: boolean },
  item: { refreshToken: string; tokenExpiresAt: number | null; isAgentIdentity?: boolean },now=Date.now()): CodexImportExpiry {
  if (item.isAgentIdentity) return { accountExpiresAt:null,credentialExpiresAt:null,autoPauseOnExpired:undefined,warnings:[] }
  let requested: number | null=null
  if (request.expiresAt !== undefined && request.expiresAt>0) {
    requested=request.expiresAt*1000
    if (!Number.isSafeInteger(requested) || requested>8.64e15) throw new GatewayError(400,'invalid_codex_import_expiry','Invalid account expiry')
  }
  if (!item.refreshToken) {
    const choices=[item.tokenExpiresAt,requested].filter((v):v is number=>v!==null)
    if (!choices.length) throw new GatewayError(400,'codex_import_expiry_required',
      '未包含 refresh_token，且无法解析 accessToken 过期时间；请在第一步设置过期时间后再导入')
    const expiry=Math.min(...choices)
    if (Math.floor(expiry/1000)<=Math.floor(now/1000)-120) throw new GatewayError(400,'codex_import_expired',`过期时间已过期: ${new Date(expiry).toISOString()}`)
    const warnings=['未包含 refresh_token，已按 accessToken/账号过期时间设置自动停止调度']
    if (request.autoPauseOnExpired===false) warnings.push('未包含 refresh_token，已强制开启过期自动暂停')
    return { accountExpiresAt:Math.floor(expiry/1000),credentialExpiresAt:expiry,autoPauseOnExpired:true,warnings }
  }
  return { accountExpiresAt:requested===null?null:Math.floor(requested/1000),credentialExpiresAt:item.tokenExpiresAt,
    autoPauseOnExpired:request.autoPauseOnExpired,warnings:[] }
}
