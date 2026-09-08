import { inspectAgentTaskResponse } from '../gateway/agent-task-response'
import type { Env } from '../env'
import { buildAccountProviderRequest } from '../gateway/account-provider-request'
import { applyAccountCredentialHeaders } from '../gateway/account-header-overrides'
import { CODEX_ORIGINATOR, CODEX_VERSION } from '../gateway/codex-original-contract'
import type { ProviderAccount } from '../gateway/providers'
import type { UpstreamCredential } from '../gateway/types'
import { fetchAccountProxy } from '../gateway/proxy-fetch'
import { openAIRateLimitReset } from '../gateway/openai-rate-limit-reset'

export async function compactDiagnosticRequest(account: ProviderAccount, credential: UpstreamCredential, model: string, oauth: boolean, accountId: string, authorization?:string) {
  const plan = buildAccountProviderRequest({ account: { ...account, credential_kind: oauth ? 'oauth' : 'api_key' }, credential, authorization,
    operation: 'responses', model, body: { model, instructions: 'You are a helpful coding assistant.',
      input: [{ type: 'message', role: 'user', content: 'Respond with OK.' }, { type: 'compaction_trigger' }],
      stream: true, ...(oauth ? { store: false } : {}) } })
  plan.headers.set('accept', 'text/event-stream')
  plan.headers.set('x-codex-beta-features', 'remote_compaction_v2')
  plan.headers.set('originator', CODEX_ORIGINATOR)
  plan.headers.set('version', CODEX_VERSION)
  plan.headers.set('user-agent', `${CODEX_ORIGINATOR}/${CODEX_VERSION} (Ubuntu 22.4.0; x86_64) xterm-256color`)
  plan.headers.set('x-codex-window-id', crypto.randomUUID())
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sub2api:codex-compact-probe:v1:${accountId}`))).slice(0, 16)
  hash[6] = (hash[6] & 15) | 64; hash[8] = (hash[8] & 63) | 128
  const hex = [...hash].map(x => x.toString(16).padStart(2, '0')).join('')
  const session = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  plan.headers.set('session_id', session); plan.headers.set('conversation_id', session)
  if (!oauth) applyAccountCredentialHeaders(plan.headers, { ...credential })
  return plan
}

export function compactDiagnosticFound(body: string): boolean {
  const isItem = (item: any) => item?.type === 'compaction' || item?.type === 'compaction_summary'
  const output = (value: any) => Array.isArray(value?.output) && value.output.some(isItem)
  try { if (output(JSON.parse(body))) return true } catch { /* Streaming response. */ }
  for (const frame of body.replace(/\r\n/g, '\n').split('\n\n')) {
    const lines = frame.split('\n')
    const raw = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    try {
      const value = JSON.parse(raw)
      const type = value.type || lines.find(line => line.startsWith('event:'))?.slice(6).trim()
      if ((type === 'response.output_item.done' || type === 'response.output_item.added') && isItem(value.item)) return true
      if (type === 'response.completed' && output(value.response)) return true
    } catch { /* Original probe ignores non-JSON SSE payloads. */ }
  }
  return false
}

export function compactDiagnosticUpdates(status: number | null, body: string, found: boolean, failed: boolean): Record<string, unknown> {
  const updates: Record<string, unknown> = { openai_compact_checked_at: new Date().toISOString(), openai_compact_last_status: status }
  if (failed || status === null) updates.openai_compact_last_error = 'Compact probe request failed'
  else if (status >= 200 && status < 300) {
    updates.openai_compact_supported = found
    updates.openai_compact_last_error = found ? '' : 'upstream returned 2xx without a compaction output item (native remote compaction v2 unsupported)'
  } else {
    if ([404, 405, 501].includes(status) || ([400, 403, 422].includes(status) && /compact/i.test(body) && /unsupported|not support|does not support|not available|disabled/i.test(body))) updates.openai_compact_supported = false
    // Provider error bodies can contain credentials or encrypted compaction data.
    updates.openai_compact_last_error = `Compact probe returned HTTP ${status}`
  }
  return updates
}

export function openAICompactDiagnostic(env: Env, account: ProviderAccount, credential: UpstreamCredential, model: string,
  oauth: boolean, accountId: string, proxyId: unknown, clientSignal: AbortSignal,
  persist: (updates: Record<string, unknown>, rateLimitReset: number | null) => Promise<boolean>, authorization?:string, recoverAgent?: (taskId:string)=>Promise<{credential:UpstreamCredential;authorization:string}>): Response {
  const abort = new AbortController()
  const signal = AbortSignal.any([abort.signal, clientSignal, AbortSignal.timeout(60000)])
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    const emit = (event: Record<string, unknown>) => { if (!signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) }
    void (async () => {
      let status: number | null = null, body = '', found = false, failed = false
      let headers = new Headers()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        let plan = await compactDiagnosticRequest(account, credential, model, oauth, accountId, authorization)
        emit({ type: 'test_start', model: (plan.body as Record<string, unknown>).model })
        const send=async()=>{
        const init: RequestInit = { method: plan.method, headers: plan.headers, body: JSON.stringify(plan.body), redirect: 'manual', signal }
        return proxyId != null && String(proxyId) !== '0'
          ? await fetchAccountProxy(env, String(proxyId), new URL(plan.url), init, signal) : await fetch(plan.url, init)
        }
        let response=await send()
        if(authorization) {
          let inspected=await inspectAgentTaskResponse(response,credential as unknown as Record<string,unknown>)
          response=inspected.response
          if(inspected.taskInvalid && recoverAgent && !signal.aborted) {
            const task=(credential as unknown as Record<string,unknown>).task_id
            const fresh=await recoverAgent(typeof task==='string'?task:'')
            credential=fresh.credential;authorization=fresh.authorization
            if(signal.aborted) throw new Error('aborted')
            plan=await compactDiagnosticRequest(account,credential,model,oauth,accountId,authorization)
            response=await send()
            inspected=await inspectAgentTaskResponse(response,credential as unknown as Record<string,unknown>)
            response=inspected.response
          }
        }
        status = response.status
        headers = response.headers
        if (!response.body) throw new Error('Missing probe body')
        reader = response.body.getReader()
        const decoder = new TextDecoder(); let bytes = 0
        while (true) {
          const next = await reader.read(); if (next.done) break
          bytes += next.value.byteLength
          if (bytes > 2 * 1024 * 1024) throw new Error('Probe response exceeded limit')
          body += decoder.decode(next.value, { stream: true })
        }
        body += decoder.decode(); found = compactDiagnosticFound(body)
      } catch { failed = true }
      finally { try { await reader?.cancel() } catch { /* Cleanup. */ } reader?.releaseLock() }
      try {
        if (abort.signal.aborted || clientSignal.aborted) return
        const updates = compactDiagnosticUpdates(status, body, found, failed)
        const saved = await persist(updates, status === 429 ? openAIRateLimitReset(headers, body) : null)
        const success = !failed && status === 200 && found
        if (success) emit({ type: 'content', text: 'Compact probe succeeded (native remote compaction v2)' })
        if (!saved) emit({ type: 'content', text: 'Account changed during probe; capability result was not saved.' })
        // Timeout still needs a terminal event for the modal.
        if (!abort.signal.aborted && !clientSignal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'test_complete', success,
          ...(!success ? { error: updates.openai_compact_last_error } : {}) })}\n\n`))
      } catch {
        if (!abort.signal.aborted && !clientSignal.aborted) controller.enqueue(encoder.encode('data: {"type":"test_complete","success":false,"error":"Failed to save compact capability result"}\n\n'))
      } finally { try { controller.close() } catch { /* Consumer cancelled. */ } }
    })()
  }, cancel() { abort.abort() } })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-store' } })
}
