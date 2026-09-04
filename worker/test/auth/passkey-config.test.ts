import { describe, expect, it } from 'vitest'
import { isPasskeyDeploymentConfigured, resolvePasskeyConfiguration } from '../../src/auth/passkey-config'
import type { Env } from '../../src/env'

function env(settings: unknown, overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    CONFIG_KV: { get: async () => settings } as unknown as KVNamespace,
    WEBAUTHN_RP_ID: 'login.example.test',
    WEBAUTHN_RP_NAME: 'Sub2API Test',
    WEBAUTHN_RP_ORIGINS: '["https://login.example.test","https://app.login.example.test"]',
    ...overrides,
  } as Env
}

describe('passkey deployment configuration', () => {
  it('combines the D1-projected feature switch with explicit RP boundaries', async () => {
    const subject = env({ passkey_enabled: true })
    await expect(resolvePasskeyConfiguration(subject)).resolves.toEqual({
      enabled: true,
      rpId: 'login.example.test',
      rpOrigins: ['https://login.example.test', 'https://app.login.example.test'],
      rpDisplayName: 'Sub2API Test',
    })
    expect(isPasskeyDeploymentConfigured(subject)).toBe(true)
  })

  it('does not infer RP configuration while the feature is disabled', async () => {
    await expect(resolvePasskeyConfiguration(env({}, {
      WEBAUTHN_RP_ID: undefined,
      WEBAUTHN_RP_ORIGINS: undefined,
    }))).resolves.toMatchObject({ enabled: false })
  })

  it('fails closed when enabled origins escape the RP or use insecure HTTP', async () => {
    const escaped = env({ passkey_enabled: true }, {
      WEBAUTHN_RP_ORIGINS: '["https://attacker.example"]',
    })
    await expect(resolvePasskeyConfiguration(escaped)).rejects.toMatchObject({
      status: 503,
      code: 'passkey_not_configured',
    })
    expect(isPasskeyDeploymentConfigured(env({}, {
      WEBAUTHN_RP_ORIGINS: 'http://login.example.test',
    }))).toBe(false)
  })

  it('allows HTTP only for a localhost development RP', async () => {
    await expect(resolvePasskeyConfiguration(env({ passkey_enabled: true }, {
      WEBAUTHN_RP_ID: 'localhost',
      WEBAUTHN_RP_ORIGINS: 'http://localhost:8787',
    }))).resolves.toMatchObject({
      enabled: true,
      rpId: 'localhost',
      rpOrigins: ['http://localhost:8787'],
    })
  })
})
