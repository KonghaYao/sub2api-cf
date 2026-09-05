import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildOpsErrorTimeParams } from '../opsErrorParams'

describe('buildOpsErrorTimeParams', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'))
  })

  afterEach(() => vi.useRealTimers())

  it('uses explicit timestamps for a complete custom range', () => {
    expect(buildOpsErrorTimeParams('custom', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z')).toEqual({
      start_time: '2026-08-01T00:00:00Z',
      end_time: '2026-08-02T00:00:00Z'
    })
  })

  it('turns presets into bounded timestamps and falls back to one hour', () => {
    expect(buildOpsErrorTimeParams('24h')).toEqual({
      start_time: '2026-08-01T12:00:00.000Z',
      end_time: '2026-08-02T12:00:00.000Z',
    })
    expect(buildOpsErrorTimeParams('custom', null, null)).toEqual({
      start_time: '2026-08-02T11:00:00.000Z',
      end_time: '2026-08-02T12:00:00.000Z',
    })
  })
})
