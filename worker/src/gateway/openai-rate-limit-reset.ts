/** Original calculateOpenAI429ResetTime + parseOpenAIRateLimitResetTime.
 * Returns an absolute millisecond timestamp; absence must not invent cooldown.
 */
export function openAIRateLimitReset(headers: Headers, body: string, now = Date.now()): number | null {
  const integer = (value: unknown): number | null => {
    if (typeof value === 'string') {
      if (!/^[+-]?\d+$/.test(value)) return null
      value = Number(value)
    } else if (typeof value === 'number') value = Math.trunc(value)
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
  }
  const window = (name: string) => {
    const rawUsed = headers.get(`x-codex-${name}-used-percent`)
    const used = rawUsed !== null && rawUsed.trim() !== '' ? Number(rawUsed) : NaN
    return { minutes: integer(headers.get(`x-codex-${name}-window-minutes`)),
      reset: integer(headers.get(`x-codex-${name}-reset-after-seconds`)), used: Number.isFinite(used) ? used : null }
  }
  const primary = window('primary'), secondary = window('secondary')
  const primaryShort = primary.minutes !== null && secondary.minutes !== null ? primary.minutes < secondary.minutes
    : primary.minutes !== null ? primary.minutes <= 360 : secondary.minutes !== null ? secondary.minutes > 360 : false
  const short = primaryShort ? primary : secondary, long = primaryShort ? secondary : primary
  const valid = (ms: number) => Number.isSafeInteger(ms) && Math.abs(ms) <= 8.64e15 ? ms : null
  const after = (seconds: number) => valid(now + seconds * 1000)
  if (long.used !== null && long.used >= 100 && long.reset !== null) return after(long.reset)
  if (short.used !== null && short.used >= 100 && short.reset !== null) return after(short.reset)
  const longest = Math.max(long.reset ?? 0, short.reset ?? 0)
  if (longest > 0) return after(longest)
  try {
    const error = JSON.parse(body)?.error
    if (!error || !['usage_limit_reached', 'rate_limit_exceeded', 'GoUsageLimitError'].includes(error.type)) return null
    const absolute = integer(error.resets_at)
    if (absolute !== null) return valid(absolute * 1000)
    const seconds = integer(error.resets_in_seconds)
    if (seconds !== null) return valid((Math.floor(now / 1000) + seconds) * 1000)
    if (error.type === 'GoUsageLimitError' && typeof error.message === 'string') {
      const prefix = /\bresets\s+in\s+/i.exec(error.message)
      if (!prefix) return null
      let remainder = error.message.slice(prefix.index + prefix[0].length), total = 0
      while (true) {
        const part = /^([0-9]+(?:\.[0-9]+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/i.exec(remainder.trimStart())
        if (!part) break
        const value = Number(part[1])
        if (!(value > 0)) return null
        const factor = ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 } as Record<string, number>)[part[2][0].toLowerCase()]
        total += value * factor
        if (!Number.isFinite(total) || total >= 9223372036.854775807) return null
        remainder = remainder.trimStart().slice(part[0].length)
      }
      if (total > 0) return valid(Math.floor(now / 1000 + total) * 1000)
    }
  } catch { /* Unknown/non-JSON provider error. */ }
  return null
}
