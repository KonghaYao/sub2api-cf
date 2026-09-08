import { describe, expect, it } from 'vitest'
import { diagnoseAdminGroupModel } from '../../src/control/catalog'

describe('group model routing diagnosis contract', () => {
  const source = diagnoseAdminGroupModel.toString()
  it('requires image capability instead of accepting chat capability', () => {
    expect(source).toContain('m.image_generation=1')
    expect(source).toContain('am.image_generation=1')
  })
  it('applies platform and runtime availability checks', () => {
    expect(source).toContain('a.platform=m.platform')
    expect(source).toContain('rate_limit_reset_at')
    expect(source).toContain('temp_unschedulable_until')
  })
})
