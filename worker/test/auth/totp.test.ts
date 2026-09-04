import { describe, expect, it } from 'vitest'
import {
  generateTotpCode,
  generateTotpRecoveryCodes,
  isTotpRecoveryCode,
  totpRecoveryCodeDigest,
  verifyTotpCode,
} from '../../src/auth/totp'
import { totpEmailCodeDigest } from '../../src/user/totp'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

const RFC_6238_SHA1_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('RFC 6238 TOTP', () => {
  it.each([
    [59_000, '94287082'],
    [1_111_111_109_000, '07081804'],
    [1_111_111_111_000, '14050471'],
    [1_234_567_890_000, '89005924'],
    [2_000_000_000_000, '69279037'],
    [20_000_000_000_000, '65353130'],
  ])('matches the RFC SHA-1 vector at %i ms', async (timeMs, expected) => {
    await expect(generateTotpCode(RFC_6238_SHA1_SECRET, timeMs, 8)).resolves.toBe(expected)
  })

  it('accepts only the configured adjacent time window', async () => {
    const now = 1_700_000_000_000
    const previous = await generateTotpCode(RFC_6238_SHA1_SECRET, now - 30_000)
    const next = await generateTotpCode(RFC_6238_SHA1_SECRET, now + 30_000)
    const outside = await generateTotpCode(RFC_6238_SHA1_SECRET, now + 60_000)

    await expect(verifyTotpCode(previous, RFC_6238_SHA1_SECRET, now)).resolves.toBe(true)
    await expect(verifyTotpCode(next, RFC_6238_SHA1_SECRET, now)).resolves.toBe(true)
    await expect(verifyTotpCode(outside, RFC_6238_SHA1_SECRET, now)).resolves.toBe(false)
  })

  it('skips a negative adjacent window at the Unix epoch', async () => {
    const code = await generateTotpCode(RFC_6238_SHA1_SECRET, 0)
    await expect(verifyTotpCode(code, RFC_6238_SHA1_SECRET, 0)).resolves.toBe(true)
  })
})

describe('TOTP email challenge digests', () => {
  const base = {
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    ENVIRONMENT: 'production',
  }

  it('is keyed and domain-separated by environment', async () => {
    const first = await totpEmailCodeDigest(base as any, 'alice', 'alice@example.test', '123456')
    const otherEnvironment = await totpEmailCodeDigest(
      { ...base, ENVIRONMENT: 'staging' } as any,
      'alice',
      'alice@example.test',
      '123456',
    )
    const otherKey = await totpEmailCodeDigest(
      { ...base, CREDENTIALS_MASTER_KEY: 'n'.repeat(32) } as any,
      'alice',
      'alice@example.test',
      '123456',
    )

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(otherEnvironment).not.toBe(first)
    expect(otherKey).not.toBe(first)
    await expect(
      sha256Literal(['sub2api/totp-email/v1', 'alice', 'alice@example.test', '123456'].join('\0')),
    ).resolves.not.toBe(first)
  })
})

describe('TOTP recovery codes', () => {
  const base = {
    CREDENTIALS_MASTER_KEY: 'm'.repeat(32),
    ENVIRONMENT: 'production',
  }

  it('generates independent 80-bit codes and owner-bound keyed digests', async () => {
    const codes = generateTotpRecoveryCodes()
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const code of codes) expect(isTotpRecoveryCode(code)).toBe(true)

    const first = await totpRecoveryCodeDigest(base as any, 'alice', codes[0])
    const compact = await totpRecoveryCodeDigest(base as any, 'alice', codes[0].replace(/-/g, ''))
    const otherOwner = await totpRecoveryCodeDigest(base as any, 'bob', codes[0])
    const otherEnvironment = await totpRecoveryCodeDigest(
      { ...base, ENVIRONMENT: 'staging' } as any,
      'alice',
      codes[0],
    )
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(compact).toBe(first)
    expect(otherOwner).not.toBe(first)
    expect(otherEnvironment).not.toBe(first)
  })
})

describe('user TOTP migration', () => {
  it('upgrades v20 with encrypted owner state, hashed challenges, and session grants', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 20)
    applyMigrations(raw, 21)
    const now = Date.now()
    raw.prepare(
      `INSERT INTO users (id, email, created_at_ms, updated_at_ms)
       VALUES ('alice', 'alice@example.test', ?, ?)`,
    ).run(now, now)

    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 21').get()).toEqual({
      name: 'user_totp',
    })
    const credentialSql = raw.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_totp_credentials'`,
    ).get().sql as string
    const setupSql = raw.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_totp_setup_challenges'`,
    ).get().sql as string
    expect(credentialSql).toContain('ciphertext_b64')
    expect(credentialSql).not.toMatch(/secret\s+TEXT/i)
    expect(setupSql).toContain('token_hash')
    expect(setupSql).not.toMatch(/setup_token\s+TEXT/i)

    expect(() => raw.prepare(
      `INSERT INTO user_totp_credentials (
         user_id, nonce_b64, ciphertext_b64, enabled_at_ms, created_at_ms, updated_at_ms
       ) VALUES ('missing-owner', 'AAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAAAA', ?, ?, ?)`,
    ).run(now, now, now)).toThrow(/FOREIGN KEY/)

    raw.prepare(
      `INSERT INTO user_sessions (
         id, family_id, user_id, auth_version, access_token_hash, refresh_token_hash,
         created_at_ms, access_expires_at_ms, refresh_expires_at_ms
       ) VALUES ('alice-session', 'alice-family', 'alice', 1, ?, ?, ?, ?, ?)`,
    ).run('a'.repeat(64), 'b'.repeat(64), now, now + 60_000, now + 120_000)
    raw.prepare(
      `UPDATE user_sessions SET step_up_expires_at_ms = ? WHERE id = 'alice-session'`,
    ).run(now + 30_000)
    expect(raw.prepare(
      `SELECT step_up_expires_at_ms FROM user_sessions WHERE id = 'alice-session'`,
    ).get()).toEqual({ step_up_expires_at_ms: now + 30_000 })
  })

  it('adds recovery-code sets without storing raw code material', () => {
    const { raw } = createSqliteD1()
    applyMigrations(raw, 27)
    applyMigrations(raw, 28)

    expect(raw.prepare('SELECT name FROM schema_migrations WHERE version = 28').get()).toEqual({
      name: 'totp_recovery_codes',
    })
    const codeSql = raw.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_totp_recovery_codes'`,
    ).get().sql as string
    expect(codeSql).toContain('code_hash')
    expect(codeSql).not.toMatch(/\bcode\s+TEXT/i)
    expect(codeSql).toContain('consumed_at_ms')
    expect(codeSql).toContain('FOREIGN KEY')
  })
})

async function sha256Literal(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
