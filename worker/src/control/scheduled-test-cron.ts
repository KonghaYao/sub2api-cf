import { GatewayError } from '../gateway/errors'

const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
const days = ['SUN','MON','TUE','WED','THU','FRI','SAT']
function invalid(): never { throw new GatewayError(400, 'invalid_cron_expression', 'Invalid five-field cron expression') }
function field(raw: string, min: number, max: number, names: string[] = []) {
  const values = new Set<number>()
  let wildcard = false
  const number = (text: string) => {
    const named = names.indexOf(text.toUpperCase())
    if (named >= 0) return named + min
    if (!/^\d+$/.test(text)) return invalid()
    const n = Number(text)
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : invalid()
  }
  for (const part of raw.split(',')) {
    const pieces = part.split('/')
    if (pieces.length > 2) invalid()
    const step = pieces[1] === undefined ? 1 : /^\d+$/.test(pieces[1]) ? Number(pieces[1]) : 0
    if (!Number.isSafeInteger(step) || step <= 0) invalid()
    const range = pieces[0]!.split('-')
    if (range.length > 2) invalid()
    const star = range[0] === '*' || range[0] === '?'
    if (star && range.length !== 1) invalid()
    const start = star ? min : number(range[0]!)
    const end = star ? max : range[1] !== undefined ? number(range[1]) : pieces.length === 2 ? max : start
    if (start > end) invalid()
    wildcard ||= star && step === 1
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return { values, star: wildcard }
}

/** Original robfig parser's five-field calendar semantics; default Worker zone is UTC. */
export function nextScheduledTestRun(expression: string, from: number): number | null {
  const parts = expression.trim().split(/\s+/)
  let formatter: Intl.DateTimeFormat | undefined
  if (/^(?:CRON_TZ|TZ)=/.test(parts[0] ?? '')) {
    const prefix = parts.shift()!
    const zone = prefix.slice(prefix.indexOf('=')+1)
    try { formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: zone === 'Local' ? 'UTC' : zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }) } catch { invalid() }
  }
  const localTime = (timestamp: number) => {
    if (!formatter) return timestamp
    const values: Record<string, number> = {}
    for (const part of formatter.formatToParts(timestamp)) if (part.type !== 'literal') values[part.type] = Number(part.value)
    return Date.UTC(values.year!,values.month!-1,values.day!,values.hour!,values.minute!,values.second!)
  }
  if (parts.length !== 5 || !Number.isFinite(from)) invalid()
  const minute = field(parts[0]!,0,59), hour = field(parts[1]!,0,23), dom = field(parts[2]!,1,31)
  const month = field(parts[3]!,1,12,months), dow = field(parts[4]!,0,6,days)
  const start = new Date(localTime(from)), endYear = start.getUTCFullYear()+5
  const date = new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),start.getUTCDate()))
  const hours = [...hour.values].sort((a,b)=>a-b), minutes = [...minute.values].sort((a,b)=>a-b)
  while (date.getUTCFullYear() <= endYear) {
    const dayMatches = dom.star || dow.star
      ? dom.values.has(date.getUTCDate()) && dow.values.has(date.getUTCDay())
      : dom.values.has(date.getUTCDate()) || dow.values.has(date.getUTCDay())
    if (month.values.has(date.getUTCMonth()+1) && dayMatches) {
      const offsets = new Set<number>([0])
      if (formatter) {
        offsets.clear()
        // Probe both sides of local-day transitions, including repeated and skipped hours.
        for (let delta = -36; delta <= 36; delta += 12) {
          const probe = date.getTime()+delta*3600000
          offsets.add(localTime(probe)-probe)
        }
      }
      let earliest: number | null = null
      for (const h of hours) for (const m of minutes) {
        const local = date.getTime()+h*3600000+m*60000
        for (const offset of offsets) {
          const candidate = local-offset
          if (candidate <= from || formatter && localTime(candidate) !== local) continue
          if (!formatter) return candidate
          if (earliest === null || candidate < earliest) earliest = candidate
        }
      }
      if (earliest !== null) return earliest
    }
    date.setUTCDate(date.getUTCDate()+1)
  }
  return null
}
