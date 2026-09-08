/** Read only authoritative pre-customer-multiplier cost evidence. Older rows
 * have no such snapshot and keep their existing display fallback. */
export function usageCostDisplay(snapshot: unknown): Record<string, number> | null {
  if (typeof snapshot !== 'string' || snapshot.length > 65_536) return null
  try {
    const value = JSON.parse(snapshot)
    if (!value || value.version !== 1 || !['channel', 'catalog'].includes(value.source)) return null
    const cost = value.basis_cost
    if (!cost || typeof cost !== 'object' || Array.isArray(cost)) return null
    const fields = ['input_amount_micros', 'output_amount_micros', 'cache_amount_micros', 'base_amount_micros', 'amount_micros']
    if (fields.some(key => !Number.isSafeInteger(cost[key]) || cost[key] < 0)) return null
    const write = cost.cache_write_amount_micros ?? 0
    const rate = value.customer_rate_multiplier_ppm
    if (!Number.isSafeInteger(write) || write < 0 || !Number.isSafeInteger(rate) || rate < 0) return null
    if (BigInt(cost.input_amount_micros) + BigInt(cost.output_amount_micros) + BigInt(cost.cache_amount_micros) + BigInt(write) + BigInt(cost.base_amount_micros) !== BigInt(cost.amount_micros)) return null
    return { input_cost: cost.input_amount_micros / 1_000_000,
      output_cost: cost.output_amount_micros / 1_000_000,
      cache_read_cost: cost.cache_amount_micros / 1_000_000,
      cache_creation_cost: write / 1_000_000,
      total_cost: cost.amount_micros / 1_000_000, rate_multiplier: rate / 1_000_000 }
  } catch { return null }
}

/** SQL equivalent for totals/charts; all arguments are internal column names. */
export function usageBasisAmountSql(fallback = 'amount_micros', prefix = ''): string {
  const column = `${prefix}customer_pricing_snapshot_json`
  const get = (path: string) => `json_extract(${column}, '$.${path}')`
  const safe = (path: string) => `(json_type(${column}, '$.${path}') IN ('integer','real') AND ${get(path)} BETWEEN 0 AND 9007199254740991 AND ${get(path)} = CAST(${get(path)} AS INTEGER))`
  const fields = ['input_amount_micros', 'output_amount_micros', 'cache_amount_micros', 'base_amount_micros', 'amount_micros']
  const write = `COALESCE(${get('basis_cost.cache_write_amount_micros')},0)`
  return `(CASE WHEN json_valid(${column}) THEN CASE WHEN ${get('version')} = 1 AND ${get('source')} IN ('channel','catalog')
    AND ${safe('customer_rate_multiplier_ppm')} AND ${fields.map(field => safe('basis_cost.'+field)).join(' AND ')}
    AND (${get('basis_cost.cache_write_amount_micros')} IS NULL OR ${safe('basis_cost.cache_write_amount_micros')})
    AND ${get('basis_cost.input_amount_micros')} + ${get('basis_cost.output_amount_micros')} + ${get('basis_cost.cache_amount_micros')} + ${get('basis_cost.base_amount_micros')} + ${write} = ${get('basis_cost.amount_micros')}
    THEN ${get('basis_cost.amount_micros')} ELSE ${fallback} END ELSE ${fallback} END)`
}
