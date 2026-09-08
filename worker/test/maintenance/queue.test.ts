import { describe,expect,it,vi,beforeEach } from 'vitest'
import { enqueueSettingsMaintenance,consumeSettingsMaintenance } from '../../src/maintenance/queue'
import { runScheduledRecovery } from '../../src/index'
import { consumeEvents } from '../../src/gateway/queue'
import type { Env } from '../../src/env'
vi.mock('../../src/app',()=>({app:{fetch:vi.fn()}}))
const work=vi.hoisted(()=>({notifications:vi.fn(),monitors:vi.fn(),probes:vi.fn(),retention:vi.fn(),alerts:vi.fn(),cyber:vi.fn(),logRetention:vi.fn(),versionSync:vi.fn(),ollama:vi.fn()}))
vi.mock('../../src/notifications/scanner',()=>({scanSystemNotifications:work.notifications}))
vi.mock('../../src/control/channel-monitors',()=>({runScheduledChannelMonitors:work.monitors}))
vi.mock('../../src/control/upstream-billing-probe',()=>({runUpstreamBillingProbes:work.probes}))
vi.mock('../../src/control/ops-dashboard',()=>({runOpsRetention:work.retention}))
vi.mock('../../src/control/ops-alerts',()=>({runOpsAlerts:work.alerts}))
vi.mock('../../src/gateway/cyber-sessions',()=>({cleanupCyberSessions:work.cyber}))
vi.mock('../../src/control/ops-system-logs',()=>({runOpsSystemLogRetention:work.logRetention,consumeOpsSystemLog:async()=>false}))
vi.mock('../../src/control/codex-version-sync',()=>({runCodexVersionSync:work.versionSync}))
vi.mock('../../src/control/ollama-cloud-usage',()=>({runOllamaCloudUsageMaintenance:work.ollama}))
beforeEach(()=>{vi.clearAllMocks();work.notifications.mockResolvedValue(undefined);work.monitors.mockResolvedValue(undefined)})
describe('settings maintenance invocation isolation',()=>{
 it('dispatches separate retryable messages without executing heavy work in cron',async()=>{
  const send=vi.fn().mockResolvedValue(undefined),env={EVENTS_QUEUE:{send}} as unknown as Env
  await runScheduledRecovery(env)
  expect(send).toHaveBeenCalledTimes(36)
  expect(send.mock.calls.map(call=>call[0].payload.task)).toEqual(expect.arrayContaining(['proxy_expiry','scheduled_account_tests','account_initialization','account_token_renewal']))
  expect(work.notifications).not.toHaveBeenCalled();expect(work.monitors).not.toHaveBeenCalled()
  const events=send.mock.calls.map(call=>call[0]); const first=events.find(event=>event.payload.task==='system_notifications'),second=events.find(event=>event.payload.task==='channel_monitors')
  expect(first.event_id).not.toBe(second.event_id)
  expect(await consumeSettingsMaintenance(first,env)).toBe(true)
  expect(work.notifications).toHaveBeenCalledTimes(1)
  expect(work.monitors).not.toHaveBeenCalled()
 })
 it('acknowledges successful tasks and retries failed tasks through the real queue consumer',async()=>{
  const env={} as Env,ack=vi.fn(),retry=vi.fn()
  const message={body:{schema_version:1,event_type:'settings.maintenance.v1',payload:{task:'channel_monitors'}},ack,retry}
  await consumeEvents({messages:[message]} as unknown as MessageBatch<unknown>,env)
  expect(ack).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled()
  ack.mockClear();work.monitors.mockRejectedValueOnce(new Error('D1 unavailable'))
  await consumeEvents({messages:[message]} as unknown as MessageBatch<unknown>,env)
  expect(ack).not.toHaveBeenCalled();expect(retry).toHaveBeenCalledTimes(1)
 })
 it('does not claim unrelated events or execute unknown task names',async()=>{
  expect(await consumeSettingsMaintenance({event_type:'usage.settled.v1'},{} as Env)).toBe(false)
  await expect(consumeSettingsMaintenance({schema_version:1,event_type:'settings.maintenance.v1',payload:{task:'constructor'}},{} as Env)).rejects.toThrow('Invalid settings')
 })
 it('continues due alert work without losing the original scheduled report time',async()=>{
  const send=vi.fn().mockResolvedValue(undefined),env={EVENTS_QUEUE:{send}} as unknown as Env
  const event={schema_version:1,event_type:'settings.maintenance.v1',event_id:'initial',occurred_at_ms:100000,payload:{task:'ops_alerts',scheduled_at_ms:100000}}
  work.alerts.mockResolvedValueOnce({has_more_due_rules:true}).mockResolvedValueOnce({has_more_due_rules:false})
  await consumeSettingsMaintenance(event,env)
  expect(work.alerts.mock.calls[0][2]).toBe(100000)
  const continuation=send.mock.calls[0][0]
  expect(continuation.event_id).not.toBe('initial');expect(continuation.payload.scheduled_at_ms).toBe(100000)
  await consumeSettingsMaintenance(continuation,env)
  expect(work.alerts.mock.calls[1][2]).toBe(100000);expect(send).toHaveBeenCalledTimes(1)
 })

 it('attempts every isolated dispatch even if one Queue send fails',async()=>{
  const send=vi.fn().mockResolvedValue(undefined).mockRejectedValueOnce(new Error('Queue unavailable'))
  await expect(enqueueSettingsMaintenance({EVENTS_QUEUE:{send}} as unknown as Env)).rejects.toThrow('1 tasks')
  expect(send).toHaveBeenCalledTimes(36)
  expect(new Set(send.mock.calls.map(call=>call[0].payload.task)).size).toBe(36)
 })
 it('routes an old recovery task failure through Queue retry without acknowledging it',async()=>{
  const env={DB:{prepare:()=>{throw new Error('D1 unavailable')}}} as unknown as Env,ack=vi.fn(),retry=vi.fn()
  const message={body:{schema_version:1,event_type:'settings.maintenance.v1',payload:{task:'oauth_state_cleanup'}},ack,retry}
  await consumeEvents({messages:[message]} as unknown as MessageBatch<unknown>,env)
  expect(ack).not.toHaveBeenCalled();expect(retry).toHaveBeenCalledTimes(1)
 })

})
