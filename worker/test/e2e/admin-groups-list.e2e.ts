import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

async function workerRequest(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`https://worker.e2e.invalid${path}`, init))
}

async function bootstrapAdmin(): Promise<string> {
  const response = await workerRequest('/api/v1/admin/bootstrap', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      user: {
        email: 'groups-list-admin@binding-e2e.test',
        display_name: 'Groups List Admin',
        balance_micros: 1,
      },
      group: { name: 'Groups List Bootstrap Group' },
      account: {
        name: 'Groups List Bootstrap Account',
        base_url: 'https://upstream.e2e.invalid/v1',
        api_key: 'groups-list-bootstrap-secret',
        max_concurrency: 1,
      },
      api_key: { name: 'Groups list bootstrap key' },
      models: [{
        public_name: 'gpt-groups-list-binding',
        upstream_name: 'gpt-groups-list-binding-upstream',
        endpoint: 'chat_completions',
        input_micros_per_million: 0,
        output_micros_per_million: 0,
        per_request_micros: 0,
        minimum_reservation_micros: 1,
      }],
    }),
  })
  expect(response.status, await response.clone().text()).toBe(201)
  const body = await response.json() as { data: { admin_session: string } }
  return body.data.admin_session
}

describe('admin groups list Cloudflare binding E2E', () => {
  it('applies every retained list filter and a stable allowlisted sort', async () => {
    const adminSession = await bootstrapAdmin()
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO "groups" (
          id, name, description, platform, enabled, sort_order,
          rate_multiplier_ppm, is_exclusive, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'openai', ?, ?, ?, ?, ?, ?)
      `).bind('crud-group-alpha', 'CRUD Alpha', 'first retained list row', 1, 30, 1_100_000, 0, now, now),
      env.DB.prepare(`
        INSERT INTO "groups" (
          id, name, description, platform, enabled, sort_order,
          rate_multiplier_ppm, is_exclusive, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'openai', ?, ?, ?, ?, ?, ?)
      `).bind('crud-group-zulu', 'CRUD Zulu', 'second retained list row', 1, 10, 1_300_000, 0, now + 1, now + 1),
      env.DB.prepare(`
        INSERT INTO "groups" (
          id, name, description, platform, enabled, sort_order,
          rate_multiplier_ppm, is_exclusive, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'openai', ?, ?, ?, ?, ?, ?)
      `).bind('crud-group-private', 'CRUD Private', 'must be filtered out', 1, 20, 1_500_000, 1, now + 2, now + 2),
      env.DB.prepare(`
        INSERT INTO "groups" (
          id, name, description, platform, enabled, sort_order,
          rate_multiplier_ppm, is_exclusive, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 'openai', ?, ?, ?, ?, ?, ?)
      `).bind('crud-group-inactive', 'CRUD Inactive', 'must be filtered out', 0, 40, 900_000, 0, now + 3, now + 3),
    ])

    const listed = await workerRequest(
      '/api/v1/admin/groups?page=1&page_size=1&platform=openai&status=active' +
      '&is_exclusive=false&search=crud&sort_by=name&sort_order=desc',
      { headers: { authorization: `Bearer ${adminSession}` } },
    )
    expect(listed.status, await listed.clone().text()).toBe(200)
    await expect(listed.json()).resolves.toMatchObject({
      data: {
        items: [{ id: 'crud-group-zulu', name: 'CRUD Zulu' }],
        total: 2,
        page: 1,
        page_size: 1,
        pages: 2,
      },
    })

    const invalidExclusive = await workerRequest('/api/v1/admin/groups?is_exclusive=maybe', {
      headers: { authorization: `Bearer ${adminSession}` },
    })
    expect(invalidExclusive.status).toBe(400)
    await expect(invalidExclusive.json()).resolves.toMatchObject({ code: 'invalid_is_exclusive' })

    const invalidSort = await workerRequest('/api/v1/admin/groups?sort_by=sql_expression', {
      headers: { authorization: `Bearer ${adminSession}` },
    })
    expect(invalidSort.status).toBe(400)
    await expect(invalidSort.json()).resolves.toMatchObject({ code: 'invalid_sort_by' })
  })
})
