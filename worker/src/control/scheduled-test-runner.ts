import { Hono } from 'hono'
import type { Env } from '../env'
import { testAdminAccount } from './accounts'
import { nextScheduledTestRun } from './scheduled-test-cron'
import type { ScheduledTestPlanRow } from './scheduled-tests'

const diagnostic = new Hono<{ Bindings: Env }>().post('/accounts/:id/test',testAdminAccount)
async function execute(env: Env,plan: ScheduledTestPlanRow) {
  const account = await env.DB.prepare('SELECT platform,credential_ref,control_version FROM accounts WHERE id=?').bind(plan.account_id)
    .first<{ platform: string; credential_ref: string; control_version: number }>()
  if (!account) return
  const started = Date.now(), abort = new AbortController()
  let responseText = '', errorMessage = '', success = false, timer: ReturnType<typeof setTimeout> | undefined
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const operation = async () => {
      const model = plan.model_id || (account.platform === 'anthropic' ? 'claude-sonnet-4-5-20250929' : account.platform === 'gemini' ? 'gemini-2.0-flash' : 'gpt-5.4')
      const response = await diagnostic.request(`/accounts/${encodeURIComponent(plan.account_id)}/test`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model_id: model }), signal: abort.signal,
      },env)
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Account diagnostic returned HTTP ${response.status}`) }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Account diagnostic returned no result')
      activeReader = reader
      const decoder = new TextDecoder(); let text = '', bytes = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > 1024*1024) { void reader.cancel(); throw new Error('Account diagnostic result is too large') }
          text += decoder.decode(part.value,{ stream: true })
        }
        text += decoder.decode()
      } finally { reader.releaseLock(); activeReader = undefined }
      if (abort.signal.aborted) throw new Error('Account diagnostic timed out')
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue
        let event
        try { event = JSON.parse(line.slice(6)) } catch { continue }
        if (event.type === 'content' && typeof event.text === 'string') responseText += event.text
        if (event.type === 'error' && typeof event.error === 'string') errorMessage = event.error
        if (event.type === 'test_complete') {
          success = event.success === true
          if (typeof event.error === 'string') errorMessage = event.error
        }
      }
      if (!success && !errorMessage) errorMessage = 'Account diagnostic did not complete successfully'
    }
    await Promise.race([operation(),new Promise<never>((_,reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error('Account diagnostic timed out')) },70000)
    })])
  } catch (error) { success = false; errorMessage = error instanceof Error ? error.message : 'Account diagnostic failed' }
  finally {
    clearTimeout(timer); abort.abort()
    // Abort-aware fetch does not guarantee that every intermediate SSE reader
    // finishes. Cancel our consumer as well, without awaiting a stuck transport.
    void activeReader?.cancel().catch(() => {})
  }
  const finished = Date.now(), ok = success && !errorMessage
  const guard = 'id=? AND revision=? AND lease_token=? AND lease_until_ms>?'
  const guardValues = [plan.id,plan.revision,plan.lease_token,finished]
  const statements = [env.DB.prepare(`INSERT INTO scheduled_test_results
    (plan_id,status,response_text,error_message,latency_ms,started_at_ms,finished_at_ms,created_at_ms)
    SELECT id,?,?,?,?,?,?,? FROM scheduled_test_plans WHERE ${guard}`)
    .bind(ok ? 'success' : 'failed',responseText.slice(0,262144),errorMessage.slice(0,4096),finished-started,started,finished,finished,...guardValues)]
  if (ok && plan.auto_recover) statements.push(env.DB.prepare(`UPDATE accounts SET health_status='unknown',last_health_error=NULL,
    ui_config_json=json_remove(ui_config_json,'$.rate_limited_at','$.rate_limit_reset_at','$.overload_until',
      '$.temp_unschedulable_until','$.temp_unschedulable_reason','$.extra.model_rate_limits','$.extra.antigravity_quota_scopes'),
    config_version=config_version+1,control_version=control_version+1,recovery_revision=recovery_revision+1,updated_at_ms=?
    WHERE id=? AND credential_ref=? AND control_version=?
      AND (health_status='unhealthy' OR json_extract(ui_config_json,'$.rate_limit_reset_at') IS NOT NULL
        OR json_extract(ui_config_json,'$.rate_limited_at') IS NOT NULL OR json_extract(ui_config_json,'$.overload_until') IS NOT NULL
        OR json_extract(ui_config_json,'$.temp_unschedulable_until') IS NOT NULL OR json_extract(ui_config_json,'$.extra.model_rate_limits') IS NOT NULL
        OR json_extract(ui_config_json,'$.extra.antigravity_quota_scopes') IS NOT NULL)
      AND EXISTS(SELECT 1 FROM scheduled_test_plans WHERE ${guard})`)
      .bind(finished,plan.account_id,account.credential_ref,account.control_version,...guardValues))
  statements.push(env.DB.prepare(`DELETE FROM scheduled_test_results WHERE plan_id=? AND id NOT IN
    (SELECT id FROM scheduled_test_results WHERE plan_id=? ORDER BY id DESC LIMIT ?)
    AND EXISTS(SELECT 1 FROM scheduled_test_plans WHERE ${guard})`).bind(plan.id,plan.id,plan.max_results,...guardValues))
  statements.push(env.DB.prepare(`UPDATE scheduled_test_plans SET last_run_at_ms=?,next_run_at_ms=?,updated_at_ms=?,
    lease_token=NULL,lease_until_ms=0 WHERE ${guard}`).bind(finished,nextScheduledTestRun(plan.cron_expression,finished),finished,...guardValues))
  await env.DB.batch(statements)
}

export async function runDueScheduledTests(env: Env,now = Date.now()) {
  // Stop starting work in time for the last 70-second diagnostic to finish
  // within the original runner's five-minute cycle budget.
  const admissionDeadline = Date.now()+230000
  const due = await env.DB.prepare(`SELECT id FROM scheduled_test_plans WHERE enabled=1 AND next_run_at_ms<=? AND lease_until_ms<=?
    ORDER BY next_run_at_ms,id LIMIT 20`).bind(now,now).all<{ id: number }>()
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4,due.results.length) },async () => {
    while (cursor < due.results.length && Date.now() < admissionDeadline) {
      const id = due.results[cursor++]!.id, token = crypto.randomUUID(), claimNow = Date.now()
      const plan = await env.DB.prepare(`UPDATE scheduled_test_plans SET lease_token=?,lease_until_ms=?
        WHERE id=? AND enabled=1 AND next_run_at_ms<=? AND lease_until_ms<=? RETURNING *`)
        .bind(token,claimNow+120000,id,now,claimNow).first<ScheduledTestPlanRow>()
      if (!plan) continue
      try { await execute(env,plan) }
      catch { /* Database/worker failures retain the lease for bounded crash recovery. */ }
    }
  }))
}
