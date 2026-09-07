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
        email: 'dashboard-admin@binding-e2e.test',
        display_name: 'Dashboard Admin',
        balance_micros: 1,
      },
      group: { name: 'Dashboard Bootstrap Group' },
      account: {
        name: 'Dashboard Bootstrap Account',
        base_url: 'https://upstream.e2e.invalid/v1',
        api_key: 'dashboard-bootstrap-secret',
        max_concurrency: 1,
      },
      api_key: { name: 'Dashboard bootstrap key' },
      models: [{
        public_name: 'gpt-dashboard-binding',
        upstream_name: 'gpt-dashboard-binding-upstream',
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

describe('admin dashboard Cloudflare bindings', () => {
  it('serves real aggregate data through the deployed Worker entry point', async () => {
    const session = await bootstrapAdmin()
    const admin = await env.DB.prepare("SELECT id FROM users WHERE email='dashboard-admin@binding-e2e.test'").first<{id:string}>()
    const now = Date.now()
    await env.DB.prepare(`INSERT INTO usage_projection
      (event_id,request_id,user_id,model,input_tokens,output_tokens,amount_micros,occurred_at_ms,projected_at_ms)
      VALUES ('dashboard-event','dashboard-request',?,'composer-2.5',100,50,75000,?,?)`).bind(admin!.id,now,now).run()
    const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now)
    const query = new URLSearchParams({start_date:today,end_date:today,timezone:'Asia/Shanghai',granularity:'hour'})
    for (const route of ['snapshot-v2','users-trend','users-ranking']) {
      const response=await workerRequest(`/api/v1/admin/dashboard/${route}?${query}`,{headers:{authorization:`Bearer ${session}`}})
      expect(response.status,await response.clone().text()).toBe(200)
      const body=await response.json() as {code:number;data:any}
      expect(body.code).toBe(0)
      if(route==='snapshot-v2') {
        expect(body.data.stats).toMatchObject({total_requests:1,total_tokens:150,total_actual_cost:0.075})
        expect(body.data.models).toContainEqual(expect.objectContaining({model:'composer-2.5',requests:1}))
      } else if(route==='users-trend') {
        expect(body.data.trend).toContainEqual(expect.objectContaining({user_id:admin!.id,tokens:150}))
      } else expect(body.data).toMatchObject({total_requests:1,total_tokens:150,total_actual_cost:0.075})
    }
  })
})
