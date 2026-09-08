/** Original ParseCodexRateLimitHeaders + buildCodexUsageExtraUpdates. */
export function codexUsageHeaderUpdates(headers: Headers, now = Date.now()): Record<string, unknown> | null {
  const updates: Record<string, unknown> = {}
  for (const name of ['primary', 'secondary']) {
    for (const field of ['used-percent', 'reset-after-seconds', 'window-minutes']) {
      const raw = headers.get(`x-codex-${name}-${field}`)
      if (!raw || raw.trim() !== raw) continue
      if (field !== 'used-percent' && !/^[+-]?\d+$/.test(raw)) continue
      if (field === 'used-percent' && !decimalFloat(raw)) continue
      const value = Number(raw)
      if (!Number.isFinite(value) || field !== 'used-percent' && !Number.isSafeInteger(value)) continue
      updates[`codex_${name}_${field.replaceAll('-', '_')}`] = value
    }
  }
  const overflow = headers.get('x-codex-primary-over-secondary-limit-percent')
  if (overflow && decimalFloat(overflow) && Number.isFinite(Number(overflow))) updates.codex_primary_over_secondary_percent = Number(overflow)
  if (!Object.keys(updates).length) return null
  updates.codex_usage_updated_at = new Date(now).toISOString()
  const p = updates.codex_primary_window_minutes as number | undefined, s = updates.codex_secondary_window_minutes as number | undefined
  const primaryShort = p !== undefined && s !== undefined ? p < s : p !== undefined ? p <= 360 : s !== undefined ? s > 360 : false
  for (const [window, source] of [['5h', primaryShort ? 'primary' : 'secondary'], ['7d', primaryShort ? 'secondary' : 'primary']]) {
    for (const field of ['used_percent', 'reset_after_seconds', 'window_minutes']) {
      const value = updates[`codex_${source}_${field}`]
      if (value !== undefined) updates[`codex_${window}_${field}`] = value
    }
    const seconds = updates[`codex_${window}_reset_after_seconds`]
    if (typeof seconds === 'number') {
      const reset = now + Math.max(0, seconds) * 1000
      if (Number.isSafeInteger(reset) && Math.abs(reset) <= 8.64e15) updates[`codex_${window}_reset_at`] = new Date(reset).toISOString()
    }
  }
  return updates
}

// Number() also accepts binary/octal/hex integer literals, unlike the original
// strconv.ParseFloat header contract. Supplier percentages are decimal floats.
function decimalFloat(value: string): boolean {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
}
