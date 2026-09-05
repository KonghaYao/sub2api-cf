const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE_INTEGER = -MAX_SAFE_INTEGER
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const JSON_INTEGER = /^-?(?:0|[1-9]\d*)$/

/**
 * JSON.parse cannot represent integer lexemes outside JavaScript's safe range.
 * Protect only those lexemes as bigint values; ordinary request controls keep
 * their native number type and therefore retain the existing validation rules.
 */
export function parseJsonPreservingIntegers(source: string): unknown {
  const marker = uniqueMarker(source)
  const protectedSource = protectUnsafeIntegerLexemes(source, marker)
  return JSON.parse(protectedSource, (_key, value: unknown) => {
    if (typeof value !== 'string' || !value.startsWith(marker)) return value
    const literal = value.slice(marker.length)
    return JSON_INTEGER.test(literal) ? BigInt(literal) : value
  })
}

/** Serializes bigint values back as unquoted JSON number lexemes. */
export function stringifyJsonPreservingIntegers(value: unknown): string | undefined {
  const marker = uniqueMarker()
  const integers: string[] = []
  const serialized = JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current !== 'bigint') return current
    const index = integers.push(current.toString()) - 1
    return `${marker}${index}`
  })
  if (serialized === undefined || integers.length === 0) return serialized
  return serialized.replace(
    new RegExp(`"${marker}(\\d+)"`, 'g'),
    (match, rawIndex: string) => integers[Number(rawIndex)] ?? match,
  )
}

function protectUnsafeIntegerLexemes(source: string, marker: string): string {
  const chunks: string[] = []
  let cursor = 0
  let index = 0
  let inString = false
  let escaped = false
  while (index < source.length) {
    const character = source[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      index += 1
      continue
    }
    if (character === '"') {
      inString = true
      index += 1
      continue
    }
    if (character !== '-' && (character < '0' || character > '9')) {
      index += 1
      continue
    }
    JSON_NUMBER.lastIndex = index
    const match = JSON_NUMBER.exec(source)
    if (match === null) {
      index += 1
      continue
    }
    const literal = match[0]
    const end = JSON_NUMBER.lastIndex
    if (JSON_INTEGER.test(literal) && isUnsafeInteger(literal)) {
      chunks.push(source.slice(cursor, index), JSON.stringify(`${marker}${literal}`))
      cursor = end
    }
    index = end
  }
  if (chunks.length === 0) return source
  chunks.push(source.slice(cursor))
  return chunks.join('')
}

function isUnsafeInteger(literal: string): boolean {
  const value = BigInt(literal)
  return value > MAX_SAFE_INTEGER || value < MIN_SAFE_INTEGER
}

function uniqueMarker(source = ''): string {
  let marker: string
  do {
    marker = `__sub2api_lossless_${crypto.randomUUID().replaceAll('-', '')}_`
  } while (source.includes(marker))
  return marker
}
