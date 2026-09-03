import { describe, expect, it } from 'vitest'
import {
  TokenValidationError,
  createOpaqueToken,
  parseBearerToken,
  tokenDigest,
} from '../../src/auth/tokens'

describe('opaque user session tokens', () => {
  it('creates type-bound access and refresh tokens with at least 256 bits of entropy', () => {
    const access = createOpaqueToken('access')
    const refresh = createOpaqueToken('refresh')

    expect(access).toMatch(/^sat_v1_[A-Za-z0-9_-]{43}$/)
    expect(refresh).toMatch(/^srt_v1_[A-Za-z0-9_-]{64}$/)
    expect(new Set(Array.from({ length: 64 }, () => createOpaqueToken('access'))).size).toBe(64)
  })

  it('digests tokens with a pepper and an explicit domain', async () => {
    const pepper = 'pepper-secret-material-that-is-at-least-32-bytes'
    const token = createOpaqueToken('access')
    const digest = await tokenDigest(token, pepper, 'access')

    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).not.toContain(token)
    await expect(tokenDigest(token, pepper, 'access')).resolves.toBe(digest)
    await expect(tokenDigest(token, `${pepper}-different`, 'access')).resolves.not.toBe(digest)
    await expect(tokenDigest(token, pepper, 'refresh')).rejects.toBeInstanceOf(TokenValidationError)
  })

  it('rejects weak peppers and malformed tokens', async () => {
    await expect(tokenDigest(createOpaqueToken('access'), 'too-short', 'access')).rejects.toThrow(
      'pepper',
    )
    await expect(tokenDigest('sat_v1_not-base64!', 'p'.repeat(32), 'access')).rejects.toBeInstanceOf(
      TokenValidationError,
    )
  })

  it('extracts only a single access token from the Bearer scheme', () => {
    const token = createOpaqueToken('access')
    expect(parseBearerToken(`Bearer ${token}`)).toBe(token)
    expect(parseBearerToken(`  bearer\t${token}  `)).toBe(token)

    const invalid = [
      null,
      '',
      token,
      `Basic ${token}`,
      `Bearer ${createOpaqueToken('refresh')}`,
      `Bearer ${token} extra`,
      `Bearer ${token}\r\nX-Injected: yes`,
    ]
    for (const header of invalid) {
      expect(() => parseBearerToken(header)).toThrowError(TokenValidationError)
    }
  })
})
