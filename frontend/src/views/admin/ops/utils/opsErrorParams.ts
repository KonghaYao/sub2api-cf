export function buildOpsErrorTimeParams(
  timeRange: string,
  customStartTime?: string | null,
  customEndTime?: string | null
): { start_time: string; end_time: string } {
  if (timeRange === 'custom' && customStartTime && customEndTime) {
    return { start_time: customStartTime, end_time: customEndTime }
  }

  const match = /^(\d+)(m|h)$/.exec(timeRange === 'custom' ? '1h' : timeRange)
  const amount = Number(match?.[1] ?? 1)
  const minutes = match?.[2] === 'm' ? amount : amount * 60
  const end = Date.now()
  return {
    start_time: new Date(end - minutes * 60_000).toISOString(),
    end_time: new Date(end).toISOString(),
  }
}
