import { GatewayError } from '../gateway/errors'

/** Go's decoder.UseNumber preserves identifiers larger than JavaScript integers. */
export class CodexImportNumber {
  constructor(readonly text: string) {}
  toString() { return this.text }
}
export type CodexImportValue = null | boolean | string | CodexImportNumber | CodexImportValue[] | { [key: string]: CodexImportValue }
const invalid = (): never => { throw new GatewayError(400,'invalid_codex_import_json','Codex session JSON could not be parsed') }
const looksLikeJson = (value: string) => value.startsWith('{') || value.startsWith('[')

function decodeStream(input: string): CodexImportValue[] {
  let cursor = 0
  const whitespace = () => { while (cursor < input.length && /[\t\r\n ]/.test(input[cursor]!)) cursor++ }
  const string = (): string => {
    const start = cursor++
    while (cursor < input.length) {
      const char = input[cursor++]
      if (char === '\\') cursor++
      else if (char === '"') {
        try { return JSON.parse(input.slice(start,cursor)) as string } catch { invalid() }
      }
    }
    return invalid()
  }
  const value = (depth: number): CodexImportValue => {
    if (depth > 256) invalid()
    whitespace()
    const char = input[cursor]
    if (char === '"') return string()
    if (char === '{' || char === '[') {
      cursor++; whitespace()
      const end = char === '{' ? '}' : ']'
      const result: CodexImportValue[] | { [key: string]: CodexImportValue } = char === '[' ? [] : Object.create(null)
      if (input[cursor] === end) { cursor++; return result }
      while (cursor < input.length) {
        whitespace()
        if (Array.isArray(result)) result.push(value(depth+1))
        else {
          if (input[cursor] !== '"') invalid()
          const key = string(); whitespace()
          if (input[cursor++] !== ':') invalid()
          result[key] = value(depth+1)
        }
        whitespace()
        if (input[cursor] === end) { cursor++; return result }
        if (input[cursor++] !== ',') invalid()
      }
      return invalid()
    }
    for (const [literal,parsed] of [['true',true],['false',false],['null',null]] as const) {
      if (input.startsWith(literal,cursor)) { cursor+=literal.length; return parsed }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(input.slice(cursor))
    if (!number) return invalid()
    cursor+=number[0].length
    return new CodexImportNumber(number[0])
  }
  const values: CodexImportValue[] = []
  whitespace()
  while (cursor < input.length) { values.push(value(0)); whitespace() }
  if (!values.length) invalid()
  return values
}
function flatten(values: CodexImportValue[]): CodexImportValue[] {
  const result: CodexImportValue[] = [], pending = [...values].reverse()
  while (pending.length) {
    const value = pending.pop()!
    if (Array.isArray(value)) for (let i=value.length-1;i>=0;i--) pending.push(value[i]!)
    else result.push(value)
  }
  return result
}
function lines(content: string): CodexImportValue[] {
  return content.split('\n').flatMap(line => {
    line=line.trim()
    return !line ? [] : looksLikeJson(line) ? flatten(decodeStream(line)) : [line]
  })
}
function parseContent(content: string): CodexImportValue[] {
  content=content.trim()
  if (!content) return []
  if (!looksLikeJson(content)) return lines(content)
  try { return flatten(decodeStream(content)) }
  catch { if (content.includes('\n')) return lines(content); return invalid() }
}
export function parseCodexImportEntries(input: { content?: string; contents?: string[] }): Array<{ index: number; value: CodexImportValue }> {
  if (input.content !== undefined && typeof input.content !== 'string' || input.contents !== undefined &&
      (!Array.isArray(input.contents) || input.contents.some(value => typeof value !== 'string'))) {
    throw new GatewayError(400,'invalid_codex_import_content','content and contents must contain strings')
  }
  const values = [input.content ?? '',...(input.contents ?? [])].flatMap(parseContent)
  return values.map((value,index) => ({ index:index+1,value }))
}
