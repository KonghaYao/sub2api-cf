import { describe, expect, it } from 'vitest'
import {
  PASSWORD_MAX_CODE_POINTS,
  PASSWORD_MIN_CODE_POINTS,
  PasswordValidationError,
  hashPassword,
  needsPasswordRehash,
  verifyPassword,
} from '../../src/auth/password'

describe('password credential codec', () => {
  it('creates a salted, versioned PBKDF2-SHA256 credential and verifies it', async () => {
    const password = 'correct horse battery staple'
    const first = await hashPassword(password)
    const second = await hashPassword(password)

    expect(first).toMatch(/^pbkdf2-sha256\$v=1\$i=\d+\$l=32\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
    expect(first).not.toContain(password)
    expect(second).not.toBe(first)
    await expect(verifyPassword(password, first)).resolves.toBe(true)
    await expect(verifyPassword('correct horse battery stapler', first)).resolves.toBe(false)
    expect(needsPasswordRehash(first)).toBe(false)
  })

  it('treats Unicode code points consistently', async () => {
    const password = '密码🔐passphrase'
    const credential = await hashPassword(password)
    await expect(verifyPassword(password, credential)).resolves.toBe(true)
    await expect(verifyPassword('密码🔒passphrase', credential)).resolves.toBe(false)
  })

  it('enforces password policy before spending PBKDF2 work', async () => {
    expect(PASSWORD_MIN_CODE_POINTS).toBeGreaterThanOrEqual(8)
    await expect(hashPassword('short')).rejects.toBeInstanceOf(PasswordValidationError)
    await expect(hashPassword('x'.repeat(PASSWORD_MAX_CODE_POINTS + 1))).rejects.toBeInstanceOf(
      PasswordValidationError,
    )
  })

  it('fails closed for malformed, unsupported, and tampered credentials', async () => {
    await expect(verifyPassword('valid-password', 'bcrypt$not-supported')).resolves.toBe(false)
    await expect(
      verifyPassword(
        'valid-password',
        'pbkdf2-sha256$v=2$i=210000$l=32$MTIzNDU2Nzg5MDEyMzQ1Ng$MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI',
      ),
    ).resolves.toBe(false)

    const credential = await hashPassword('valid-password')
    const fields = credential.split('$')
    const replacement = fields[5][8] === 'A' ? 'B' : 'A'
    fields[5] = `${fields[5].slice(0, 8)}${replacement}${fields[5].slice(9)}`
    await expect(verifyPassword('valid-password', fields.join('$'))).resolves.toBe(false)
  })
})
