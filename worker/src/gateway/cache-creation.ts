/** Original normalizeCacheCreationBreakdown: retain partial details, cap
 * contradictory positive aggregates proportionally, rounding 5m to nearest.
 * BigInt keeps token conservation exact at the JavaScript integer boundary. */
export function normalizeCacheCreationBreakdown(aggregate: number, fiveMinutes = 0, oneHour = 0): [number, number] {
  const safe = (value: number) => Number.isSafeInteger(value) && value > 0 ? value : 0
  const five = safe(fiveMinutes), hour = safe(oneHour), total = safe(aggregate)
  if (total === 0 || (five <= total && hour <= total - five)) return [five, hour]
  const sum = BigInt(five) + BigInt(hour)
  const scaledFive = Number((2n * BigInt(total) * BigInt(five) + sum) / (2n * sum))
  return [scaledFive, total - scaledFive]
}
