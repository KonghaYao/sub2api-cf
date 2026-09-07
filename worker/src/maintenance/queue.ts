import { recoveryMaintenanceTasks } from './recovery'
import { recoverRiskBanCommands } from '../risk/ban-state'
import { recoverRiskJobs } from '../gateway/risk-moderation'
import { deliverRiskNotifications } from '../risk/effects'
import { projectCyberRiskEvents, cleanupRiskData } from '../risk/maintenance'
import { runOllamaCloudUsageMaintenance } from '../control/ollama-cloud-usage'
import { runOpsSystemLogRetention } from '../control/ops-system-logs'
import { runCodexVersionSync } from '../control/codex-version-sync'
import { runOpsAlerts } from '../control/ops-alerts'
import { cleanupCyberSessions } from '../gateway/cyber-sessions'
import { runOpsRetention } from '../control/ops-dashboard'
import { runUpstreamBillingProbes } from '../control/upstream-billing-probe'
import type { Env,PlatformEvent } from '../env'
import { scanSystemNotifications } from '../notifications/scanner'
import { runScheduledChannelMonitors } from '../control/channel-monitors'

const tasks = {
  ...recoveryMaintenanceTasks,
  risk_ban_commands: (env:Env) => recoverRiskBanCommands(env),
  risk_job_recovery: (env:Env) => recoverRiskJobs(env),
  risk_notifications: (env:Env) => deliverRiskNotifications(env),
  risk_cyber_projection: (env:Env) => projectCyberRiskEvents(env),
  risk_cleanup: (env:Env) => cleanupRiskData(env),
  ollama_cloud_usage: (env:Env) => runOllamaCloudUsageMaintenance(env),
  ops_log_retention: (env:Env) => runOpsSystemLogRetention(env),
  codex_version_sync: (env:Env) => runCodexVersionSync(env),
  ops_alerts: (env:Env,scheduledAt?:number) => runOpsAlerts(env,Date.now(),scheduledAt),
  cyber_session_cleanup: (env:Env) => cleanupCyberSessions(env),
  ops_retention: (env:Env) => runOpsRetention(env),
  upstream_billing_probes: (env:Env) => runUpstreamBillingProbes(env),
  system_notifications: (env:Env) => scanSystemNotifications(env),
  channel_monitors: (env:Env) => runScheduledChannelMonitors(env,Date.now()),
}
type TaskName=keyof typeof tasks
export async function enqueueSettingsMaintenance(env:Env,nowMs=Date.now()):Promise<void>{
  const minute=Math.floor(nowMs/60000)
  let failures=0
  for(const task of Object.keys(tasks) as TaskName[]){
    const event:PlatformEvent<{task:TaskName;scheduled_at_ms?:number}>={schema_version:1,event_id:`settings-maintenance:${task}:${minute}`,event_type:'settings.maintenance.v1',occurred_at_ms:nowMs,aggregate_type:'maintenance',aggregate_id:task,payload:{task,scheduled_at_ms:nowMs}}
    try{await env.EVENTS_QUEUE.send(event)}catch{failures++}
  }
  if(failures)throw new Error(`Maintenance dispatch failed for ${failures} tasks`)
}
export async function consumeSettingsMaintenance(value:unknown,env:Env):Promise<boolean>{
  if(!value||typeof value!=='object'||(value as Record<string,unknown>).event_type!=='settings.maintenance.v1')return false
  const event=value as Partial<PlatformEvent<{task:TaskName;scheduled_at_ms?:number}>>
  if(event.schema_version!==1||!event.payload||!Object.hasOwn(tasks,event.payload.task))throw new Error('Invalid settings maintenance event')
  if(event.payload.scheduled_at_ms!==undefined&&!Number.isSafeInteger(event.payload.scheduled_at_ms))throw new Error('Invalid settings maintenance schedule')
  const result:unknown=event.payload.task==='ops_alerts'?await tasks.ops_alerts(env,event.payload.scheduled_at_ms??event.occurred_at_ms):await tasks[event.payload.task](env)
  if(event.payload.task==='ops_alerts'&&result&&typeof result==='object'&&(result as {has_more_due_rules?:boolean}).has_more_due_rules){
    await env.EVENTS_QUEUE.send({...event,payload:{...event.payload,scheduled_at_ms:event.payload.scheduled_at_ms??event.occurred_at_ms??Date.now()},event_id:`settings-maintenance:ops_alerts:${crypto.randomUUID()}`,occurred_at_ms:Date.now()} as PlatformEvent<{task:TaskName;scheduled_at_ms?:number}>)
  }
  return true
}
