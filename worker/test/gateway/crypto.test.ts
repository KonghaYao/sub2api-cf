import { describe, expect, it } from 'vitest'
import { apiKeyDigest, decryptCredential, encryptCredential } from '../../src/gateway/crypto'
import { GatewayError } from '../../src/gateway/errors'

describe('gateway secrets', () => {
  it('uses a keyed digest for customer API keys', async () => {
    const first = await apiKeyDigest('sk-customer', 'a'.repeat(32))
    const second = await apiKeyDigest('sk-customer', 'b'.repeat(32))

    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(second).not.toBe(first)
    expect(first).not.toContain('sk-customer')
  })

  it('binds encrypted credentials to account metadata with AES-GCM AAD', async () => {
    const encrypted = await encryptCredential(
      { api_key: 'sk-upstream' },
      'master-key'.repeat(4),
      'production/account-1/secret-1/1',
    )
    await expect(
      decryptCredential(
        encrypted.nonce_b64,
        encrypted.ciphertext_b64,
        'master-key'.repeat(4),
        'production/account-1/secret-1/1',
      ),
    ).resolves.toEqual({ api_key: 'sk-upstream' })
    await expect(
      decryptCredential(
        encrypted.nonce_b64,
        encrypted.ciphertext_b64,
        'master-key'.repeat(4),
        'production/account-2/secret-1/1',
      ),
    ).rejects.toBeInstanceOf(GatewayError)
  })
})
