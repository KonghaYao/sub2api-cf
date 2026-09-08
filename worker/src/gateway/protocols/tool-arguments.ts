// Match original Go dedupeRepeatedJSONArgumentString: only two identical,
// individually valid JSON objects/arrays. Never rewrite arbitrary tool text.
export function dedupeRepeatedJsonArguments(value: string): string {
  if (!value.length || value.length % 2) return value
  const half = value.slice(0, value.length / 2)
  if (half !== value.slice(value.length / 2) || !/^[\s]*[\[{]/.test(half)) return value
  try { JSON.parse(half); return half } catch { return value }
}

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null
export function normalizeResponsesToolArguments(value: unknown, eventType?: string): unknown {
  const root = object(value)
  if (!root) return value
  const item = (value: unknown): unknown => {
    const row = object(value)
    if (!row || !['function_call', 'custom_tool_call'].includes(String(row.type)) || typeof row.arguments !== 'string') return value
    const argumentsValue = dedupeRepeatedJsonArguments(row.arguments)
    return argumentsValue === row.arguments ? value : { ...row, arguments: argumentsValue }
  }
  const output = (value: unknown) => Array.isArray(value) ? value.map(item) : value
  const nested = object(root.response)
  return {
    ...root,
    ...((root.type ?? eventType) === 'response.function_call_arguments.done' && typeof root.arguments === 'string' ? { arguments: dedupeRepeatedJsonArguments(root.arguments) } : {}),
    ...(root.item === undefined ? {} : { item: item(root.item) }),
    ...(root.output === undefined ? {} : { output: output(root.output) }),
    ...(nested?.output === undefined ? {} : { response: { ...nested, output: output(nested.output) } }),
  }
}
