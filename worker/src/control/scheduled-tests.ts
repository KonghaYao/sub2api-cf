import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlError, controlSuccess, readJsonObject } from './http'
import { nextScheduledTestRun } from './scheduled-test-cron'

export interface ScheduledTestPlanRow {
  id: number; account_id: string; model_id: string; cron_expression: string; enabled: number
  max_results: number; auto_recover: number; last_run_at_ms: number | null; next_run_at_ms: number | null
  created_at_ms: number; updated_at_ms: number; revision: number; lease_token: string | null; lease_until_ms: number
}
const iso = (n: number | null) => n === null ? null : new Date(n).toISOString()
function projection(p: ScheduledTestPlanRow) {
  return { id: p.id, account_id: p.account_id, model_id: p.model_id, cron_expression: p.cron_expression,
    enabled: p.enabled === 1, max_results: p.max_results, auto_recover: p.auto_recover === 1,
    last_run_at: iso(p.last_run_at_ms), next_run_at: iso(p.next_run_at_ms), created_at: iso(p.created_at_ms), updated_at: iso(p.updated_at_ms) }
}
function planId(c: Context<{ Bindings: Env }>): number {
  const raw = c.req.param('id') ?? ''
  const id = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) throw new GatewayError(400,'invalid_plan_id','Invalid plan ID')
  return id
}
function fields(body: Record<string, unknown>, existing?: ScheduledTestPlanRow) {
  for (const key of ['model_id','cron_expression']) if (body[key] !== undefined && typeof body[key] !== 'string') throw new GatewayError(400,'invalid_plan',`${key} must be a string`)
  for (const key of ['enabled','auto_recover']) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new GatewayError(400,'invalid_plan',`${key} must be a boolean`)
  if (body.max_results !== undefined && !Number.isSafeInteger(body.max_results)) throw new GatewayError(400,'invalid_plan','max_results must be an integer')
  const cron = (body.cron_expression || existing?.cron_expression) as string
  if (!cron || cron.length > 256) throw new GatewayError(400,'invalid_cron_expression','Cron expression is required')
  const model = (body.model_id || existing?.model_id || '') as string
  if (model.length > 512) throw new GatewayError(400,'invalid_plan','Model ID is too long')
  return { cron, model, enabled: body.enabled === undefined ? existing?.enabled ?? 1 : body.enabled ? 1 : 0,
    recover: body.auto_recover === undefined ? existing?.auto_recover ?? 0 : body.auto_recover ? 1 : 0,
    max: typeof body.max_results === 'number' && body.max_results > 0 ? body.max_results : existing?.max_results ?? 50 }
}
async function requirePlan(env: Env,id: number) {
  const plan = await env.DB.prepare('SELECT * FROM scheduled_test_plans WHERE id=?').bind(id).first<ScheduledTestPlanRow>()
  if (!plan) throw new GatewayError(404,'plan_not_found','Plan not found')
  return plan
}
export async function listAccountScheduledTests(c: Context<{ Bindings: Env }>) {
  try {
    const rows = await c.env.DB.prepare('SELECT * FROM scheduled_test_plans WHERE account_id=? ORDER BY id DESC')
      .bind(c.req.param('id')).all<ScheduledTestPlanRow>()
    return controlSuccess(rows.results.map(projection))
  } catch (e) { return controlError(asGatewayError(e)) }
}
export async function createScheduledTest(c: Context<{ Bindings: Env }>) {
  try {
    const body = await readJsonObject(c.req.raw), parsed = fields(body), now = Date.now()
    const accountId = typeof body.account_id === 'string' ? body.account_id : Number.isSafeInteger(body.account_id) ? String(body.account_id) : ''
    if (!accountId || !await c.env.DB.prepare('SELECT id FROM accounts WHERE id=?').bind(accountId).first()) throw new GatewayError(400,'invalid_account_id','Account not found')
    const next = nextScheduledTestRun(parsed.cron,now)
    const plan = await c.env.DB.prepare(`INSERT INTO scheduled_test_plans
      (account_id,model_id,cron_expression,enabled,max_results,auto_recover,next_run_at_ms,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?) RETURNING *`).bind(accountId,parsed.model,parsed.cron,parsed.enabled,parsed.max,parsed.recover,next,now,now).first<ScheduledTestPlanRow>()
    return controlSuccess(projection(plan!))
  } catch (e) { return controlError(asGatewayError(e)) }
}
export async function updateScheduledTest(c: Context<{ Bindings: Env }>) {
  try {
    const id = planId(c), plan = await requirePlan(c.env,id), parsed = fields(await readJsonObject(c.req.raw),plan), now = Date.now()
    const saved = await c.env.DB.prepare(`UPDATE scheduled_test_plans SET model_id=?,cron_expression=?,enabled=?,max_results=?,auto_recover=?,
      next_run_at_ms=?,updated_at_ms=?,revision=revision+1,lease_token=NULL,lease_until_ms=0 WHERE id=? AND revision=? RETURNING *`)
      .bind(parsed.model,parsed.cron,parsed.enabled,parsed.max,parsed.recover,nextScheduledTestRun(parsed.cron,now),now,id,plan.revision).first<ScheduledTestPlanRow>()
    if (!saved) throw new GatewayError(409,'plan_changed','Plan changed; reload it and retry')
    return controlSuccess(projection(saved))
  } catch (e) { return controlError(asGatewayError(e)) }
}
export async function deleteScheduledTest(c: Context<{ Bindings: Env }>) {
  try { await c.env.DB.prepare('DELETE FROM scheduled_test_plans WHERE id=?').bind(planId(c)).run(); return controlSuccess({ message: 'deleted' }) }
  catch (e) { return controlError(asGatewayError(e)) }
}
export async function listScheduledTestResults(c: Context<{ Bindings: Env }>) {
  try {
    const rawLimit = Number(c.req.query('limit')), limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? rawLimit : 50
    const rows = await c.env.DB.prepare('SELECT * FROM scheduled_test_results WHERE plan_id=? ORDER BY id DESC LIMIT ?').bind(planId(c),limit).all<{
      id: number; plan_id: number; status: string; response_text: string; error_message: string; latency_ms: number
      started_at_ms: number; finished_at_ms: number; created_at_ms: number
    }>()
    return controlSuccess(rows.results.map(r => ({ id: r.id, plan_id: r.plan_id, status: r.status, response_text: r.response_text,
      error_message: r.error_message, latency_ms: r.latency_ms, started_at: iso(r.started_at_ms), finished_at: iso(r.finished_at_ms), created_at: iso(r.created_at_ms) })))
  } catch (e) { return controlError(asGatewayError(e)) }
}
