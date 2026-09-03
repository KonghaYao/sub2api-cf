import { describe, expect, it } from 'vitest'
import { resolveBuildOutDir } from '../../vite-build-target'

describe('resolveBuildOutDir', () => {
  it('keeps the legacy Go embed output for the default production build', () => {
    expect(resolveBuildOutDir('production')).toBe('../backend/internal/web/dist')
  })

  it('uses a frontend-local output for Cloudflare static assets', () => {
    expect(resolveBuildOutDir('cloudflare')).toBe('dist')
  })
})
