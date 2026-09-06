import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createCompositeRoute, deleteCompositeRoute, listCompositeRoutes, previewCompositeRoute, updateCompositeRoute } from '../../src/control/composite-routes'
import type { Env } from '../../src/env'
import { applyMigrations, createSqliteD1 } from '../helpers/sqlite-d1'

function fixture() {
  const { raw, d1 } = createSqliteD1(); applyMigrations(raw)
  raw.exec(`INSERT INTO "groups" (id,name,platform,created_at_ms,updated_at_ms) VALUES ('composite','Composite','composite',1,1),('plain','Plain','openai',1,1)`)
  const app = new Hono<{ Bindings: Env }>(); app.get('/groups/:id/composite-routes', listCompositeRoutes); app.post('/groups/:id/composite-routes', createCompositeRoute); app.put('/groups/:id/composite-routes/:route_id', updateCompositeRoute); app.delete('/groups/:id/composite-routes/:route_id', deleteCompositeRoute); app.post('/groups/:id/composite-routes/preview', previewCompositeRoute)
  return { raw, app, env: { DB: d1 } as Env }
}
describe('composite routes on D1', () => {
  it('creates, resolves by endpoint and updates/deletes with CAS', async () => {
    const test = fixture(); const headers = { 'content-type':'application/json', 'idempotency-key':'composite-create-0001' }
    const created = await test.app.request('/groups/composite/composite-routes',{method:'POST',headers,body:JSON.stringify({public_model:'router/gpt',match_type:'exact',target_platform:'openai',upstream_model:'gpt-5',endpoint:'responses',priority:10})},test.env)
    expect(created.status,await created.clone().text()).toBe(201); const route=(await created.json() as any).data; expect(route).toMatchObject({target_platform:'openai',upstream_model:'gpt-5',control_version:0})
    const preview = await test.app.request('/groups/composite/composite-routes/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'router/gpt',endpoint:'responses'})},test.env); await expect(preview.json()).resolves.toMatchObject({data:{matched:true,target_platform:'openai',upstream_model:'gpt-5'}})
    const updated = await test.app.request(`/groups/composite/composite-routes/${route.id}`,{method:'PUT',headers:{'content-type':'application/json','idempotency-key':'composite-update-0001'},body:JSON.stringify({public_model:'router/gpt',target_platform:'openai',endpoint:'responses',priority:20,expected_control_version:0})},test.env); expect(updated.status).toBe(200)
    const stale = await test.app.request(`/groups/composite/composite-routes/${route.id}`,{method:'DELETE',headers:{'content-type':'application/json','idempotency-key':'composite-delete-0001'},body:JSON.stringify({expected_control_version:0})},test.env); expect(stale.status).toBe(412)
    const deleted = await test.app.request(`/groups/composite/composite-routes/${route.id}`,{method:'DELETE',headers:{'content-type':'application/json','idempotency-key':'composite-delete-0002'},body:JSON.stringify({expected_control_version:1})},test.env); expect(deleted.status).toBe(200)
  })
  it('rejects concrete groups and exposes an empty configuration as no match', async () => {
    const test=fixture(); const list=await test.app.request('/groups/plain/composite-routes',{},test.env); expect(list.status).toBe(409)
    const preview=await test.app.request('/groups/composite/composite-routes/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'missing',endpoint:'any'})},test.env); await expect(preview.json()).resolves.toMatchObject({data:{matched:false,reason:'No matching composite route'}})
  })
})
