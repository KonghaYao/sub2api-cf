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
        email: 'audit-admin@binding-e2e.test',
        display_name: 'Audit Binding Admin',
        balance_micros: 1,
      },
      group: { name: 'Audit Binding Group' },
      account: {
        name: 'Audit Binding Upstream',
        base_url: 'https://upstream.e2e.invalid/v1',
        api_key: 'audit-binding-upstream-secret',
        max_concurrency: 1,
      },
      api_key: { name: 'Audit binding key' },
      models: [{
        public_name: 'gpt-audit-binding',
        upstream_name: 'gpt-audit-binding-upstream',
        endpoint: 'chat_completions',
        input_micros_per_million: 0,
        output_micros_per_million: 0,
        per_request_micros: 0,
        minimum_reservation_micros: 1,
      }],
    }),
  })
  expect(response.status, await response.clone().text()).toBe(201)
  const body = await response.json() as { data: { admin_session: string; user_id: string } }

  await env.DB.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < 501
    )
    INSERT INTO auth_audit_events (
      id, user_id, event_type, outcome, metadata_json, occurred_at_ms
    )
    SELECT
      printf('binding-auth-%03d', value), ?, 'auth.binding.seed', 'succeeded', '{}',
      9000000000000 + value
    FROM sequence
  `).bind(body.data.user_id).run()

  return body.data.admin_session
}

describe('admin audit Cloudflare binding E2E', () => {
  it('merges more than 500 audit events without a compound SELECT failure', async () => {
    const adminSession = await bootstrapAdmin()

    const first = await workerRequest('/api/v1/admin/audit/events?limit=100', {
      headers: { authorization: `Bearer ${adminSession}` },
    })
    expect(first.status, await first.clone().text()).toBe(200)
    const firstBody = await first.json() as {
      data: {
        items: Array<{ category: string; event_id: string }>
        has_more: boolean
        next_cursor: string | null
      }
    }
    expect(firstBody.data.items).toHaveLength(100)
    expect(firstBody.data.items.slice(0, 2)).toEqual([
      expect.objectContaining({ category: 'auth', event_id: 'binding-auth-501' }),
      expect.objectContaining({ category: 'auth', event_id: 'binding-auth-500' }),
    ])
    expect(firstBody.data.has_more).toBe(true)
    expect(firstBody.data.next_cursor).toEqual(expect.any(String))

    const second = await workerRequest(
      `/api/v1/admin/audit/events?category=auth&action=auth.binding.seed&limit=100` +
      `&cursor=${encodeURIComponent(firstBody.data.next_cursor ?? '')}`,
      { headers: { authorization: `Bearer ${adminSession}` } },
    )
    expect(second.status, await second.clone().text()).toBe(200)
    const secondBody = await second.json() as {
      data: { items: Array<{ category: string; event_id: string }> }
    }
    expect(secondBody.data.items).toHaveLength(100)
    expect(secondBody.data.items[0]).toMatchObject({
      category: 'auth',
      event_id: 'binding-auth-401',
    })
  })
})
