import { env, exports } from 'cloudflare:workers'
import { listDurableObjectIds } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'

async function workerRequest(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`https://worker.e2e.invalid${path}`, init))
}

async function jsonRequest(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<Response> {
  return workerRequest(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function responseData<T>(response: Response): Promise<T> {
  const body = await response.json() as { code: number; data: T }
  expect(body.code).toBe(0)
  return body.data
}

async function enableRegistration(): Promise<void> {
  await env.CONFIG_KV.put('e2e:public-settings:v1', JSON.stringify({
    site_name: 'Binding E2E',
    registration_enabled: true,
    email_verification_enabled: false,
    turnstile_enabled: false,
  }))
}

describe('Cloudflare binding E2E', () => {
  it('runs the Worker router over migrated D1 and real local KV/R2 bindings', async () => {
    const ready = await workerRequest('/ready')
    expect(ready.status).toBe(200)
    await expect(ready.json()).resolves.toEqual({ status: 'ready' })

    const applied = await env.DB.prepare(
      'SELECT name FROM d1_migrations ORDER BY id',
    ).all<{ name: string }>()
    expect(applied.results).toHaveLength(env.TEST_MIGRATIONS.length)
    expect(applied.results.map((migration) => migration.name)).toContain(
      '0025_api_key_monetary_recovery.sql',
    )

    await enableRegistration()
    const settings = await workerRequest('/api/v1/settings/public')
    await expect(settings.json()).resolves.toMatchObject({
      code: 0,
      data: { site_name: 'Binding E2E', registration_enabled: true },
    })

    await env.OBJECTS.put('binding-smoke.txt', 'r2-binding-ok')
    expect(await (await env.OBJECTS.get('binding-smoke.txt'))?.text()).toBe('r2-binding-ok')
  })

  it('executes auth -> user key -> gateway -> D1/DO/Queue as one vertical slice', async () => {
    await enableRegistration()

    const deniedBootstrap = await jsonRequest('/api/v1/admin/bootstrap', {}, {
      authorization: 'Bearer incorrect-admin-token-value',
    })
    expect(deniedBootstrap.status).toBe(401)

    const bootstrap = await jsonRequest('/api/v1/admin/bootstrap', {
      user: {
        email: 'admin@binding-e2e.test',
        display_name: 'Binding Admin',
        balance_micros: 1_000_000,
      },
      group: { name: 'Binding Group' },
      account: {
        name: 'Mock Upstream',
        base_url: 'https://upstream.e2e.invalid/v1',
        api_key: 'upstream-e2e-secret',
        max_concurrency: 2,
      },
      api_key: { name: 'Bootstrap key' },
      models: [{
        public_name: 'gpt-binding',
        upstream_name: 'gpt-binding-upstream',
        endpoint: 'chat_completions',
        input_micros_per_million: 1_000_000,
        output_micros_per_million: 2_000_000,
        per_request_micros: 7,
        minimum_reservation_micros: 100,
      }],
    }, {
      authorization: `Bearer ${env.ADMIN_TOKEN}`,
    })
    expect(bootstrap.status).toBe(201)
    const bootstrapped = await responseData<{
      group_id: string
      admin_session: string
    }>(bootstrap)

    const publicGroup = await jsonRequest(
      `/api/v1/admin/groups/${bootstrapped.group_id}`,
      { is_exclusive: false },
      {
        authorization: `Bearer ${bootstrapped.admin_session}`,
        'idempotency-key': 'binding-e2e-publish-group-0001',
        'if-match': '"0"',
      },
      'PUT',
    )
    expect(publicGroup.status, JSON.stringify(await publicGroup.clone().json())).toBe(200)

    const registration = await jsonRequest('/api/v1/auth/register', {
      email: 'alice@binding-e2e.test',
      password: 'correct horse battery staple',
    })
    expect(registration.status).toBe(201)
    const registered = await responseData<{
      user: { id: string; email: string }
      access_token: string
    }>(registration)
    expect(registered.user.email).toBe('alice@binding-e2e.test')

    const login = await jsonRequest('/api/v1/auth/login', {
      email: 'alice@binding-e2e.test',
      password: 'correct horse battery staple',
    })
    expect(login.status).toBe(200)
    const signedIn = await responseData<{ access_token: string; user: { id: string } }>(login)
    expect(signedIn.user.id).toBe(registered.user.id)

    const unauthorizedKey = await jsonRequest('/api/v1/keys', {
      name: 'Unauthorized',
      group_id: bootstrapped.group_id,
    })
    expect(unauthorizedKey.status).toBe(401)

    const funded = await jsonRequest(
      `/api/v1/admin/users/${registered.user.id}/balance`,
      { amount_delta_micros: 1_000_000 },
      {
        authorization: `Bearer ${bootstrapped.admin_session}`,
        'idempotency-key': 'binding-e2e-fund-alice-0001',
      },
    )
    expect(funded.status).toBe(200)
    await expect(responseData<{ balance_micros: number }>(funded)).resolves.toMatchObject({
      balance_micros: 1_000_000,
    })

    const createKey = await jsonRequest('/api/v1/keys', {
      name: 'Binding gateway key',
      group_id: bootstrapped.group_id,
      quota_micros: 500_000,
      rate_limit_5h_micros: 100_000,
      rate_limit_1d_micros: 200_000,
      rate_limit_7d_micros: 300_000,
    }, {
      authorization: `Bearer ${signedIn.access_token}`,
      'idempotency-key': 'binding-e2e-create-key-0001',
    })
    expect(createKey.status, JSON.stringify(await createKey.clone().json())).toBe(201)
    const key = await responseData<{ id: string; key: string; key_prefix: string }>(createKey)
    expect(key.key).toMatch(/^sk-sub2api-[A-Za-z0-9_-]{48}$/)

    const persistedSecret = await env.DB.prepare(
      'SELECT key_hash, key_prefix FROM api_keys WHERE id = ?',
    ).bind(key.id).first<{ key_hash: string; key_prefix: string }>()
    expect(persistedSecret).toMatchObject({ key_prefix: key.key_prefix })
    expect(persistedSecret?.key_hash).not.toContain(key.key)

    const deniedGateway = await jsonRequest('/v1/chat/completions', {
      model: 'gpt-binding',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 16,
    })
    expect(deniedGateway.status).toBe(401)

    const completion = await jsonRequest('/v1/chat/completions', {
      model: 'gpt-binding',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 16,
      stream: false,
    }, {
      authorization: `Bearer ${key.key}`,
    })
    expect(completion.status).toBe(200)
    await expect(completion.json()).resolves.toMatchObject({
      id: 'chatcmpl-binding-e2e',
      model: 'gpt-binding',
      choices: [{ message: { content: 'binding-ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })

    const monetary = await env.DB.prepare(
      `SELECT quota_used_micros, usage_5h_micros, usage_1d_micros, usage_7d_micros
         FROM api_keys WHERE id = ?`,
    ).bind(key.id).first<{
      quota_used_micros: number
      usage_5h_micros: number
      usage_1d_micros: number
      usage_7d_micros: number
    }>()
    expect(monetary).toEqual({
      quota_used_micros: 27,
      usage_5h_micros: 27,
      usage_1d_micros: 27,
      usage_7d_micros: 27,
    })
    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM settlement_recovery',
    ).first<{ total: number }>()).toEqual({ total: 0 })

    await vi.waitFor(async () => {
      const usage = await env.DB.prepare(
        `SELECT input_tokens, output_tokens, amount_micros, outcome
           FROM usage_projection WHERE api_key_id = ?`,
      ).bind(key.id).first<{
        input_tokens: number
        output_tokens: number
        amount_micros: number
        outcome: string
      }>()
      expect(usage).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        amount_micros: 27,
        outcome: 'completed',
      })
      expect(await env.DB.prepare(
        'SELECT balance_micros FROM users WHERE id = ?',
      ).bind(registered.user.id).first<{ balance_micros: number }>()).toEqual({
        balance_micros: 999_973,
      })
    }, { timeout: 10_000, interval: 25 })

    const consumed = await env.DB.prepare(
      `SELECT consumer, COUNT(*) AS total
         FROM inbox
        WHERE consumer IN ('usage-projection-v1', 'user-state-projection-v1')
        GROUP BY consumer
        ORDER BY consumer`,
    ).all<{ consumer: string; total: number }>()
    expect(consumed.results.map((row) => row.consumer)).toEqual([
      'usage-projection-v1',
      'user-state-projection-v1',
    ])
    expect(consumed.results.find((row) => row.consumer === 'usage-projection-v1')?.total).toBe(1)
    expect(consumed.results.find((row) => row.consumer === 'user-state-projection-v1')?.total)
      .toBeGreaterThan(0)

    const durableObjectCounts = await Promise.all([
      listDurableObjectIds(env.AUTH_RATE_LIMIT!),
      listDurableObjectIds(env.USER_STATE),
      listDurableObjectIds(env.API_KEY_LIMIT_STATE!),
      listDurableObjectIds(env.POOL_STATE),
    ])
    expect(durableObjectCounts.every((ids) => ids.length > 0)).toBe(true)

    const userStateBackup = await workerRequest(
      `/internal/backup/durable-objects/USER_STATE/${registered.user.id}/export`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.BACKUP_OPERATOR_TOKEN}`,
          'x-sub2api-backup-environment': 'e2e',
        },
      },
    )
    expect(userStateBackup.status).toBe(200)
    expect(userStateBackup.headers.get('content-type')).toContain('application/x-ndjson')
    const backupText = new TextDecoder().decode(await userStateBackup.arrayBuffer())
    const backupHeader = JSON.parse(backupText.split('\n')[0])
    expect(backupHeader).toMatchObject({
      schema: 'sub2api-user-state-backup',
      version: 1,
      environment: 'e2e',
      namespace: 'USER_STATE',
      object_id: registered.user.id,
    })
    const replayedBackup = await workerRequest(
      `/internal/backup/durable-objects/USER_STATE/${registered.user.id}/restore`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.BACKUP_OPERATOR_TOKEN}`,
          'x-sub2api-backup-environment': 'e2e',
          'content-type': 'application/x-ndjson',
        },
        body: backupText,
      },
    )
    expect(replayedBackup.status).toBe(200)
    await expect(replayedBackup.json()).resolves.toMatchObject({
      restored: true,
      idempotent: true,
      inventory_digest: backupHeader.inventory_digest,
      state_digest: backupHeader.state_digest,
    })

    const subscriptionId = 'subscription-backup-e2e'
    const subscriptionStub = env.SUBSCRIPTION_STATE!.get(
      env.SUBSCRIPTION_STATE!.idFromName(subscriptionId),
    )
    const startsAt = Date.now() - 86_400_000
    const configuredSubscription = await subscriptionStub.fetch(new Request(
      'https://subscription-state.internal/configure',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schema_version: 1,
          subscription_id: subscriptionId,
          user_id: registered.user.id,
          group_id: bootstrapped.group_id,
          starts_at_ms: startsAt,
          expires_at_ms: startsAt + 31 * 86_400_000,
          daily_quota_micros: 100_000,
          weekly_quota_micros: 500_000,
          monthly_quota_micros: 1_000_000,
          daily_used_micros: 27,
          weekly_used_micros: 27,
          monthly_used_micros: 27,
          daily_anchor_ms: 0,
          daily_window_start_ms: null,
          weekly_window_start_ms: null,
          monthly_window_start_ms: null,
          control_version: 0,
          quota_reset_epoch: 0,
          quota_reset_generation: 0,
        }),
      },
    ))
    expect(configuredSubscription.status).toBe(200)

    const subscriptionBackup = await workerRequest(
      `/internal/backup/durable-objects/SUBSCRIPTION_STATE/${subscriptionId}/export`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.BACKUP_OPERATOR_TOKEN}`,
          'x-sub2api-backup-environment': 'e2e',
        },
      },
    )
    expect(subscriptionBackup.status).toBe(200)
    const subscriptionArtifact = await subscriptionBackup.text()
    const subscriptionHeader = JSON.parse(subscriptionArtifact.split('\n')[0])
    expect(subscriptionHeader).toMatchObject({
      schema: 'sub2api-subscription-state-backup',
      version: 1,
      environment: 'e2e',
      namespace: 'SUBSCRIPTION_STATE',
      object_id: subscriptionId,
    })
    const replayedSubscription = await workerRequest(
      `/internal/backup/durable-objects/SUBSCRIPTION_STATE/${subscriptionId}/restore`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.BACKUP_OPERATOR_TOKEN}`,
          'x-sub2api-backup-environment': 'e2e',
          'content-type': 'application/x-ndjson',
        },
        body: subscriptionArtifact,
      },
    )
    expect(replayedSubscription.status).toBe(200)
    await expect(replayedSubscription.json()).resolves.toMatchObject({
      restored: true,
      idempotent: true,
      inventory_digest: subscriptionHeader.inventory_digest,
      state_digest: subscriptionHeader.state_digest,
    })
    const verifiedSubscription = await workerRequest(
      `/internal/backup/durable-objects/SUBSCRIPTION_STATE/${subscriptionId}/verify`,
      {
        headers: {
          authorization: `Bearer ${env.BACKUP_OPERATOR_TOKEN}`,
          'x-sub2api-backup-environment': 'e2e',
        },
      },
    )
    expect(verifiedSubscription.status).toBe(200)
    await expect(verifiedSubscription.json()).resolves.toMatchObject({
      inventory_digest: subscriptionHeader.inventory_digest,
      state_digest: subscriptionHeader.state_digest,
      logical_empty: false,
    })
  })
})
